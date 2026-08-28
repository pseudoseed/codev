import type { V2Counts, V2Node, V2Status } from '@cluesmith/codev-types';
import {
  architectId,
  builderId,
  workspaceId,
  workspaceName,
  worktreeDirName,
} from './v2-ids.js';
import { statusForArchitect, statusForBuilder, statusForWorkspace } from './v2-status.js';

export interface V2DiscoveredBuilder {
  worktreePath: string;
  roleId: string | null;
  blockedGate: string | null;
  /** Raw YAML trust-boundary value; validation deliberately happens in v2. */
  blockedGateRequest: unknown | null;
}

export interface V2BuilderRow {
  worktree: string;
  spawnedByArchitect?: string | null;
}

export interface V2ArchitectRow {
  name: string;
  terminalId?: string | null;
}

export interface V2Deps {
  listWorkspaces: () => string[];
  discoverBuilders: (workspacePath: string) => V2DiscoveredBuilder[];
  getBuilders: (workspacePath: string) => V2BuilderRow[];
  getArchitects: (workspacePath: string) => V2ArchitectRow[];
  heldByAgent: (workspacePath: string, toAgent: string, now: number) => boolean;
  sessionForRole: (workspacePath: string, roleId: string) => boolean;
  sessionForTerminal: (terminalId: string) => boolean;
  terminalsForWorkspace: (workspacePath: string) => number;
  lastDataAt: (workspacePath: string, roleId: string) => number | null;
  bytesWritten: (workspacePath: string, roleId: string) => number;
}

export interface V2Projection {
  nodes: V2Node[];
  counts: V2Counts;
}

function emptyByStatus(): Record<V2Status, number> {
  return { 'gate-waiting': 0, stalled: 0, running: 0, offline: 0 };
}

export function projectHierarchy(now: number, deps: V2Deps): V2Projection {
  const nodes: V2Node[] = [];
  const byStatus = emptyByStatus();
  let builderTotal = 0;
  const workspaces = deps.listWorkspaces();

  for (const ws of workspaces) {
    const wsId = workspaceId(ws);
    nodes.push({
      id: wsId,
      kind: 'workspace',
      parentId: null,
      name: workspaceName(ws),
      status: statusForWorkspace(deps.terminalsForWorkspace(ws)),
      flags: { heldMail: false },
      lastDataAt: null,
      blockedGate: null,
      blockedGateRequest: null,
    });

    const architects = deps.getArchitects(ws);
    const architectNames = new Set(architects.map((a) => a.name));
    for (const architect of architects) {
      const live = Boolean(architect.terminalId && deps.sessionForTerminal(architect.terminalId));
      nodes.push({
        id: architectId(ws, architect.name),
        kind: 'architect',
        parentId: wsId,
        name: architect.name,
        status: statusForArchitect(live),
        flags: { heldMail: deps.heldByAgent(ws, architect.name, now) },
        lastDataAt: null,
        blockedGate: null,
        blockedGateRequest: null,
      });
    }

    const rows = deps.getBuilders(ws);
    const rowByWorktree = new Map(rows.map((row) => [row.worktree, row]));

    for (const discovered of deps.discoverBuilders(ws)) {
      const dirName = worktreeDirName(discovered.worktreePath);
      const live = discovered.roleId !== null && deps.sessionForRole(ws, discovered.roleId);
      const lastMs = live && discovered.roleId ? deps.lastDataAt(ws, discovered.roleId) : null;
      const status = statusForBuilder({
        blockedGate: discovered.blockedGate,
        live,
        lastDataAt: lastMs,
        now,
      });
      const spawned = rowByWorktree.get(discovered.worktreePath)?.spawnedByArchitect ?? null;
      const parentId =
        spawned && architectNames.has(spawned) ? architectId(ws, spawned) : wsId;
      const agent = discovered.roleId;
      // Deliberate unchecked serialization seam: overview preserves malformed
      // YAML request values so the v2 client can fail the enclosing frame loudly.
      const blockedGateRequest = discovered.blockedGateRequest as V2Node['blockedGateRequest'];
      nodes.push({
        id: builderId(ws, dirName),
        kind: 'builder',
        parentId,
        name: dirName,
        status,
        flags: { heldMail: agent !== null && deps.heldByAgent(ws, agent, now) },
        lastDataAt: lastMs === null ? null : new Date(lastMs).toISOString(),
        blockedGate: discovered.blockedGate,
        blockedGateRequest,
      });
      builderTotal += 1;
      byStatus[status] += 1;
    }
  }

  const counts: V2Counts = {
    workspaces: workspaces.length,
    builders: { total: builderTotal, byStatus },
    gateWaiting: byStatus['gate-waiting'],
  };

  return { nodes, counts };
}
