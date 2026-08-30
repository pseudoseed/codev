import { machineHeaders, type MachineConfig } from '../connection/machine.js';

/**
 * The approval path, as a client walks it.
 *
 * Four requests, because four different things are being established: that this
 * machine is paired, that a human is present, that this session holds a
 * capability, and that this particular gate is the one being approved. Porch
 * writes `status.yaml`; nothing here does.
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
  | { readonly ok: true; readonly approvedAt: string; readonly machine: string; readonly sessionId: string }
  | {
    readonly ok: false;
    readonly signal: string;
    readonly message: string;
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
 * Exchange a pairing token for a human-paired session.
 *
 * The token is what makes "a human is present" a fact rather than a claim: it is
 * single-use, minutes-long, and a person carries it from one screen to another.
 * Holding this machine's credential is deliberately not enough, because a
 * builder on this machine can read that file.
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
  return {
    ok: true,
    approvedAt: text(approved.body, 'approvedAt') ?? new Date().toISOString(),
    machine: text(approved.body, 'machine') ?? config.label,
    sessionId: text(approved.body, 'sessionId') ?? session.sessionId,
  };
}

function encodeWorkspace(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
