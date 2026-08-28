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
import type { T3Client } from './client.js';

/** One connection's worth of transport: a live client, already authenticated. */
export interface SubscriptionTransport {
  readonly client: T3Client;
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

export class ResumingSubscription {
  #cursor: SequenceCursor;
  #stopped = false;
  #attempt = 0;
  #everSubscribed = false;
  #transport: SubscriptionTransport | null = null;

  constructor(
    /** Opens a fresh, authenticated transport. Called again after every drop. */
    private readonly connect: () => Promise<SubscriptionTransport>,
    private readonly options: ResumingSubscriptionOptions,
  ) {
    this.#cursor = new SequenceCursor(options.startAfter ?? 0, options.persist);
  }

  /** The last sequence whose handler completed. Safe to resume from. */
  get applied(): number {
    return this.#cursor.applied;
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
      const resuming = this.#everSubscribed || (this.options.startAfter ?? 0) > 0;
      const payload: Record<string, unknown> = {
        ...this.options.payload,
        requestCompletionMarker: true,
        ...(resuming ? { afterSequence: this.#cursor.applied } : {}),
      };

      const catchUp: SequencedItem[] = [];
      let snapshot: unknown | null = null;
      let synchronized = false;
      const requestedAfter = this.#cursor.applied;

      // Applying inside the stream handler, not after it: the values must reach
      // the handler in arrival order, and the cursor must move only behind them.
      const pending: Array<Promise<void>> = [];

      try {
        await transport.client.stream(this.options.method, payload, (value) => {
          if (this.options.isSynchronized(value)) {
            if (!synchronized) {
              synchronized = true;
              this.#everSubscribed = true;
              this.options.onResume(
                resuming
                  ? classifyResume(requestedAfter, catchUp, snapshot)
                  : // Not a resume: report what arrived without pretending the
                    // snapshot was a failure to replay something we never asked for.
                    { kind: 'replayed', items: catchUp, lastSequence: this.#cursor.applied, duplicatesDropped: 0 },
                { attempt: this.#attempt, resumed: resuming },
              );
            }
            return;
          }

          if (this.options.isSnapshot(value)) {
            snapshot = value;
            pending.push(Promise.resolve(this.options.onValue(value, null)));
            return;
          }

          const sequence = this.options.sequenceOf(value);
          if (sequence === null) {
            pending.push(Promise.resolve(this.options.onValue(value, null)));
            return;
          }

          if (!synchronized) catchUp.push({ sequence });

          // Already applied. t3code overlaps deliberately; re-running an
          // idempotent handler is harmless but pointless, and skipping it keeps
          // the cursor monotonic.
          if (sequence <= this.#cursor.applied) return;

          pending.push(
            this.#cursor.apply({ sequence }, () => this.options.onValue(value, sequence)),
          );
        });
      } catch {
        // The socket dropped or the server ended the stream. Either way the
        // subscription is over and the loop opens a new one — unless stopped.
      } finally {
        await Promise.allSettled(pending);

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

      // A timer, not a microtask. See `delayBetweenAttemptsMs`.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.options.delayBetweenAttemptsMs ?? 0),
      );
    }
  }
}
