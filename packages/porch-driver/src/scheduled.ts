/**
 * Spec 146, Phase 4 — durable scheduled delivery on the thread path.
 *
 * WHY THIS IS IN PHASE 4 AND NOT PHASE 13
 *
 * Two surviving features reach the mailbox directly, and Phase 13 deletes the
 * mailbox. `servers/cron-delivery.ts` imports `db/mailbox.js` and
 * `mailbox-delivery.js`; `servers/delayed-send.ts` persists every `--delay` body as
 * a mailbox row so a pre-due message survives a Tower restart. Deleting the mailbox
 * without a replacement is a silent loss of `afx send --delay` and of every cron
 * notification — the kind of loss that is discovered by a user, months later, as
 * "the reminder never came".
 *
 * So it is designed here, where it can be tested against the properties Phase 4 is
 * already establishing, rather than improvised in the deletion phase.
 *
 * THE REQUIREMENT IS NARROW, AND DELIBERATELY SO
 *
 * A pre-due message survives a restart, fires once at its due time, and is
 * deduplicated by the same idempotency key the rest of this phase already uses.
 * That is all. This is not a general job scheduler and must not grow into one:
 * cron's *scheduling* stays where it is, and only the durable due-time delivery
 * moves here.
 *
 * EXACTLY-ONCE IS NOT ACHIEVED BY TRYING TO FIRE EXACTLY ONCE
 *
 * A crash between "dispatch" and "record that it fired" is unavoidable, and a store
 * that marked a row fired BEFORE dispatching would lose the message at exactly that
 * point — the same defect the cursor has, in the same shape, and the spec is
 * explicit that the write follows the action. So this store fires at-least-once and
 * leans on the derived `commandId`: a re-fire after a crash is the same command, and
 * the server collapses it. Exactly-once DELIVERY, at-least-once firing.
 *
 * WHAT SURVIVES A RESTART, AND WHAT DOES NOT
 *
 * The row survives; the timer does not. On construction the store re-reads its file
 * and re-arms every pending row — a row already past its due time fires immediately,
 * because a message that was due while the process was down is late, not cancelled.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CommandDispatcher, DispatchJournal } from './commands.js';
import { commandIdForKey, sendMessage, type SendReceipt } from './deliver.js';

/** A message waiting for its due time. */
export interface ScheduledMessage {
  readonly idempotencyKey: string;
  readonly threadId: string;
  readonly text: string;
  /** Epoch ms. */
  readonly dueAt: number;
  /** ISO 8601, when it was scheduled. */
  readonly scheduledAt: string;
}

type StoreRecord =
  | { readonly kind: 'scheduled'; readonly message: ScheduledMessage }
  | { readonly kind: 'fired'; readonly idempotencyKey: string; readonly at: string }
  | { readonly kind: 'cancelled'; readonly idempotencyKey: string; readonly at: string };

/**
 * The store file was damaged in a way a crash does not produce.
 *
 * Distinct from an empty file and from a torn tail, for the same reason
 * `JournalCorruptError` is: those two are ordinary, and this one means the caller
 * must not proceed as though it had read the schedule. Reporting "nothing is
 * scheduled" for a file we could not read would drop every pending message
 * silently.
 */
export class ScheduleCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    readonly detail: string,
  ) {
    super(
      `Scheduled-message store ${path} is damaged at line ${line}: ${detail}\n` +
        `  A crash leaves a partial LAST line, which is recovered silently. A ` +
        `partial line anywhere else is not something a crash produces, so it is ` +
        `reported rather than skipped.`,
    );
    this.name = 'ScheduleCorruptError';
  }
}

/**
 * An append-only, fsynced record of messages waiting for their due time.
 *
 * Same durability discipline as the dispatch journal, and for the same reason: a
 * record still in the page cache when the machine dies did not survive the crash it
 * exists for. A `--delay` message is often scheduled minutes or hours ahead, so the
 * window this protects is the whole point of the feature.
 */
export class ScheduleStore {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  #append(record: StoreRecord): void {
    this.#truncateTornTail();
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Cut a partial final line off before appending, so the next record is not glued to it. */
  #truncateTornTail(): string | null {
    if (!existsSync(this.path)) return null;
    const raw = readFileSync(this.path, 'utf-8');
    if (raw.length === 0 || raw.endsWith('\n')) return null;
    const lastNewline = raw.lastIndexOf('\n');
    const torn = raw.slice(lastNewline + 1);
    const fd = openSync(this.path, 'w');
    try {
      writeSync(fd, lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return torn;
  }

  /** Every record in order. Throws on damage that a crash does not produce. */
  read(): ReadonlyArray<StoreRecord> {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf-8');
    if (raw.length === 0) return [];

    const lines = raw.split('\n');
    // A complete file ends with '\n', so the split leaves a trailing ''. Anything
    // else there is a line a crash cut in half, which is ordinary.
    lines.pop();

    const records: StoreRecord[] = [];
    lines.forEach((line, index) => {
      if (line.length === 0) return;
      try {
        records.push(JSON.parse(line) as StoreRecord);
      } catch (error) {
        throw new ScheduleCorruptError(this.path, index + 1, (error as Error).message);
      }
    });
    return records;
  }

  /** Record a message as scheduled. */
  schedule(message: ScheduledMessage): void {
    this.#append({ kind: 'scheduled', message });
  }

  /** Record that a message fired. Written AFTER the dispatch, never before. */
  markFired(idempotencyKey: string): void {
    this.#append({ kind: 'fired', idempotencyKey, at: new Date().toISOString() });
  }

  /** Record that a message will never fire. */
  cancel(idempotencyKey: string): void {
    this.#append({ kind: 'cancelled', idempotencyKey, at: new Date().toISOString() });
  }

  /**
   * Messages that have neither fired nor been cancelled, in schedule order.
   *
   * **`afx inbox` is NOT repointed here.** An earlier draft of this comment said it
   * would be; the architect ruled the other way and the reasoning is worth keeping
   * next to the code that tempted it. Every part of that command's surface exists
   * to manage a hold — it lists messages held because the render gate could not
   * classify a screen, shows the reason, and lets a human dismiss one. On this path
   * there is no hold state, no reason code and nothing to dismiss: a send lands or
   * fails at the call site. Pointing it here would have given it rows to display
   * while removing the reason anyone ever opened it.
   *
   * `afx inbox` therefore retires WITH the mailbox in Phase 14, and its removal is a
   * release-note line because it is a command people type. Ruling and reasoning in
   * `codev/research/146-delivery-semantics-evidence.md`.
   */
  pending(): ReadonlyArray<ScheduledMessage> {
    const settled = new Set<string>();
    const scheduled = new Map<string, ScheduledMessage>();
    for (const record of this.read()) {
      if (record.kind === 'scheduled') {
        // First write wins: re-scheduling a live key must not move its due time,
        // which is what makes a duplicate schedule a no-op rather than a reset.
        if (!scheduled.has(record.message.idempotencyKey)) {
          scheduled.set(record.message.idempotencyKey, record.message);
        }
      } else {
        settled.add(record.idempotencyKey);
      }
    }
    return [...scheduled.values()].filter((m) => !settled.has(m.idempotencyKey));
  }
}

/**
 * Fires scheduled messages at their due time, across restarts.
 *
 * `start()` re-arms everything the store still lists as pending, so a process that
 * comes back up honours a schedule written by the one before it.
 */
/** How long a failed fire waits before trying again. */
const RETRY_DELAY_MS = 30_000;

export class ScheduledDelivery {
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #firing = new Map<string, Promise<SendReceipt>>();
  #started = false;

  constructor(
    private readonly store: ScheduleStore,
    private readonly dispatcher: CommandDispatcher,
    private readonly journal: DispatchJournal,
    /** Injected so tests can drive time without sleeping through a real delay. */
    private readonly now: () => number = () => Date.now(),
    /**
     * How a due message is sent. Defaults to a direct dispatch.
     *
     * **Pass the thread's queue in production.** A due time has no relationship to
     * what the thread is doing, so a scheduled message will eventually come due in
     * the middle of an active turn — and a direct `sendMessage` would interleave it
     * into that turn, breaking the one property this phase exists to establish. The
     * queue is what holds it until settle.
     *
     * The default stays direct because the store is also usable without a thread
     * (the tests drive it that way), but a caller wiring this to a real builder and
     * leaving the default has quietly opted out of queue-until-settle.
     *
     * **The return type is the union, not `AcceptedByServer`.** The queue this doc
     * comment recommends returns `queued-by-porch` whenever a turn is active, so a
     * narrower type here would be a promise this class cannot keep: it would hand
     * back a queued receipt under a type that claims the server answered, which is
     * the one distinction this phase exists to preserve. Both lanes found it by the
     * `as never` the test needed to make the narrow type compile — a cast is the
     * type system reporting a mismatch, not a way to spell it away.
     */
    private readonly send: (message: ScheduledMessage) => Promise<SendReceipt> = async (message) =>
      await sendMessage(this.dispatcher, this.journal, {
        threadId: message.threadId,
        text: message.text,
        idempotencyKey: message.idempotencyKey,
      }),
    /** Injected so the retry path can be tested without waiting out a real delay. */
    private readonly retryDelayMs: number = RETRY_DELAY_MS,
  ) {}

  /**
   * Arm every pending message.
   *
   * A row already past its due time fires immediately: it was due while the process
   * was down, which makes it late rather than cancelled.
   */
  start(): void {
    this.#started = true;
    for (const message of this.store.pending()) this.#arm(message);
  }

  /** Cancel every timer. Does not touch the store — the rows stay pending. */
  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#started = false;
  }

  /** Pending messages, oldest first. */
  pending(): ReadonlyArray<ScheduledMessage> {
    return this.store.pending();
  }

  /**
   * Schedule a message for a due time.
   *
   * Idempotent on the key: scheduling the same key twice does not create a second
   * row and does not re-arm a second timer, so the message cannot double-fire. The
   * first schedule's due time wins — a retry is a retry, not a reschedule.
   */
  schedule(message: ScheduledMessage): void {
    const alreadyPending = this.store.pending().some((m) => m.idempotencyKey === message.idempotencyKey);
    if (alreadyPending) return;
    this.store.schedule(message);
    if (this.#started) this.#arm(message);
  }

  /** Drop a pending message. It will not fire, now or after a restart. */
  cancel(idempotencyKey: string): void {
    const timer = this.#timers.get(idempotencyKey);
    if (timer) clearTimeout(timer);
    this.#timers.delete(idempotencyKey);
    this.store.cancel(idempotencyKey);
  }

  /**
   * Fire everything now due, regardless of timers.
   *
   * The path tests use, and the path a caller uses to drain on demand. Returns the
   * receipts, so "nothing was due" and "one thing fired" are distinguishable.
   *
   * **Every due message is attempted, even after one fails.** Returning on the first
   * rejection let a single unreachable thread cancel the rest of the batch, and the
   * messages it skipped were never attempted at all — they stay pending, so nothing
   * is lost, but the caller is told "the drain failed" when most of it had not been
   * tried. Due times are independent of each other; a failure of one says nothing
   * about the others.
   *
   * It still fails loudly, which is the property the phase requires: the error is
   * rethrown once every due message has had its attempt, so a caller cannot mistake
   * a partial drain for a complete one.
   */
  async fireDue(): Promise<ReadonlyArray<SendReceipt>> {
    const due = this.store.pending().filter((m) => m.dueAt <= this.now());
    const receipts: SendReceipt[] = [];
    const failures: unknown[] = [];
    for (const message of due) {
      try {
        receipts.push(await this.#fire(message));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `${failures.length} of ${due.length} due messages failed to fire`);
    }
    return receipts;
  }

  #arm(message: ScheduledMessage): void {
    if (this.#timers.has(message.idempotencyKey)) return;
    const delay = Math.max(message.dueAt - this.now(), 0);
    const timer = setTimeout(() => {
      this.#timers.delete(message.idempotencyKey);
      void this.#fire(message).catch(() => {
        // A failed fire leaves the row PENDING: it did not fire, and saying so by
        // deleting it would spell "could not send" like "sent".
        //
        // But pending is not enough on its own. The timer has already been removed
        // above, so without re-arming, "the next start() or fireDue() picks it up"
        // meant a RESTART or an external caller — a `--delay` message whose one
        // dispatch attempt failed would sit dormant in a healthy long-lived process
        // forever. That is the silent loss this store exists to prevent, arrived at
        // from the other side.
        //
        // Re-armed on a fixed retry delay rather than immediately, so a server that
        // is down does not become a hot loop. Still at-least-once: the derived
        // `commandId` makes a later success collapse with any attempt that did land.
        if (this.#started) {
          const retry = setTimeout(() => {
            this.#timers.delete(message.idempotencyKey);
            if (this.store.pending().some((m) => m.idempotencyKey === message.idempotencyKey)) {
              this.#arm({ ...message, dueAt: this.now() });
            }
          }, this.retryDelayMs);
          retry.unref?.();
          this.#timers.set(message.idempotencyKey, retry);
        }
      });
    }, delay);
    // Never hold the process open for a message that can wait for the next start().
    timer.unref?.();
    this.#timers.set(message.idempotencyKey, timer);
  }

  async #fire(message: ScheduledMessage): Promise<SendReceipt> {
    const inFlight = this.#firing.get(message.idempotencyKey);
    if (inFlight) return await inFlight;

    const attempt = (async () => {
      const receipt = await this.send(message);
      // AFTER the send resolves. Marking it fired first would lose the message at
      // exactly the crash window this store exists to survive.
      //
      // What "the send resolved" means depends on the wiring, and the earlier
      // comment here claimed the stronger of the two. Direct dispatch: the server
      // answered. Through the queue: the intent is fsynced to the command journal
      // and the message is admitted, which may be well before the server sees it.
      //
      // Marking fired on a queued receipt is still correct, because durability has
      // MOVED rather than been skipped — `recoverPendingCommands` replays the queued
      // intent under the same derived `commandId`, so a crash re-delivers it once.
      // What it does mean is that this store's own retry path no longer covers that
      // message; the queue owns it from here. Said plainly because the receipt kind
      // is the only thing that distinguishes the two cases at runtime.
      this.store.markFired(message.idempotencyKey);
      return receipt;
    })();

    this.#firing.set(message.idempotencyKey, attempt);
    try {
      return await attempt;
    } finally {
      this.#firing.delete(message.idempotencyKey);
    }
  }

  /** The `commandId` a scheduled key will dispatch under. Exposed for evidence. */
  static commandIdFor(idempotencyKey: string): string {
    return commandIdForKey(idempotencyKey);
  }
}
