import { describe, it, expect } from 'vitest';
import { readSseData } from '../src/lib/sse-reader.js';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readSseData(stream)) out.push(line);
  return out;
}

const FRAME_A = { seq: 0, type: 'tick', at: 't0', buckets: {} };
const FRAME_B = { seq: 1, type: 'tick', at: 't1', buckets: {} };
const FRAME_C = { seq: 2, type: 'tick', at: 't2', buckets: {} };
const FRAME_D = { seq: 3, type: 'tick', at: 't3', buckets: {} };

function sse(frame: unknown, nl = '\n'): string {
  return `data: ${JSON.stringify(frame)}${nl}${nl}`;
}

describe('readSseData (scenario 27)', () => {
  it('reassembles one frame split across 3 chunks', async () => {
    const bytes = new TextEncoder().encode(sse(FRAME_A));
    const a = Math.max(1, Math.floor(bytes.length / 3));
    const b = Math.max(a + 1, Math.floor((2 * bytes.length) / 3));
    const out = await collect(streamOf([bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)]));
    expect(out).toEqual([JSON.stringify(FRAME_A)]);
  });

  it('reassembles a chunk that splits a multi-byte UTF-8 character', async () => {
    const frame = { seq: 0, type: 'tick', at: 'café', buckets: {} };
    const bytes = new TextEncoder().encode(sse(frame));
    const idx = bytes.indexOf(0xc3);
    expect(idx).toBeGreaterThan(0);
    const out = await collect(streamOf([bytes.slice(0, idx + 1), bytes.slice(idx + 1)]));
    expect(out).toEqual([JSON.stringify(frame)]);
  });

  it('yields 4 frames that arrive in one chunk', async () => {
    const text = [FRAME_A, FRAME_B, FRAME_C, FRAME_D].map((f) => sse(f)).join('');
    const out = await collect(streamOf([new TextEncoder().encode(text)]));
    expect(out).toEqual([FRAME_A, FRAME_B, FRAME_C, FRAME_D].map((f) => JSON.stringify(f)));
  });

  it('holds a mid-frame remainder until the rest arrives', async () => {
    const full = sse(FRAME_A);
    const cut = full.indexOf('"type"');
    const bytes = new TextEncoder().encode(full);
    const out = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(out).toEqual([JSON.stringify(FRAME_A)]);
  });

  it('accepts CRLF line endings', async () => {
    const out = await collect(streamOf([new TextEncoder().encode(sse(FRAME_A, '\r\n'))]));
    expect(out).toEqual([JSON.stringify(FRAME_A)]);
  });

  it('does not apply a trailing partial frame at EOF', async () => {
    const complete = sse(FRAME_A);
    const partial = `data: ${JSON.stringify(FRAME_B).slice(0, 12)}`;
    const out = await collect(streamOf([new TextEncoder().encode(complete + partial)]));
    expect(out).toEqual([JSON.stringify(FRAME_A)]);
  });
});
