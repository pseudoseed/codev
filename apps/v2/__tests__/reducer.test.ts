import { describe, it, expect } from 'vitest';
import {
  applyFrame,
  applyUnknown,
  initialReducerState,
  serialise,
  type ReducerState,
} from '../src/lib/reducer.js';
import { TRACE_LEN, type ClientNode } from '../src/lib/validate.js';

const COUNTS = { workspaces: 22, builders: { total: 58, byStatus: { running: 10 } }, gateWaiting: 3 };

function ws(id: string, name = id): ClientNode {
  return { id, kind: 'workspace', parentId: null, name, status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null };
}
function arch(id: string, parentId: string): ClientNode {
  return { id, kind: 'architect', parentId, name: id, status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null };
}
function bld(id: string, parentId: string, extra: Partial<ClientNode> = {}): ClientNode {
  return { id, kind: 'builder', parentId, name: id, status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null, ...extra };
}

function snap(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    seq: 0,
    type: 'snapshot',
    streamId: 's1',
    resumed: false,
    nodes: [ws('workspace:/a', 'a'), arch('architect:/a#main', 'workspace:/a'), bld('builder:/a#one', 'workspace:/a', { buckets: Array(TRACE_LEN).fill(1) })],
    counts: COUNTS,
    ...over,
  });
}

function run(raws: string[], start = initialReducerState()): ReducerState {
  let s = start;
  for (const r of raws) s = applyFrame(s, r).state;
  return s;
}

describe('D1 table (scenario 1)', () => {
  it('snapshot replaces nodes and stores counts', () => {
    const s = run([snap()]);
    expect(s.nodes.size).toBe(3);
    expect(s.counts).toEqual(COUNTS);
    expect(s.cursor).toEqual({ streamId: 's1', seq: 0 });
    expect(s.darkPaths.size).toBe(0);
  });

  it('resumed does not replace the map (scenario 4)', () => {
    const s0 = run([snap()]);
    const before = serialise(s0);
    const s1 = applyFrame(s0, JSON.stringify({ seq: 1, type: 'resumed', from: 0 })).state;
    expect(s1.nodes.size).toBe(3);
    expect(s1.cursor.seq).toBe(1);
    expect(serialise(s1).nodes).toEqual(before.nodes);
  });

  it('node upserts by id', () => {
    const s = run([snap(), JSON.stringify({
      seq: 1, type: 'node',
      node: bld('builder:/a#two', 'workspace:/a', { status: 'running' }),
    })]);
    expect(s.nodes.has('builder:/a#two')).toBe(true);
    expect(s.nodes.get('builder:/a#two')?.buckets).toEqual(Array(TRACE_LEN).fill(0));
  });

  it('gone deletes by id', () => {
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'gone', id: 'builder:/a#one' })]);
    expect(s.nodes.has('builder:/a#one')).toBe(false);
  });

  it('counts replaces Counts', () => {
    const next = { workspaces: 1, builders: { total: 1, byStatus: { stalled: 1 } }, gateWaiting: 0 };
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'counts', counts: next })]);
    expect(s.counts).toEqual(next);
  });

  it('tick advances traces', () => {
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: { 'builder:/a#one': 9 } })]);
    const t = s.nodes.get('builder:/a#one')?.buckets ?? [];
    expect(t).toHaveLength(TRACE_LEN);
    expect(t[TRACE_LEN - 1]).toBe(9);
    expect(t[0]).toBe(1);
  });

  it('dark marks a workspace path', () => {
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'dark', id: 'workspace:/gone', reason: 'unknown' })]);
    expect(s.darkPaths.get('workspace:/gone')?.reason).toBe('unknown');
    expect(s.nodes.size).toBe(3);
  });
});

describe('tick absence means zero (scenario 2)', () => {
  it('omitted builder appends 0 not a repeat', () => {
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: {} })]);
    const t = s.nodes.get('builder:/a#one')?.buckets ?? [];
    expect(t[TRACE_LEN - 1]).toBe(0);
    expect(t[TRACE_LEN - 2]).toBe(1);
  });
});

describe('node upsert buckets (scenarios 3, 39)', () => {
  it('existing builder keeps its trace', () => {
    const s0 = run([snap(), JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: { 'builder:/a#one': 7 } })]);
    const before = s0.nodes.get('builder:/a#one')?.buckets;
    const s1 = applyFrame(s0, JSON.stringify({
      seq: 2, type: 'node',
      node: bld('builder:/a#one', 'workspace:/a', { status: 'stalled' }),
    })).state;
    expect(s1.nodes.get('builder:/a#one')?.buckets).toEqual(before);
    expect(s1.nodes.get('builder:/a#one')?.status).toBe('stalled');
  });

  it('new builder with absent buckets gets 20 zeros', () => {
    const s = run([snap(), JSON.stringify({
      seq: 1, type: 'node',
      node: { id: 'builder:/a#new', kind: 'builder', parentId: 'workspace:/a', name: 'new', status: 'running', flags: { heldMail: false }, lastDataAt: null, blockedGate: null, blockedGateRequest: null },
    })]);
    expect(s.nodes.get('builder:/a#new')?.buckets).toEqual(Array(TRACE_LEN).fill(0));
  });
});

describe('gate request node deltas (Spec 128)', () => {
  it('retains a request-only change through validation and reduction', () => {
    const request = {
      question: 'Which path?',
      choices: [{ label: 'A', consequence: 'Implement A', recommended: true }],
      terminalExcerpt: 'warning: choose carefully',
    };
    const state = run([snap(), JSON.stringify({
      seq: 1,
      type: 'node',
      node: bld('builder:/a#one', 'workspace:/a', {
        status: 'gate-waiting',
        blockedGate: 'plan-approval',
        blockedGateRequest: request,
      }),
    })]);
    expect(state.mismatch).toBeNull();
    expect(state.nodes.get('builder:/a#one')).toMatchObject({
      blockedGate: 'plan-approval',
      blockedGateRequest: request,
    });
  });

  it('enters visible mismatch for malformed content rather than storing null', () => {
    const result = applyFrame(run([snap()]), JSON.stringify({
      seq: 1,
      type: 'node',
      node: bld('builder:/a#one', 'workspace:/a', {
        blockedGate: 'plan-approval',
        blockedGateRequest: { question: 'Q?', choices: [] } as never,
      }),
    }));
    expect(result.effect).toBe('recover-fresh');
    expect(result.state.mismatch?.field).toBe('node.blockedGateRequest');
  });
});

describe('resume refused (scenario 5)', () => {
  it('snapshot with resumed false replaces the map', () => {
    const s = run([
      snap(),
      JSON.stringify({
        seq: 0, type: 'snapshot', streamId: 's2', resumed: false,
        nodes: [ws('workspace:/b', 'b')],
        counts: { workspaces: 1, builders: { total: 0, byStatus: {} }, gateWaiting: 0 },
      }),
    ]);
    expect([...s.nodes.keys()]).toEqual(['workspace:/b']);
    expect(s.cursor.streamId).toBe('s2');
  });
});

describe('unknown status is stored as-is (scenario 6, 31)', () => {
  it('does not rewrite to running and is not mismatch', () => {
    const s = run([snap(), JSON.stringify({
      seq: 1, type: 'node',
      node: bld('builder:/a#one', 'workspace:/a', { status: 'reticulating' }),
    })]);
    expect(s.mismatch).toBeNull();
    expect(s.nodes.get('builder:/a#one')?.status).toBe('reticulating');
  });
});

describe('two reducers converge (scenario 8)', () => {
  it('50 frames into two instances match', () => {
    const frames = [snap()];
    for (let i = 1; i <= 49; i++) {
      frames.push(JSON.stringify({
        seq: i, type: 'tick', at: String(i),
        buckets: i % 2 === 0 ? {} : { 'builder:/a#one': i },
      }));
    }
    const a = run(frames);
    const b = run(frames);
    expect(serialise(a)).toEqual(serialise(b));
  });
});

describe('cursor advances on deltas (scenario 19)', () => {
  it('reconnect would use the last delta seq', () => {
    const frames = [snap()];
    for (let i = 1; i <= 5; i++) {
      frames.push(JSON.stringify({
        seq: i, type: 'node',
        node: bld('builder:/a#one', 'workspace:/a', { status: 'running' }),
      }));
    }
    const s = run(frames);
    expect(s.cursor.seq).toBe(5);
  });
});

describe('degenerate frames (scenario 20)', () => {
  it('invalid JSON is mismatch and does not advance cursor', () => {
    const s0 = run([snap()]);
    const r = applyFrame(s0, 'not-json');
    expect(r.effect).toBe('recover-fresh');
    expect(r.state.cursor.seq).toBe(0);
    expect(r.state.mismatch?.how).toBe('invalid-json');
  });

  it('unknown type is mismatch and does not advance cursor', () => {
    const s0 = run([snap()]);
    const r = applyFrame(s0, JSON.stringify({ seq: 1, type: 'nope' }));
    expect(r.effect).toBe('recover-fresh');
    expect(r.state.cursor.seq).toBe(0);
    expect(r.state.mismatch?.type).toBe('nope');
  });
});

describe('dark store (scenarios 21, 22, 41)', () => {
  it('snapshot nodes [] plus dark is a dark plot not empty', () => {
    const s = run([
      JSON.stringify({
        seq: 0, type: 'snapshot', streamId: 's1', resumed: false, nodes: [], counts: COUNTS,
      }),
      JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/gone', reason: 'unreadable' }),
    ]);
    expect(s.nodes.size).toBe(0);
    expect(s.darkPaths.size).toBe(1);
    expect(s.darkPaths.get('workspace:/gone')?.reason).toBe('unreadable');
  });

  it('gone does not clear a dark path (scenario 22)', () => {
    const s = run([
      snap(),
      JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/gone', reason: 'unknown' }),
      JSON.stringify({ seq: 1, type: 'gone', id: 'workspace:/gone' }),
    ]);
    expect(s.darkPaths.has('workspace:/gone')).toBe(true);
    expect(s.nodes.has('workspace:/gone')).toBe(false);
  });

  it('workspace node clears that dark path', () => {
    const s0 = run([
      snap(),
      JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/a', reason: 'unreadable' }),
    ]);
    expect(s0.darkPaths.has('workspace:/a')).toBe(true);
    const s1 = applyFrame(s0, JSON.stringify({
      seq: 1, type: 'node', node: ws('workspace:/a', 'a'),
    })).state;
    expect(s1.darkPaths.has('workspace:/a')).toBe(false);
    expect(s1.nodes.has('workspace:/a')).toBe(true);
  });

  it('dark records the injected arrival time', () => {
    const s0 = run([snap()]);
    const s = applyFrame(
      s0,
      JSON.stringify({ seq: 1, type: 'dark', id: 'workspace:/gone', reason: 'unknown' }),
      '2026-08-24T12:00:00.000Z',
    ).state;
    expect(s.darkPaths.get('workspace:/gone')?.at).toBe('2026-08-24T12:00:00.000Z');
  });

  it('dark survives deltas and is cleared by a replacement snapshot', () => {
    const s0 = run([
      snap(),
      JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/gone', reason: 'unknown' }),
      JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: {} }),
    ]);
    expect(s0.darkPaths.has('workspace:/gone')).toBe(true);
    const s1 = applyFrame(s0, snap({ streamId: 's2' })).state;
    expect(s1.darkPaths.size).toBe(0);
  });

  it('snapshot replaces darkPaths before its own dark frames (scenario 41)', () => {
    let s = run([
      snap(),
      JSON.stringify({ seq: 1, type: 'dark', id: 'workspace:/a', reason: 'x' }),
      JSON.stringify({ seq: 1, type: 'dark', id: 'workspace:/b', reason: 'x' }),
      JSON.stringify({ seq: 1, type: 'dark', id: 'workspace:/c', reason: 'x' }),
    ]);
    expect(s.darkPaths.size).toBe(3);
    s = applyFrame(s, JSON.stringify({
      seq: 0, type: 'snapshot', streamId: 's2', resumed: false, nodes: [], counts: COUNTS,
    })).state;
    s = applyFrame(s, JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/a', reason: 'x' })).state;
    s = applyFrame(s, JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/b', reason: 'x' })).state;
    expect([...s.darkPaths.keys()].sort()).toEqual(['workspace:/a', 'workspace:/b']);
  });
});

describe('buckets two shapes (scenario 23)', () => {
  it('node number[] and tick {} do not throw and append a zero', () => {
    const s = run([snap(), JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: {} })]);
    expect(s.nodes.get('builder:/a#one')?.buckets?.at(-1)).toBe(0);
  });
});

describe('counts from snapshot alone (scenario 24)', () => {
  it('stores snapshot counts with no counts delta', () => {
    const s = run([snap()]);
    expect(s.counts).toEqual(COUNTS);
  });
});

describe('mismatch budget (scenarios 28, 37)', () => {
  it('first bad frame recover-fresh; second on that state halt', () => {
    const s0 = run([snap()]);
    const r1 = applyFrame(s0, '@@@');
    expect(r1.effect).toBe('recover-fresh');
    const r2 = applyFrame(r1.state, '@@@');
    expect(r2.effect).toBe('halt');
  });

  it('while in mismatch, a valid delta is ignored', () => {
    const s0 = run([snap()]);
    const r1 = applyFrame(s0, '@@@');
    const r2 = applyFrame(r1.state, JSON.stringify({ seq: 1, type: 'tick', at: 't', buckets: {} }));
    expect(r2.effect).toBe('none');
    expect(r2.state.cursor.seq).toBe(0);
    expect(r2.state.mismatch?.how).toBe('invalid-json');
  });

  it('valid snapshot clears mismatch and resets the budget', () => {
    const s0 = run([snap()]);
    const r1 = applyFrame(s0, '@@@');
    const r2 = applyFrame(r1.state, snap({ streamId: 's2' }));
    expect(r2.state.mismatch).toBeNull();
    expect(r2.state.mismatchAttempts).toBe(0);
    const r3 = applyFrame(r2.state, '@@@');
    expect(r3.effect).toBe('recover-fresh');
  });
});

describe('sequence ordering (scenarios 34, 36)', () => {
  it('two frames sharing a seq are both applied', () => {
    const s = run([
      snap(),
      JSON.stringify({ seq: 0, type: 'dark', id: 'workspace:/x', reason: 'unknown' }),
    ]);
    expect(s.nodes.size).toBe(3);
    expect(s.darkPaths.has('workspace:/x')).toBe(true);
  });

  it('lower seq on the same stream is terminal', () => {
    const s0 = run([snap(), JSON.stringify({ seq: 5, type: 'tick', at: 't', buckets: {} })]);
    const r = applyFrame(s0, JSON.stringify({ seq: 4, type: 'tick', at: 't', buckets: {} }));
    expect(r.effect).toBe('recover-fresh');
    expect(r.state.mismatch?.field).toBe('seq');
  });

  it('new streamId seq 0 after cursor 500 is accepted', () => {
    let s = run([snap()]);
    for (let i = 1; i <= 500; i++) {
      s = applyFrame(s, JSON.stringify({ seq: i, type: 'tick', at: String(i), buckets: {} })).state;
    }
    expect(s.cursor.seq).toBe(500);
    const r = applyFrame(s, snap({ streamId: 'fresh', seq: 0 }));
    expect(r.state.mismatch).toBeNull();
    expect(r.state.cursor).toEqual({ streamId: 'fresh', seq: 0 });
  });
});

describe('extra fields ignored (scenario 35)', () => {
  it('node with garbage in an unread field applies', () => {
    const s = run([snap(), JSON.stringify({
      seq: 1, type: 'node',
      node: { ...bld('builder:/a#z', 'workspace:/a'), color: { r: 1 } },
    })]);
    expect(s.mismatch).toBeNull();
    expect(s.nodes.has('builder:/a#z')).toBe(true);
  });
});

describe('seq via applyUnknown (scenario 33 objects)', () => {
  it('rejects NaN seq', () => {
    const r = applyUnknown(run([snap()]), { seq: NaN, type: 'gone', id: 'x' });
    expect(r.effect).toBe('recover-fresh');
  });
});
