import { describe, it, expect } from 'vitest';
import { GATE_REQUEST_LIMITS, type GateRequest, type V2Counts, type V2Node } from '@cluesmith/codev-types';
import {
  ScopeBus,
  V2_BUFFER_MAX_AGE_MS,
  V2_BUFFER_MAX_FRAMES,
  scopeKey,
} from '../servers/v2-events.js';

const counts: V2Counts = { workspaces: 1, builders: { total: 0, byStatus: {} }, gateWaiting: 0 };

function node(id: string): V2Node {
  return {
    id,
    kind: 'builder',
    parentId: null,
    name: id,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    blockedGate: null,
    blockedGateRequest: null,
  };
}

describe('scopeKey', () => {
  it('is order-independent', () => {
    expect(scopeKey(['/b', '/a'])).toBe(scopeKey(['/a', '/b']));
  });
});

describe('ScopeBus', () => {
  it('snapshot does not consume a sequence number (4b / 6c)', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const a = bus.snapshotFrame(key, { scope: ['/a'], nodes: [], counts, resumed: false });
    const b = bus.snapshotFrame(key, { scope: ['/a'], nodes: [], counts, resumed: false });
    expect(a.seq).toBe(b.seq);
    expect(a.seq).toBe(0);
    const delta = bus.emit(key, { type: 'node', node: node('n1') });
    expect(delta.seq).toBe(a.seq + 1);
  });

  it('resumes from since+1 and never returns an empty honour (6, 6b, 5b)', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const snap = bus.snapshotFrame(key, { scope: ['/a'], nodes: [], counts, resumed: false });
    const empty = bus.resume(key, snap.seq, snap.streamId);
    expect(empty.kind).toBe('resumed');
    if (empty.kind !== 'resumed') return;
    expect(empty.frames[0]).toMatchObject({ type: 'resumed', from: snap.seq, seq: snap.seq });
    expect(empty.frames).toHaveLength(1);

    bus.emit(key, { type: 'node', node: node('n1') });
    bus.emit(key, { type: 'gone', id: 'n1' });
    const mid = bus.resume(key, snap.seq, snap.streamId);
    expect(mid.kind).toBe('resumed');
    if (mid.kind !== 'resumed') return;
    expect(mid.frames.map((f) => f.type)).toEqual(['resumed', 'node', 'gone']);
    expect(mid.frames[1].seq).toBe(snap.seq + 1);
  });

  it('outside the 500-frame window returns snapshot (5)', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const stream = bus.streamId(key);
    bus.emit(key, { type: 'node', node: node('first') });
    for (let i = 0; i < V2_BUFFER_MAX_FRAMES; i++) {
      bus.emit(key, { type: 'gone', id: `x${i}` });
    }
    const result = bus.resume(key, 0, stream);
    expect(result).toEqual({ kind: 'snapshot', reason: 'outside' });
    expect(bus.streamId(key)).toBe(stream);
  });

  it('age-evicted frames are outside', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const stream = bus.streamId(key);
    bus.emit(key, { type: 'node', node: node('old') }, 0);
    const result = bus.resume(key, 0, stream, V2_BUFFER_MAX_AGE_MS + 1);
    expect(result).toEqual({ kind: 'snapshot', reason: 'outside' });
  });

  it('mismatched streamId returns snapshot', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    bus.emit(key, { type: 'node', node: node('n') });
    expect(bus.resume(key, 1, 'other-stream')).toEqual({ kind: 'snapshot', reason: 'mismatch' });
  });

  it('dark is a buffered delta', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const snap = bus.snapshotFrame(key, { scope: ['/a'], nodes: [], counts, resumed: false });
    bus.emit(key, { type: 'dark', id: 'workspace:/a', reason: 'unreadable' });
    const result = bus.resume(key, snap.seq, snap.streamId);
    expect(result.kind).toBe('resumed');
    if (result.kind !== 'resumed') return;
    expect(result.frames.map((f) => f.type)).toEqual(['resumed', 'dark']);
    expect(result.frames[1]).toMatchObject({ type: 'dark', id: 'workspace:/a', reason: 'unreadable' });
  });

  it('fans emit to every subscriber', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe(key, (f) => a.push(f));
    bus.subscribe(key, (f) => b.push(f));
    bus.emit(key, { type: 'gone', id: 'x' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('gate request retention budget (Spec 128)', () => {
  it('retains gate content in buffered node frames and resume replay', () => {
    const bus = new ScopeBus();
    const key = scopeKey(['/a']);
    const request: GateRequest = {
      question: 'Which path?',
      choices: [{ label: 'A', consequence: 'Implement A' }],
    };
    const changed = {
      ...node('builder:/a#one'),
      blockedGate: 'plan-approval',
      blockedGateRequest: request,
    };
    bus.emit(key, { type: 'node', node: changed }, 1_000);
    const replay = bus.resume(key, 0, bus.streamId(key), 1_001);
    expect(replay.kind).toBe('resumed');
    if (replay.kind === 'resumed') {
      expect(replay.frames[1]).toMatchObject({ type: 'node', node: changed });
    }
  });

  it('bounds maximal node, snapshot, lastByScope, and 500-frame replay JSON bytes', () => {
    const plainRequest: GateRequest = {
      question: 'q'.repeat(GATE_REQUEST_LIMITS.questionBytes),
      choices: Array.from({ length: GATE_REQUEST_LIMITS.maxChoices }, (_, index) => ({
        label: 'l'.repeat(GATE_REQUEST_LIMITS.labelBytes),
        consequence: 'c'.repeat(GATE_REQUEST_LIMITS.consequenceBytes),
        ...(index === 0 ? { recommended: true } : {}),
      })),
      terminalExcerpt: 't'.repeat(GATE_REQUEST_LIMITS.terminalExcerptBytes),
    };
    // Backslashes cost one byte in the field but two in JSON. Use exactly
    // enough to exercise the whole-request cap rather than merely every field
    // cap independently.
    const escapedBytesNeeded = GATE_REQUEST_LIMITS.requestBytes
      - Buffer.byteLength(JSON.stringify(plainRequest));
    const request: GateRequest = {
      ...plainRequest,
      terminalExcerpt: '\\'.repeat(escapedBytesNeeded)
        + 't'.repeat(GATE_REQUEST_LIMITS.terminalExcerptBytes - escapedBytesNeeded),
    };
    const maximalNode: V2Node = {
      ...node('maximal'),
      status: 'gate-waiting',
      blockedGate: 'plan-approval',
      blockedGateRequest: request,
    };
    // Twenty simultaneous max-content builders is the explicit realistic
    // loaded-scope model; the replay bound below remains the harder limit.
    const builders = Array.from({ length: 20 }, (_, index) => ({
      ...maximalNode,
      id: `builder:/workspace#maximal-${index}`,
      name: `maximal-${index}`,
    }));
    const requestBytes = Buffer.byteLength(JSON.stringify(request));
    const nodeFrameBytes = Buffer.byteLength(JSON.stringify({ seq: 1, type: 'node', node: maximalNode }));
    const snapshotBytes = Buffer.byteLength(JSON.stringify({
      seq: 0,
      type: 'snapshot',
      streamId: '0123456789abcdef',
      resumed: false,
      scope: ['/workspace'],
      nodes: builders,
      counts: { workspaces: 1, builders: { total: 20, byStatus: { 'gate-waiting': 20 } }, gateWaiting: 20 },
    }));
    const lastByScopeBytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(
      builders.map((builder) => [builder.id, builder]),
    )));
    const replay500Bytes = Array.from({ length: V2_BUFFER_MAX_FRAMES }, (_, index) =>
      Buffer.byteLength(JSON.stringify({ seq: index + 1, type: 'node', node: maximalNode })))
      .reduce((sum, bytes) => sum + bytes, 0);

    expect(requestBytes).toBe(GATE_REQUEST_LIMITS.requestBytes);
    expect(nodeFrameBytes).toBeLessThan(33 * 1024);
    expect(snapshotBytes).toBeLessThan(672 * 1024);
    expect(lastByScopeBytes).toBeLessThan(672 * 1024);
    expect(replay500Bytes).toBeLessThan(16 * 1024 * 1024);
  });
});
