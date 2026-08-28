import { describe, expect, it } from 'vitest';
import { initialReducerState } from '../src/lib/reducer.js';
import { buildTree, workspaceLabel } from '../src/lib/tree.js';
import type { ClientNode } from '../src/lib/validate.js';

function node(over: Partial<ClientNode> & Pick<ClientNode, 'id' | 'kind'>): ClientNode {
  return {
    parentId: null,
    name: over.id,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    blockedGate: null,
    blockedGateRequest: null,
    ...over,
  };
}

describe('tree (D13, scenario 21)', () => {
  it('labels a dark workspace from the id basename', () => {
    expect(workspaceLabel('workspace:/tmp/ws-a')).toBe('ws-a');
  });

  it('places a builder under its workspace beside the architect', () => {
    const nodes = new Map<string, ClientNode>([
      ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'a' })],
      ['architect:1', node({ id: 'architect:1', kind: 'architect', parentId: 'workspace:/a', name: 'arch' })],
      ['builder:1', node({ id: 'builder:1', kind: 'builder', parentId: 'workspace:/a', name: 'b1' })],
    ]);
    const { plots, orphanArchitects, orphanBuilders } = buildTree(nodes, new Map());
    expect(plots).toHaveLength(1);
    expect(plots[0].architects.map((g) => g.node.name)).toEqual(['arch']);
    expect(plots[0].architects[0].builders).toEqual([]);
    expect(plots[0].builders.map((b) => b.name)).toEqual(['b1']);
    expect(orphanArchitects).toEqual([]);
    expect(orphanBuilders).toEqual([]);
  });

  it('nests a builder under its architect parent', () => {
    const nodes = new Map<string, ClientNode>([
      ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'a' })],
      ['architect:1', node({ id: 'architect:1', kind: 'architect', parentId: 'workspace:/a', name: 'arch' })],
      ['builder:1', node({ id: 'builder:1', kind: 'builder', parentId: 'architect:1', name: 'b1' })],
    ]);
    const { plots, orphanBuilders } = buildTree(nodes, new Map());
    expect(plots[0].architects[0].builders.map((b) => b.name)).toEqual(['b1']);
    expect(plots[0].builders).toEqual([]);
    expect(orphanBuilders).toEqual([]);
  });

  it('does not invent an architect parent by name', () => {
    const nodes = new Map<string, ClientNode>([
      ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'a' })],
      ['architect:pay', node({ id: 'architect:pay', kind: 'architect', parentId: 'workspace:/a', name: 'pay' })],
      ['builder:pay-1', node({ id: 'builder:pay-1', kind: 'builder', parentId: 'workspace:/a', name: 'pay-1' })],
    ]);
    const { plots } = buildTree(nodes, new Map());
    expect(plots[0].architects[0].builders).toEqual([]);
    expect(plots[0].builders[0].name).toBe('pay-1');
  });

  it('surfaces an unresolvable parent at machine level', () => {
    const nodes = new Map<string, ClientNode>([
      ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'a' })],
      ['architect:ghost', node({ id: 'architect:ghost', kind: 'architect', parentId: 'workspace:/missing', name: 'ghost' })],
      ['builder:lost', node({ id: 'builder:lost', kind: 'builder', parentId: 'workspace:/missing', name: 'lost' })],
    ]);
    const { plots, orphanArchitects, orphanBuilders } = buildTree(nodes, new Map());
    expect(plots).toHaveLength(1);
    expect(plots[0].architects).toEqual([]);
    expect(plots[0].builders).toEqual([]);
    expect(orphanArchitects.map((g) => g.node.name)).toEqual(['ghost']);
    expect(orphanBuilders.map((b) => b.name)).toEqual(['lost']);
  });

  it('builds a dark plot from the id when there is no node', () => {
    const dark = new Map([['workspace:/tmp/gone', { reason: 'unreadable', at: 't0' }]]);
    const { plots } = buildTree(new Map(), dark);
    expect(plots).toHaveLength(1);
    expect(plots[0].name).toBe('gone');
    expect(plots[0].dark).toEqual({ reason: 'unreadable', at: 't0' });
    expect(plots[0].architects).toEqual([]);
    expect(plots[0].builders).toEqual([]);
    expect(initialReducerState().nodes.size).toBe(0);
  });
});
