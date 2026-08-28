/**
 * Spec 146, Phase 2 — the t3code RPC transport client.
 *
 * These live in `packages/codev` for the same reason Phase 1's do: the root
 * `test` script is `pnpm --filter @cluesmith/codev test`, so a test placed in the
 * package under test would look present and never run.
 *
 * Weighted, as Phase 1 established, towards the ways this layer can lie:
 * an unparseable frame presenting as an empty one, a stalled stream presenting as
 * a quiet server, a gap presenting as continuity, a dead socket presenting as a
 * live one.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ack,
  decodeFrames,
  encodeFrame,
  exitValue,
  interrupt,
  isSuccess,
  MalformedFrameError,
  request,
  type ExitFrame,
} from '../../../t3-client/src/envelope.js';
import { classifyResume, SequenceCursor } from '../../../t3-client/src/resume.js';
import { assertTransportSafe, missingScopes, webSocketUrl } from '../../../t3-client/src/auth.js';
import { exponentialBackoff } from '../../../t3-client/src/socket.js';
import { T3Client, NotConnectedError, type SocketLike } from '../../../t3-client/src/client.js';

// ---------------------------------------------------------------- envelope

describe('spec 146 phase 2: the wire envelope', () => {
  it('round-trips a request as one JSON object, with headers present', () => {
    const frame = request(1, 'orchestration.dispatchCommand', { type: 'project.create' });
    const decoded = JSON.parse(encodeFrame(frame));
    expect(decoded).toMatchObject({
      _tag: 'Request',
      id: 1,
      tag: 'orchestration.dispatchCommand',
      headers: [],
    });
  });

  it('builds the small client frames the protocol requires', () => {
    expect(ack(7)).toEqual({ _tag: 'Ack', requestId: 7 });
    expect(interrupt(7)).toEqual({ _tag: 'Interrupt', requestId: 7 });
  });

  it('decodes a batched message, not just a single frame', () => {
    // The spike saw both shapes. Handling only one silently drops frames on a
    // connection that otherwise looks healthy.
    const frames = decodeFrames(
      JSON.stringify([
        { _tag: 'Chunk', requestId: 1, values: [1, 2] },
        { _tag: 'Exit', requestId: 1, exit: { _tag: 'Success' } },
      ]),
    );
    expect(frames).toHaveLength(2);
  });

  it('distinguishes an empty message from an unreadable one', () => {
    // The distinction this whole project is about: nothing to report vs
    // cannot report.
    expect(decodeFrames('   ')).toEqual([]);
    expect(() => decodeFrames('{oh no')).toThrow(MalformedFrameError);
  });

  it('throws on an unknown server frame tag rather than skipping it', () => {
    // A tag we do not know means our envelope model is stale. Skipping it would
    // present a degraded connection as a working one.
    expect(() => decodeFrames(JSON.stringify({ _tag: 'Teleport', requestId: 1 }))).toThrow(
      /unknown server frame tag/,
    );
  });

  it('surfaces a failed exit as a throw carrying the cause', () => {
    const failure = {
      _tag: 'Exit',
      requestId: 1,
      exit: { _tag: 'Failure', cause: { _tag: 'Fail', error: { reason: 'nope' } } },
    } as ExitFrame;
    expect(isSuccess(failure)).toBe(false);
    expect(() => exitValue(failure)).toThrow(/nope/);
  });
});

// ---------------------------------------------------------------- resume / gaps

describe('spec 146 phase 2: resume has three answers, not two', () => {
  const item = (sequence: number) => ({ sequence });

  it('reports a contiguous range', () => {
    const outcome = classifyResume(45, [item(46), item(47), item(48)]);
    expect(outcome.kind).toBe('contiguous');
    if (outcome.kind === 'contiguous') expect(outcome.lastSequence).toBe(48);
  });

  it('reports empty when the server had nothing newer', () => {
    const outcome = classifyResume(45, []);
    expect(outcome.kind).toBe('empty');
  });

  it('reports a GAP when the range starts late — not empty, not contiguous', () => {
    const outcome = classifyResume(45, [item(50)]);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') {
      expect(outcome.firstReceived).toBe(50);
      expect(outcome.reason).toMatch(/4 event\(s\) are missing/);
    }
  });

  it('reports a GAP when a snapshot arrives instead of a range', () => {
    // The spec's exact case: "If afterSequence replay returns a snapshot instead
    // of the requested range, porch treats it as a gap."
    const outcome = classifyResume(45, [item(46)], { threads: [] });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.snapshot).not.toBeNull();
  });

  it('reports a GAP for a hole in the middle, not just a late start', () => {
    const outcome = classifyResume(45, [item(46), item(49)]);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.reason).toMatch(/jumped from 46 to 49/);
  });

  it('never spells a gap the same way as empty', () => {
    // The assertion that matters: a caller switching on `kind` cannot conflate
    // "nothing happened" with "something happened and we cannot see what".
    const gap = classifyResume(45, [item(99)]);
    const empty = classifyResume(45, []);
    expect(gap.kind).not.toBe(empty.kind);
  });
});

describe('spec 146 phase 2: the cursor advances after the handler, never before', () => {
  it('does not advance when the handler throws, so the event is redelivered', async () => {
    // The spec is emphatic and an earlier revision of it was wrong: persisting
    // before acting loses the event permanently on a crash in between.
    const cursor = new SequenceCursor(45);
    await expect(
      cursor.apply({ sequence: 46 }, () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');
    expect(cursor.applied, 'a failed handler must not advance the cursor').toBe(45);
  });

  it('advances only once the handler completes', async () => {
    const cursor = new SequenceCursor(45);
    const seen: number[] = [];
    await cursor.apply({ sequence: 46 }, (i) => {
      // The cursor must still be at 45 while the handler runs, or a crash here
      // would resume past an event that was never applied.
      expect(cursor.applied).toBe(45);
      seen.push(i.sequence);
    });
    expect(cursor.applied).toBe(46);
    expect(seen).toEqual([46]);
  });

  it('persists only after the handler, so at-least-once holds', async () => {
    const persisted: number[] = [];
    const cursor = new SequenceCursor(0, (s) => void persisted.push(s));
    await cursor.apply({ sequence: 1 }, () => {});
    expect(persisted).toEqual([1]);
  });
});

// ---------------------------------------------------------------- auth

describe('spec 146 phase 2: transport safety', () => {
  it('allows loopback over plain http', () => {
    expect(() => assertTransportSafe('http://127.0.0.1:3799')).not.toThrow();
    expect(() => assertTransportSafe('http://localhost:3799')).not.toThrow();
  });

  it('REFUSES a non-loopback host without TLS rather than warning', () => {
    // A warning would let this pass in the one case it matters.
    expect(() => assertTransportSafe('http://10.0.0.5:3799')).toThrow(/must be HTTPS/);
  });

  it('produces wss for https and ws only for loopback', () => {
    expect(webSocketUrl('https://box.tailnet.ts.net', 't')).toMatch(/^wss:/);
    expect(webSocketUrl('http://127.0.0.1:3799', 't')).toMatch(/^ws:/);
  });

  it('reports WHICH scopes were withheld, not merely that some were', () => {
    const missing = missingScopes('orchestration:read orchestration:operate');
    expect(missing).toContain('review:write');
    expect(missing).not.toContain('orchestration:read');
  });
});

// ---------------------------------------------------------------- backoff

describe('spec 146 phase 2: reconnect backoff', () => {
  it('jitters, so N dropped builders do not reconnect in lockstep', () => {
    const always = exponentialBackoff({ baseMs: 100, random: () => 1 });
    const never = exponentialBackoff({ baseMs: 100, random: () => 0 });
    expect(always.delayMs(1)).toBeGreaterThan(never.delayMs(1)!);
  });

  it('grows and then caps', () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 400, random: () => 1 });
    expect(policy.delayMs(1)).toBe(100);
    expect(policy.delayMs(2)).toBe(200);
    expect(policy.delayMs(9)).toBe(400);
  });

  it('returns null to stop rather than retrying forever by default', () => {
    const policy = exponentialBackoff({ maxAttempts: 2 });
    expect(policy.delayMs(3)).toBeNull();
  });
});

// ---------------------------------------------------------------- client

/** A socket that records what was sent and lets a test drive inbound frames. */
function fakeSocket(): SocketLike & {
  sent: string[];
  emit(frame: unknown): void;
  drop(): void;
  readyState: number;
} {
  const listeners: Record<string, ((event: never) => void)[]> = {};
  return {
    sent: [],
    readyState: 1,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
    addEventListener(type: string, listener: (event: never) => void) {
      (listeners[type] ??= []).push(listener);
    },
    emit(frame: unknown) {
      for (const l of listeners.message ?? []) (l as (e: unknown) => void)({ data: JSON.stringify(frame) });
    },
    drop() {
      this.readyState = 3;
      for (const l of listeners.close ?? []) (l as () => void)();
    },
  } as never;
}

describe('spec 146 phase 2: the client', () => {
  it('resolves a call with the exit value', async () => {
    const socket = fakeSocket();
    const client = new T3Client(socket);
    const promise = client.call('vcs.status', { cwd: '/repo' });
    socket.emit({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: { clean: true } } });
    await expect(promise).resolves.toEqual({ clean: true });
  });

  it('ACKS every chunk, because a non-acking client stalls its own stream', async () => {
    // The protocol obligation the spike never exercised. The server enables
    // ack backpressure; without this the stream stops and looks like silence.
    const socket = fakeSocket();
    const client = new T3Client(socket);
    const values: unknown[] = [];
    const promise = client.stream('orchestration.subscribeThread', {}, (v) => values.push(v));

    socket.emit({ _tag: 'Chunk', requestId: 1, values: ['a', 'b'] });
    socket.emit({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success' } });
    await promise;

    const acks = socket.sent.map((s) => JSON.parse(s)).filter((f) => f._tag === 'Ack');
    expect(acks, 'every Chunk must be acked').toHaveLength(1);
    expect(acks[0].requestId).toBe(1);
    expect(values).toEqual(['a', 'b']);
  });

  it('acks BEFORE delivering, so a slow consumer cannot deadlock the connection', async () => {
    const socket = fakeSocket();
    const client = new T3Client(socket);
    let ackedWhenHandlerRan = false;
    const promise = client.stream('orchestration.subscribeThread', {}, () => {
      ackedWhenHandlerRan = socket.sent.some((s) => JSON.parse(s)._tag === 'Ack');
    });
    socket.emit({ _tag: 'Chunk', requestId: 1, values: ['x'] });
    socket.emit({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success' } });
    await promise;
    expect(ackedWhenHandlerRan).toBe(true);
  });

  it('fails loudly at the call site when the socket is not open — it does not queue', async () => {
    const socket = fakeSocket();
    socket.readyState = 3;
    const client = new T3Client(socket);
    await expect(client.call('vcs.status', {})).rejects.toThrow(NotConnectedError);
  });

  it('rejects in-flight requests when the socket drops, rather than hanging', async () => {
    const socket = fakeSocket();
    const client = new T3Client(socket);
    const promise = client.call('vcs.status', {});
    socket.drop();
    await expect(promise).rejects.toThrow(NotConnectedError);
    expect(client.inFlight).toBe(0);
  });

  it('surfaces a malformed frame rather than treating it as no frames', () => {
    const socket = fakeSocket();
    const onMalformed = vi.fn();
    // eslint-disable-next-line no-new
    new T3Client(socket, { onMalformed });
    for (const l of [] as never[]) void l;
    (socket as unknown as { emit(f: unknown): void }).emit({ _tag: 'Nonsense' });
    expect(onMalformed).toHaveBeenCalledOnce();
  });
});
