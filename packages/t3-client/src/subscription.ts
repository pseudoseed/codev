/**
 * Spec 146, Phase 2 — a subscription that survives a dropped socket.
 *
 * `socket.ts` restores a *transport*. This restores a *subscription*, which is a
 * different and harder thing: it resubscribes with `afterSequence` at the last
 * **applied** sequence, and it classifies what came back before treating any of
 * it as continuous.
 *
 * WHY THE TWO ARE SEPARATE
 *
 * A socket that silently reconnects and resumes reading looks identical to one
 * that never dropped. The events in between are exactly what the spec says must
 * never be assumed continuous, so the reconnection is automatic and the
 * resumption is not: every resubscription produces a `ResumeOutcome` the caller
 * is handed, including the `gap` that means "something happened here and I cannot
 * tell you what".
 *
 * WHAT COUNTS AS A GAP, AND WHAT DOES NOT
 *
 * A **first** subscription sends no `afterSequence`, and the server answers with
 * a snapshot. That is correct and expected, and it is NOT a gap — there was no
 * range to lose. A gap is only meaningful when we asked to resume from somewhere
 * and the server declined. Conflating the two would report a gap on every startup
 * and train the caller to ignore them.
 *
 * ORDERING, WHICH IS THE WHOLE POINT
 *
 * The cursor advances **after** the handler completes (`SequenceCursor`), so a
 * crash between the two redelivers rather than skips. That makes delivery
 * at-least-once, and every handler passed here must be idempotent. This is the
 * spec's correction of its own earlier revision, and it is load-bearing.
 */

import { classifyResume, SequenceCursor, type ResumeOutcome, type SequencedItem } from './resume.js';

/**
 * The only thing this module needs from a client: the ability to open one stream.
 *
 * Narrowed from `T3Client` (issue #241) because the wider type overstated the
 * dependency and made it uncallable from a caller that legitimately has something
 * else. Tower shares ONE socket between commands and subscriptions, so its transport
 * has to be a thin per-attempt wrapper whose `close` cancels this attempt's request
 * id rather than the socket — a `T3Client` cannot express that, and requiring one
 * forced a cast at exactly the seam where the distinction lives.
 *
 * `T3Client` satisfies this structurally, so nothing that passed one before changes.
 */
export interface SubscriptionClient {
  stream(
    method: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    timeoutMs?: number,
    onRequestId?: (id: number) => void,
  ): Promise<unknown>;
}

/** One connection's worth of transport: a live client, already authenticated. */
export interface SubscriptionTransport {
  readonly client: SubscriptionClient;
  /** Close it. Called when the subscription stops. */
  close(): void;
}

export interface ResumingSubscriptionOptions {
  /** The streaming method, e.g. `orchestration.subscribeThread`. */
  readonly method: string;
  /** Payload minus `afterSequence` and `requestCompletionMarker`, which are ours. */
  readonly payload: Record<string, unknown>;
  /**
   * Read a sequence off a stream value, or null if it carries none.
   *
   * Injected rather than assumed: t3code wraps events as
   * `{ kind: 'event', event: { sequence, ... } }`, and a caller subscribing to
   * something else should not have to match that shape.
   */
  sequenceOf(value: unknown): number | null;
  /** True when the value is the server's snapshot frame rather than an event. */
  isSnapshot(value: unknown): boolean;
  /** True for the marker that ends the catch-up replay and begins live events. */
  isSynchronized(value: unknown): boolean;
  /** Applied to every event, in order. MUST be idempotent — delivery is at-least-once. */
  onValue(value: unknown, sequence: number | null): void | Promise<void>;
  /**
   * Called once per (re)subscription, with what the server actually returned.
   * A `gap` here is the caller's cue to reconcile; nothing reconciles silently.
   */
  onResume(outcome: ResumeOutcome, info: { readonly attempt: number; readonly resumed: boolean }): void;
  /** Where to start. 0 means "no cursor yet", so the first subscription sends none. */
  readonly startAfter?: number;
  /** Persist the cursor after each applied event. */
  persist?(sequence: number): void | Promise<void>;
  /**
   * A handler threw. **Not optional in practice**: without it a failing handler
   * is invisible, and the subscription retries it forever in silence.
   *
   * The stream is ended after this fires and the resubscription redelivers from
   * the last successfully applied sequence, so the failed event comes back.
   */
  onHandlerError?(error: unknown, sequence: number | null): void;
  /**
   * Should this stream error be retried by resubscribing?
   *
   * The default treats a **known** protocol or validation failure as terminal —
   * `PayloadShapeError`, `RpcFailureError`, and the codegen errors — and retries
   * everything else. That is a deny-list, and the weaker of the two directions on
   * purpose: an unrecognised error on a socket is far more often a transport
   * hiccup than a contract violation, and retrying a terminal error wastes time
   * while terminating a transient one strands the subscription. A caller that
   * wants the stricter allow-list passes its own.
   */
  isRetryable?(error: unknown): boolean;
  /**
   * Pause between resubscription attempts. Default 0, which is still a *timer*
   * rather than a microtask, and that distinction is load-bearing.
   *
   * The loop resubscribes as soon as a stream ends. A server that ends the stream
   * immediately — or a test whose script runs out — then produces a loop that
   * only ever awaits already-resolved promises. Those are microtasks, so the
   * event loop never reaches the timer queue: `stop()` scheduled on a timer can
   * never run, and the process spins at 100% until it is killed. That happened,
   * and it took a test worker with it.
   *
   * So every iteration ends on a `setTimeout`, even at zero.
   */
  readonly delayBetweenAttemptsMs?: number;
}

/**
 * Errors that resubscribing cannot fix.
 *
 * Matched by `name` rather than by `instanceof`, so this module does not have to
 * import the error classes and create a dependency cycle, and so an error that
 * crossed a realm boundary still classifies.
 */
const TERMINAL_ERROR_NAMES = new Set([
  'PayloadShapeError',
  'RpcFailureError',
  'UnresolvedRefError',
  'UnsupportedKeywordError',
  // Both say the connection cannot be read, not that it was lost. Resubscribing
  // re-runs the same decode against the same server and fails the same way, so
  // retrying turns a protocol fault into a quiet loop -- the behaviour iteration
  // 1 removed for validation errors, reintroduced by iteration 2's own new
  // failure paths.
  'ProtocolError',
  'MalformedFrameError',
]);

const defaultIsRetryable = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name !== 'string' || !TERMINAL_ERROR_NAMES.has(name);
};

/** Thrown from `run()` when a stream failed with something resubscribing cannot fix. */
export class SubscriptionTerminatedError extends Error {
  constructor(readonly reason: unknown) {
    super(
      `t3code subscription ended on a non-retryable error: ` +
        `${(reason as Error)?.name ?? 'unknown'}: ${(reason as Error)?.message ?? String(reason)}\n` +
        `  Resubscribing would produce the same failure, so it is surfaced here rather than ` +
        `turned into a reconnect loop that looks like a quiet connection.`,
    );
    this.name = 'SubscriptionTerminatedError';
  }
}

export class ResumingSubscription {
  #cursor: SequenceCursor;
  #stopped = false;
  #attempt = 0;
  #everSubscribed = false;
  #emptyStreak = 0;
  #transport: SubscriptionTransport | null = null;

  constructor(
    /** Opens a fresh, authenticated transport. Called again after every drop. */
    private readonly connect: () => Promise<SubscriptionTransport>,
    private readonly options: ResumingSubscriptionOptions,
  ) {
    this.#cursor = new SequenceCursor(options.startAfter ?? 0, (value) => options.persist?.(value));
  }

  /** The last sequence whose handler completed. Safe to resume from. */
  get applied(): number {
    return this.#cursor.applied;
  }

  /**
   * Move the cursor FORWARD after reconciling a gap out of band.
   *
   * The caller reconciles from the snapshot it was handed, then calls this. A
   * lower value is refused, because a stale snapshot arriving late must not walk
   * the cursor back over events already applied.
   *
   * This is the wrong method for a cursor that is AHEAD of the server's head —
   * see `resetTo`. That case needs a backwards move by construction, and this
   * method's early return made it a silent no-op.
   */
  reconcileTo(sequence: number): void {
    if (sequence <= this.#cursor.applied) return;
    this.#cursor = new SequenceCursor(sequence, (value) => this.options.persist?.(value));
    void this.options.persist?.(sequence);
  }

  /**
   * Reset the cursor to a reconciled position, in either direction.
   *
   * `ws.ts:1492-1526` computes `replayGap = headSequence - afterSequence` and
   * takes the snapshot path when that gap is negative — a cursor AHEAD of the
   * server's head, which is what a restore or rollback of the server's database
   * produces. Recovering from it means moving the cursor **down**, so
   * `reconcileTo` cannot do it: every candidate value is below `applied` and its
   * early return makes the call a no-op.
   *
   * The consequence was worse than a failed recovery. `queuedThrough` starts each
   * attempt at `applied`, so with the cursor stuck at a huge value every live
   * event the restored server emits is discarded as already-queued — no
   * `onValue`, no `onHandlerError`, no second gap, because the stream is
   * synchronized and healthy. One gap reported, then permanent silence that looks
   * like a quiet thread. "I could not tell" spelled exactly like "nothing
   * happened", in the module written to keep those apart.
   *
   * Separate from `reconcileTo` and deliberately named, because a backwards move
   * must be something a caller chooses, never something a late snapshot does to
   * it by accident.
   */
  resetTo(sequence: number): void {
    this.#cursor = new SequenceCursor(sequence, (value) => this.options.persist?.(value));
    // Persisted here, not left to the next applied event: a reconciled position
    // that dies with the process is not a recovery, it is the same snapshot cycle
    // again on restart.
    void this.options.persist?.(sequence);
    // End the stream in flight. `queuedThrough` is derived from `applied` when the
    // attempt opens, so a stream running under the old cursor goes on discarding
    // everything below it no matter what the cursor now says.
    this.#transport?.close();
  }

  /** Stop reconnecting and close the current transport. Idempotent. */
  stop(): void {
    this.#stopped = true;
    this.#transport?.close();
    this.#transport = null;
  }

  /**
   * Subscribe, and keep resubscribing across drops until `stop()`.
   *
   * Resolves when stopped. Rejects when `connect` rejects, because a transport we
   * cannot open is not something to retry silently at this layer — `ManagedSocket`
   * owns the backoff, and stacking a second retry loop here would hide it.
   */
  async run(): Promise<void> {
    while (!this.#stopped) {
      this.#attempt += 1;
      const transport = await this.connect();
      // `connect` can take a while (backoff, a fresh ticket), and `stop()` may
      // have landed during it. Without this the subscription opens one more
      // stream after being told to stop, on a socket the caller believes is shut.
      if (this.#stopped) {
        transport.close();
        return;
      }
      this.#transport = transport;

      // A first subscription sends no cursor and gets a snapshot, which is
      // correct rather than a gap. Only a resume can produce one.
      //
      // `#cursor.applied > 0` is part of the test, not just `#everSubscribed`: a
      // first attempt that applied events and then dropped BEFORE synchronizing
      // has a real cursor, and re-subscribing without it would pull a whole
      // snapshot to redeliver events we already applied. Gating only on
      // synchronization would throw that cursor away.
      const resuming =
        this.#everSubscribed || this.#cursor.applied > 0 || (this.options.startAfter ?? 0) > 0;
      const payload: Record<string, unknown> = {
        ...this.options.payload,
        requestCompletionMarker: true,
        ...(resuming ? { afterSequence: this.#cursor.applied } : {}),
      };

      const catchUp: SequencedItem[] = [];
      let streamFailure: unknown | null = null;
      let snapshot: unknown | null = null;
      let synchronized = false;
      const requestedAfter = this.#cursor.applied;

      // Handlers run one at a time, in arrival order, on a single chain.
      //
      // The stream callback is synchronous but `onValue` may be async, so
      // firing each one as it arrives lets event N+1's handler start before N's
      // finishes — and then the cursor lands on whichever resolves last, which
      // is not necessarily the highest. An earlier version of this file
      // collected the promises in an array and claimed arrival order in a
      // comment. Collecting is not sequencing.
      let chain: Promise<void> = Promise.resolve();

      // Set the moment a handler fails. Everything after it is refused: no
      // further handlers run, the cursor does not move, and the stream is ended
      // so the resubscription redelivers from the last SUCCESSFULLY applied
      // sequence.
      //
      // The version this replaces swallowed every rejection and let the queue
      // carry on. Event 10's handler throwing while 11 succeeded advanced the
      // cursor to 11, so 10 was gone permanently and nothing anywhere said so —
      // which broke exactly the at-least-once property three separate comments in
      // this repo claim, and that Phase 3's crash recovery is built on. Both
      // review lanes found it independently; one reproduced it.
      let handlerFailure: { error: unknown; sequence: number | null } | null = null;

      const enqueue = (work: () => void | Promise<void>, sequence: number | null) => {
        chain = chain.then(async () => {
          if (handlerFailure) return;
          try {
            await work();
          } catch (error) {
            handlerFailure = { error, sequence };
            this.options.onHandlerError?.(error, sequence);
            // End the stream. The loop will resubscribe from `cursor.applied`,
            // which has NOT moved past the failed event.
            transport.close();
          }
        });
      };

      // Advances at ENQUEUE time, ahead of the cursor, which advances only when a
      // handler completes. Testing duplicates against the cursor would re-apply an
      // event that is already queued but not yet run.
      let queuedThrough = this.#cursor.applied;

      try {
        await transport.client.stream(this.options.method, payload, (value) => {
          if (this.options.isSynchronized(value)) {
            if (!synchronized) {
              synchronized = true;
              this.#everSubscribed = true;
              // Computed here, delivered behind the handler chain. `catchUp`
              // stops growing once `synchronized` is set (see below), so the
              // outcome is final at this point -- but the handlers it describes
              // have only been QUEUED. Reporting a `gap` before the snapshot
              // handler has run lets a caller call `reconcileTo()` against data
              // that was never applied, and if that handler then fails the
              // cursor has already moved past it. That is the same at-least-once
              // violation iteration 1 fixed, one layer up.
              const resumeOutcome = resuming ? classifyResume(requestedAfter, catchUp, snapshot) : null;
              const meta = { attempt: this.#attempt, resumed: resuming };
              enqueue(
                () =>
                  this.options.onResume(
                    resumeOutcome ??
                      // Not a resume: report what arrived without pretending the
                      // snapshot was a failure to replay something we never asked
                      // for. `applied` is read HERE, not at synchronization, or it
                      // reports 0 while the handlers that move it are still queued.
                      {
                        kind: 'replayed' as const,
                        items: catchUp,
                        lastSequence: this.#cursor.applied,
                        duplicatesDropped: 0,
                      },
                    meta,
                  ),
                null,
              );
            }
            return;
          }

          if (handlerFailure) return;

          if (this.options.isSnapshot(value)) {
            snapshot = value;
            enqueue(() => this.options.onValue(value, null), null);
            return;
          }

          const sequence = this.options.sequenceOf(value);
          if (sequence === null) {
            enqueue(() => this.options.onValue(value, null), null);
            return;
          }

          if (!synchronized) catchUp.push({ sequence });

          // Already applied or already queued. t3code overlaps deliberately;
          // re-running an idempotent handler is harmless but pointless, and
          // skipping it keeps the cursor monotonic.
          if (sequence <= queuedThrough) return;
          queuedThrough = sequence;

          enqueue(
            () => this.#cursor.apply({ sequence }, () => this.options.onValue(value, sequence)),
            sequence,
          );
        });
      } catch (error) {
        // The socket dropped, the server ended the stream, or the request failed.
        // Only the first is something resubscribing can fix.
        //
        // The version this replaces caught everything and looped. A
        // PayloadShapeError or an RpcFailureError became an endless reconnect
        // that looked like a quiet connection, and the named error this phase
        // went to the trouble of producing never reached anyone.
        const retryable = (this.options.isRetryable ?? defaultIsRetryable)(error);
        if (!retryable) streamFailure = error;
      } finally {
        // Drain the chain, so the cursor reflects every handler that ran before
        // the next resubscription reads it.
        await chain;

        // A stream that ended before synchronizing produced no outcome at all,
        // so the caller heard nothing — neither success nor gap. Silence is the
        // one answer that must never be available: the events between the cursor
        // and wherever the server stopped are exactly what we cannot account for.
        if (!synchronized) {
          this.options.onResume(
            {
              kind: 'gap',
              requestedAfter,
              firstReceived: catchUp.length > 0 ? catchUp[0].sequence : null,
              snapshot,
              items: catchUp,
              reason:
                'the stream ended before the server signalled that catch-up was complete, ' +
                'so whether the requested range arrived in full is unknown',
            },
            { attempt: this.#attempt, resumed: resuming },
          );
        }

        transport.close();
        this.#transport = null;
      }

      if (streamFailure !== null) throw new SubscriptionTerminatedError(streamFailure);

      // Two shapes spin, and the first version of this guard only covered one.
      //
      //  - A stream that delivered nothing and never synchronized: resubscribe,
      //    get nothing, resubscribe.
      //  - A stream whose HANDLER failed. That one delivers and synchronizes —
      //    the sync check runs before the failure guard — so resetting the streak
      //    on `synchronized` exempted exactly the path the same iteration added.
      //    Measured by a review lane at **88 reconnects in 100ms**, each one a
      //    WebSocket ticket and an upgrade against a real server.
      //
      // So a fruitless attempt is one that produced no progress OR ended in a
      // handler failure. Reset only when an attempt actually got somewhere.
      const madeProgress = (synchronized || catchUp.length > 0) && handlerFailure === null;
      this.#emptyStreak = madeProgress ? 0 : this.#emptyStreak + 1;
      const backoff =
        this.#emptyStreak > 0 ? Math.min(50 * 2 ** (this.#emptyStreak - 1), 5_000) : 0;

      // A timer, not a microtask. See `delayBetweenAttemptsMs`.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(this.options.delayBetweenAttemptsMs ?? 0, backoff)),
      );
    }
  }
}
