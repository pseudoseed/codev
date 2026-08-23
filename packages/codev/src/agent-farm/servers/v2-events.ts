import crypto from 'node:crypto';
import type {
  V2Counts,
  V2DarkFrame,
  V2Frame,
  V2Node,
  V2ResumedFrame,
  V2SnapshotFrame,
} from '@cluesmith/codev-types';

export const V2_BUFFER_MAX_FRAMES = 500;
export const V2_BUFFER_MAX_AGE_MS = 5 * 60 * 1000;

export type V2DeltaInput =
  | { type: 'node'; node: V2Node }
  | { type: 'gone'; id: string }
  | { type: 'counts'; counts: V2Counts }
  | { type: 'tick'; at: string; buckets: { [builderId: string]: number } };

export type V2Subscriber = (frame: V2Frame) => void;

export type V2ResumeResult =
  | { kind: 'resumed'; frames: V2Frame[] }
  | { kind: 'snapshot'; reason: 'mismatch' | 'outside' };

export function scopeKey(paths: string[]): string {
  return [...paths].sort().join('\0');
}

interface Buffered {
  seq: number;
  at: number;
  frame: V2Frame;
}

interface ScopeState {
  cursor: number;
  streamId: string;
  buffer: Buffered[];
  subscribers: Set<V2Subscriber>;
}

function mintStreamId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export class ScopeBus {
  private readonly scopes = new Map<string, ScopeState>();

  state(key: string): ScopeState {
    let s = this.scopes.get(key);
    if (!s) {
      s = { cursor: 0, streamId: mintStreamId(), buffer: [], subscribers: new Set() };
      this.scopes.set(key, s);
    }
    return s;
  }

  cursor(key: string): number {
    return this.state(key).cursor;
  }

  streamId(key: string): string {
    return this.state(key).streamId;
  }

  snapshotFrame(
    key: string,
    input: { scope: string[]; nodes: V2Node[]; counts: V2Counts; resumed: boolean },
  ): V2SnapshotFrame {
    const s = this.state(key);
    return {
      seq: s.cursor,
      type: 'snapshot',
      streamId: s.streamId,
      resumed: input.resumed,
      scope: input.scope,
      nodes: input.nodes,
      counts: input.counts,
    };
  }

  darkFrame(key: string, id: string, reason: string): V2DarkFrame {
    return { seq: this.state(key).cursor, type: 'dark', id, reason };
  }

  emit(key: string, input: V2DeltaInput, now: number = Date.now()): V2Frame {
    const s = this.state(key);
    s.cursor += 1;
    const frame = { seq: s.cursor, ...input } as V2Frame;
    s.buffer.push({ seq: s.cursor, at: now, frame });
    this.trim(s, now);
    for (const sub of s.subscribers) sub(frame);
    return frame;
  }

  resume(key: string, since: number, stream: string, now: number = Date.now()): V2ResumeResult {
    const s = this.state(key);
    this.trim(s, now);
    if (stream !== s.streamId) return { kind: 'snapshot', reason: 'mismatch' };
    if (since === s.cursor) {
      const resumed: V2ResumedFrame = { seq: since, type: 'resumed', from: since };
      return { kind: 'resumed', frames: [resumed] };
    }
    const next = since + 1;
    if (!s.buffer.some((b) => b.seq === next)) {
      return { kind: 'snapshot', reason: 'outside' };
    }
    const resumed: V2ResumedFrame = { seq: since, type: 'resumed', from: since };
    const deltas = s.buffer.filter((b) => b.seq > since).map((b) => b.frame);
    return { kind: 'resumed', frames: [resumed, ...deltas] };
  }

  subscribe(key: string, sub: V2Subscriber): () => void {
    const s = this.state(key);
    s.subscribers.add(sub);
    return () => { s.subscribers.delete(sub); };
  }

  private trim(s: ScopeState, now: number): void {
    const cutoff = now - V2_BUFFER_MAX_AGE_MS;
    while (s.buffer.length > 0 && (s.buffer.length > V2_BUFFER_MAX_FRAMES || s.buffer[0].at < cutoff)) {
      s.buffer.shift();
    }
  }
}
