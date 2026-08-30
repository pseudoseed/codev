import { machineHeaders, type MachineConfig } from '../connection/machine.js';

/**
 * The approval path, as a client walks it.
 *
 * Four requests, because four different things are established: that this
 * machine is paired, that a session was opened by a deliberate single-use mint,
 * that this session holds a capability, and that this particular gate is the one
 * being approved. Porch writes `status.yaml`; nothing here does.
 *
 * NONE OF THEM ESTABLISHES THAT A HUMAN IS PRESENT. Minting a pairing token
 * needs only write access to the pairing store, and every agent on this host
 * runs as the same user. See `codev/resources/146-approval-threat-model.md`;
 * what the chain carries instead is a stated `authority`, recorded and never
 * verified.
 */

export const HUMAN_SESSION_HEADER = 'x-codev-human-session';
export const PAIRING_TOKEN_HEADER = 'x-codev-pairing-token';

export interface HumanSession {
  readonly sessionId: string;
  /** Presented in `x-codev-human-session`. Never stored anywhere durable. */
  readonly presentation: string;
  readonly expiresAt: string;
}

export type ApprovalOutcome =
  | {
    readonly ok: true;
    readonly approvedAt: string;
    readonly machine: string;
    readonly sessionId: string | null;
    /**
     * True when the gate was ALREADY approved before this request.
     *
     * A definite, readable answer — not this session's approval. The fields
     * below describe whoever actually approved it, which may be someone else on
     * another machine, so the caller must not present it as "you approved this".
     */
    readonly alreadyApproved?: boolean;
    /** What the pairing token behind the approving capability claimed. */
    readonly authority?: string;
    /**
     * Present when the gate WAS approved and committed but the push failed.
     *
     * A success with a caveat, never a failure: telling a human their approval
     * did not happen when it did sends them to approve again, chasing a state
     * that already changed.
     */
    readonly pushFailed?: string;
  }
  | {
    readonly ok: false;
    readonly signal: string;
    readonly message: string;
    /**
     * The server answered, and this client could not tell what happened.
     *
     * NOT the same as a refusal. An unreadable 200 may well mean the gate WAS
     * approved, so telling a human it failed would send them to approve again —
     * the same defect as reporting a push failure as a refusal, at the same
     * point in the product. The caller must render this as "check", never as
     * "no".
     */
    readonly unconfirmed?: boolean;
    /**
     * True when the session this was attempted with is gone — expired, idled
     * out, or revoked. The caller drops it, so the panel offers a pairing token
     * again instead of a dead Approve button the human can only escape by
     * reloading the page.
     */
    readonly sessionEnded?: boolean;
  };

interface Json {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function send(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Json> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>,
  };
}

function text(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Signals that mean "this session is over", as distinct from "this was refused". */
const SESSION_ENDED = new Set([
  'HUMAN_SESSION_REQUIRED',
  'HUMAN_SESSION_REVOKED',
  'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION',
]);

function refusal(result: Json, fallback: string): {
  ok: false;
  signal: string;
  message: string;
  sessionEnded: boolean;
} {
  const signal = text(result.body, 'signal') ?? `HTTP_${result.status}`;
  return {
    ok: false,
    signal,
    message: text(result.body, 'message') ?? fallback,
    // A 401 on any step of this path means the session went away mid-ceremony;
    // sessions idle out after 30 minutes, so this is ordinary, not exceptional.
    sessionEnded: SESSION_ENDED.has(signal) || result.status === 401,
  };
}

function api(config: MachineConfig, path: string): string {
  return `${config.origin}/api/agent/v1${path}`;
}

/**
 * Exchange a pairing token for a paired client session.
 *
 * The token makes each session a distinct, single-use, recorded act, and binds
 * it to one ceremony. It does NOT make "a human is present" a fact: minting one
 * needs only write access to the pairing store, which every agent on this host
 * has. The machine credential is required alongside it so a revoked machine
 * cannot open a session — that part is a real control.
 */
export async function openHumanSession(
  fetchImpl: typeof globalThis.fetch,
  config: MachineConfig,
  pairingToken: string,
): Promise<{ ok: true; session: HumanSession } | { ok: false; signal: string; message: string }> {
  const result = await send(fetchImpl, api(config, '/human-sessions'), {
    ...machineHeaders(config),
    [PAIRING_TOKEN_HEADER]: pairingToken,
  }, {});
  const presentation = text(result.body, 'presentation');
  const sessionId = text(result.body, 'sessionId');
  if (result.status !== 201 || !presentation || !sessionId) {
    return refusal(result, 'the server did not issue a human session');
  }
  return {
    ok: true,
    session: { sessionId, presentation, expiresAt: text(result.body, 'expiresAt') ?? '' },
  };
}

/**
 * Issue a capability, mint a nonce for one gate, and spend both.
 *
 * The three are one act from the human's point of view and are kept together for
 * that reason. A capability outlives one approval, but re-issuing per approval
 * is cheap and keeps nothing long-lived in the page.
 */
export async function approveGate(
  fetchImpl: typeof globalThis.fetch,
  config: MachineConfig,
  session: HumanSession,
  gate: { readonly projectId: string; readonly gateName: string },
): Promise<ApprovalOutcome> {
  const authed = { ...machineHeaders(config), [HUMAN_SESSION_HEADER]: session.presentation };

  const issued = await send(fetchImpl, api(config, '/approval-capabilities'), authed, {
    principalKind: 'human-client',
  });
  const capability = text(issued.body, 'presentation');
  const capabilityId = text(issued.body, 'capabilityId');
  if (issued.status !== 201 || !capability || !capabilityId) {
    return refusal(issued, 'the server did not issue an approval capability');
  }

  const minted = await send(fetchImpl, api(config, '/approval-nonces'), authed, {
    projectId: gate.projectId,
    gateName: gate.gateName,
    capabilityId,
  });
  const nonce = text(minted.body, 'nonce');
  if (minted.status !== 201 || !nonce) {
    return refusal(minted, 'the server did not mint an approval nonce');
  }

  const workspace = encodeURIComponent(encodeWorkspace(config.workspacePath));
  const approved = await send(fetchImpl, api(config, `/workspaces/${workspace}/gates/approve`), authed, {
    projectId: gate.projectId,
    gateName: gate.gateName,
    capability,
    nonce,
  });
  if (approved.status !== 200) {
    return refusal(approved, 'the gate was not approved');
  }

  /*
   * EVERY PIECE OF EVIDENCE COMES FROM THE SERVER OR THE ANSWER IS NOT A YES.
   *
   * This used to treat any 200 as confirmation and fill the gaps from local
   * state: the timestamp from this browser's clock, the machine from the
   * configured label, the session from the one already in hand. So an empty
   * body — or a proxy's own 200 — rendered as "approved on alpha at <now>,
   * session s1", every word of it manufactured here. That is the client telling
   * a human their approval landed at the one moment it has no business
   * guessing, and it is the honest-degradation principle broken at the most
   * consequential point in the product.
   *
   * An unreadable success is reported as UNCONFIRMED rather than as a failure,
   * because the gate may well be approved. "I could not tell" is not "no", and
   * this is precisely where confusing them costs a duplicate approval.
   */
  const signal = text(approved.body, 'signal');
  const approvedAt = text(approved.body, 'approvedAt');
  const machine = text(approved.body, 'machine');
  // NULLABLE ON PURPOSE. An approval recorded before session ids existed is a
  // real approval with an unknown approver, and reporting "unknown" is right
  // where inventing this session's id would be a lie.
  const sessionId = text(approved.body, 'sessionId') ?? null;
  const alreadyApproved = signal === 'GATE_ALREADY_APPROVED';
  if ((signal !== 'GATE_APPROVED' && !alreadyApproved) || !approvedAt || !machine) {
    return {
      ok: false,
      unconfirmed: true,
      signal: 'GATE_APPROVAL_UNCONFIRMED',
      message:
        'the server answered 200 but not with a result this client can read, so whether the '
        + 'gate was approved is unknown. Check status.yaml before approving again.',
    };
  }

  const pushFailed = text(approved.body, 'pushFailed');
  const authority = text(approved.body, 'authority');
  return {
    ok: true,
    approvedAt,
    machine,
    sessionId,
    ...(alreadyApproved ? { alreadyApproved: true } : {}),
    ...(authority ? { authority } : {}),
    ...(pushFailed ? { pushFailed } : {}),
  };
}

function encodeWorkspace(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
