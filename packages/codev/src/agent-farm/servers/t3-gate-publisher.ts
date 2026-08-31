/**
 * Spec 250, Phase 6 — porch gate state published onto the fork's thread record.
 *
 * Spec 146 wrote the gate name into the thread TITLE, because t3code had nowhere
 * else to put it. Phase 4 built the nowhere-else; this is what fills it.
 *
 * ## `status.yaml` is authoritative, always
 *
 * The block on the thread is a PROJECTION of `status.yaml` and never a second
 * copy of the truth. Any disagreement is resolved by re-reading `status.yaml` —
 * never by trusting what was last published, and never by reading the thread back
 * and reconciling. That direction is one-way on purpose: a projection that can
 * write back to its source is a second source.
 *
 * ## The publisher invents no revision
 *
 * `codev.gate.set` takes an OPTIONAL `revision`, and this module never sends one.
 * The server allocates `gateRevision + 1` and returns it. A counter held in a
 * writer's memory resets when the writer restarts, and a reset counter makes
 * every later write stale — which renders as "no gate pending" exactly where a
 * human is waiting. Not sending one is not laziness about idempotency; it is the
 * only way a restart cannot lie.
 *
 * The corollary is that on reconnect this republishes CURRENT state rather than
 * replaying what it saw while it was away. There is no history to replay: the
 * gate a human needs to see is whatever `status.yaml` says right now.
 *
 * ## Losing the question is better than losing the gate
 *
 * Codev bounds a gate request in BYTES (`GATE_REQUEST_LIMITS`); the fork bounds
 * `CodevGate` in string length. They are different limits, and the fork's are
 * tighter — a 1024-byte question is accepted by porch and can exceed the fork's
 * 500-character cap. The fork refuses an oversize gate WHOLE, because a gate that
 * partially applied would leave a human looking at half a question.
 *
 * So this module does the narrowing, and it narrows the OPTIONAL content only.
 * `gateName` and `requestedAt` are what say "a human is needed"; the question and
 * choices are what make the decision easier. Dropping the second to keep the first
 * is right, and dropping both because the second did not fit is not. Every drop is
 * named in the projection so the caller can log which content did not travel —
 * silent truncation would let a human read a shortened question as the whole one.
 */

import type { GateRequest } from '@cluesmith/codev-types';
import { watchAgentState, type StateSubscription } from './agent-state-stream.js';
import { readWorkspaceStatuses, type PorchStatusProjection, type StatusReadResult } from './status-reader.js';

/** The RPC the fork exposes for gate writes. Its own method, with its own scope. */
export const GATE_WRITE_METHOD = 'codev.gateWrite';

/**
 * The fork's `CodevGate` bounds, in string length.
 *
 * Copied from `packages/contracts/src/orchestration.ts` in the fork rather than
 * imported: the vendored contract carries the JSON Schema, and the emitter drops
 * the `TrimmedNonEmptyString` checks behind its transform (`generated/LOSSY.md`),
 * so the caps are not readable from the artifacts either. A test reads them back
 * out of the generated schema where they survive, and out of the fork source when
 * the checkout is present, so the copy is checked rather than trusted.
 */
export const T3_GATE_LIMITS = Object.freeze({
  gateName: 120,
  question: 500,
  label: 200,
  consequence: 2000,
  terminalExcerpt: 8000,
  minChoices: 1,
  maxChoices: 5,
});

export interface T3GateChoice {
  readonly label: string;
  readonly consequence: string;
  readonly recommended?: boolean;
}

/** The `CodevGate` payload, as this repository constructs it. */
export interface T3Gate {
  readonly gateName: string;
  readonly requestedAt: string;
  readonly question?: string;
  readonly choices?: ReadonlyArray<T3GateChoice>;
  readonly terminalExcerpt?: string;
}

/**
 * What `status.yaml` says the thread's gate block should be.
 *
 * `dropped` names optional content that did not fit the fork's bounds. It is
 * empty on the ordinary path and is never a failure: the gate still publishes.
 */
export type GateProjection =
  | { readonly kind: 'set'; readonly gate: T3Gate; readonly dropped: ReadonlyArray<string> }
  | { readonly kind: 'clear' };

/** True when two projections would produce the same thing on the thread. */
export function sameProjection(a: GateProjection, b: GateProjection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'clear' || b.kind === 'clear') return true;
  return JSON.stringify(a.gate) === JSON.stringify(b.gate);
}

function fits(value: string, limit: number): boolean {
  // `.length`, matching Effect's `isMaxLength`, which counts UTF-16 code units.
  // Counting bytes here would refuse content the server accepts, and counting
  // code POINTS would accept content it refuses — an emoji is one code point and
  // two units. The check has to be the server's check or it is a different check.
  return value.length <= limit;
}

/** A single-line rendering: the fork refuses a multi-line question outright. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Which gate a human is actually waiting on.
 *
 * `status.yaml` holds every gate the project has ever had, approved ones
 * included. A thread carries ONE block, so this picks the pending gate with the
 * earliest `requested_at` — earliest rather than latest, because when two are
 * somehow pending the older one is the one that has been waiting.
 *
 * Ties, and gates with no timestamp, fall back to gate NAME order. Not because
 * name order is meaningful, but because an arbitrary-but-stable choice publishes
 * the same gate on every cycle, and an unstable one makes the block flicker
 * between two gates for as long as both are pending.
 */
export function pendingGate(
  status: PorchStatusProjection,
): { readonly name: string; readonly requestedAt: string | undefined; readonly request?: GateRequest } | null {
  const pending = Object.entries(status.gates)
    .filter(([, gate]) => gate.status === 'pending')
    .map(([name, gate]) => ({ name, requestedAt: gate.requested_at, request: gate.request }));
  if (pending.length === 0) return null;
  pending.sort((a, b) => {
    const at = a.requestedAt ?? '';
    const bt = b.requestedAt ?? '';
    if (at !== bt) {
      // A gate with no timestamp sorts LAST, not first. An empty string would
      // otherwise win every comparison and make an untimestamped gate outrank a
      // real one that has been waiting for a day.
      if (at === '') return 1;
      if (bt === '') return -1;
      return at < bt ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return pending[0];
}

/**
 * Project one status file into the block the thread should carry.
 *
 * Pure. It reads `status.yaml`'s projection and returns what to publish; it does
 * not know about sockets, revisions, or what was published before.
 */
export function projectGate(status: PorchStatusProjection, now: () => string = () => new Date().toISOString()): GateProjection {
  const pending = pendingGate(status);
  if (pending === null) return { kind: 'clear' };

  const dropped: string[] = [];

  // `gateName` is the one field with no fallback. A name too long for the fork
  // cannot be shortened without changing which gate it names, so this reports the
  // gate as clear rather than publishing a gate under a name that is not its own.
  // It has never happened — porch gate names are short words — and a silent
  // truncation here would be a gate a human cannot match to their protocol.
  if (!fits(pending.name, T3_GATE_LIMITS.gateName) || pending.name.trim() === '') {
    return { kind: 'clear' };
  }

  const gate: {
    gateName: string;
    requestedAt: string;
    question?: string;
    choices?: T3GateChoice[];
    terminalExcerpt?: string;
  } = {
    gateName: pending.name,
    // A gate with no recorded timestamp still needs one on the wire: `requestedAt`
    // is required. "Now" is the honest substitute — it says the gate is pending as
    // of this publish, which is exactly what is known.
    requestedAt: pending.requestedAt ?? now(),
  };

  const request = pending.request;
  if (request) {
    const question = singleLine(request.question ?? '');
    if (question !== '' && fits(question, T3_GATE_LIMITS.question)) {
      gate.question = question;
    } else if (question !== '') {
      dropped.push(`question (${question.length} chars over the ${T3_GATE_LIMITS.question} limit)`);
    }

    const choices = (request.choices ?? []).filter(
      (choice) =>
        fits(choice.label, T3_GATE_LIMITS.label) && fits(choice.consequence, T3_GATE_LIMITS.consequence),
    );
    const overlong = (request.choices ?? []).length - choices.length;
    if (overlong > 0) dropped.push(`${overlong} choice(s) whose label or consequence was over the limit`);

    if (choices.length >= T3_GATE_LIMITS.minChoices) {
      // Truncating to the cap keeps the first N in the order porch recorded them,
      // which is the order the human was meant to read.
      const kept = choices.slice(0, T3_GATE_LIMITS.maxChoices);
      if (kept.length < choices.length) {
        dropped.push(`${choices.length - kept.length} choice(s) past the ${T3_GATE_LIMITS.maxChoices}-choice limit`);
      }
      // At most one recommendation. Two is not two recommendations, it is none,
      // and the fork refuses the whole gate for it — so the SECOND is demoted
      // rather than the gate lost. Recorded, because a choice quietly losing its
      // recommendation is a changed answer.
      let seenRecommended = false;
      gate.choices = kept.map((choice) => {
        if (choice.recommended !== true) return { label: choice.label, consequence: choice.consequence };
        if (seenRecommended) {
          dropped.push(`the "recommended" mark on "${choice.label}" (only one choice may carry it)`);
          return { label: choice.label, consequence: choice.consequence };
        }
        seenRecommended = true;
        return { label: choice.label, consequence: choice.consequence, recommended: true };
      });
    } else if ((request.choices ?? []).length > 0) {
      dropped.push('every choice was over the limit, so none could be published');
    }

    if (request.terminalExcerpt !== undefined && request.terminalExcerpt !== '') {
      if (fits(request.terminalExcerpt, T3_GATE_LIMITS.terminalExcerpt)) {
        gate.terminalExcerpt = request.terminalExcerpt;
      } else {
        // Kept, tail-first, because the end of a terminal excerpt is the part
        // that says what happened. A marker is prepended so nobody reads the
        // fragment as the whole output — that is the "could not tell" rule
        // applied to a payload rather than to a signal.
        const marker = '[…truncated for the thread gate block; see the worktree for the full output]\n';
        gate.terminalExcerpt =
          marker + request.terminalExcerpt.slice(-(T3_GATE_LIMITS.terminalExcerpt - marker.length));
        dropped.push(
          `${request.terminalExcerpt.length - T3_GATE_LIMITS.terminalExcerpt + marker.length} chars from the head of terminalExcerpt`,
        );
      }
    }
  }

  return { kind: 'set', gate, dropped };
}

/** What `publishGate` needs of a transport. Injected, so no socket is required to test it. */
export interface GateWriter {
  call(method: string, payload: unknown): Promise<unknown>;
}

/**
 * The outcome of one gate write.
 *
 * THREE ANSWERS. `unconfirmed` is not `refused` and neither is `applied`:
 *
 *   applied      the server answered with a revision. The write landed.
 *   refused      the server said no, and named a reason. Settled — retrying
 *                replays a decision that was already made.
 *   unconfirmed  the transport failed, or the response could not be read. The
 *                write may or may not have landed, and the caller must not
 *                render either. The fork spells this `CODEV_GATE_WRITE_UNCONFIRMED`
 *                for the same reason.
 */
export type GateWriteOutcome =
  | { readonly kind: 'applied'; readonly gateRevision: number; readonly cleared: boolean }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'unconfirmed'; readonly detail: string };

function readResult(value: unknown): GateWriteOutcome {
  const result = value as { threadId?: unknown; gateRevision?: unknown; cleared?: unknown } | null;
  if (
    !result
    || typeof result !== 'object'
    || typeof result.gateRevision !== 'number'
    || typeof result.cleared !== 'boolean'
  ) {
    // NOT applied. The call returned, so something happened on the server — but a
    // response this cannot read carries no revision, and reporting a write as
    // applied on the strength of "it did not throw" is how a gate that was never
    // set gets rendered as set.
    return {
      kind: 'unconfirmed',
      detail:
        `${GATE_WRITE_METHOD} answered with a shape carrying no gateRevision: `
        + `${JSON.stringify(value).slice(0, 200)}`,
    };
  }
  return { kind: 'applied', gateRevision: result.gateRevision, cleared: result.cleared };
}

/**
 * A refusal from the fork, read off the RPC error.
 *
 * `RpcFailureError` (from `@cluesmith/t3-client`) carries the domain error, and
 * `CodevGateWriteError` carries a `reason` literal. Read structurally rather than
 * by importing the client: this module is driven by an injected writer in tests
 * and must not acquire a transport dependency to classify a transport's error.
 */
function readRefusal(error: unknown): GateWriteOutcome {
  const named = error as { name?: unknown; error?: unknown; message?: unknown } | null;
  const domain = named?.error as { _tag?: unknown; reason?: unknown; detail?: unknown } | null;
  if (
    named?.name === 'RpcFailureError'
    && domain
    && typeof domain === 'object'
    && typeof domain.reason === 'string'
  ) {
    return {
      kind: 'refused',
      reason: domain.reason,
      detail: typeof domain.detail === 'string' ? domain.detail : String(named.message ?? ''),
    };
  }
  return {
    kind: 'unconfirmed',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Write one projection to a thread. Sends no revision; reads the server's.
 *
 * `commandId` is generated per call and never reused: unlike `dispatchCommand`
 * there is no journal here and no replay, because a gate write that did not land
 * is superseded by the next publish cycle rather than recovered. Re-sending an
 * old projection under an old id would resurrect a gate `status.yaml` has since
 * cleared.
 */
export async function publishGate(
  writer: GateWriter,
  threadId: string,
  projection: GateProjection,
  options: { readonly commandId?: string; readonly now?: () => string } = {},
): Promise<GateWriteOutcome> {
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  const commandId = options.commandId ?? cryptoRandomId();
  const payload =
    projection.kind === 'clear'
      ? { type: 'codev.gate.clear', commandId, threadId, createdAt }
      : { type: 'codev.gate.set', commandId, threadId, gate: projection.gate, createdAt };
  try {
    return readResult(await writer.call(GATE_WRITE_METHOD, payload));
  } catch (error) {
    return readRefusal(error);
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * One thread's published gate state, so an unchanged `status.yaml` costs nothing.
 *
 * The memory is a WRITE SUPPRESSOR and never a source of truth. It answers "have
 * I already sent exactly this?", and the only thing that may set it is a write the
 * server confirmed. A refused or unconfirmed write leaves it untouched, so the
 * next cycle sends again — which is the behaviour that makes an unconfirmed write
 * safe to have.
 *
 * `forget` exists for reconnect: a new connection has published nothing, whatever
 * this process remembers about the old one.
 */
export class GatePublisher {
  readonly #lastPublished = new Map<string, GateProjection>();

  constructor(
    private readonly writer: GateWriter,
    private readonly onDropped?: (threadId: string, dropped: ReadonlyArray<string>) => void,
  ) {}

  /** Drop every memory of what has been published. Call on reconnect. */
  forget(): void {
    this.#lastPublished.clear();
  }

  /**
   * Publish one thread's gate, unless the identical projection already landed.
   *
   * Returns `null` when nothing was sent, which is distinct from every outcome —
   * "no write was needed" and "the write succeeded" are different facts and a
   * caller counting publishes must be able to tell them apart.
   */
  async publish(
    threadId: string,
    status: PorchStatusProjection,
    options: { readonly force?: boolean } = {},
  ): Promise<GateWriteOutcome | null> {
    const projection = projectGate(status);
    const previous = this.#lastPublished.get(threadId);
    if (!options.force && previous && sameProjection(previous, projection)) return null;

    if (projection.kind === 'set' && projection.dropped.length > 0) {
      this.onDropped?.(threadId, projection.dropped);
    }
    const outcome = await publishGate(this.writer, threadId, projection);
    // ONLY a confirmed write updates the memory. A refusal is settled for THIS
    // write and says nothing about what the thread now carries — the server may
    // have rejected a stale revision from another writer — and an unconfirmed one
    // says nothing at all. Recording either would suppress the retry.
    if (outcome.kind === 'applied') this.#lastPublished.set(threadId, projection);
    return outcome;
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * The publish cycle, driven by the watch that already notices `status.yaml`.
 *
 * `status-reader.ts` is a reader with no cycle of its own, so the publisher
 * needed a lifecycle naming rather than assuming one. `watchAgentState` is that
 * lifecycle and it is reused rather than reimplemented: it already carries the
 * debounce, the fingerprint over every artifact root, the 5s reconcile backstop
 * for the macOS FSEvents arming window, and a distinct signal for a watch that
 * failed to arm. A second watcher here would be a second set of all four, wrong
 * in a different way.
 *
 * ## Why this lives with the connection
 *
 * It is started where the t3code socket is, and torn down with it. That is what
 * makes "on reconnect it republishes current state" true without any code that
 * knows about reconnects: a new connection builds a new `GatePublisher`, which
 * remembers nothing, so the first cycle after it republishes everything. A
 * publisher that outlived its socket would remember writes confirmed by a server
 * it is no longer talking to.
 *
 * ## What it does NOT do
 *
 * It never reads the thread back. `status.yaml` is authoritative and the block is
 * a projection of it; reconciling in the other direction would make the thread a
 * second source of truth for a question the file already answers.
 */
export interface GateWatchOptions {
  readonly workspaceRoot: string;
  readonly writer: GateWriter;
  /** Injected so a test drives the cycle without a filesystem. */
  readonly readStatuses?: (workspaceRoot: string) => ReadonlyArray<StatusReadResult>;
  readonly builderWorktrees?: (workspaceRoot: string) => ReadonlyArray<string>;
  readonly log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
}

export interface GateWatch {
  close(): void;
  /** Run one cycle now. Returns what was written, for a caller that wants to know. */
  publishNow(): Promise<ReadonlyArray<{ readonly threadId: string; readonly outcome: GateWriteOutcome }>>;
}

export function startGateWatch(options: GateWatchOptions): GateWatch {
  const log = options.log ?? (() => {});
  const publisher = new GatePublisher(options.writer, (threadId, dropped) => {
    // Reported at WARN because it is content a human was meant to read and will
    // not. It is not an error: the gate published, which is the part that matters.
    log(
      'WARN',
      `Gate block for thread ${threadId} published without some content the fork would refuse: `
      + `${dropped.join('; ')}. status.yaml still carries all of it.`,
    );
  });
  const readStatuses = options.readStatuses
    ?? ((root: string) => readWorkspaceStatuses(root, [...(options.builderWorktrees?.(root) ?? [])]));

  const cycle = async () => {
    const written: Array<{ threadId: string; outcome: GateWriteOutcome }> = [];
    for (const result of readStatuses(options.workspaceRoot)) {
      // A status that could not be read publishes NOTHING. Clearing the block on
      // an unreadable file would spell "I could not read status.yaml" exactly like
      // "no gate is pending" — on the one thread where a human may be waiting.
      if (!result.ok) continue;
      const threadId = result.status.threadId;
      // No join key, no thread to publish onto. Not an error: `thread_id` is
      // written only for thread-backed spawns.
      if (!threadId) continue;
      const outcome = await publisher.publish(threadId, result.status);
      if (outcome === null) continue;
      if (outcome.kind !== 'applied') {
        log(
          outcome.kind === 'refused' ? 'WARN' : 'ERROR',
          `Gate write for thread ${threadId} was ${outcome.kind}: `
          + `${outcome.kind === 'refused' ? `${outcome.reason} — ${outcome.detail}` : outcome.detail}`,
        );
      }
      written.push({ threadId, outcome });
    }
    return written;
  };

  /**
   * One cycle at a time, SERIALIZED rather than skipped.
   *
   * Overlapping cycles race each other's revisions, so they must not run
   * concurrently. The first version dropped a request while one was in flight and
   * returned `[]` — which is "I did nothing" spelled exactly like "there was
   * nothing to do", and it is worse than it sounds: the watcher fires on the same
   * file change a caller is reacting to, so the dropped request was reliably the
   * caller's. Found by a test whose explicit `publishNow` silently did nothing.
   *
   * Chaining instead means every request runs, in order, after whatever is ahead
   * of it — and a cycle that finds nothing changed sends nothing, because the
   * publisher already suppresses an identical projection. A rejected predecessor
   * does not poison the chain: the next cycle re-reads `status.yaml`, which is
   * the authoritative answer regardless of what happened before it.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const runCycle = (): Promise<ReadonlyArray<{ threadId: string; outcome: GateWriteOutcome }>> => {
    const next = queue.then(cycle, cycle);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const subscription: StateSubscription = watchAgentState<ReadonlyArray<StatusReadResult>>({
    workspacePath: options.workspaceRoot,
    snapshot: () => {
      const statuses = readStatuses(options.workspaceRoot);
      return {
        payload: statuses,
        artifactRoots: [
          options.workspaceRoot,
          ...(options.builderWorktrees?.(options.workspaceRoot) ?? []),
        ],
      };
    },
    onEvent: (event) => {
      if (event.type === 'STATE_STREAM_WATCH_FAILED') {
        // Named, not swallowed. A watch that never armed still gets the 5s
        // reconcile backstop, so gates keep publishing — but on a slower cadence
        // than anyone reading the code would assume.
        log('WARN', `Gate watch could not arm on ${options.workspaceRoot}: ${event.signal?.message ?? 'no reason given'}`);
        return;
      }
      void runCycle().catch((error: unknown) => {
        log('ERROR', `Gate publish cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.reconcileMs === undefined ? {} : { reconcileMs: options.reconcileMs }),
  });

  return {
    close: () => subscription.close(),
    publishNow: runCycle,
  };
}
