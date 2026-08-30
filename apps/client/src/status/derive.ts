import type {
  GateRequest,
  T3codeReachability,
  ThreadIdentity,
} from '../connection/types.js';

/**
 * What a row is doing.
 *
 * `unknown` is a first-class outcome, not a fallback. "I could not observe the
 * session" and "the session is settled" are different facts with different
 * remedies, and spelling them the same way is the defect this client exists to
 * avoid — so `unknown` always carries `why`.
 */
export type RowStatusKind = 'blocked' | 'turning' | 'working' | 'settled' | 'unknown';

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
  unknown: 'UNKNOWN',
};

export function statusWord(status: RowStatus): string {
  return status.kind === 'blocked' && status.gate ? `GATE ${status.gate.toUpperCase()}` : WORD[status.kind];
}

/**
 * t3code's own session vocabulary, mapped to ours.
 *
 * An unrecognised value is NOT quietly bucketed as working. A server newer than
 * this client would then be reported as running while it was doing something
 * this build has no word for.
 */
function fromSessionState(sessionState: string): RowStatus {
  switch (sessionState) {
    case 'settled':
      return { kind: 'settled' };
    case 'running':
    case 'turning':
      return { kind: 'turning' };
    case 'starting':
    case 'ready':
      return { kind: 'working' };
    default:
      return {
        kind: 'unknown',
        why: `the server reported session state "${sessionState}", which this client does not recognise`,
        whyIsRowSpecific: true,
      };
  }
}

function sessionUnobservable(t3code: T3codeReachability): RowStatus {
  if (t3code === 'unreachable') {
    return { kind: 'unknown', why: 'this machine cannot reach t3code, so session state is unknown' };
  }
  if (t3code === 'not-provided') {
    return { kind: 'unknown', why: 'this server is not reporting session state' };
  }
  return {
    kind: 'unknown',
    why: 't3code returned no state for this thread',
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
export function deriveRowStatus(identity: ThreadIdentity, t3code: T3codeReachability): RowStatus {
  const gate = pendingGate(identity);
  if (gate) return gate;
  if (identity.sessionState !== undefined) return fromSessionState(identity.sessionState);
  return sessionUnobservable(t3code);
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
