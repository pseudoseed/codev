import { describe, it, expect } from 'vitest';
import { IDLE_WAITING_THRESHOLD_MS } from '@cluesmith/codev-sdk/builder-helpers';
import type { V2Node } from '@cluesmith/codev-types';
import { architectId, builderId, workspaceId } from '../servers/v2-ids.js';
import { statusForArchitect, statusForBuilder, statusForWorkspace } from '../servers/v2-status.js';
import {
  projectHierarchy,
  type V2ArchitectRow,
  type V2BuilderRow,
  type V2Deps,
  type V2DiscoveredBuilder,
} from '../servers/v2-projection.js';

const NOW = 1_700_000_000_000;
const STALE = NOW - IDLE_WAITING_THRESHOLD_MS - 1;
const FRESH = NOW - 1_000;

const WS_A = '/tmp/ws-a';
const WS_B = '/tmp/ws-b';

function byId(nodes: V2Node[]): Map<string, V2Node> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function fakeDeps(overrides: Partial<{
  workspaces: string[];
  builders: Record<string, V2DiscoveredBuilder[]>;
  rows: Record<string, V2BuilderRow[]>;
  architects: Record<string, V2ArchitectRow[]>;
  held: Set<string>;
  liveRoles: Set<string>;
  liveTerminals: Set<string>;
  terminalCounts: Record<string, number>;
  lastDataAt: Record<string, number>;
}> = {}): V2Deps {
  const workspaces = overrides.workspaces ?? [WS_A];
  const builders = overrides.builders ?? {};
  const rows = overrides.rows ?? {};
  const architects = overrides.architects ?? {};
  const held = overrides.held ?? new Set<string>();
  const liveRoles = overrides.liveRoles ?? new Set<string>();
  const liveTerminals = overrides.liveTerminals ?? new Set<string>();
  const terminalCounts = overrides.terminalCounts ?? {};
  const lastDataAt = overrides.lastDataAt ?? {};
  return {
    listWorkspaces: () => workspaces,
    discoverBuilders: (ws) => builders[ws] ?? [],
    getBuilders: (ws) => rows[ws] ?? [],
    getArchitects: (ws) => architects[ws] ?? [],
    heldByAgent: (ws, toAgent) => held.has(`${ws}|${toAgent.toLowerCase()}`),
    sessionForRole: (ws, roleId) => liveRoles.has(`${ws}|${roleId}`),
    sessionForTerminal: (id) => liveTerminals.has(id),
    terminalsForWorkspace: (ws) => terminalCounts[ws] ?? 0,
    lastDataAt: (ws, roleId) => lastDataAt[`${ws}|${roleId}`] ?? null,
    bytesWritten: () => 0,
  };
}

function discovered(
  dir: string,
  extra: Partial<V2DiscoveredBuilder> = {},
  ws = WS_A,
): V2DiscoveredBuilder {
  return {
    worktreePath: `${ws}/.builders/${dir}`,
    roleId: `builder-${dir.toLowerCase()}`,
    blockedGate: null,
    ...extra,
  };
}

describe('v2-status', () => {
  it('resolves each 4b case to exactly one status', () => {
    expect(statusForBuilder({
      blockedGate: null,
      live: true,
      lastDataAt: STALE,
      now: NOW,
    })).toBe('stalled');

    expect(statusForBuilder({
      blockedGate: null,
      live: true,
      lastDataAt: NOW,
      now: NOW,
    })).toBe('running');

    expect(statusForBuilder({
      blockedGate: null,
      live: true,
      lastDataAt: null,
      now: NOW,
    })).toBe('running');

    expect(statusForBuilder({
      blockedGate: null,
      live: false,
      lastDataAt: null,
      now: NOW,
    })).toBe('offline');

    expect(statusForBuilder({
      blockedGate: 'plan-approval',
      live: true,
      lastDataAt: STALE,
      now: NOW,
    })).toBe('gate-waiting');
  });

  it('never emits gate-waiting or stalled for architects or workspaces', () => {
    expect(statusForArchitect(true)).toBe('running');
    expect(statusForArchitect(false)).toBe('offline');
    expect(statusForWorkspace(1)).toBe('running');
    expect(statusForWorkspace(0)).toBe('offline');
  });
});

describe('v2-ids', () => {
  it('qualifies builder ids by workspace so the same dir name does not collide', () => {
    expect(builderId(WS_A, 'experiment-39')).toBe(`builder:${WS_A}#experiment-39`);
    expect(builderId(WS_B, 'experiment-39')).toBe(`builder:${WS_B}#experiment-39`);
    expect(builderId(WS_A, 'experiment-39')).not.toBe(builderId(WS_B, 'experiment-39'));
  });
});

describe('projectHierarchy', () => {
  it('scenario 7b: same local builder dir in two workspaces is two nodes', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      workspaces: [WS_A, WS_B],
      builders: {
        [WS_A]: [discovered('experiment-39', {}, WS_A)],
        [WS_B]: [discovered('experiment-39', {}, WS_B)],
      },
    }));
    const a = byId(nodes).get(builderId(WS_A, 'experiment-39'));
    const b = byId(nodes).get(builderId(WS_B, 'experiment-39'));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
  });

  it('scenario 9e: worktree with no session is offline and present', () => {
    const { nodes, counts } = projectHierarchy(NOW, fakeDeps({
      builders: { [WS_A]: [discovered('spir-52')] },
    }));
    const node = byId(nodes).get(builderId(WS_A, 'spir-52'));
    expect(node).toBeDefined();
    expect(node!.status).toBe('offline');
    expect(node!.lastDataAt).toBeNull();
    expect(counts.builders.total).toBe(1);
    expect(counts.builders.byStatus.offline).toBe(1);
  });

  it('parents to the spawning architect when that architect is in the projection', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      architects: { [WS_A]: [{ name: 'uiv2', terminalId: 't-arch' }] },
      liveTerminals: new Set(['t-arch']),
      terminalCounts: { [WS_A]: 1 },
      builders: { [WS_A]: [discovered('spir-52')] },
      rows: {
        [WS_A]: [{
          worktree: `${WS_A}/.builders/spir-52`,
          spawnedByArchitect: 'uiv2',
        }],
      },
    }));
    const node = byId(nodes).get(builderId(WS_A, 'spir-52'));
    expect(node).toBeDefined();
    expect(node!.parentId).toBe(architectId(WS_A, 'uiv2'));
    expect(node!.parentId).not.toBe(workspaceId(WS_A));
  });

  it('scenario 9f: null spawnedByArchitect, or an architect not in the projection, parents to the workspace', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      architects: { [WS_A]: [{ name: 'main', terminalId: 't-main' }] },
      liveTerminals: new Set(['t-main']),
      terminalCounts: { [WS_A]: 1 },
      builders: {
        [WS_A]: [discovered('legacy'), discovered('orphan')],
      },
      rows: {
        [WS_A]: [
          { worktree: `${WS_A}/.builders/legacy`, spawnedByArchitect: null },
          { worktree: `${WS_A}/.builders/orphan`, spawnedByArchitect: 'gone-arch' },
        ],
      },
    }));
    const map = byId(nodes);
    expect(map.get(builderId(WS_A, 'legacy'))!.parentId).toBe(workspaceId(WS_A));
    expect(map.get(builderId(WS_A, 'orphan'))!.parentId).toBe(workspaceId(WS_A));
  });

  it('scenario 9g: architect and workspace with no session are present as offline', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      architects: { [WS_A]: [{ name: 'main', terminalId: 'missing' }] },
      terminalCounts: { [WS_A]: 0 },
    }));
    const map = byId(nodes);
    expect(map.get(workspaceId(WS_A))!.status).toBe('offline');
    expect(map.get(architectId(WS_A, 'main'))!.status).toBe('offline');
  });

  it('scenario 5c: eligible held mail sets the flag; a non-eligible agent stays false', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      architects: { [WS_A]: [{ name: 'main', terminalId: 't-main' }] },
      liveTerminals: new Set(['t-main']),
      liveRoles: new Set([`${WS_A}|builder-spir-52`]),
      lastDataAt: { [`${WS_A}|builder-spir-52`]: FRESH },
      terminalCounts: { [WS_A]: 1 },
      builders: { [WS_A]: [discovered('spir-52'), discovered('quiet')] },
      held: new Set([`${WS_A}|builder-spir-52`, `${WS_A}|main`]),
    }));
    const map = byId(nodes);
    expect(map.get(builderId(WS_A, 'spir-52'))!.flags.heldMail).toBe(true);
    expect(map.get(builderId(WS_A, 'quiet'))!.flags.heldMail).toBe(false);
    expect(map.get(architectId(WS_A, 'main'))!.flags.heldMail).toBe(true);
    expect(map.get(builderId(WS_A, 'spir-52'))!.lastDataAt).toBe(new Date(FRESH).toISOString());
  });

  it('does not put buckets on projected nodes', () => {
    const { nodes } = projectHierarchy(NOW, fakeDeps({
      builders: { [WS_A]: [discovered('spir-52')] },
    }));
    expect(byId(nodes).get(builderId(WS_A, 'spir-52'))!.buckets).toBeUndefined();
  });

  it('counts gateWaiting across the whole hierarchy', () => {
    const { counts } = projectHierarchy(NOW, fakeDeps({
      workspaces: [WS_A, WS_B],
      builders: {
        [WS_A]: [discovered('in-gate', { blockedGate: 'plan-approval' }, WS_A)],
        [WS_B]: [discovered('running', {}, WS_B)],
      },
      liveRoles: new Set([`${WS_B}|builder-running`]),
      lastDataAt: { [`${WS_B}|builder-running`]: FRESH },
    }));
    expect(counts.gateWaiting).toBe(1);
    expect(counts.builders.total).toBe(2);
    expect(counts.workspaces).toBe(2);
  });
});
