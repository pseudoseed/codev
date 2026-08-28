/**
 * Spec 146, Phase 2 — resubscription by sequence, and gap detection.
 *
 * The spec's claim is that no completion event is lost on reconnect: the spike
 * dropped a socket mid-turn at sequence 45, resubscribed with `afterSequence: 45`,
 * and got 46-54 matching the control connection exactly. This module is where that
 * observation becomes a tested property rather than a thing that happened once.
 *
 * THE POINT OF THIS FILE IS THE THIRD ANSWER.
 *
 * The spec is explicit: if `afterSequence` replay returns a snapshot instead of the
 * requested range, porch treats it as a gap, reconciles from the snapshot, and logs
 * it — it never assumes continuity. So a resubscription has three outcomes, not two:
 *
 *   replayed  the server honoured the cursor and replayed from it
 *   gap       the server answered with something else (a snapshot, or a range we
 *             cannot trust) — we do NOT know what we missed
 *   empty     the server had nothing after our cursor, which is ordinary
 *
 * `gap` and `empty` must never be spelled the same way. An empty result means
 * "nothing happened"; a gap means "something happened and we cannot see what".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE CANNOT DETECT, AND WHY THE FIRST OUTCOME IS NOT CALLED
 * "CONTIGUOUS"
 *
 * t3code's sequence is a **single global counter**, not a per-thread one.
 * `orchestration_events` has one `sequence` column and the resume query is
 * `WHERE sequence > ? ORDER BY sequence ASC` across every aggregate
 * (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:160-181`);
 * `apps/server/src/ws.ts:1498-1508` then filters that global stream down to the
 * one thread you subscribed to.
 *
 * So on any server with more than one active thread, a **correct** replay of
 * thread events after 45 looks like `48, 51, 52`. The intervening numbers belong
 * to other threads. There is no hole there, and nothing in the response
 * distinguishes that from a response where our own 49 was genuinely dropped.
 *
 * An earlier version of this file asserted `first === afterSequence + 1` and
 * walked the list demanding `previous + 1`. Both are arithmetic on a counter that
 * was never per-thread. It passed its unit tests, which fed it consecutive
 * integers, and it passed the live run, which had exactly one active thread. On a
 * real multi-thread server it would have reported `gap` on every healthy resume,
 * and porch would have reconciled from snapshots forever.
 *
 * The honest statement is therefore: **a lost event inside a replayed range is
 * not detectable from the sequence numbers alone, and this module does not claim
 * to detect it.** What is detectable is the protocol-level fact that the server
 * declined the cursor and sent a snapshot instead — which is the case the spec
 * actually names, and the case that loses events in bulk. Detecting a single
 * dropped event needs a second source: the spike compared `eventId` lists against
 * a control connection, which is what Phase 3's exit conditions do.
 *
 * `replayed` means "the server honoured the cursor". It does not mean "nothing
 * was lost", and no call site may read it that way.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A stream item carrying a sequence number, as t3code emits them. */
export interface SequencedItem {
  readonly sequence: number;
  readonly [key: string]: unknown;
}

export type ResumeOutcome =
  | {
      /**
       * The server replayed from the cursor. See the header: this is NOT a claim
       * that the range is hole-free — that is not knowable here.
       */
      readonly kind: 'replayed';
      /** Items strictly after `afterSequence`, in ascending order. */
      readonly items: ReadonlyArray<SequencedItem>;
      readonly lastSequence: number;
      /**
       * Items at or below the cursor that were dropped as already-applied.
       * t3code overlaps deliberately — "overlapping events are deduped by
       * sequence on the client" (`ws.ts:1481`) — so this is ordinary, and it is
       * reported rather than hidden because a caller with a persisted cursor
       * wants to know its replay overlapped.
       */
      readonly duplicatesDropped: number;
    }
  | {
      readonly kind: 'empty';
      /** The cursor is unchanged; the server had nothing newer. */
      readonly lastSequence: number;
    }
  | {
      readonly kind: 'gap';
      /**
       * What we asked to resume after, and what we actually got. Both are needed
       * to reconcile, and neither is guessable from the other.
       */
      readonly requestedAfter: number;
      readonly firstReceived: number | null;
      /** Present when the server answered with a snapshot rather than a range. */
      readonly snapshot: unknown | null;
      readonly items: ReadonlyArray<SequencedItem>;
      readonly reason: string;
    };

/**
 * Classify what came back from a resubscription.
 *
 * `snapshotSeen` is passed separately rather than sniffed out of `items`, because
 * "the server sent a snapshot" is a fact about the *protocol exchange*, not about
 * the item shapes, and inferring it from the payload would be guessing.
 *
 * The server reaches the snapshot path in two ways, both worth forcing in a test
 * (`ws.ts:1493-1526`): the replay gap exceeds `THREAD_RESUME_MAX_GAP` (1,000), or
 * the cursor is **ahead** of the server's head — which is what porch sees when
 * the server's database is restored from a backup while porch's cursor survives.
 */
export function classifyResume(
  afterSequence: number,
  items: ReadonlyArray<SequencedItem>,
  snapshotSeen: unknown | null = null,
): ResumeOutcome {
  if (snapshotSeen !== null) {
    return {
      kind: 'gap',
      requestedAfter: afterSequence,
      firstReceived: items.length > 0 ? items[0].sequence : null,
      snapshot: snapshotSeen,
      items,
      reason:
        'server answered with a snapshot instead of the requested range; ' +
        'the events between the cursor and the snapshot are not recoverable from this response',
    };
  }

  // Ascending order is a guarantee of the store's query, not a hope. A response
  // that violates it is one we cannot reason about at all, so it is a gap rather
  // than something to sort into looking correct.
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].sequence < items[i - 1].sequence) {
      return {
        kind: 'gap',
        requestedAfter: afterSequence,
        firstReceived: items[0].sequence,
        snapshot: null,
        items,
        reason:
          `events arrived out of order (${items[i - 1].sequence} then ${items[i].sequence}); ` +
          `the server replays ORDER BY sequence ASC, so this response cannot be trusted as a range`,
      };
    }
  }

  // At-or-below the cursor is redelivery, which the at-least-once design expects
  // and t3code performs on purpose. Drop, count, do not flag.
  const fresh = items.filter((entry) => entry.sequence > afterSequence);
  const duplicatesDropped = items.length - fresh.length;

  if (fresh.length === 0) {
    return { kind: 'empty', lastSequence: afterSequence };
  }

  return {
    kind: 'replayed',
    items: fresh,
    lastSequence: fresh[fresh.length - 1].sequence,
    duplicatesDropped,
  };
}

/**
 * A cursor that advances only after its handler has run.
 *
 * The spec is emphatic and an earlier revision of it was wrong: persisting the
 * sequence *before* acting loses the event permanently if the process dies in
 * between, because replay resumes past it. Advancing after the handler yields
 * at-least-once delivery instead, which is why every handler must be idempotent.
 *
 * This class exists so that ordering is a property of the type rather than of
 * whoever writes the loop next.
 */
export class SequenceCursor {
  #applied: number;

  constructor(
    startAfter = 0,
    /** Called with the new value once a handler has completed. */
    private readonly persist: (sequence: number) => void | Promise<void> = () => {},
  ) {
    this.#applied = startAfter;
  }

  /** The last sequence whose handler completed. Safe to resubscribe from. */
  get applied(): number {
    return this.#applied;
  }

  /**
   * Run `handler` for an item, then advance. If the handler throws, the cursor
   * does NOT move, so the item is redelivered on the next resubscription.
   */
  async apply(item: SequencedItem, handler: (item: SequencedItem) => void | Promise<void>): Promise<void> {
    await handler(item);
    this.#applied = item.sequence;
    await this.persist(item.sequence);
  }
}
