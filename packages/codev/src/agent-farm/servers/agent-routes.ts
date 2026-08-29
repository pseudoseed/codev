/** codev-agent HTTP surface added beside Tower's terminal routes (Spec 146). */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { decodeWorkspacePath } from '../lib/tower-client.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { openAgentStateSse, type AgentStreamSnapshot } from './agent-state-stream.js';
import { readWorkspaceStatuses } from './status-reader.js';
import {
  readThreadRegistry,
  type T3codeThreadSnapshot,
  type ThreadRegistrySnapshot,
} from './thread-registry.js';

export const AGENT_ROUTE_PREFIX = '/api/agent/v1';
export const HUMAN_SESSION_HEADER = 'x-codev-human-session';

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
  readonly reason?: 'MISSING' | 'MALFORMED' | 'UNKNOWN' | 'EXPIRED' | 'IDLE' | 'INVALID';
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
    const stored = this.#sessions.get(sessionId);
    if (!stored) return { paired: false, reason: 'UNKNOWN' };
    const now = this.now();
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
    return this.#sessions.delete(sessionId);
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

/**
 * Return true when the request belongs to codev-agent.  Called only after
 * Tower's existing request-authentication choke point, so terminal routes keep
 * their byte-for-byte behaviour and auth policy during the additive window.
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

  if (req.method === 'GET' && url.pathname === `${AGENT_ROUTE_PREFIX}/session`) {
    const header = req.headers[HUMAN_SESSION_HEADER];
    const presentation = Array.isArray(header) ? header[0] : header;
    const recognition = context.humanSessions.recognize(presentation);
    writeJson(res, recognition.paired ? 200 : 401, {
      signal: recognition.paired ? 'HUMAN_SESSION_RECOGNISED' : 'HUMAN_SESSION_REQUIRED',
      ...recognition,
    });
    return true;
  }

  const match = url.pathname.match(/^\/api\/agent\/v1\/workspaces\/([^/]+)\/(state|stream)$/);
  if (!match || req.method !== 'GET') {
    writeJson(res, 404, { signal: 'AGENT_ROUTE_NOT_FOUND' });
    return true;
  }
  const workspace = decodeWorkspace(match[1]);
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

  if (match[2] === 'state') {
    writeJson(res, 200, buildAgentProtocolSnapshot(context, workspace).payload);
  } else {
    openAgentStateSse(req, res, {
      workspacePath: workspace,
      snapshot: () => buildAgentProtocolSnapshot(context, workspace),
    });
  }
  return true;
}
