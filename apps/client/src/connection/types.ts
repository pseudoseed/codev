/**
 * The wire shape of `GET /api/agent/v1/workspaces/<workspace>/state` and of the
 * `protocol-state` SSE frames on `.../stream`.
 *
 * Hand-mirrored from `agent-routes.ts` and `thread-registry.ts` rather than
 * imported: this app runs in a browser and those modules reach `node:fs` and
 * `better-sqlite3` through their import graph. `validateSnapshot` is what keeps
 * the mirror honest — an unrecognised payload is refused, not rendered.
 */

export interface GateRequestChoice {
  readonly label: string;
  readonly consequence: string;
  readonly recommended?: boolean;
}

export interface GateRequest {
  readonly question: string;
  readonly choices: readonly GateRequestChoice[];
  readonly terminalExcerpt?: string;
}

export interface GateStatus {
  readonly status: 'pending' | 'approved';
  readonly requested_at?: string;
  readonly approved_at?: string;
  readonly request?: GateRequest;
}

export interface PorchStatusProjection {
  readonly projectId: string;
  readonly title: string;
  readonly protocol: string;
  readonly phase: string;
  readonly currentPlanPhase: string | null;
  readonly gates: Readonly<Record<string, GateStatus>>;
  readonly threadId?: string;
  readonly updatedAt?: string;
  readonly artifactRoot: string;
  readonly statusPath: string;
}

export interface ThreadIdentity {
  /**
   * `terminal` while a row is still driven by a PTY rather than a t3code thread.
   * The dual-write window is real, and a client that publishes only thread-backed
   * rows renders a busy workspace as empty.
   */
  readonly backing: 'thread' | 'terminal';
  readonly threadId?: string;
  readonly role: 'architect' | 'builder' | 'unmanaged';
  readonly roleId?: string;
  readonly workspacePath: string;
  readonly worktree?: string;
  readonly management: 'managed' | 'unmanaged';
  readonly porch?: PorchStatusProjection;
  readonly spawnedByArchitect?: string;
  readonly sessionState?: string;
}

export interface AgentStateSignal {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly role?: string;
  readonly roleId?: string;
}

/** Whether session state was observable at all. Never inferred from its absence. */
export type T3codeReachability = 'not-provided' | 'unreachable' | 'available';

export interface ThreadRegistrySnapshot {
  readonly t3code: T3codeReachability;
  readonly architects: Readonly<Record<string, string>>;
  readonly builders: Readonly<Record<string, string>>;
  readonly identities: readonly ThreadIdentity[];
  readonly statuses: readonly PorchStatusProjection[];
  readonly signals: readonly AgentStateSignal[];
}

export interface AgentProtocolSnapshot {
  readonly schemaVersion: 1;
  readonly workspacePath: string;
  readonly generatedAt: string;
  readonly protocol: ThreadRegistrySnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse a payload this build does not understand instead of rendering a
 * half-recognised one. A snapshot missing `protocol.t3code` is an OLDER SERVER,
 * and an older server's silence about session state must not be shown as
 * "t3code was asked and said nothing".
 */
export function validateSnapshot(value: unknown): AgentProtocolSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.workspacePath !== 'string' || value.workspacePath.length === 0) return null;
  if (typeof value.generatedAt !== 'string') return null;
  const protocol = value.protocol;
  if (!isRecord(protocol)) return null;
  if (protocol.t3code !== 'not-provided' && protocol.t3code !== 'unreachable' && protocol.t3code !== 'available') {
    return null;
  }
  if (!Array.isArray(protocol.identities)) return null;
  if (!Array.isArray(protocol.statuses)) return null;
  if (!Array.isArray(protocol.signals)) return null;
  if (!isRecord(protocol.architects) || !isRecord(protocol.builders)) return null;
  return value as unknown as AgentProtocolSnapshot;
}
