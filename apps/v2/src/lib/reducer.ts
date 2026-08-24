import {
  TRACE_LEN,
  parseAndValidate,
  validateFrame,
  type ClientCounts,
  type ClientNode,
  type Mismatch,
  type ValidatedFrame,
} from './validate.js';

export type DarkEntry = { reason: string; at: string };

export type ReducerState = {
  nodes: Map<string, ClientNode>;
  darkPaths: Map<string, DarkEntry>;
  counts: ClientCounts | null;
  cursor: { streamId: string | null; seq: number };
  mismatch: Mismatch | null;
  mismatchAttempts: number;
};

export type ApplyEffect = 'none' | 'recover-fresh' | 'halt';

export type ApplyResult = { state: ReducerState; effect: ApplyEffect };

export function initialReducerState(): ReducerState {
  return {
    nodes: new Map(),
    darkPaths: new Map(),
    counts: null,
    cursor: { streamId: null, seq: 0 },
    mismatch: null,
    mismatchAttempts: 0,
  };
}

function zeros(): number[] {
  return Array.from({ length: TRACE_LEN }, () => 0);
}

function cloneNode(n: ClientNode): ClientNode {
  return {
    ...n,
    flags: { ...n.flags },
    buckets: n.buckets ? [...n.buckets] : undefined,
  };
}

function cloneState(s: ReducerState): ReducerState {
  return {
    nodes: new Map([...s.nodes].map(([k, v]) => [k, cloneNode(v)])),
    darkPaths: new Map(s.darkPaths),
    counts: s.counts
      ? {
          workspaces: s.counts.workspaces,
          builders: {
            total: s.counts.builders.total,
            byStatus: { ...s.counts.builders.byStatus },
          },
          gateWaiting: s.counts.gateWaiting,
        }
      : null,
    cursor: { ...s.cursor },
    mismatch: s.mismatch ? { ...s.mismatch } : null,
    mismatchAttempts: s.mismatchAttempts,
  };
}

function enterMismatch(state: ReducerState, mismatch: Mismatch): ApplyResult {
  const next = cloneState(state);
  next.mismatch = mismatch;
  if (state.mismatchAttempts === 0) {
    next.mismatchAttempts = 1;
    return { state: next, effect: 'recover-fresh' };
  }
  return { state: next, effect: 'halt' };
}

function applyValidated(state: ReducerState, frame: ValidatedFrame, now: string): ReducerState {
  const next = cloneState(state);

  if (frame.type === 'snapshot') {
    next.nodes = new Map();
    for (const n of frame.nodes) {
      const copy = cloneNode(n);
      if (copy.kind === 'builder' && copy.buckets === undefined) {
        copy.buckets = zeros();
      }
      next.nodes.set(copy.id, copy);
    }
    next.darkPaths = new Map();
    next.counts = frame.counts;
    next.cursor = { streamId: frame.streamId, seq: frame.seq };
    next.mismatch = null;
    next.mismatchAttempts = 0;
    return next;
  }

  switch (frame.type) {
    case 'resumed':
      break;
    case 'node': {
      const existing = next.nodes.get(frame.node.id);
      const copy = cloneNode(frame.node);
      if (existing?.buckets) {
        copy.buckets = [...existing.buckets];
      } else if (copy.kind === 'builder' && copy.buckets === undefined) {
        copy.buckets = zeros();
      }
      next.nodes.set(copy.id, copy);
      break;
    }
    case 'gone':
      next.nodes.delete(frame.id);
      break;
    case 'counts':
      next.counts = frame.counts;
      break;
    case 'tick': {
      for (const [id, node] of next.nodes) {
        if (node.kind !== 'builder') continue;
        const trace = node.buckets ? [...node.buckets] : zeros();
        const value = Object.prototype.hasOwnProperty.call(frame.buckets, id)
          ? frame.buckets[id]
          : 0;
        trace.push(value);
        while (trace.length > TRACE_LEN) trace.shift();
        next.nodes.set(id, { ...node, buckets: trace });
      }
      break;
    }
    case 'dark':
      next.darkPaths.set(frame.id, { reason: frame.reason, at: now });
      break;
  }

  next.cursor = { ...next.cursor, seq: frame.seq };
  return next;
}

export function applyFrame(state: ReducerState, raw: string, now = new Date().toISOString()): ApplyResult {
  const parsed = parseAndValidate(raw, state.cursor.seq);
  if (!parsed.ok) return enterMismatch(state, parsed.mismatch);
  return applyValidatedFrame(state, parsed.frame, now);
}

export function applyValidatedFrame(state: ReducerState, frame: ValidatedFrame, now = new Date().toISOString()): ApplyResult {
  if (state.mismatch !== null && frame.type !== 'snapshot') {
    return { state, effect: 'none' };
  }

  const sameStream =
    state.cursor.streamId !== null &&
    (frame.type !== 'snapshot' || frame.streamId === state.cursor.streamId);
  if (sameStream && frame.seq < state.cursor.seq) {
    return enterMismatch(state, {
      how: 'bad-field',
      afterSeq: state.cursor.seq,
      type: frame.type,
      seq: frame.seq,
      field: 'seq',
    });
  }

  return { state: applyValidated(state, frame, now), effect: 'none' };
}

export function applyUnknown(state: ReducerState, obj: unknown, now = new Date().toISOString()): ApplyResult {
  const parsed = validateFrame(obj, state.cursor.seq);
  if (!parsed.ok) return enterMismatch(state, parsed.mismatch);
  return applyValidatedFrame(state, parsed.frame, now);
}

export function serialise(state: ReducerState): unknown {
  return {
    nodes: [...state.nodes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, n]) => n),
    darkPaths: [...state.darkPaths.entries()].sort(([a], [b]) => a.localeCompare(b)),
    counts: state.counts,
    cursor: state.cursor,
    mismatch: state.mismatch,
    mismatchAttempts: state.mismatchAttempts,
  };
}
