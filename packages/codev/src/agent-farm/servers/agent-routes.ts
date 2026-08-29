/** codev-agent HTTP surface added beside Tower's terminal routes (Spec 146). */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { decodeWorkspacePath } from '../lib/tower-client.js';
import {
  APPROVAL_SIGNAL,
  ApprovalCapabilityStore,
  ApprovalNonceStore,
  issueApprovalCapability,
} from '../lib/approval-capability.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import {
  AGENT_ROUTE_PREFIX,
  HUMAN_SESSION_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PAIRING_TOKEN_HEADER,
  authenticateAgentRequest,
  matchAgentRoute,
  type AgentAuthOutcome,
} from './agent-auth.js';
import { MACHINE_SIGNAL, type MachineCredentialStore } from '../lib/machine-credentials.js';
import { PAIRING_SIGNAL, type PairingStore } from '../lib/pairing.js';
import { openAgentStateSse, type AgentStreamSnapshot } from './agent-state-stream.js';
import { readWorkspaceStatuses } from './status-reader.js';
import {
  readThreadRegistry,
  type T3codeThreadSnapshot,
  type ThreadRegistrySnapshot,
} from './thread-registry.js';

// Both constants moved to `agent-auth.ts` in Phase 7, where the route table that
// uses them lives. Re-exported so existing importers keep their import site.
export { AGENT_ROUTE_PREFIX, HUMAN_SESSION_HEADER, MACHINE_CREDENTIAL_HEADER, PAIRING_TOKEN_HEADER };

const MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SESSION_LIFETIME_MS = 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface StoredHumanSession {
  readonly id: string;
  readonly verifier: Buffer;
  readonly pairedAt: number;
  readonly expiresAt: number;
  lastSeenAt: number;
}

export interface HumanPairingAttestation {
  /** Stable id of the browser pairing ceremony, not a builder/architect id. */
  readonly pairingId: string;
  /** Only the human-client completion path is accepted. */
  readonly principalKind: 'human-client' | 'builder' | 'architect';
  readonly pairedAt?: number;
  readonly lifetimeMs?: number;
}

export interface IssuedHumanSession {
  readonly sessionId: string;
  /** Returned once to the human client; codev-agent retains only its hash. */
  readonly credential: string;
  readonly expiresAt: string;
}

export interface HumanSessionRecognition {
  readonly paired: boolean;
  readonly sessionId?: string;
  readonly reason?: 'MISSING' | 'MALFORMED' | 'UNKNOWN' | 'EXPIRED' | 'IDLE' | 'INVALID' | 'REVOKED';
}

function verifier(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

/**
 * Codev's human session, intentionally separate from Tower's shared local key
 * and from t3code's coarse orchestration token.
 *
 * Pairing completion is an internal seam, not an HTTP route in this phase.
 * The host retains only a verifier, sessions die on codev-agent restart, expire
 * after at most eight hours, and also expire after thirty idle minutes.
 */
export class HumanPairedSessionRegistry {
  readonly #sessions = new Map<string, StoredHumanSession>();
  /** sessionId → original expiresAt. Dropped once that time passes. */
  readonly #revoked = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  completePairing(attestation: HumanPairingAttestation): IssuedHumanSession {
    if (attestation.principalKind !== 'human-client') {
      throw new Error(`PAIRING_PRINCIPAL_REFUSED:${attestation.principalKind}`);
    }
    if (attestation.pairingId.length === 0) throw new Error('PAIRING_ID_REQUIRED');
    const pairedAt = attestation.pairedAt ?? this.now();
    const requestedLifetime = attestation.lifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    if (!Number.isFinite(requestedLifetime) || requestedLifetime <= 0) {
      throw new Error('PAIRING_LIFETIME_INVALID');
    }
    const lifetime = Math.min(requestedLifetime, MAX_SESSION_LIFETIME_MS);
    const sessionId = randomUUID();
    const credential = randomBytes(32).toString('base64url');
    const expiresAt = pairedAt + lifetime;
    this.#sessions.set(sessionId, {
      id: sessionId,
      verifier: verifier(credential),
      pairedAt,
      expiresAt,
      lastSeenAt: pairedAt,
    });
    return { sessionId, credential, expiresAt: new Date(expiresAt).toISOString() };
  }

  recognize(presentation: string | undefined): HumanSessionRecognition {
    if (presentation === undefined || presentation.length === 0) return { paired: false, reason: 'MISSING' };
    const separator = presentation.indexOf('.');
    if (separator <= 0 || separator === presentation.length - 1) return { paired: false, reason: 'MALFORMED' };
    const sessionId = presentation.slice(0, separator);
    const credential = presentation.slice(separator + 1);
    const now = this.now();
    const revokedUntil = this.#revoked.get(sessionId);
    if (revokedUntil !== undefined) {
      if (now < revokedUntil) return { paired: false, reason: 'REVOKED' };
      this.#revoked.delete(sessionId);
    }
    const stored = this.#sessions.get(sessionId);
    if (!stored) return { paired: false, reason: 'UNKNOWN' };
    if (now >= stored.expiresAt) {
      this.#sessions.delete(sessionId);
      return { paired: false, reason: 'EXPIRED' };
    }
    if (now - stored.lastSeenAt >= SESSION_IDLE_MS) {
      this.#sessions.delete(sessionId);
      return { paired: false, reason: 'IDLE' };
    }
    const presented = verifier(credential);
    if (!timingSafeEqual(presented, stored.verifier)) return { paired: false, reason: 'INVALID' };
    stored.lastSeenAt = now;
    return { paired: true, sessionId };
  }

  revoke(sessionId: string): boolean {
    const stored = this.#sessions.get(sessionId);
    if (!stored) return false;
    this.#sessions.delete(sessionId);
    const now = this.now();
    this.#revoked.set(sessionId, stored.expiresAt);
    for (const [id, until] of this.#revoked) {
      if (now >= until) this.#revoked.delete(id);
    }
    return true;
  }
}

export interface AgentProtocolSnapshot {
  readonly schemaVersion: 1;
  readonly workspacePath: string;
  readonly generatedAt: string;
  readonly protocol: ThreadRegistrySnapshot;
  readonly humanSession: {
    readonly requiredFor: 'approval-capability-issuance';
    readonly persistence: 'memory-only';
    readonly maximumLifetimeMs: number;
    readonly idleLifetimeMs: number;
  };
}

export interface AgentRouteContext {
  readonly db: () => Database.Database;
  readonly log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  readonly isKnownWorkspace: (workspacePath: string) => boolean;
  readonly humanSessions: HumanPairedSessionRegistry;
  /** Spec 146 Phase 6: issuance is the only way a capability comes into being. */
  readonly approvalCapabilities: ApprovalCapabilityStore;
  readonly approvalNonces: ApprovalNonceStore;
  /** Spec 146 Phase 7: which client machine is talking, and its revocation. */
  readonly machineCredentials: MachineCredentialStore;
  /** Spec 146 Phase 7: how a machine holding nothing obtains a credential. */
  readonly pairings: PairingStore;
  /** Optional only because the browser normally joins t3code itself. */
  readonly t3codeSnapshot?: (workspacePath: string) => T3codeThreadSnapshot;
}

let routeContext: AgentRouteContext | null = null;

export function initAgentRoutes(context: AgentRouteContext): void {
  routeContext = context;
  // Startup reconciliation is read-only.  Phase 8 can begin writing thread_id
  // without changing this code; any two-store disagreement is logged, not fixed.
  for (const workspacePath of knownWorkspaceCandidates(context.db())) {
    const { payload } = buildAgentProtocolSnapshot(context, workspacePath);
    for (const signal of payload.protocol.signals) {
      if (signal.code === 'THREAD_ID_DISAGREEMENT' || signal.code === 'IDENTITY_SHAPE_CONFLICT') {
        context.log('WARN', `codev-agent reconciliation ${signal.code}: ${signal.message}`);
      }
    }
  }
}

export function shutdownAgentRoutes(): void {
  routeContext = null;
}

function knownWorkspaceCandidates(db: Database.Database): string[] {
  try {
    const rows = db.prepare(`
      SELECT workspace_path FROM known_workspaces
      UNION SELECT workspace_path FROM architect
      UNION SELECT workspace_path FROM builders
      ORDER BY workspace_path
    `).all() as Array<{ workspace_path: string }>;
    return rows.map((row) => row.workspace_path);
  } catch {
    return [];
  }
}

function builderWorktrees(db: Database.Database, workspacePath: string): string[] {
  try {
    const rows = db.prepare('SELECT worktree FROM builders WHERE workspace_path = ? ORDER BY id')
      .all(normalizeWorkspacePath(workspacePath)) as Array<{ worktree: string }>;
    return rows.map((row) => row.worktree);
  } catch {
    // readThreadRegistry emits the distinct DB failure.  Returning no worktrees
    // avoids turning the same lock into a generic route 500 first.
    return [];
  }
}

export function buildAgentProtocolSnapshot(
  context: AgentRouteContext,
  workspacePath: string,
): AgentStreamSnapshot<AgentProtocolSnapshot> {
  const workspace = normalizeWorkspacePath(workspacePath);
  const db = context.db();
  const worktrees = builderWorktrees(db, workspace);
  const statuses = readWorkspaceStatuses(workspace, worktrees);
  const protocol = readThreadRegistry(
    db,
    workspace,
    statuses,
    context.t3codeSnapshot?.(workspace) ?? { status: 'not-provided' },
  );
  return {
    artifactRoots: [workspace, ...worktrees],
    payload: {
      schemaVersion: 1,
      workspacePath: workspace,
      generatedAt: new Date().toISOString(),
      protocol,
      humanSession: {
        requiredFor: 'approval-capability-issuance',
        persistence: 'memory-only',
        maximumLifetimeMs: MAX_SESSION_LIFETIME_MS,
        idleLifetimeMs: SESSION_IDLE_MS,
      },
    },
  };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function decodeWorkspace(encoded: string): string | null {
  try {
    return normalizeWorkspacePath(decodeWorkspacePath(encoded));
  } catch {
    return null;
  }
}


/** Cap on an approval request body. These carry four short fields, never a payload. */
const MAX_APPROVAL_BODY_BYTES = 4096;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_APPROVAL_BODY_BYTES) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => finish(null));
    req.on('end', () => {
      if (chunks.length === 0) return finish({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Last resort for an async route body that threw.
 *
 * Every handler below reads its body through a promise, and a store that throws
 * inside one of those `.then`s becomes an UNHANDLED REJECTION — which Tower's
 * process-level handler answers with `process.exit(1)`. One route's bad day took
 * the whole server down, and the caller got no response at all, which is the
 * worst possible spelling of "I could not tell". This catches the class rather
 * than one instance of it.
 */
function guardRouteFailure(
  res: http.ServerResponse,
  context: AgentRouteContext,
  route: string,
  error: unknown,
): void {
  context.log('ERROR', `agent route ${route} failed: ${error instanceof Error ? error.message : String(error)}`);
  if (res.writableEnded) return;
  writeJson(res, 503, {
    signal: 'AGENT_ROUTE_FAILED',
    message: 'the request could not be completed; the failure is in this host\'s log',
  });
}

/**
 * Approval capability issuance, nonce minting and revocation.
 *
 * Authentication happened before this ran, in `agent-auth.ts`: these routes carry
 * `human-session`, which means a live machine credential AND a human-paired
 * session. `humanSessionId` is that session, already recognised.
 *
 * CSRF: the session travels in a custom request header, never a cookie, so a
 * cross-origin form post cannot carry it and a cross-origin fetch that tries is
 * stopped by preflight. Phase 7 added the explicit `Origin` refusal in front of
 * that, so the browser boundary no longer rests on preflight alone.
 *
 * The declared-principal refusal below is DEFENCE IN DEPTH, not identification.
 * Over loopback TCP the peer process is not attributable: `remoteAddress` is
 * 127.0.0.1 for a builder, an architect and a browser alike, and there is no
 * peer-credential mechanism for TCP on macOS. A builder that declares itself a
 * human client is not caught here. What stops it is that it has no human-paired
 * session, and that what the host stores is a verifier it cannot present.
 */
function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: AgentRouteContext,
  humanSessionId: string,
): void {
  if (req.method === 'POST' && url.pathname === `${AGENT_ROUTE_PREFIX}/approval-capabilities`) {
    void readJsonBody(req).then((body) => {
      if (!body) {
        writeJson(res, 400, { signal: 'APPROVAL_REQUEST_MALFORMED' });
        return;
      }
      const outcome = issueApprovalCapability(context.approvalCapabilities, {
        humanSession: { paired: true, sessionId: humanSessionId },
        declaredPrincipal: typeof body.principalKind === 'string' ? body.principalKind : undefined,
        machine: typeof body.machine === 'string' ? body.machine : undefined,
        lifetimeMs: typeof body.lifetimeMs === 'number' ? body.lifetimeMs : undefined,
      });
      if (!outcome.issued) {
        writeJson(res, 403, { signal: outcome.code, message: outcome.message });
        return;
      }
      // The presentation is returned once and never stored in presentable form.
      writeJson(res, 201, {
        signal: APPROVAL_SIGNAL.APPROVAL_AUTHORIZED,
        capabilityId: outcome.capability.capabilityId,
        presentation: outcome.capability.presentation,
        machine: outcome.capability.machine,
        expiresAt: outcome.capability.expiresAt,
      });
    }).catch((error: unknown) => guardRouteFailure(res, context, 'approval-capability-issue', error));
    return;
  }

  if (req.method === 'POST' && url.pathname === `${AGENT_ROUTE_PREFIX}/approval-nonces`) {
    void readJsonBody(req).then((body) => {
      const projectId = body && typeof body.projectId === 'string' ? body.projectId : '';
      const gateName = body && typeof body.gateName === 'string' ? body.gateName : '';
      const capabilityId = body && typeof body.capabilityId === 'string' ? body.capabilityId : '';
      if (!projectId || !gateName || !capabilityId) {
        writeJson(res, 400, { signal: 'APPROVAL_REQUEST_MALFORMED' });
        return;
      }
      // The capability must exist, be live, and belong to THIS session before a
      // nonce is minted against it. Minting against any string was harmless —
      // the secret still has to verify at `porch approve` — but an unchecked
      // identifier accepted at one layer is the shape this phase keeps finding.
      const capability = context.approvalCapabilities.describe(capabilityId);
      if (!capability || capability.revokedAt || Date.parse(capability.expiresAt) <= Date.now()) {
        writeJson(res, 404, {
          signal: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN,
          message: 'no live capability with that id on this host',
        });
        return;
      }
      if (capability.sessionId !== humanSessionId) {
        writeJson(res, 403, {
          signal: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION,
          message: 'that capability was issued to a different human session',
        });
        return;
      }
      const nonce = context.approvalNonces.mint({ projectId, gateName, capabilityId });
      writeJson(res, 201, { signal: APPROVAL_SIGNAL.APPROVAL_AUTHORIZED, nonce, projectId, gateName });
    }).catch((error: unknown) => guardRouteFailure(res, context, 'approval-nonce-mint', error));
    return;
  }

  const revokeMachine = url.pathname.match(/^\/api\/agent\/v1\/approval-capabilities\/machine\/([^/]+)$/);
  if (req.method === 'DELETE' && revokeMachine) {
    const machine = decodeURIComponent(revokeMachine[1]);
    const revoked = context.approvalCapabilities.revokeMachine(machine);
    writeJson(res, 200, { signal: APPROVAL_SIGNAL.CAPABILITY_REVOKED, machine, revoked });
    return;
  }

  writeJson(res, 404, { signal: 'AGENT_ROUTE_NOT_FOUND' });
}

/**
 * Redeem a pairing token for this machine's credential.
 *
 * The only route reachable without a machine credential, and the reason the auth
 * table has a mode for it. Redemption is where the token is actually spent: the
 * auth layer checked only that one was presented, because consuming it there
 * would spend it before the machine name from the body was known.
 *
 * The issued presentation is returned once, in the response body. It is never
 * logged — neither the token nor the credential appears in any `log()` call on
 * this path, and a test asserts that over the whole captured log stream.
 */
function handlePairingRedeem(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: AgentRouteContext,
): void {
  const raw = req.headers[PAIRING_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  void readJsonBody(req).then((body) => {
    const machine = body && typeof body.machine === 'string' ? body.machine.trim() : '';
    if (!machine) {
      writeJson(res, 400, {
        signal: 'PAIRING_REQUEST_MALFORMED',
        message: 'redemption requires the machine name this credential is for',
      });
      return;
    }
    let redemption;
    try {
      redemption = context.pairings.redeem(token, { machine });
    } catch (error) {
      // An unparseable store is "I could not tell", not "no such token".
      context.log('ERROR', `pairing store unreadable: ${(error as Error).message}`);
      writeJson(res, 503, {
        signal: PAIRING_SIGNAL.PAIRING_STORE_UNREADABLE,
        message: 'the pairing store could not be read',
      });
      return;
    }
    if (!redemption.redeemed) {
      writeJson(res, 401, { signal: redemption.code, message: redemption.message });
      return;
    }
    // THE TOKEN IS ALREADY SPENT AT THIS POINT, and it has to be — issuing the
    // credential first would leave a credential standing against a token nobody
    // consumed. So an issuance failure here (a contended lock, a full disk) burns
    // the operator's token and hands back nothing, and before this it also threw
    // out of a `.then` with no catch, which Tower's `unhandledRejection` handler
    // turns into `process.exit(1)`: a filesystem hiccup during pairing took the
    // whole server down.
    let credential;
    try {
      credential = context.machineCredentials.issue({ machine });
    } catch (error) {
      // Put the token back so the operator can simply retry, and SAY whether that
      // worked. "Your token still works" and "your token is gone, mint another"
      // are different instructions, and reporting one when the other is true is
      // the failure this spec keeps finding.
      let released = false;
      try {
        released = redemption.pairingId !== undefined && context.pairings.release(redemption.pairingId);
      } catch (releaseError) {
        context.log('ERROR', `pairing token release failed: ${(releaseError as Error).message}`);
      }
      context.log('ERROR', `machine credential issuance failed for ${machine}: ${(error as Error).message}`);
      writeJson(res, 503, {
        signal: PAIRING_SIGNAL.PAIRING_CREDENTIAL_ISSUE_FAILED,
        message: released
          ? 'the credential could not be issued; the pairing token was released and can be redeemed again'
          : 'the credential could not be issued and the pairing token could not be released; mint a new token',
        tokenReleased: released,
      });
      return;
    }
    context.log('INFO', `paired machine ${machine} via pairing ${redemption.pairingId ?? 'unknown'}`);
    writeJson(res, 201, {
      signal: PAIRING_SIGNAL.PAIRING_TOKEN_ACCEPTED,
      machine: credential.machine,
      credentialId: credential.credentialId,
      credential: credential.presentation,
      expiresAt: credential.expiresAt,
    });
  }).catch((error: unknown) => guardRouteFailure(res, context, 'pairing-redeem', error));
}

/**
 * Revoke one machine — its credential AND its approval capabilities.
 *
 * TWO STORES, ONE OPERATOR ACTION. The machine credential and the approval
 * capability are separate stores keyed by the same machine name, and revoking
 * only the first would leave a revoked device still able to present a live
 * approval capability to `porch approve`. An operator asked to remember two calls
 * will eventually make one, so the route makes both and reports each count
 * separately rather than collapsing them into one boolean.
 *
 * Success criterion 15: after this, that machine's every request fails closed
 * with MACHINE_CREDENTIAL_REVOKED, and no other machine's file is touched.
 * `revoked: false` means there was nothing live to revoke — not an error, and
 * reported as its own answer rather than as a failure.
 */
function handleMachineRevoke(
  res: http.ServerResponse,
  url: URL,
  context: AgentRouteContext,
): void {
  const match = url.pathname.match(/^\/api\/agent\/v1\/machines\/([^/]+)$/);
  const machine = decodeURIComponent(match ? match[1] : '');
  const revoked = context.machineCredentials.revoke(machine);
  const approvalCapabilitiesRevoked = context.approvalCapabilities.revokeMachine(machine);
  writeJson(res, 200, {
    signal: revoked ? MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED : 'MACHINE_CREDENTIAL_NOT_LIVE',
    machine,
    revoked,
    approvalCapabilitiesRevoked,
  });
}

/** Report a refused request. The signal is the auth layer's, verbatim. */
function writeRefusal(res: http.ServerResponse, outcome: AgentAuthOutcome): void {
  if (outcome.allowed) throw new Error('writeRefusal called on an allowed outcome');
  writeJson(res, outcome.status, {
    signal: outcome.signal,
    message: outcome.message,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
}

/**
 * Return true when the request belongs to codev-agent.
 *
 * THE ROUTE TABLE IS THE ROUTER. Every request resolves through
 * `matchAgentRoute`, so a path the table does not name cannot be served, and a
 * route added to the table without an authentication mode does not compile. This
 * is what makes the enumerating test in `agent-auth.test.ts` a fact about the
 * dispatcher rather than a list somebody remembered to update.
 *
 * Called after Tower's own request-authentication choke point, which is a
 * different boundary and is not a substitute: Tower's shared local key is ONE key
 * for every client, so it cannot express "this machine and not that one".
 */
export function handleAgentRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): boolean {
  if (!url.pathname.startsWith(`${AGENT_ROUTE_PREFIX}/`)) return false;
  const context = routeContext;
  if (!context) {
    writeJson(res, 503, { signal: 'CODEV_AGENT_STARTING', message: 'codev-agent is still starting' });
    return true;
  }

  const route = matchAgentRoute(req.method, url.pathname);
  if (!route) {
    writeJson(res, 404, { signal: 'AGENT_ROUTE_NOT_FOUND' });
    return true;
  }

  let outcome: AgentAuthOutcome;
  try {
    outcome = authenticateAgentRequest(req, route, context);
  } catch (error) {
    // A credential store that exists but will not parse must not answer
    // "unknown machine" — that reads as a definite "you were never paired".
    context.log('ERROR', `machine credential store unreadable: ${(error as Error).message}`);
    writeJson(res, 503, {
      signal: MACHINE_SIGNAL.MACHINE_STORE_UNREADABLE,
      message: 'the machine credential store could not be read',
    });
    return true;
  }
  if (!outcome.allowed) {
    writeRefusal(res, outcome);
    return true;
  }

  switch (route.id) {
    case 'pairing-redeem':
      handlePairingRedeem(req, res, context);
      return true;

    case 'session-probe': {
      // The machine is authenticated; this reports whether a HUMAN session is
      // also live, which is what a client asks before it tries to approve.
      const header = req.headers[HUMAN_SESSION_HEADER];
      const recognition = context.humanSessions.recognize(Array.isArray(header) ? header[0] : header);
      writeJson(res, recognition.paired ? 200 : 401, {
        signal: recognition.paired
          ? 'HUMAN_SESSION_RECOGNISED'
          : recognition.reason === 'REVOKED'
            ? 'HUMAN_SESSION_REVOKED'
            : 'HUMAN_SESSION_REQUIRED',
        ...recognition,
      });
      return true;
    }

    case 'machine-credential-revoke':
      handleMachineRevoke(res, url, context);
      return true;

    case 'approval-capability-issue':
    case 'approval-nonce-mint':
    case 'approval-capability-revoke-machine':
      handleApprovalRoute(req, res, url, context, outcome.humanSessionId as string);
      return true;

    case 'workspace-state':
    case 'workspace-stream': {
      const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/(state|stream)$/);
      const workspace = match ? decodeWorkspace(match[1]) : null;
      if (!workspace) {
        writeJson(res, 400, { signal: 'WORKSPACE_PATH_INVALID' });
        return true;
      }
      if (!context.isKnownWorkspace(workspace)) {
        // This is also the filesystem scope check: callers cannot use the service
        // as a general status.yaml reader by base64-encoding an arbitrary path.
        writeJson(res, 404, { signal: 'WORKSPACE_NOT_REGISTERED' });
        return true;
      }
      if (route.id === 'workspace-state') {
        writeJson(res, 200, buildAgentProtocolSnapshot(context, workspace).payload);
      } else {
        openAgentStateSse(req, res, {
          workspacePath: workspace,
          snapshot: () => buildAgentProtocolSnapshot(context, workspace),
        });
      }
      return true;
    }

    default:
      // Unreachable while every table entry has a case. If a route is added to
      // the table and not here, this says so rather than serving it unhandled.
      writeJson(res, 501, { signal: 'AGENT_ROUTE_UNIMPLEMENTED', route: route.id });
      return true;
  }
}
