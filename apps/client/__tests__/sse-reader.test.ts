import { describe, expect, it } from 'vitest';
import { readSseFrames } from '../src/connection/sse-reader.js';

function body(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // One byte at a time, so a frame split across reads has to be reassembled.
      for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
}

describe('readSseFrames', () => {
  it('keeps the event name, which is how a revocation is told from a snapshot', async () => {
    const frames = [];
    for await (const frame of readSseFrames(body(
      'event: protocol-state\ndata: {"a":1}\n\nevent: protocol-state-unauthorized\ndata: {"b":2}\n\n',
    ))) frames.push(frame);
    expect(frames).toEqual([
      { event: 'protocol-state', data: '{"a":1}' },
      { event: 'protocol-state-unauthorized', data: '{"b":2}' },
    ]);
  });

  it('defaults an unnamed frame to message', async () => {
    const frames = [];
    for await (const frame of readSseFrames(body('data: one\n\n'))) frames.push(frame);
    expect(frames).toEqual([{ event: 'message', data: 'one' }]);
  });

  it('surfaces a comment, because the heartbeat is one', async () => {
    const frames = [];
    for await (const frame of readSseFrames(body(': heartbeat 2026-08-29T12:00:00Z\n\n'))) frames.push(frame);
    expect(frames).toEqual([{ event: 'comment', data: 'heartbeat 2026-08-29T12:00:00Z' }]);
  });

  it('joins multi-line data', async () => {
    const frames = [];
    for await (const frame of readSseFrames(body('data: a\ndata: b\n\n'))) frames.push(frame);
    expect(frames[0].data).toBe('a\nb');
  });
});
