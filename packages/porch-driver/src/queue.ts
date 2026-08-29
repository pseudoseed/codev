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
}

interface QueuedItem {
  readonly message: OutboundMessage;
  readonly commandId: string;
  readonly position: number;
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
    if (existing) return await existing;
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
    this.journal.recordIntent(commandId, 'thread.message.send', {
      type: 'thread.message.send',
      commandId,
      threadId: message.threadId,
      idempotencyKey: message.idempotencyKey,
      message: { role: 'user', text: message.text },
    });

    const queuedAt = new Date().toISOString();
    this.#queue.push({ message, commandId, position, resolve, reject });

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

    // Not deferred: the caller gets the server's own answer, which is a stronger
    // claim and must only be made when it is true.
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
      try {
        const receipt = await sendMessage(this.dispatcher, this.journal, item.message);
        this.#queue.shift();
        item.resolve(receipt);
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
      }
    }
  }
}
