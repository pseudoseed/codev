import type {
  GateRequest,
  T3codeObservation,
  T3codeReachability,
  ThreadIdentity,
  ThreadSessionState,
} from '../connection/types.js';

/**
 * What a row is doing.
 *
 * `unknown` is a first-class outcome, not a fallback. "I could not observe the
 * session" and "the session is settled" are different facts with different
 * remedies, and spelling them the same way is the defect this client exists to
 * avoid — so `unknown` always carries `why`.
 */
export type RowStatusKind =
  | 'blocked'
  | 'turning'
  | 'working'
  | 'settled'
  | 'stopped'
  | 'error'
  | 'unknown';

export interface RowStatus {
  readonly kind: RowStatusKind;
  /** Present on `blocked`: the porch gate holding this row. */
  readonly gate?: string;
  readonly gateRequest?: GateRequest;
  readonly gateRequestedAt?: string;
  /** Present on `unknown`: what could not be observed, and why. */
  readonly why?: string;
  /**
   * True when `why` is about THIS row rather than about the whole server.
   *
   * A server-wide cause is stated once at the machine; repeating it under every
   * row buried the rows with something specific to say in identical text.
   */
  readonly whyIsRowSpecific?: boolean;
}

const WORD: Record<RowStatusKind, string> = {
  blocked: 'GATE',
  turning: 'TURNING',
  working: 'WORKING',
  settled: 'SETTLED',
  stopped: 'STOPPED',
  error: 'ERROR',
  unknown: 'UNKNOWN',
};

export function statusWord(status: RowStatus): string {
  return status.kind === 'blocked' && status.gate ? `GATE ${status.gate.toUpperCase()}` : WORD[status.kind];
}

/**
 * t3code's session vocabulary AND the thread's settledness, mapped to ours.
 *
 * ## Why this takes two inputs
 *
 * t3code reports a session `status` — `idle | starting | running | ready |
 * interrupted | stopped | error` — and records settledness SEPARATELY, on the
 * thread, as `settledAt` / `settledOverride`. Neither answers "is this row
 * finished" alone: a `stopped` session on a settled thread finished and was
 * reaped, and a `stopped` session on an unsettled one did not finish. An earlier
 * version of this function took one string and recognised `settled` as if it
 * were a session status. It is not one, and no t3code server ever sends it.
 *
 * ## Precedence, and why it is this order
 *
 * `error` first: a session that has failed is not working, whatever it last
 * reported, and folding it into anything else launders a crash.
 *
 * Then activity (`running`, `starting`), because a running turn is a PRESENT
 * fact and `settledAt` is a PAST one. A settled thread that has been given more
 * work is working.
 *
 * Then settledness, which is what separates a session that finished from one
 * that was stopped or is merely quiet.
 *
 * (The porch gate outranks all of this and is applied by the caller.)
 *
 * ## Two words beyond the original four
 *
 * `STOPPED` and `ERROR` exist because the alternative is folding `interrupted`,
 * `stopped` and `error` into `SETTLED` — rendering "this crashed" and "this was
 * torn down" as "this finished its work". `SETTLED` keeps meaning finished.
 *
 * An unrecognised status is still NOT bucketed. A server newer than this build
 * would otherwise be reported as running while doing something this build has no
 * word for.
 */
function fromSession(session: ThreadSessionState): RowStatus {
  if (session.status === 'error') {
    return {
      kind: 'error',
      why: session.lastError ?? 'the t3code session reported an error and gave no detail',
      whyIsRowSpecific: true,
    };
  }
  switch (session.status) {
    case 'running':
      return { kind: 'turning' };
    case 'starting':
      return { kind: 'working' };
    case 'ready':
    case 'idle':
      return session.settled ? { kind: 'settled' } : { kind: 'working' };
    case 'interrupted':
    case 'stopped':
      return session.settled
        ? { kind: 'settled' }
        : {
            kind: 'stopped',
            why: `the t3code session is ${session.status} and the thread is not settled`,
            whyIsRowSpecific: true,
          };
    default:
      return {
        kind: 'unknown',
        why: `the server reported session status "${session.status}", which this client does not recognise`,
        whyIsRowSpecific: true,
      };
  }
}

/**
 * Why no session could be read for this row.
 *
 * Every branch says something different, because each sends a reader somewhere
 * different: upgrade the server, configure one, fix the config, wait, wait for a
 * timer, check the server, or look at this one row. Collapsing any pair spells
 * two remedies with one sentence.
 *
 * The row-specific branch at the end is only reached when t3code WAS observed
 * and returned nothing for this thread — which is a fact about the thread, not
 * about the machine, and is the one case that should not repeat the machine's
 * sentence under every row.
 */
function sessionUnobservable(t3code: T3codeReachability): RowStatus {
  switch (t3code) {
    case 'not-provided':
      return { kind: 'unknown', why: 'this server is not reporting session state' };
    case 'not-configured':
      return {
        kind: 'unknown',
        why: 'this workspace has no t3code server configured, so there is no session to report',
      };
    case 'misconfigured':
      return {
        kind: 'unknown',
        why: 'this workspace\'s t3code configuration is incomplete, so no session could be observed',
      };
    case 'connecting':
      return { kind: 'unknown', why: 'this server is still connecting to t3code' };
    case 'cooling-down':
      return {
        kind: 'unknown',
        why: 'this server\'s last t3code connection failed and it is waiting before retrying',
      };
    case 'unreachable':
      return { kind: 'unknown', why: 'this machine cannot reach t3code, so session state is unknown' };
    default:
      return {
        kind: 'unknown',
        why: 't3code returned no state for this thread',
        whyIsRowSpecific: true,
      };
  }
}

/**
 * How long ago the content was observed, in words a person reads.
 *
 * Never "unknown age" silently: a missing observation is reported as such,
 * because a consumer that cannot see the age must not be allowed to assume it is
 * small.
 */
function agePhrase(observation: T3codeObservation | undefined): string {
  if (observation?.ageMs === undefined) return 'an unknown length of time ago';
  const seconds = Math.max(0, Math.round(observation.ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * The stale rule.
 *
 * A STALE SNAPSHOT NEVER DERIVES `SETTLED`. "It had finished when I last looked"
 * is not "it has finished", and the second is what a `SETTLED` stamp asserts.
 * That is the whole reason the age travels on the wire.
 *
 * Content that was ACTIVE when last seen keeps its word — a row that was turning
 * is still the best answer available, and the machine already carries the STALE
 * band that says how much to trust it. Only the finished-looking answer is
 * withheld, because only that one closes a question a reader would otherwise
 * stop asking.
 */
function stale(status: RowStatus, observation: T3codeObservation | undefined): RowStatus {
  if (status.kind !== 'settled') return status;
  return {
    kind: 'unknown',
    why: `this server stopped watching t3code; the session last looked settled ${agePhrase(observation)}`,
    whyIsRowSpecific: true,
  };
}

/**
 * PORCH WINS.
 *
 * A pending gate comes from `status.yaml`, which porch alone writes, and it
 * outranks every session signal: a thread whose session says `settled` while
 * porch holds a pending gate is blocked, not finished. t3code's titles, pins and
 * activity entries are display projections and are never consulted here.
 */
export function deriveRowStatus(
  identity: ThreadIdentity,
  t3code: T3codeReachability,
  observation?: T3codeObservation,
): RowStatus {
  const gate = pendingGate(identity);
  if (gate) return gate;
  /*
   * A ROW WITH NO THREAD IS A THIRD FACT, and today it is the COMMON one.
   *
   * Every architect and builder row in `global.db` is terminal-backed right now,
   * and a terminal-backed row has no t3code thread for a session to be attached
   * to. Without this branch such a row fell through to `sessionUnobservable` and,
   * on a machine reporting `available`, rendered "t3code returned no state for
   * this thread" — about a thread it does not have. That sends a reader to look
   * for a thread t3code lost, when nothing is wrong and nothing is missing.
   *
   * Keyed on `threadId` because that is the field a session is JOINED on
   * server-side; `backing: 'terminal'` is the same fact stated the other way and
   * the two cannot disagree in anything the registry emits.
   *
   * Row-specific, so it prints under the row rather than being mistaken for a
   * statement about the machine.
   */
  if (identity.threadId === undefined) {
    return {
      kind: 'unknown',
      why: 'this row has no t3code thread, so there is no session to observe',
      whyIsRowSpecific: true,
    };
  }
  if (identity.session === undefined) return sessionUnobservable(t3code);
  const status = fromSession(identity.session);
  return t3code === 'stale' ? stale(status, observation) : status;
}

/**
 * A gate blocks a row only once it has been REQUESTED.
 *
 * `status: 'pending'` alone does not mean a human is being waited on. Porch
 * declares a project's gates at init and they sit `pending` for its whole life:
 * every AIR project carries `gates.pr.status: pending` from its first commit.
 * The pair that means "awaiting a human" is `pending` AND `requested_at`, and
 * porch itself tests exactly that pair in four places — `next.ts` before it
 * refuses to advance, `porch status` before it prints WAITING FOR HUMAN
 * APPROVAL, and `porch pending` when it lists what is actually waiting.
 *
 * Reading `pending` alone reported two builders as blocked on a `pr` gate while
 * both were mid-implementation. A status the tree shows confidently and wrongly
 * is worse than one it declines to show.
 */
function pendingGate(identity: ThreadIdentity): RowStatus | null {
  const gates = identity.porch?.gates;
  if (!gates) return null;
  const pending = Object.entries(gates)
    .filter(([, gate]) => gate.status === 'pending' && Boolean(gate.requested_at))
    // Newest request first, then by name, so the same state always renders the
    // same row rather than following object key order.
    .sort((a, b) => {
      const at = (b[1].requested_at ?? '').localeCompare(a[1].requested_at ?? '');
      return at !== 0 ? at : a[0].localeCompare(b[0]);
    });
  if (pending.length === 0) return null;
  const [name, gate] = pending[0];
  return {
    kind: 'blocked',
    gate: name,
    ...(gate.request ? { gateRequest: gate.request } : {}),
    ...(gate.requested_at ? { gateRequestedAt: gate.requested_at } : {}),
  };
}
