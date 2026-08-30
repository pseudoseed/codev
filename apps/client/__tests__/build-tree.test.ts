import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/tree/build.js';
import type { MachineConfig, MachineState } from '../src/connection/machine.js';
import type { AgentProtocolSnapshot, ThreadIdentity } from '../src/connection/types.js';

const config: MachineConfig = {
  id: 'alpha',
  label: 'alpha',
  origin: 'http://127.0.0.1:4100',
  workspacePath: '/w',
  credential: 'id.secret',
};

function snapshot(identities: ThreadIdentity[], t3code: AgentProtocolSnapshot['protocol']['t3code'] = 'available'): AgentProtocolSnapshot {
  return {
    schemaVersion: 1,
    workspacePath: '/w',
    generatedAt: '2026-08-29T12:00:00Z',
    protocol: { t3code, architects: {}, builders: {}, identities, statuses: [], signals: [] },
  };
}

function machine(over: Partial<MachineState> = {}): MachineState {
  return {
    config,
    status: 'live',
    why: null,
    message: null,
    snapshot: snapshot([]),
    lastLiveAt: '2026-08-29T12:00:00Z',
    retrying: true,
    ...over,
  };
}

const architect: ThreadIdentity = {
  backing: 'thread',
  threadId: 'th-arch',
  role: 'architect',
  roleId: 'main',
  workspacePath: '/w',
  management: 'unmanaged',
  session: { status: 'ready', settled: false },
};

function builder(id: string, over: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return {
    backing: 'thread',
    threadId: `th-${id}`,
    role: 'builder',
    roleId: id,
    workspacePath: '/w',
    worktree: `/w/.builders/${id}`,
    management: 'managed',
    session: { status: 'running', settled: false },
    ...over,
  };
}

describe('buildTree', () => {
  it('nests builders under the architect that spawned them', () => {
    const tree = buildTree([machine({
      snapshot: snapshot([architect, builder('air-220', { spawnedByArchitect: 'main' })]),
    })]);
    const group = tree[0].workspace!.architects[0];
    expect(group.architect.name).toBe('main');
    expect(group.builders.map((row) => row.name)).toEqual(['air-220']);
    expect(tree[0].workspace!.unattributedBuilders).toHaveLength(0);
  });

  it('does not guess a parent for a builder no architect here spawned', () => {
    const tree = buildTree([machine({
      snapshot: snapshot([architect, builder('air-220', { spawnedByArchitect: 'someone-else' })]),
    })]);
    expect(tree[0].workspace!.architects[0].builders).toHaveLength(0);
    expect(tree[0].workspace!.unattributedBuilders.map((row) => row.name)).toEqual(['air-220']);
  });

  it('renders a thread with no porch record as unmanaged rather than hiding it', () => {
    const tree = buildTree([machine({
      snapshot: snapshot([{
        backing: 'thread',
        threadId: 'th-loose',
        role: 'unmanaged',
        workspacePath: '/w',
        management: 'unmanaged',
      }]),
    })]);
    expect(tree[0].workspace!.unmanagedThreads.map((row) => row.threadId)).toEqual(['th-loose']);
  });

  it('sorts gate-blocked rows to the top', () => {
    const blocked = builder('air-9', {
      spawnedByArchitect: 'main',
      porch: {
        projectId: '9',
        title: 't',
        protocol: 'air',
        phase: 'implement',
        currentPlanPhase: null,
        gates: { 'plan-approval': { status: 'pending', requested_at: '2026-08-29T11:00:00Z' } },
        artifactRoot: '/w/.builders/air-9',
        statusPath: '/w/.builders/air-9/codev/projects/9/status.yaml',
      },
    });
    const tree = buildTree([machine({
      snapshot: snapshot([architect, builder('air-220', { spawnedByArchitect: 'main' }), blocked]),
    })]);
    expect(tree[0].workspace!.architects[0].builders.map((row) => row.name)).toEqual(['air-9', 'air-220']);
  });

  it('keeps a machine that never delivered a snapshot as a machine with no workspace', () => {
    const tree = buildTree([machine({ status: 'disconnected', snapshot: null, lastLiveAt: null, why: 'transport' })]);
    expect(tree[0].workspace).toBeNull();
    expect(tree[0].connection.status).toBe('disconnected');
  });

  it('retains the last snapshot while disconnected so it can be labelled stale', () => {
    const tree = buildTree([machine({
      status: 'disconnected',
      why: 'transport',
      message: 'the server closed the stream',
      snapshot: snapshot([architect]),
      lastLiveAt: '2026-08-29T11:59:00Z',
    })]);
    expect(tree[0].workspace!.architects).toHaveLength(1);
    expect(tree[0].connection.lastLiveAt).toBe('2026-08-29T11:59:00Z');
  });
});
