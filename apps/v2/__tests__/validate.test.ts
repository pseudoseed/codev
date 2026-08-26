import { describe, it, expect } from 'vitest';
import { escapePreview, parseAndValidate, validateFrame } from '../src/lib/validate.js';

const after = 0;
const baseNode = {
  id: 'b',
  kind: 'builder',
  parentId: 'workspace:/a',
  name: 'builder',
  status: 'gate-waiting',
  flags: { heldMail: false },
  lastDataAt: null,
  blockedGate: 'plan-approval',
  blockedGateRequest: null,
};
const fullRequest = {
  question: 'Delete the legacy table?',
  choices: [
    { label: 'Delete', consequence: 'Run the full suite', recommended: true },
    { label: 'Keep', consequence: 'Document audit retention' },
  ],
  terminalExcerpt: 'warning: legacy references remain',
};

describe('parseAndValidate', () => {
  it('invalid JSON reports preview and no seq/type (scenario 29)', () => {
    const r = parseAndValidate('{nope', after);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mismatch.how).toBe('invalid-json');
    expect(r.mismatch.preview).toBe('{nope');
    expect(r.mismatch.seq).toBeUndefined();
    expect(r.mismatch.type).toBeUndefined();
  });

  it('preview is the first 120 UTF-8 bytes, escaped', () => {
    const euro = '€'.repeat(80);
    const preview = escapePreview(euro);
    expect(new TextEncoder().encode(euro).length).toBeGreaterThan(120);
    expect(preview.startsWith('\\xe2\\x82\\xac')).toBe(true);
    expect(preview.match(/\\x[0-9a-f]{2}/g)?.length).toBe(120);
  });
});

describe('validateFrame read-set (scenario 30)', () => {
  it('node with no id', () => {
    const r = validateFrame({ seq: 1, type: 'node', node: { kind: 'builder', parentId: null, name: 'x', status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null } }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mismatch.field).toMatch(/id/);
      expect(r.mismatch.type).toBe('node');
      expect(r.mismatch.seq).toBe(1);
    }
  });

  it('node with kind machine', () => {
    const r = validateFrame({
      seq: 1, type: 'node',
      node: { id: 'b', kind: 'machine', parentId: null, name: 'x', status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null },
    }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toMatch(/kind/);
  });

  it('node with numeric parentId', () => {
    const r = validateFrame({
      seq: 1, type: 'node',
      node: { id: 'b', kind: 'builder', parentId: 1, name: 'x', status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null },
    }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toMatch(/parentId/);
  });

  it('snapshot nodes not an array', () => {
    const r = validateFrame({ seq: 0, type: 'snapshot', streamId: 's', resumed: false, nodes: {}, counts: { workspaces: 0, builders: { total: 0, byStatus: {} }, gateWaiting: 0 } }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toBe('nodes');
  });

  it('snapshot with one bad element among good ones', () => {
    const good = { id: 'w', kind: 'workspace', parentId: null, name: 'a', status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null };
    const r = validateFrame({
      seq: 0, type: 'snapshot', streamId: 's', resumed: false,
      nodes: [good, { ...good, id: '', kind: 'builder' }],
      counts: { workspaces: 1, builders: { total: 0, byStatus: {} }, gateWaiting: 0 },
    }, after);
    expect(r.ok).toBe(false);
  });

  it('snapshot with no counts', () => {
    const r = validateFrame({ seq: 0, type: 'snapshot', streamId: 's', resumed: false, nodes: [] }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toMatch(/counts/);
  });

  it('counts with a negative total', () => {
    const r = validateFrame({ seq: 1, type: 'counts', counts: { workspaces: 1, builders: { total: -1, byStatus: {} }, gateWaiting: 0 } }, after);
    expect(r.ok).toBe(false);
  });

  it('tick with buckets as an array', () => {
    const r = validateFrame({ seq: 1, type: 'tick', at: 't', buckets: [] }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toBe('buckets');
  });

  it('tick with a non-numeric value', () => {
    const r = validateFrame({ seq: 1, type: 'tick', at: 't', buckets: { a: 'x' } }, after);
    expect(r.ok).toBe(false);
  });

  it('dark with id that is not workspace:<path>', () => {
    const r = validateFrame({ seq: 0, type: 'dark', id: 'machine:x', reason: 'unknown' }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toBe('id');
  });

  it('resumed with a bad from', () => {
    const r = validateFrame({ seq: 1, type: 'resumed', from: -1 }, after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatch.field).toBe('from');
  });
});

describe('blocked gate request contract (Spec 128)', () => {
  it('accepts required null compatibility fields and a full canonical request', () => {
    expect(validateFrame({ seq: 1, type: 'node', node: baseNode }, after).ok).toBe(true);
    const result = validateFrame({
      seq: 2,
      type: 'node',
      node: { ...baseNode, blockedGateRequest: fullRequest },
    }, after);
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'node') {
      expect(result.frame.node.blockedGateRequest).toEqual(fullRequest);
    }
  });

  it.each([
    ['missing field', (() => { const { blockedGateRequest: _drop, ...node } = baseNode; return node; })()],
    ['wrong choices type', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: {} } }],
    ['extra request key', { ...baseNode, blockedGateRequest: { ...fullRequest, context: 'nope' } }],
    ['six choices', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: Array.from({ length: 6 }, (_, i) => ({ label: String(i), consequence: 'C' })) } }],
    ['two recommendations', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: [
      { label: 'A', consequence: 'A', recommended: true },
      { label: 'B', consequence: 'B', recommended: true },
    ] } }],
    ['extra choice key', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: [{ label: 'A', consequence: 'A', icon: 'x' }] } }],
    ['over-limit label', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: [{ label: 'é'.repeat(129), consequence: 'A' }] } }],
    ['prohibited terminal control', { ...baseNode, blockedGateRequest: { question: 'Q?', choices: [{ label: 'A', consequence: 'A' }], terminalExcerpt: '\u001b[31mred' } }],
  ])('rejects %s as blockedGateRequest instead of degrading it to null', (_name, node) => {
    const result = validateFrame({ seq: 1, type: 'node', node }, after);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatch.field).toBe('node.blockedGateRequest');
  });

  it('requires blockedGate itself on every node, including non-builders', () => {
    const { blockedGate: _drop, ...missing } = {
      ...baseNode,
      id: 'workspace:/a',
      kind: 'workspace',
      parentId: null,
      blockedGateRequest: null,
    };
    const result = validateFrame({ seq: 1, type: 'node', node: missing }, after);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatch.field).toBe('node.blockedGate');
  });

  it('rejects request content with no gate and gate content on non-builder nodes', () => {
    const orphan = validateFrame({
      seq: 1,
      type: 'node',
      node: { ...baseNode, blockedGate: null, blockedGateRequest: fullRequest },
    }, after);
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.mismatch.field).toBe('node.blockedGateRequest');

    const workspace = validateFrame({
      seq: 2,
      type: 'node',
      node: {
        ...baseNode,
        id: 'workspace:/a',
        kind: 'workspace',
        parentId: null,
        blockedGate: 'pr',
        blockedGateRequest: fullRequest,
      },
    }, after);
    expect(workspace.ok).toBe(false);
    if (!workspace.ok) expect(workspace.mismatch.field).toBe('node.blockedGate');
  });
});

describe('seq is a safe non-negative integer (scenario 33)', () => {
  const base = { type: 'gone', id: 'x' };
  for (const seq of [NaN, Infinity, 1.5, -1, 2 ** 60]) {
    it(`rejects ${String(seq)}`, () => {
      const r = validateFrame({ ...base, seq }, after);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.mismatch.field).toBe('seq');
    });
  }
});

describe('unknown type (scenario 29)', () => {
  it('reports the type and seq', () => {
    const r = validateFrame({ seq: 4, type: 'wibble' }, after);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mismatch.how).toBe('unknown-type');
    expect(r.mismatch.type).toBe('wibble');
    expect(r.mismatch.seq).toBe(4);
  });
});

describe('fields outside the read-set are ignored (scenario 35)', () => {
  it('extra unknown field on a gone frame applies', () => {
    const r = validateFrame({ seq: 1, type: 'gone', id: 'x', extra: { garbage: true } }, after);
    expect(r.ok).toBe(true);
  });
});
