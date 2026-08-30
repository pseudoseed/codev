import type { MachineState } from '../connection/machine.js';
import { deriveRowStatus, type RowStatus } from '../status/derive.js';
import type {
  AgentStateSignal,
  PorchStatusProjection,
  T3codeObservation,
  T3codeReachability,
  ThreadIdentity,
} from '../connection/types.js';

export interface ThreadRow {
  readonly key: string;
  readonly backing: 'thread' | 'terminal';
  /** Absent while a row is still terminal-backed. */
  readonly threadId?: string;
  /** The Codev identity — architect name or builder id — when there is one. */
  readonly name: string;
  readonly role: 'architect' | 'builder' | 'unmanaged';
  readonly management: 'managed' | 'unmanaged';
  readonly worktree?: string;
  readonly porch?: PorchStatusProjection;
  readonly status: RowStatus;
}

export interface ArchitectGroup {
  readonly key: string;
  readonly architect: ThreadRow;
  readonly builders: readonly ThreadRow[];
}

export interface WorkspaceNode {
  readonly key: string;
  readonly path: string;
  readonly generatedAt: string;
  /**
   * Whether this server could observe session state at all. Reported once, at
   * the machine, rather than repeated on every row — and never omitted, because
   * a tree full of UNKNOWN with no stated cause reads as a broken client.
   */
  readonly sessionVisibility: T3codeReachability;
  /**
   * How old the reported session content is, when the server said. Absent on a
   * server that predates the field, and on every status that carries no content.
   */
  readonly sessionObservation?: T3codeObservation;
  readonly architects: readonly ArchitectGroup[];
  /**
   * Builders `global.db` does not attribute to an architect present here. They
   * are shown, under a group that says so — a builder placed under an architect
   * that did not spawn it is a wrong answer, and hiding it is worse.
   */
  readonly unattributedBuilders: readonly ThreadRow[];
  /** Threads with no porch record. Rendered as unmanaged, never filtered out. */
  readonly unmanagedThreads: readonly ThreadRow[];
  readonly signals: readonly AgentStateSignal[];
}

export interface MachineNode {
  readonly key: string;
  readonly label: string;
  readonly origin: string;
  readonly connection: MachineState;
  /** Null when this machine has never delivered a snapshot. */
  readonly workspace: WorkspaceNode | null;
}

function rowFrom(
  identity: ThreadIdentity,
  t3code: T3codeReachability,
  machineKey: string,
  observation?: T3codeObservation,
): ThreadRow {
  const label = identity.roleId ?? identity.threadId ?? 'unnamed';
  return {
    key: `${machineKey}:${identity.role}:${identity.roleId ?? identity.threadId ?? label}`,
    backing: identity.backing,
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    name: label,
    role: identity.role,
    management: identity.management,
    ...(identity.worktree ? { worktree: identity.worktree } : {}),
    ...(identity.porch ? { porch: identity.porch } : {}),
    status: deriveRowStatus(identity, t3code, observation),
  };
}

export function buildTree(machines: readonly MachineState[]): readonly MachineNode[] {
  return machines.map((connection) => {
    const key = connection.config.id;
    return {
      key,
      label: connection.config.label,
      origin: connection.config.origin,
      connection,
      workspace: connection.snapshot ? buildWorkspace(connection, key) : null,
    };
  });
}

function buildWorkspace(connection: MachineState, machineKey: string): WorkspaceNode {
  const snapshot = connection.snapshot!;
  const { protocol } = snapshot;
  const t3code = protocol.t3code;
  // Carried to every row because the STALE rule needs it: a row whose last-known
  // content reads as finished must report how old that is instead of the word.
  const observation = protocol.t3codeObservation;

  const architectRows = protocol.identities
    .filter((identity) => identity.role === 'architect')
    .map((identity) => rowFrom(identity, t3code, machineKey, observation));
  const architectNames = new Set(architectRows.map((row) => row.name));

  const grouped = new Map<string, ThreadRow[]>();
  for (const row of architectRows) grouped.set(row.name, []);
  const unattributed: ThreadRow[] = [];

  for (const identity of protocol.identities) {
    if (identity.role !== 'builder') continue;
    const row = rowFrom(identity, t3code, machineKey, observation);
    const parent = identity.spawnedByArchitect;
    if (parent !== undefined && architectNames.has(parent)) {
      grouped.get(parent)!.push(row);
    } else {
      unattributed.push(row);
    }
  }

  const unmanagedThreads = protocol.identities
    .filter((identity) => identity.role === 'unmanaged')
    .map((identity) => rowFrom(identity, t3code, machineKey, observation));

  return {
    key: `${machineKey}:${snapshot.workspacePath}`,
    path: snapshot.workspacePath,
    generatedAt: snapshot.generatedAt,
    sessionVisibility: t3code,
    ...(protocol.t3codeObservation ? { sessionObservation: protocol.t3codeObservation } : {}),
    architects: architectRows.map((architect) => ({
      key: architect.key,
      architect,
      builders: sortRows(grouped.get(architect.name) ?? []),
    })),
    unattributedBuilders: sortRows(unattributed),
    unmanagedThreads: sortRows(unmanagedThreads),
    signals: protocol.signals,
  };
}

/** Gates first: a row waiting on a human belongs where a human looks first. */
function sortRows(rows: readonly ThreadRow[]): readonly ThreadRow[] {
  return [...rows].sort((a, b) => {
    const blocked = Number(b.status.kind === 'blocked') - Number(a.status.kind === 'blocked');
    return blocked !== 0 ? blocked : a.name.localeCompare(b.name);
  });
}
