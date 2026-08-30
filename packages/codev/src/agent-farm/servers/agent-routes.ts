/** codev-agent HTTP surface added beside Tower's terminal routes (Spec 146). */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { decodeWorkspacePath } from '../lib/tower-client.js';
import {
  APPROVAL_SIGNAL,
  ApprovalCapabilityStore,
  ApprovalNonceStore,
  CAPABILITY_ENV_VAR,
  NONCE_ENV_VAR,
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
import {
  APPROVAL_OPERATION_SIGNAL,
  type ApprovalOperationState,
  type ApprovalOperationStore,
} from '../lib/approval-operations.js';
import { PAIRING_SIGNAL, type PairingStore } from '../lib/pairing.js';
import { openAgentStateSse, type AgentStreamSnapshot } from './agent-state-stream.js';
import { readWorkspaceStatuses } from './status-reader.js';
import type { GateStatus } from '../../commands/porch/types.js';
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
  /** Carried from the token, so an approval can record what authorized it. */
  readonly authority?: string;
  lastSeenAt: number;
}

export interface HumanPairingAttestation {
  /** Stable id of the browser pairing ceremony, not a builder/architect id. */
  readonly pairingId: string;
  /** Only the human-client completion path is accepted. */
  readonly principalKind: 'human-client' | 'builder' | 'architect';
  readonly pairedAt?: number;
  readonly lifetimeMs?: number;
  /**
   * WHAT AUTHORIZED THE TOKEN THIS SESSION WAS PAIRED WITH, verbatim.
   *
   * Recorded and never interpreted. This host cannot verify a human was present
   * — a same-uid process can mint its own token — so the chain carries the
   * minter's own account instead of an assertion nothing established.
   */
  readonly authority?: string;
}

export interface IssuedHumanSession {
  readonly sessionId: string;
  /** The authority recorded on the token this session was paired with. */
  readonly authority?: string;
  /** Returned once to the human client; codev-agent retains only its hash. */
  readonly credential: string;
  readonly expiresAt: string;
}

export interface HumanSessionRecognition {
  readonly paired: boolean;
  readonly sessionId?: string;
  /** What the token this session was paired with claimed as its authority. */
  readonly authority?: string;
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
      ...(attestation.authority ? { authority: attestation.authority } : {}),
      lastSeenAt: pairedAt,
    });
    return {
      sessionId,
      credential,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(attestation.authority ? { authority: attestation.authority } : {}),
    };
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
    return { paired: true, sessionId, ...(stored.authority ? { authority: stored.authority } : {}) };
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
  /**
   * Spec 236: where an approval lives between its submit and its report.
   *
   * Optional because a host may serve the read surface without accepting work it
   * has nowhere to record — `tools/codev-agent-host` is one. The routes answer
   * 501 rather than accepting and losing it.
   */
  readonly approvalOperations?: ApprovalOperationStore;
}

let routeContext: AgentRouteContext | null = null;

export function initAgentRoutes(context: AgentRouteContext): void {
  routeContext = context;
  /*
   * RESOLVE INTERRUPTED APPROVALS BEFORE THE SURFACE CAN ANSWER A POLL.
   *
   * A record left `running` by a killed Tower would otherwise be reported as in
   * progress for the rest of the store's life — "running forever" as a reachable
   * state rather than an impossible one. Done here, synchronously, because
   * `routeContext` is set on the line above and a request can arrive immediately
   * after this function returns.
   */
  if (context.approvalOperations) {
    try {
      const resolved = context.approvalOperations.resolveInterrupted((operation) => {
        const gate = readScopedGate(operation.workspacePath, operation.projectId, operation.gateName);
        if (gate === null) return 'unreadable';
        return gate.status === 'approved' ? 'approved' : 'pending';
      });
      for (const operation of resolved) {
        context.log('WARN', `approval ${operation.operationId}: ${operation.message ?? 'interrupted'}`);
      }
    } catch (error) {
      // A store that will not open must not stop Tower from starting. The
      // records stay unresolved and the next start tries again; saying nothing
      // would make that silent.
      context.log('ERROR', `could not resolve interrupted approvals: ${(error as Error).message}`);
    }
  }
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
 * peer-credential mechanism for TCP on macOS.
 *
 * A BUILDER THAT DECLARES ITSELF A HUMAN CLIENT IS NOT CAUGHT HERE, AND NOTHING
 * ELSE CATCHES IT EITHER. An earlier version of this comment said what stopped
 * it was having no paired session. That was false: minting a pairing token needs
 * only write access to the pairing store, and a builder runs as the same user,
 * so it can mint one, redeem it, and hold a session this surface treats exactly
 * like a browser's.
 *
 * What the system actually provides is scoping, revocation and provenance:
 * per-machine credentials that can be withdrawn one at a time, single-use nonces
 * bound to one gate, and an `authority` string recorded from the token through
 * the session and the capability into `status.yaml`. It does not provide proof
 * that a person was present, and no comment here should imply otherwise —
 * asserting a property the code does not have is worse than naming the gap,
 * because the next person builds on it.
 */
function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: AgentRouteContext,
  humanSessionId: string,
  humanSessionAuthority: string | undefined,
): void {
  if (req.method === 'POST' && url.pathname === `${AGENT_ROUTE_PREFIX}/approval-capabilities`) {
    void readJsonBody(req).then((body) => {
      if (!body) {
        writeJson(res, 400, { signal: 'APPROVAL_REQUEST_MALFORMED' });
        return;
      }
      /*
       * `machine` NAMES THE HOST THAT WILL VERIFY THIS CAPABILITY, not the
       * device asking for it. `verify` compares the stored name against THIS
       * host's own identity, so a capability issued for a client-supplied name
       * can never verify anywhere — it would be handed over looking valid and
       * refused as APPROVAL_CAPABILITY_FOREIGN_MACHINE at the moment of use,
       * which reads as a revocation rather than as a bad request.
       *
       * So a mismatch is refused HERE, at issuance, where the caller can still
       * be told what it did. Omitting the field is the normal case and takes the
       * host's identity. Silently ignoring a value the client set would be the
       * same defect with a quieter spelling.
       */
      const declaredMachine = typeof body.machine === 'string' ? body.machine.trim() : undefined;
      if (declaredMachine !== undefined && declaredMachine !== context.approvalCapabilities.machine) {
        writeJson(res, 400, {
          signal: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_FOREIGN_MACHINE,
          message:
            `a capability can only be issued for this host (${context.approvalCapabilities.machine}); `
            + `"${declaredMachine}" would never verify anywhere`,
          machine: context.approvalCapabilities.machine,
        });
        return;
      }
      const outcome = issueApprovalCapability(context.approvalCapabilities, {
        humanSession: { paired: true, sessionId: humanSessionId, authority: humanSessionAuthority },
        declaredPrincipal: typeof body.principalKind === 'string' ? body.principalKind : undefined,
        machine: declaredMachine,
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
      redemption = context.pairings.redeem(token, { machine, purpose: 'machine-credential' });
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
 * Turn a fresh pairing token into a paired client session.
 *
 * THE PATH PHASE 6 BUILT AND NOTHING COULD REACH. `completePairing` had no
 * caller outside its own file, so no browser could ever hold a session, so the
 * approval capability it gates could never be issued, so criterion 9b was
 * unreachable while every unit test around it passed. Adding the route is half
 * the fix; the other half is the end-to-end test that drives a request through
 * it, in `agent-approval-path.test.ts`.
 *
 * ## WHAT THIS SESSION IS, AND WHAT IT IS NOT
 *
 * It establishes: a live machine credential, plus possession of a fresh
 * single-use token minted on this host for this ceremony. All three are real and
 * all three are revocable.
 *
 * It does NOT establish that a human was present. Minting a token needs only
 * write access to the pairing store, and every builder on this host runs as the
 * same user — so a builder can mint one, redeem it here, and hold a session. The
 * threat model used to say a builder was stopped by having no session; it was
 * not, and asserting a property the code does not have is worse than naming the
 * gap, because the next person builds on it.
 *
 * What the system does instead is RECORD: the token's stated authority travels
 * to this session, to any capability it issues, and into `status.yaml` beside
 * the approval, so a reader can see what was actually claimed.
 *
 * The token is spent HERE and not in the auth layer, for the same reason machine
 * redemption spends it here: the auth layer does not yet know what it is being
 * spent on, and a token consumed for a request that then fails is a token the
 * operator has to mint again.
 */
function handleHumanSessionIssue(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: AgentRouteContext,
  machine: string,
): void {
  const raw = req.headers[PAIRING_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  void readJsonBody(req).then((body) => {
    if (!body) {
      writeJson(res, 400, { signal: 'HUMAN_SESSION_REQUEST_MALFORMED' });
      return;
    }
    let redemption;
    try {
      redemption = context.pairings.redeem(token, { machine, purpose: 'client-session' });
    } catch (error) {
      context.log('ERROR', `pairing store unreadable: ${(error as Error).message}`);
      writeJson(res, 503, {
        signal: PAIRING_SIGNAL.PAIRING_STORE_UNREADABLE,
        message: 'the pairing store could not be read',
      });
      return;
    }
    if (!redemption.redeemed || !redemption.pairingId) {
      writeJson(res, 401, { signal: redemption.code, message: redemption.message });
      return;
    }
    let issued: IssuedHumanSession;
    try {
      issued = context.humanSessions.completePairing({
        pairingId: redemption.pairingId,
        principalKind: 'human-client',
        lifetimeMs: typeof body.lifetimeMs === 'number' ? body.lifetimeMs : undefined,
        authority: redemption.authority,
      });
    } catch (error) {
      // The token was spent on a ceremony that did not complete. Put it back
      // rather than leave the human holding neither a token nor a session.
      context.pairings.release(redemption.pairingId);
      writeJson(res, 400, {
        signal: 'HUMAN_SESSION_REFUSED',
        message: (error as Error).message,
      });
      return;
    }
    writeJson(res, 201, {
      signal: 'HUMAN_SESSION_ISSUED',
      sessionId: issued.sessionId,
      /*
       * THE JOINED FORM, because that is what `recognize` reads.
       *
       * `completePairing` hands back the id and the secret separately, and the
       * header carries `<sessionId>.<secret>`. Returning the two halves and
       * leaving the client to join them puts a wire format in every client that
       * only this file should know — and a client that joins them wrongly gets
       * MALFORMED, which is indistinguishable from a bad secret.
       */
      presentation: `${issued.sessionId}.${issued.credential}`,
      expiresAt: issued.expiresAt,
    });
  }).catch((error: unknown) => guardRouteFailure(res, context, 'human-session-issue', error));
}

/**
 * What `status.yaml` says about one gate, or null if it cannot be read.
 *
 * Used only as a backstop: when an approval request fails unexpectedly, the file
 * is the authority on whether the gate is approved, and reporting a refusal
 * without asking it is how a completed approval gets denied.
 *
 * ## It SCANS rather than constructing a path, and that is the whole point
 *
 * The first version built `codev/projects/<projectId>/status.yaml`. **No real
 * project lives there.** Directories are named `<id>-<slug>` —
 * `0087-porch-timeout-termination-retries`, `220-spec-146-phase-11-codev-client`
 * — so the lookup would have found nothing in production, returned null, and
 * fallen through to the 503 refusal this backstop exists to prevent. It passed
 * only because the e2e fixture happens to name its directories for the id.
 *
 * The same false premise cost phase 5 its reconciliation criterion. So this
 * reuses `readWorkspaceStatuses`, which reads what is on disk, and matches on
 * the `projectId` INSIDE each file rather than on a directory name.
 */
export function readScopedGate(
  workspacePath: string,
  projectId: string,
  gateName: string,
): GateStatus | null {
  try {
    for (const result of readWorkspaceStatuses(workspacePath, buildersOf(workspacePath))) {
      if (result.ok && result.status.projectId === projectId) {
        return result.status.gates[gateName] ?? null;
      }
    }
  } catch {
    // The backstop cannot report what it cannot read, and says nothing rather
    // than guessing — the caller then reports the original failure.
  }
  return null;
}

function buildersOf(workspacePath: string): string[] {
  try {
    return readdirSync(join(workspacePath, '.builders'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspacePath, '.builders', entry.name));
  } catch {
    return [];
  }
}

/**
 * Spend a capability and a nonce by asking porch to approve a gate.
 *
 * PORCH REMAINS THE ONLY WRITER OF `status.yaml`. This route does not touch it;
 * it calls porch's own `approve`, which resolves the capability, records who
 * approved with what, and commits. The capability presentation arrives in the
 * body because the host keeps only a verifier — it cannot present what it
 * deliberately cannot reconstruct.
 *
 * `onRefusal: 'throw'` is not a nicety. porch's CLI answers a refusal with
 * `process.exit(1)`, and that inside Tower would end the process and answer the
 * request with nothing.
 */
function handleGateApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspacePath: string,
  context: AgentRouteContext,
  humanSessionId: string,
): void {
  void readJsonBody(req).then(async (body) => {
    const projectId = body && typeof body.projectId === 'string' ? body.projectId : '';
    const gateName = body && typeof body.gateName === 'string' ? body.gateName : '';
    const capability = body && typeof body.capability === 'string' ? body.capability : '';
    const nonce = body && typeof body.nonce === 'string' ? body.nonce : '';
    if (!projectId || !gateName || !capability || !nonce) {
      writeJson(res, 400, {
        signal: 'APPROVAL_REQUEST_MALFORMED',
        message: 'projectId, gateName, capability and nonce are all required',
      });
      return;
    }

    // The capability must belong to THIS session before it is spent. porch
    // checks it again; this check is what stops one session spending another's.
    const capabilityId = capability.split('.')[0] ?? '';
    const stored = context.approvalCapabilities.describe(capabilityId);
    if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= Date.now()) {
      writeJson(res, 404, {
        signal: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN,
        message: 'no live capability with that id on this host',
      });
      return;
    }
    if (stored.sessionId !== humanSessionId) {
      writeJson(res, 403, {
        signal: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION,
        message: 'that capability was issued to a different human session',
      });
      return;
    }

    // Imported here, not at module load. porch's entry point pulls in the whole
    // state layer, and this module is loaded by every Tower start.
    const { approve, ApprovalRefusedError } = await import('../../commands/porch/index.js');
    let result;
    try {
      result = await approve(workspacePath, projectId, gateName, true, undefined, {
        // A DELIBERATELY MINIMAL ENVIRONMENT. Inheriting process.env would carry
        // Tower's own CODEV_ARCHITECT_NAME / CODEV_WORKTREE_ROOT into the caller
        // attribution and record this approval as an architect session, which it
        // is not. What approved it is a human-paired client, and the capability
        // is the evidence.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          /*
           * PASSED THROUGH, NOT DROPPED. porch notifies the builder's terminal
           * after an approval, and that notification resolves Tower through
           * this variable. A host running over a database snapshot sets it to
           * its own state root; dropping it here would send that host's
           * approvals at the operator's REAL Tower and its real builders.
           * Production does not set it and is unaffected.
           */
          ...(process.env.CODEV_AGENT_FARM_DIR
            ? { CODEV_AGENT_FARM_DIR: process.env.CODEV_AGENT_FARM_DIR }
            : {}),
          [CAPABILITY_ENV_VAR]: capability,
          [NONCE_ENV_VAR]: nonce,
        },
        cwd: workspacePath,
        capabilities: context.approvalCapabilities,
        nonces: context.approvalNonces,
        onRefusal: 'throw',
        // An HTTP request will not run a repository's build and test suite. See
        // the option's own comment for why a timeout is not the answer.
        refuseIfChecksWouldRun: true,
      });
    } catch (error) {
      if (error instanceof ApprovalRefusedError) {
        writeJson(res, 403, { signal: error.code, message: error.message });
        return;
      }
      /*
       * AN UNEXPECTED FAILURE IS NOT EVIDENCE THE GATE IS UNAPPROVED.
       *
       * The two delivery failures are typed and handled inside `approve`, but
       * anything else thrown after the gate write — a notification, a phase
       * advance, a bug — used to reach `guardRouteFailure` as a 503, which the
       * client renders as a definite refusal, which sends the human to approve
       * again. `status.yaml` is the authority on whether the gate is approved,
       * so it is READ, and the answer says what it found.
       *
       * This is a backstop for the class rather than for the two members of it
       * we happen to know about.
       */
      const persisted = readScopedGate(workspacePath, projectId, gateName);
      if (persisted?.status === 'approved') {
        writeJson(res, 200, {
          signal: 'GATE_APPROVED',
          projectId,
          gateName,
          machine: persisted.approval?.machine ?? stored.machine,
          sessionId: persisted.approval?.session_id ?? null,
          approvedAt: persisted.approved_at ?? null,
          ...(persisted.approval?.authority ? { authority: persisted.approval.authority } : {}),
          delivery: 'unknown',
          deliveryMessage:
            `the approval is recorded in status.yaml, but this request then failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      throw error;
    }

    /*
     * EVERY FIELD BELOW COMES FROM WHAT PORCH PERSISTED. NONE IS BUILT HERE.
     *
     * This used to answer GATE_APPROVED unconditionally, with the REQUESTING
     * session id, this host's machine name, and `new Date()`. Two ways that
     * falsified the record it was reporting:
     *
     *  - `approve` returns normally when the gate was ALREADY approved, so a
     *    stale or concurrent request claimed that this session approved a gate
     *    somebody else had.
     *  - the timestamp was this server's clock rather than the one in
     *    `status.yaml`, so an old approval was reported as having just happened.
     *
     * The client is built to refuse a response it cannot read rather than fill
     * gaps from local state; this is the same rule one layer down, and it was
     * the layer manufacturing the values.
     */
    const record = result.record;
    writeJson(res, 200, {
      signal: result.outcome === 'approved' ? 'GATE_APPROVED' : 'GATE_ALREADY_APPROVED',
      projectId,
      gateName,
      // The machine and session that made the approval THAT EXISTS — which on
      // the already-approved path is somebody else's, and says so.
      machine: record?.machine ?? stored.machine,
      sessionId: record?.session_id ?? null,
      approvedAt: result.approvedAt ?? null,
      ...(record?.authority ? { authority: record.authority } : {}),
      ...(result.delivery
        ? { delivery: result.delivery, deliveryMessage: result.deliveryMessage }
        : {}),
    });
  }).catch((error: unknown) => guardRouteFailure(res, context, 'gate-approve', error));
}

/**
 * Submit an approval that outlives its request (Spec 236, phase 5).
 *
 * ## Why this exists beside `handleGateApprove` rather than replacing it
 *
 * The synchronous route sets `refuseIfChecksWouldRun: true` and keeps doing so.
 * That refusal is correct for a caller that must answer inside its request, and
 * it is what a client gets if it does not opt into this path. **Nothing that
 * works today changes behaviour.**
 *
 * What this adds is the case the refusal could not serve: an ordinary project
 * whose phase declares checks. Porch runs them here in the background, and the
 * client polls. A request timeout was never the alternative — a client that gives
 * up does not stop porch, so it would abandon a call that goes on to approve the
 * gate anyway.
 *
 * ## Everything is checked BEFORE an operation exists
 *
 * A capability belonging to another session must not create a record. An
 * operation is a durable artifact an operator can see; creating one and then
 * refusing it would put a failed approval in their history for a request that
 * never had the right to make one.
 *
 * ## Named to share no prefix with `handleGateApprove`
 *
 * `spec-146-phase-11-approval-writes.test.ts` slices this file from
 * `indexOf('function handleGateApprove')`. Any name beginning with that string —
 * `handleGateApproveAsync`, `handleGateApprovalStatus` — placed earlier would
 * capture the match and fail that test against the wrong function, reading as a
 * regression in code that is fine.
 */
function handleApprovalSubmit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspacePath: string,
  context: AgentRouteContext,
  humanSessionId: string,
): void {
  void readJsonBody(req).then((body) => {
    const projectId = body && typeof body.projectId === 'string' ? body.projectId : '';
    const gateName = body && typeof body.gateName === 'string' ? body.gateName : '';
    const capability = body && typeof body.capability === 'string' ? body.capability : '';
    const nonce = body && typeof body.nonce === 'string' ? body.nonce : '';
    if (!projectId || !gateName || !capability || !nonce) {
      writeJson(res, 400, {
        signal: 'APPROVAL_REQUEST_MALFORMED',
        message: 'projectId, gateName, capability and nonce are all required',
      });
      return;
    }

    const operations = context.approvalOperations;
    if (!operations) {
      // A host that wired no operation store cannot accept work it has nowhere to
      // record. Saying so beats accepting and losing it.
      writeJson(res, 501, {
        signal: 'APPROVAL_OPERATIONS_NOT_AVAILABLE',
        message: 'this host does not accept asynchronous approvals; use the synchronous route',
      });
      return;
    }

    // The same session check the synchronous route makes, and for the same
    // reason — one session must not spend another's capability — but made BEFORE
    // an operation record exists.
    const capabilityId = capability.split('.')[0] ?? '';
    const stored = context.approvalCapabilities.describe(capabilityId);
    if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= Date.now()) {
      writeJson(res, 404, {
        signal: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN,
        message: 'no live capability with that id on this host',
      });
      return;
    }
    if (stored.sessionId !== humanSessionId) {
      writeJson(res, 403, {
        signal: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION,
        message: 'that capability was issued to a different human session',
      });
      return;
    }

    const submission = operations.submit({ workspacePath, projectId, gateName, sessionId: humanSessionId });
    if (!submission.accepted) {
      // 409, not 400: the request is well formed and would be valid at another
      // moment. A client told "bad request" retries with different input; one
      // told "conflict" polls the operation it was just handed the id of.
      writeJson(res, 409, { signal: submission.code, message: submission.message });
      return;
    }

    const { operationId } = submission.operation;
    // ACCEPTED, not approved. 202 is the whole point of this route: the gate is
    // NOT approved at this moment, and a client that read 200 as done would
    // report an outcome that has not happened.
    writeJson(res, 202, {
      signal: APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_SUBMITTED,
      operationId,
      projectId,
      gateName,
      state: 'submitted',
      // NO `poll` URL. The first draft echoed one back, built by interpolating
      // AGENT_ROUTE_PREFIX — which put a path literal in this file that names no
      // route, and the dispatcher-literal guard in `agent-auth.test.ts` caught it.
      // That guard exists to find a path the router serves without a table entry,
      // and a URL the server merely *quotes* is exactly the noise that would
      // train someone to loosen it. The client already holds both halves: it just
      // called this route on this workspace, and it now has the id.
    });

    // The response is already sent. From here nothing may write to `res`, and
    // every outcome goes into the store instead — which is what the client polls.
    void runApprovalOperation({
      context,
      operations,
      operationId,
      workspacePath,
      projectId,
      gateName,
      capability,
      nonce,
      fallbackMachine: stored.machine,
    });
  }).catch((error: unknown) => guardRouteFailure(res, context, 'approval-submit', error));
}

/**
 * Run one approval to completion, recording every outcome in the store.
 *
 * THE RESPONSE HAS ALREADY GONE. So this function's only job is to leave the
 * store holding something true, and its failure mode is not "the client sees an
 * error" but "the client sees nothing, or sees the wrong thing, forever".
 *
 * `refuseIfChecksWouldRun` is deliberately NOT set: running the checks is the
 * entire reason this path exists. `onRefusal: 'throw'` is not optional — porch's
 * CLI answers a refusal with `process.exit(1)`, and that inside Tower would end
 * the process.
 */
async function runApprovalOperation(input: {
  readonly context: AgentRouteContext;
  readonly operations: ApprovalOperationStore;
  readonly operationId: string;
  readonly workspacePath: string;
  readonly projectId: string;
  readonly gateName: string;
  readonly capability: string;
  readonly nonce: string;
  readonly fallbackMachine: string;
}): Promise<void> {
  const { context, operations, operationId } = input;
  try {
    // WHAT IS BEING RUN, read before it starts.
    //
    // `markRunning` took these from the first commit and nothing ever passed
    // them, so `phase` and `checks` could never appear in a poll response — the
    // store accepted them, the response spread them, and the one call that would
    // populate them passed neither. An operator polling `running` got the word
    // and nothing to wait on, which is a spinner.
    operations.markRunning(
      operationId,
      await describeWork(input.workspacePath, input.projectId, input.gateName),
    );
    const { approve } = await import('../../commands/porch/index.js');
    const result = await approve(input.workspacePath, input.projectId, input.gateName, true, undefined, {
      // The SAME deliberately minimal environment the synchronous route uses.
      // Inheriting process.env would carry Tower's own CODEV_ARCHITECT_NAME /
      // CODEV_WORKTREE_ROOT into the caller attribution and record this approval
      // as an architect session, which it is not.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.CODEV_AGENT_FARM_DIR
          ? { CODEV_AGENT_FARM_DIR: process.env.CODEV_AGENT_FARM_DIR }
          : {}),
        [CAPABILITY_ENV_VAR]: input.capability,
        [NONCE_ENV_VAR]: input.nonce,
      },
      cwd: input.workspacePath,
      capabilities: context.approvalCapabilities,
      nonces: context.approvalNonces,
      onRefusal: 'throw',
      // NOT SET, and that is this route's whole reason for existing.
    });

    const record = result.record;
    operations.settle(operationId, {
      state: 'succeeded',
      record: {
        // EVERY FIELD FROM WHAT PORCH PERSISTED. `approve` returns normally when
        // the gate was ALREADY approved, so reporting the requesting session and
        // a fresh timestamp would claim this session approved a gate somebody
        // else had — the defect the synchronous route was fixed for.
        machine: record?.machine ?? input.fallbackMachine,
        sessionId: record?.session_id ?? null,
        approvedAt: result.approvedAt ?? null,
        ...(record?.authority ? { authority: record.authority } : {}),
        outcome: result.outcome,
        // FORWARDED, as the synchronous route has always done. Dropping these
        // reported a `committed-not-pushed` approval as plain success — a caveat
        // on a real approval, removed on the path ordinary projects must use.
        ...(result.delivery
          ? { delivery: result.delivery, deliveryMessage: result.deliveryMessage }
          : {}),
      },
    });
  } catch (error) {
    await settleApprovalFailure(input, error);
  }
}

/**
 * The phase this approval will run, and the checks it will run there.
 *
 * Asked with PORCH'S OWN COMPUTATION — `getPhaseChecks` after overrides — rather
 * than a second reading of the protocol that could drift from it. The names an
 * operator is shown while waiting are then the names of the commands that
 * actually run.
 *
 * Best effort by design: this is display content for a `running` record, and a
 * project whose protocol cannot be loaded still has an approval worth running.
 * It reports what it could read and nothing it could not.
 */
async function describeWork(
  workspacePath: string,
  projectId: string,
  gateName: string,
): Promise<{ phase?: string; checks?: readonly string[] }> {
  try {
    const status = readWorkspaceStatuses(workspacePath, buildersOf(workspacePath))
      .find((result) => result.ok && result.status.projectId === projectId);
    if (!status?.ok) return {};

    /*
     * `verify-approval` MOVES THE PHASE BEFORE THE CHECKS ARE COMPUTED.
     *
     * `approve()` enters `verify` first — its own comment says why: so the checks
     * below are the verify phase's, which are none. Reading the phase off
     * `status.yaml` therefore names the phase the project is LEAVING, and would
     * report `review`'s check set for a run that executes verify's.
     *
     * This is the one case where this display could be confidently wrong rather
     * than merely absent, so it is special-cased rather than left to the general
     * read. The answer does not depend on the transition succeeding: if it
     * cannot, `approve` throws and nothing runs.
     */
    if (gateName === 'verify-approval') return { phase: 'verify', checks: [] };
    const { loadProtocol, getPhaseChecks } = await import('../../commands/porch/protocol.js');
    const { loadCheckOverrides } = await import('../../commands/porch/config.js');
    const protocol = loadProtocol(workspacePath, status.status.protocol);
    const overrides = loadCheckOverrides(workspacePath, status.status.protocol);
    const checks = Object.keys(
      getPhaseChecks(protocol, status.status.phase, overrides ?? undefined, workspacePath),
    );
    return { phase: status.status.phase, ...(checks.length > 0 ? { checks } : {}) };
  } catch {
    // A protocol that will not load is not a reason to refuse the approval —
    // porch will reach the same problem and report it properly. Saying nothing
    // here is honest; guessing a phase name would not be.
    return {};
  }
}

/**
 * Record why an approval did not succeed — refusal, or failure, or neither.
 *
 * THE THIRD CASE IS THE ONE THAT MATTERS. Anything thrown AFTER porch wrote the
 * gate — a notification, a phase advance, a bug — would otherwise be recorded as
 * `failed`, telling an operator to approve a gate that is already approved. So
 * `status.yaml` is read before that conclusion is drawn, exactly as the
 * synchronous route's backstop does.
 */
async function settleApprovalFailure(
  input: {
    readonly context: AgentRouteContext;
    readonly operations: ApprovalOperationStore;
    readonly operationId: string;
    readonly workspacePath: string;
    readonly projectId: string;
    readonly gateName: string;
    readonly fallbackMachine: string;
  },
  error: unknown,
): Promise<void> {
  const { context, operations, operationId } = input;
  const message = error instanceof Error ? error.message : String(error);
  try {
    const { ApprovalRefusedError } = await import('../../commands/porch/index.js');
    if (error instanceof ApprovalRefusedError) {
      // A REFUSAL IS NOT A FAILURE. Porch declining because a precondition is
      // unmet is porch working; recording it as `failed` would send an operator
      // to debug a host when their checks did not pass.
      operations.settle(operationId, { state: 'refused', code: error.code, message: error.message });
      return;
    }

    const persisted = readScopedGate(input.workspacePath, input.projectId, input.gateName);
    if (persisted?.status === 'approved') {
      operations.settle(operationId, {
        state: 'succeeded',
        record: {
          machine: persisted.approval?.machine ?? input.fallbackMachine,
          sessionId: persisted.approval?.session_id ?? null,
          approvedAt: persisted.approved_at ?? null,
          ...(persisted.approval?.authority ? { authority: persisted.approval.authority } : {}),
          outcome: 'approved',
        },
      });
      context.log('WARN', `approval ${operationId} wrote the gate and then failed: ${message}`);
      return;
    }
    operations.settle(operationId, { state: 'failed', message });
  } catch (settleError) {
    // The store itself would not take the outcome. Nothing can be recorded, so
    // say so where an operator will find it — the record stays `running` until
    // the next startup pass resolves it, which is exactly what that pass is for.
    context.log(
      'ERROR',
      `approval ${operationId} could not be settled (${(settleError as Error).message}); `
      + `the outcome it could not record was: ${message}`,
    );
  }
}

/**
 * The signal that matches an operation's state.
 *
 * `succeeded`, `refused` and `failed` share `APPROVAL_OPERATION_SETTLED` because
 * `state` already says which — a second code per outcome would be two places to
 * keep in step for one fact. `interrupted` keeps its own, because it is the one
 * terminal state that says something about THIS HOST rather than about the
 * approval, and the matrix classifies it as a failure row for that reason.
 */
function signalForState(state: ApprovalOperationState): string {
  if (state === 'interrupted') return APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_INTERRUPTED;
  if (state === 'submitted' || state === 'running') {
    return APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_SUBMITTED;
  }
  return APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_SETTLED;
}

/** Report one submitted approval. Every field is what the store holds. */
function handleApprovalOperation(
  res: http.ServerResponse,
  url: URL,
  context: AgentRouteContext,
  humanSessionId: string,
): void {
  const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approvals\/([^/]+)$/);
  const operationId = match ? decodeURIComponent(match[2]) : '';
  const operations = context.approvalOperations;
  if (!operations) {
    writeJson(res, 501, {
      signal: 'APPROVAL_OPERATIONS_NOT_AVAILABLE',
      message: 'this host does not accept asynchronous approvals',
    });
    return;
  }

  let operation;
  try {
    operation = operations.describe(operationId);
  } catch (error) {
    // UNREADABLE IS NOT UNKNOWN. Answering "no such operation" here would tell a
    // client its approval never existed because a file on this host is corrupt.
    context.log('ERROR', `approval operation store unreadable: ${(error as Error).message}`);
    writeJson(res, 503, {
      signal: APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_STORE_UNREADABLE,
      message: 'the approval operation store could not be read',
    });
    return;
  }

  if (!operation) {
    writeJson(res, 404, {
      signal: APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_UNKNOWN,
      message: 'no approval operation with that id on this host',
    });
    return;
  }
  // One session must not read another's approval, for the same reason it cannot
  // spend another's capability.
  if (operation.sessionId !== humanSessionId) {
    writeJson(res, 403, {
      signal: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION,
      message: 'that approval was submitted by a different human session',
    });
    return;
  }

  writeJson(res, 200, {
    // DERIVED FROM THE STATE, not fixed at "submitted". A settled operation
    // answering `APPROVAL_OPERATION_SUBMITTED` is a label that contradicts the
    // field beside it, and a label is what gets read.
    signal: signalForState(operation.state),
    operationId: operation.operationId,
    projectId: operation.projectId,
    gateName: operation.gateName,
    state: operation.state,
    submittedAt: operation.submittedAt,
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.settledAt ? { settledAt: operation.settledAt } : {}),
    ...(operation.phase ? { phase: operation.phase } : {}),
    ...(operation.checks ? { checks: operation.checks } : {}),
    ...(operation.code ? { code: operation.code } : {}),
    ...(operation.message ? { message: operation.message } : {}),
    ...(operation.record ? { record: operation.record } : {}),
    ...(operation.gateAfterInterruption
      ? { gateAfterInterruption: operation.gateAfterInterruption }
      : {}),
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

    case 'human-session-issue':
      handleHumanSessionIssue(req, res, context, outcome.machine as string);
      return true;

    case 'machine-credential-revoke':
      handleMachineRevoke(res, url, context);
      return true;

    case 'approval-capability-issue':
    case 'approval-nonce-mint':
    case 'approval-capability-revoke-machine':
      handleApprovalRoute(
        req, res, url, context,
        outcome.humanSessionId as string,
        outcome.humanSessionAuthority,
      );
      return true;

    case 'gate-approve': {
      const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approve$/);
      const workspace = match ? decodeWorkspace(match[1]) : null;
      if (!workspace) {
        writeJson(res, 400, { signal: 'WORKSPACE_PATH_INVALID' });
        return true;
      }
      if (!context.isKnownWorkspace(workspace)) {
        writeJson(res, 404, { signal: 'WORKSPACE_NOT_REGISTERED' });
        return true;
      }
      handleGateApprove(req, res, workspace, context, outcome.humanSessionId as string);
      return true;
    }

    case 'approval-submit': {
      const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approvals$/);
      const workspace = match ? decodeWorkspace(match[1]) : null;
      if (!workspace) {
        writeJson(res, 400, { signal: 'WORKSPACE_PATH_INVALID' });
        return true;
      }
      if (!context.isKnownWorkspace(workspace)) {
        writeJson(res, 404, { signal: 'WORKSPACE_NOT_REGISTERED' });
        return true;
      }
      handleApprovalSubmit(req, res, workspace, context, outcome.humanSessionId as string);
      return true;
    }

    case 'approval-operation': {
      const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approvals\/([^/]+)$/);
      const workspace = match ? decodeWorkspace(match[1]) : null;
      if (!workspace) {
        writeJson(res, 400, { signal: 'WORKSPACE_PATH_INVALID' });
        return true;
      }
      if (!context.isKnownWorkspace(workspace)) {
        writeJson(res, 404, { signal: 'WORKSPACE_NOT_REGISTERED' });
        return true;
      }
      handleApprovalOperation(res, url, context, outcome.humanSessionId as string);
      return true;
    }

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
        // The credential presented at the handshake, re-checked for as long as
        // the stream lives. Authenticating once and then streaming for hours is
        // a credential that cannot be revoked — and success criterion 15 says a
        // revoked machine's subtree fails closed, which an open stream is.
        const presented = req.headers[MACHINE_CREDENTIAL_HEADER];
        const credential = Array.isArray(presented) ? presented[0] : presented;
        openAgentStateSse(req, res, {
          workspacePath: workspace,
          snapshot: () => buildAgentProtocolSnapshot(context, workspace),
          stillAuthorized: () => {
            const verdict = context.machineCredentials.verify(credential);
            return { ok: verdict.authorized, code: verdict.code, message: verdict.message };
          },
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
