/**
 * Spec 146, Phase 4 — one thread's message queue.
 *
 * TWO PROPERTIES, AND THEY PULL AGAINST EACH OTHER
 *
 *  1. Messages to one builder are delivered IN THE ORDER SENT.
 *  2. A message sent while a turn is active is queued and delivered when the turn
 *     settles — never dropped, never interleaved into the running turn.
 *
 * Property 2 means a send is sometimes deferred. Property 1 means a send that is
 * NOT deferred still must not overtake one that was. So a queue that only holds
 * messages while a turn is active is wrong: the moment the turn settles, a fresh
 * send could be dispatched while the backlog is still draining and arrive first.
 *
 * Hence the rule this class actually implements: **every message goes through the
 * same FIFO, always.** There is no fast path around it. When nothing is queued and
 * no turn is active the queue drains immediately, which looks like a fast path and
 * is not one — the ordering guarantee does not depend on the caller's timing.
 *
 * WHY ORDERING IS NOT FREE IN A SINGLE-THREADED RUNTIME
 *
 * Pushing to an array is atomic here; awaiting is not. Two concurrent `send` calls
 * that each awaited the dispatcher would interleave their continuations, and the
 * second could reach the transport first. So dispatch runs in ONE promise chain
 * (`#drain`), and a message's position is fixed when it enters the queue rather
 * than when it reaches the network. The test drives this with concurrent sends, not
 * a sequential loop — a sequential loop cannot produce the reordering that matters
 * and would pass against a queue with no ordering guarantee at all.
 *
 * WHAT IS *NOT* QUEUED
 *
 * An unreachable server. The spec is explicit that a send must fail loudly at the
 * call site rather than silently queueing, and that this is the one place the old
 * mailbox's hold-and-retry behaviour is deliberately not reproduced. So a transport
 * failure rejects the caller's promise and the message leaves the queue. The only
 * reason a message waits here is a live turn.
 */

import type { DispatchJournal, CommandDispatcher } from './commands.js';
import {
  buildMessageCommand,
  commandIdForKey,
  journalHasDispatched,
  sendMessage,
  type AcceptedByServer,
  type OutboundMessage,
  type QueuedByPorch,
  type SendReceipt,
} from './deliver.js';

/** What the queue needs to know about the thread it serves. */
export interface QueueTarget {
  readonly threadId: string;
  /** True while a turn is running. Read at dispatch time, never cached. */
  readonly isTurnActive: boolean;
  /**
   * Resolve when the running turn settles. Optional.
   *
   * **Without it the backlog stalls, and only a live server shows you.** A message
   * on this path IS a `thread.turn.start`, so dispatching the head of the queue
   * starts a turn — and the next iteration then sees `isTurnActive` and stops. One
   * message goes, the rest sit there until someone happens to call `flush()` again.
   *
   * Every unit test missed this because a fake dispatcher never starts a real turn,
   * so `isTurnActive` stays false and all ten drain in one pass. Against the real
   * server exactly five of ten arrived, in order, and waiting longer never produced
   * the other five: not a timing problem, a stalled queue.
   *
   * Supplied, the drain waits for each turn to settle and keeps going, which is
   * what "delivered when the turn settles" means once a message is a turn. Omitted,
   * the drain stops at an active turn and the caller owns re-flushing — the older
   * behaviour, kept because it is what a caller with no settle signal can honour.
   */
  readonly awaitSettle?: () => Promise<void>;
  /**
   * Watch for the turn the NEXT dispatch will start. Called before dispatching.
   *
   * **`isTurnActive` cannot close this race, because it is a projection.** It is
   * fed by the event subscription, so between "the server accepted our
   * `thread.turn.start`" and "our subscription has projected that turn as active"
   * the flag still reads false. The drain loops immediately after a successful
   * dispatch, re-reads the flag inside that window, believes no turn is running,
   * and sends the next queued message INTO the turn it just started — the exact
   * interleaving this queue exists to prevent.
   *
   * Polling `isTurnActive` does not fix it either, one level down: an `awaitSettle`
   * built as "while (isTurnActive) wait" returns instantly in the same window,
   * because it is reading the same not-yet-updated projection.
   *
   * So the drain does not ask "is a turn active now"; it asks "has the turn I just
   * started finished". Registered BEFORE the dispatch so no event can land in the
   * gap, and `settled` must resolve only after that turn was seen RUNNING — the
   * latch `TurnTracker.expectTurn` already implements for exactly this reason.
   *
   * Omitted, the drain falls back to `awaitSettle` and the older behaviour. That
   * fallback keeps ORDER, which is never at risk here: the queue is FIFO and
   * dispatches one at a time. What it cannot guarantee under a slow projection is
   * NON-INTERLEAVING, so a caller that needs the phase's full property supplies
   * this.
   */
  readonly expectTurn?: () => { readonly settled: Promise<void> };
  /**
   * Called when a message that was already acknowledged fails on drain. Optional.
   *
   * A caller holding a `queued-by-porch` receipt has been told the truth — porch has
   * the message durably — and has already returned. If the later dispatch fails, the
   * rejection goes to `accepted(key)`, which that caller never has to await, so
   * without this hook the only signal is that recovery re-dispatches the intent
   * after a restart. That is a real durability guarantee and a poor liveness one: a
   * long-lived process never restarts.
   *
   * `ScheduledDelivery` is exactly such a caller — it marks a row fired on a queued
   * receipt and does not await acceptance. The hook is what lets a wiring notice.
   */
  readonly onDrainError?: (error: unknown, message: OutboundMessage) => void;
}

interface QueuedItem {
  readonly message: OutboundMessage;
  readonly commandId: string;
  readonly position: number;
  /** ISO 8601, when the intent reached the disk. A duplicate send reports this one. */
  readonly queuedAt: string;
  readonly resolve: (receipt: AcceptedByServer) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * FIFO message delivery for one thread.
 *
 * `send` resolves with a {@link QueuedByPorch} receipt as soon as the intent is
 * durable, and the caller can await {@link accepted} for the server's answer. The
 * split exists because those are two different facts about two different machines
 * and the spec requires the acknowledgement to say which one it is.
 */
export class ThreadMessageQueue {
  #queue: QueuedItem[] = [];
  #draining: Promise<void> = Promise.resolve();
  #nextPosition = 1;
  /** Server answers, by idempotency key, for callers that want to await delivery. */
  #accepted = new Map<string, Promise<AcceptedByServer>>();
  /**
   * A turn THIS queue started and has not seen finish.
   *
   * Held across drain passes on purpose. The race is not confined to one pass: each
   * `send` schedules its own drain, so the second send's pass re-reads a projection
   * that the first send's dispatch has not yet updated and dispatches straight into
   * that turn. A flag re-read per iteration cannot see this; a promise the queue
   * owns can, because it does not depend on anyone else noticing anything.
   */
  #pendingTurn: Promise<void> | null = null;

  constructor(
    private readonly target: () => QueueTarget,
    private readonly dispatcher: CommandDispatcher,
    private readonly journal: DispatchJournal,
  ) {}

  /** How many messages are waiting. Zero while idle. */
  get depth(): number {
    return this.#queue.length;
  }

  /**
   * Enqueue a message and report that porch has it durably.
   *
   * The returned receipt distinguishes the two cases the spec requires to be
   * distinguishable: `queued-by-porch` when a turn was active and the message is
   * waiting on disk, `accepted-by-server` when it went straight out and the server
   * answered.
   *
   * A duplicate idempotency key never enters the queue twice — the second call
   * returns the first call's outcome. That is the local half of the idempotency
   * guarantee; the derived `commandId` is the half that survives a restart.
   */
  async send(message: OutboundMessage): Promise<SendReceipt> {
    const commandId = commandIdForKey(message.idempotencyKey);

    const existing = this.#accepted.get(message.idempotencyKey);
    if (existing) {
      // THE SAME FIX AS THE FRESH PATH BELOW, AT ITS SECOND SITE.
      //
      // `existing` only resolves when the drain dispatches, so awaiting it blocked
      // a duplicate send for the whole agent turn — and with no `awaitSettle`, for
      // good. The first send of the same key returned `queued-by-porch` immediately;
      // the second hung. Two calls, same key, same queue state, wildly different
      // behaviour, and only one of them honest.
      //
      // If the item is still in the queue then nothing has been dispatched and the
      // truthful answer is already known, so report it now rather than waiting for
      // a machine that has not been asked anything yet. The original position and
      // timestamp are reused deliberately: a duplicate is the SAME message, and a
      // receipt claiming a new position would describe a queue that does not exist.
      const queued = this.#queue.find((item) => item.commandId === commandId);
      if (queued) {
        return {
          kind: 'queued-by-porch',
          idempotencyKey: message.idempotencyKey,
          commandId,
          threadId: message.threadId,
          queuedAt: queued.queuedAt,
          position: queued.position,
        } satisfies QueuedByPorch;
      }
      return await existing;
    }
    if (journalHasDispatched(this.journal, commandId)) {
      return await sendMessage(this.dispatcher, this.journal, message);
    }

    const position = this.#nextPosition++;
    let resolve!: (receipt: AcceptedByServer) => void;
    let reject!: (error: unknown) => void;
    const answered = new Promise<AcceptedByServer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Attached so a rejection nobody awaits is not an unhandled rejection. The
    // caller that DOES await `accepted()` still sees the error.
    answered.catch(() => {});
    this.#accepted.set(message.idempotencyKey, answered);

    // Journalled BEFORE the queue admits it, so a crash here leaves an intent that
    // recovery re-dispatches rather than a message that existed only in memory.
    //
    // **The intent must be the command that will actually be sent.** This wrote its
    // own copy of the payload, and when the command type was corrected only the
    // dispatch path was. Nothing failed at the time — the journal is porch's own
    // file and takes any object — so the damage was invisible until a crash, at
    // which point recovery would replay a command the server has no branch for and
    // lose precisely the queued messages recovery exists to save.
    const command = buildMessageCommand(message);
    this.journal.recordIntent(commandId, String(command.type), command);

    const queuedAt = new Date().toISOString();
    this.#queue.push({ message, commandId, position, queuedAt, resolve, reject });

    const wasActive = this.target().isTurnActive;
    this.#scheduleDrain();

    if (wasActive) {
      return {
        kind: 'queued-by-porch',
        idempotencyKey: message.idempotencyKey,
        commandId,
        threadId: message.threadId,
        queuedAt,
        position,
      } satisfies QueuedByPorch;
    }

    // Not deferred AT SEND TIME — but it can become deferred before it is dispatched,
    // and then awaiting the server's answer would wait forever.
    //
    // No turn was active when this was queued, so the caller is owed the stronger
    // `accepted-by-server` receipt. Except that an earlier message in the same drain
    // pass may dispatch first and START a turn, and with no `awaitSettle` the drain
    // then stops with this one still queued. Nothing will resolve `answered` until
    // someone calls `flush()` again, which the caller cannot know to do because it is
    // blocked here.
    //
    // So: let the current drain pass finish, then report what is actually true. Still
    // queued means `queued-by-porch` — the weaker claim, and the honest one.
    await this.#draining;
    if (this.#queue.some((item) => item.commandId === commandId)) {
      return {
        kind: 'queued-by-porch',
        idempotencyKey: message.idempotencyKey,
        commandId,
        threadId: message.threadId,
        queuedAt,
        position,
      } satisfies QueuedByPorch;
    }
    return await answered;
  }

  /** The server's answer for a key already sent, or undefined if there is none. */
  accepted(idempotencyKey: string): Promise<AcceptedByServer> | undefined {
    return this.#accepted.get(idempotencyKey);
  }

  /**
   * Drain everything currently drainable.
   *
   * Call when a turn settles. Safe to call at any time and safe to call twice: the
   * drain is one chain, so a second call joins the running one rather than starting
   * a rival that could reorder.
   */
  async flush(): Promise<void> {
    this.#scheduleDrain();
    await this.#draining;
  }

  #scheduleDrain(): void {
    this.#draining = this.#draining.then(() => this.#drain()).catch(() => {});
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      // FIRST, and before consulting any projection: a turn we started ourselves and
      // have not seen finish. This is the only fact about the turn that is knowable
      // without waiting for the subscription to catch up.
      if (this.#pendingTurn) {
        const pending = this.#pendingTurn;
        // A displaced or failed turn is not a delivery failure — the message went
        // out. Clear it and fall through to the weaker guard below.
        await pending.catch(() => {});
        if (this.#pendingTurn === pending) this.#pendingTurn = null;
        continue;
      }

      // Re-read every iteration. A turn that starts midway through a drain must not
      // be raced by the rest of the backlog.
      if (this.target().isTurnActive) {
        const settle = this.target().awaitSettle;
        // No settle signal: stop, and the caller re-flushes. With one: wait, then
        // continue — otherwise the drain stops on the turn its OWN dispatch started
        // and the backlog never moves.
        if (!settle) return;
        await settle();
        continue;
      }

      const item = this.#queue[0];
      // Registered BEFORE the dispatch, so the turn this dispatch starts cannot
      // begin and end in the gap between sending and starting to watch.
      const expectation = this.target().expectTurn?.();
      try {
        const receipt = await sendMessage(this.dispatcher, this.journal, item.message);
        this.#queue.shift();
        item.resolve(receipt);
        // A message IS a turn start, so this dispatch started one. Recorded here
        // rather than awaited here, so a caller blocked in `send` is not held for
        // the whole turn — the next DISPATCH waits, which is what must not race.
        if (expectation) this.#pendingTurn = expectation.settled;
      } catch (error) {
        // Loud, at the call site, and OUT OF THE QUEUE — the shift is the half
        // that makes the comment true. Rejecting without removing left the failed
        // message at the head of a `while` loop that re-sent it forever: a hot
        // spin that never drains, never returns, and starves everything behind it.
        // It is also the hold-and-retry behaviour the spec says not to reproduce,
        // arrived at by accident rather than by choice.
        this.#queue.shift();
        this.#accepted.delete(item.message.idempotencyKey);
        item.reject(error);
        // The caller may have taken a `queued-by-porch` receipt and gone. Its own
        // handler must not be able to break the drain for everyone behind it.
        try {
          this.target().onDrainError?.(error, item.message);
        } catch {
          // A broken notifier is not a delivery failure.
        }
      }

    }
  }
}
