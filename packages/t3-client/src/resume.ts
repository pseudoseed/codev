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
 *   contiguous  the requested range arrived intact
 *   gap         the server answered with something else (a snapshot, or a range
 *               starting later than we asked) — we do NOT know what we missed
 *   empty       the server had nothing after our cursor, which is ordinary
 *
 * `gap` and `empty` must never be spelled the same way. An empty result means
 * "nothing happened"; a gap means "something happened and we cannot see what". This
 * project has spent a phase on defects where those two collapsed into one another.
 */

/** A stream item carrying a sequence number, as t3code emits them. */
export interface SequencedItem {
  readonly sequence: number;
  readonly [key: string]: unknown;
}

export type ResumeOutcome =
  | {
      readonly kind: 'contiguous';
      /** Items from `afterSequence + 1` upward, in order, with no holes. */
      readonly items: ReadonlyArray<SequencedItem>;
      readonly lastSequence: number;
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

  if (items.length === 0) {
    // Ordinary. The cursor stays where it was.
    return { kind: 'empty', lastSequence: afterSequence };
  }

  const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0].sequence;

  if (first !== afterSequence + 1) {
    return {
      kind: 'gap',
      requestedAfter: afterSequence,
      firstReceived: first,
      snapshot: null,
      items: sorted,
      reason:
        `requested events after ${afterSequence} but the first received was ${first}; ` +
        `${first - afterSequence - 1} event(s) are missing`,
    };
  }

  // Holes in the middle are as much a gap as a late start.
  for (let i = 1; i < sorted.length; i += 1) {
    const expected = sorted[i - 1].sequence + 1;
    if (sorted[i].sequence !== expected) {
      return {
        kind: 'gap',
        requestedAfter: afterSequence,
        firstReceived: first,
        snapshot: null,
        items: sorted,
        reason: `sequence jumped from ${sorted[i - 1].sequence} to ${sorted[i].sequence}`,
      };
    }
  }

  return {
    kind: 'contiguous',
    items: sorted,
    lastSequence: sorted[sorted.length - 1].sequence,
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
