/**
 * Regression test for Bugfix #273: `afx send` reported `delivered` for a message
 * whose first 1021 characters never reached the architect's prompt.
 *
 * The cut is not in the formatter — `formatted_message` in the mailbox row was
 * complete at 1274 characters. It is at the **write call site**: a tty's input queue
 * is finite (1024 bytes on macOS) and a `session.write` larger than it is truncated
 * silently, so `writeMessagePaced` resolves `true` and the row is marked `delivered`
 * for bytes that were dropped by the kernel.
 *
 * `writeMessageToSession` bounded writes by LINE COUNT only, and the message that
 * broke was three lines — header, a 1173-character body on one line, footer — so it
 * took the short path and went out as ONE 1274-byte write. The paced path had the same
 * hole one level down: it writes a whole line per call, and that body IS one line.
 *
 * These tests assert on the strings handed to `session.write`. Without the fix the
 * first two fail: one write of 1274 characters, and one of 1174.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeMessageToSession,
  segmentMessageForWrite,
  MAX_WRITE_CHUNK_CHARS,
} from '../servers/message-write.js';
import type { WritableSession } from '../servers/message-write.js';

function makeSession(): WritableSession & { writes: string[] } {
  const writes: string[] = [];
  return { write: (data: string) => { writes.push(data); return true; }, writes };
}

/** The shape of the message that was truncated in #273: header, one long line, footer. */
function realWorldMessage(bodyChars: number): string {
  const body = Array.from({ length: bodyChars }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  return `### [BUILDER builder-air-271 MESSAGE | 2026-08-31T15:51:58.929Z] ###\n${body}\n${'#'.repeat(31)}`;
}

describe('writeMessageToSession — oversized single write (Bugfix #273)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never hands a single write larger than the tty input queue can hold', () => {
    const session = makeSession();
    const msg = realWorldMessage(1173);
    expect(msg).toHaveLength(1274);          // the exact size of the #273 message
    expect(msg.split('\n')).toHaveLength(3); // three lines — the old fast path

    writeMessageToSession(session, msg, false);
    vi.advanceTimersByTime(5_000);

    const oversized = session.writes.filter(w => w.length > MAX_WRITE_CHUNK_CHARS);
    expect(oversized).toEqual([]);
  });

  it('splits a single line longer than the cap, not just multi-line messages', () => {
    const session = makeSession();
    // Six lines, one of them 1173 chars: the paced path already ran here, and
    // still wrote that line in one call.
    const msg = ['a', 'b', 'c', 'd', 'x'.repeat(1173), 'e'].join('\n');

    writeMessageToSession(session, msg, false);
    vi.advanceTimersByTime(5_000);

    const oversized = session.writes.filter(w => w.length > MAX_WRITE_CHUNK_CHARS);
    expect(oversized).toEqual([]);
  });

  it('delivers every byte of the message, in order, followed by the Enter', () => {
    const session = makeSession();
    const msg = realWorldMessage(1173);

    writeMessageToSession(session, msg, false);
    vi.advanceTimersByTime(5_000);

    expect(session.writes.at(-1)).toBe('\r');
    expect(session.writes.slice(0, -1).join('')).toBe(msg);
  });

  it('reports a completion time that covers the last chunk and the Enter', () => {
    const session = makeSession();
    const msg = realWorldMessage(1173);

    const endTime = writeMessageToSession(session, msg, false);

    // Nothing after endTime: the promise writeMessagePaced resolves at endTime must
    // not resolve while bytes are still scheduled.
    vi.advanceTimersByTime(endTime);
    expect(session.writes.at(-1)).toBe('\r');
    expect(session.writes.slice(0, -1).join('')).toBe(msg);
  });

  it('leaves genuinely short messages on the single-write fast path', () => {
    const session = makeSession();
    const msg = 'line1\nline2\nline3';

    writeMessageToSession(session, msg, false);
    expect(session.writes).toEqual([msg]);
  });
});

describe('segmentMessageForWrite (Bugfix #273)', () => {
  it('reassembles to the original message byte for byte', () => {
    const msg = realWorldMessage(1173);
    expect(segmentMessageForWrite(msg).join('')).toBe(msg);
  });

  it('keeps every chunk within the cap', () => {
    const msg = 'x'.repeat(4000) + '\n' + 'y'.repeat(17);
    for (const chunk of segmentMessageForWrite(msg)) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_WRITE_CHUNK_CHARS);
    }
  });

  it('never splits a surrogate pair across two writes', () => {
    // Place a 2-unit emoji so the naive boundary falls between its halves.
    const msg = 'a'.repeat(MAX_WRITE_CHUNK_CHARS - 1) + '😀' + 'b'.repeat(400);

    const segments = segmentMessageForWrite(msg);
    expect(segments.join('')).toBe(msg);
    for (const chunk of segments) {
      // A chunk holding half a pair round-trips through UTF-8 as U+FFFD.
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it('never splits a multi-byte UTF-8 sequence across two writes', () => {
    // 2-byte (é), 3-byte (日) and 4-byte (😀) characters, laid out so a boundary lands
    // on each of them in turn. `session.write` takes a string, so the UTF-8 encoding
    // happens per chunk — a chunk that is not well-formed UTF-16 would be written as
    // U+FFFD and the concatenated bytes would no longer equal the message's.
    const filler = 'aéa日a😀';
    const msg = filler.repeat(400);

    const segments = segmentMessageForWrite(msg);
    expect(segments.length).toBeGreaterThan(1);
    for (const chunk of segments) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_WRITE_CHUNK_CHARS);
    }

    const written = Buffer.concat(segments.map(c => Buffer.from(c, 'utf8')));
    expect(written.equals(Buffer.from(msg, 'utf8'))).toBe(true);
  });

  it('never splits a multi-byte sequence at ANY offset the cap could land on', () => {
    // Slide a 4-byte character across every possible boundary position.
    for (let lead = MAX_WRITE_CHUNK_CHARS - 4; lead <= MAX_WRITE_CHUNK_CHARS + 1; lead++) {
      const msg = 'a'.repeat(lead) + '😀日é' + 'b'.repeat(300);
      const segments = segmentMessageForWrite(msg);
      const written = Buffer.concat(segments.map(c => Buffer.from(c, 'utf8')));
      expect(written.equals(Buffer.from(msg, 'utf8'))).toBe(true);
    }
  });

  it('keeps the newline attached to the tail chunk of its line', () => {
    const segments = segmentMessageForWrite('x'.repeat(300) + '\nshort');
    expect(segments.filter(s => s.includes('\n'))).toHaveLength(1);
    expect(segments.at(-1)).toBe('short');
  });
});
