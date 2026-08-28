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
import { checkPayload, checkableMethods, PayloadShapeError } from '../../../t3-client/src/checked.js';
import { ResumingSubscription } from '../../../t3-client/src/subscription.js';

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

  it('reports a replayed range', () => {
    const outcome = classifyResume(45, [item(46), item(47), item(48)]);
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind === 'replayed') expect(outcome.lastSequence).toBe(48);
  });

  it('reports empty when the server had nothing newer', () => {
    const outcome = classifyResume(45, []);
    expect(outcome.kind).toBe('empty');
  });

  it('reports a GAP when a snapshot arrives instead of a range', () => {
    // The spec's exact case: "If afterSequence replay returns a snapshot instead
    // of the requested range, porch treats it as a gap."
    const outcome = classifyResume(45, [item(46)], { threads: [] });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.snapshot).not.toBeNull();
  });

  it('never spells a gap the same way as empty', () => {
    // The assertion that matters: a caller switching on `kind` cannot conflate
    // "nothing happened" with "something happened and we cannot see what".
    const gap = classifyResume(45, [item(99)], { threads: [] });
    const empty = classifyResume(45, []);
    expect(gap.kind).not.toBe(empty.kind);
  });

  // ---------------------------------------------------------------- the fix
  //
  // t3code's `sequence` is a SINGLE GLOBAL COUNTER
  // (`OrchestrationEventStore.ts:160-181` — one `orchestration_events` table,
  // `WHERE sequence > ? ORDER BY sequence ASC`), and `ws.ts:1498-1508` filters
  // that global stream down to one thread. So the numbers a thread sees are
  // sparse by construction.
  //
  // The first version of these tests fed `classifyResume` consecutive integers
  // and asserted that non-consecutive ones were a gap. Both the code and the
  // tests were written from the same wrong premise, so they agreed, and the
  // live run agreed too because it had exactly one active thread. Three
  // instruments, one assumption.

  it('does NOT call a sparse range a gap — other threads own the missing numbers', () => {
    // A healthy replay on a server with other active threads.
    const outcome = classifyResume(45, [item(48), item(51), item(52)]);
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind === 'replayed') expect(outcome.lastSequence).toBe(52);
  });

  it('does NOT call a late start a gap', () => {
    // 46-49 went to other threads. This is the single most common shape on a
    // busy server, and the old code failed every one of them.
    const outcome = classifyResume(45, [item(50)]);
    expect(outcome.kind).toBe('replayed');
  });

  it('drops already-applied events rather than flagging them', () => {
    // t3code overlaps on purpose: "overlapping events are deduped by sequence
    // on the client" (`ws.ts:1481`). Redelivery is the at-least-once design
    // working, not a fault.
    const outcome = classifyResume(45, [item(44), item(45), item(46)]);
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind === 'replayed') {
      expect(outcome.duplicatesDropped).toBe(2);
      expect(outcome.items.map((entry) => entry.sequence)).toEqual([46]);
    }
  });

  it('reports empty when everything returned was already applied', () => {
    const outcome = classifyResume(45, [item(44), item(45)]);
    expect(outcome.kind).toBe('empty');
  });

  it('reports a GAP when events arrive out of ascending order', () => {
    // The store guarantees ORDER BY sequence ASC. A violation means the response
    // is not a range we can reason about, so it must not be sorted into looking
    // correct.
    const outcome = classifyResume(45, [item(48), item(46)]);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.reason).toMatch(/out of order/);
  });

  it('states plainly that a hole inside a replayed range is undetectable here', () => {
    // This is the honest limit, asserted so a later change cannot quietly claim
    // more. `[48, 51, 52]` with 49 genuinely lost and `[48, 51, 52]` with 49
    // belonging to another thread are the SAME RESPONSE. No classifier reading
    // only sequence numbers can separate them; Phase 3 separates them with a
    // control connection and eventId comparison, as the spike did.
    const healthy = classifyResume(45, [item(48), item(51), item(52)]);
    const lostAnEvent = classifyResume(45, [item(48), item(51), item(52)]);
    expect(healthy.kind).toBe(lostAnEvent.kind);
    expect(healthy.kind).toBe('replayed');
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
    // checkPayloads:false: `{ clean: true }` is a placeholder, not a vcs.status
    // result. This test is about Exit resolving to the success value.
    const client = new T3Client(socket, { checkPayloads: false });
    const promise = client.call('vcs.status', { cwd: '/repo' });
    socket.emit({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: { clean: true } } });
    await expect(promise).resolves.toEqual({ clean: true });
  });

  it('ACKS every chunk, because a non-acking client stalls its own stream', async () => {
    // The protocol obligation the spike never exercised. The server enables
    // ack backpressure; without this the stream stops and looks like silence.
    const socket = fakeSocket();
    // checkPayloads:false because this test is about the ACK protocol, not about
    // payload shapes: its values are placeholders under a real method name. The
    // checker rejecting them is the checker working — see the payload-shape
    // describe block below, which asserts exactly that.
    const client = new T3Client(socket, { checkPayloads: false });
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
    // checkPayloads:false because this test is about the ACK protocol, not about
    // payload shapes: its values are placeholders under a real method name. The
    // checker rejecting them is the checker working — see the payload-shape
    // describe block below, which asserts exactly that.
    const client = new T3Client(socket, { checkPayloads: false });
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

// ---------------------------------------------------------------- payload shape checks

describe('spec 146 phase 2: inbound payloads are shape-checked, and a pass is not a proof', () => {
  it('accepts a payload matching the generated shape', () => {
    const outcome = checkPayload('vcs.createWorktree', 'output', {
      worktree: { path: '/tmp/wt', refName: 'main', isMain: false, isCurrent: false, isLocked: false },
    });
    // Either it matched, or the generator could not cover it. What it must NOT
    // be is 'failed' on a well-formed payload.
    expect(outcome.status).not.toBe('failed');
  });

  it('reports a mismatch as FAILED, naming the method and the failing path', () => {
    const outcome = checkPayload('vcs.createWorktree', 'output', { worktree: 'not-an-object' });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBeInstanceOf(PayloadShapeError);
      expect(outcome.error.method).toBe('vcs.createWorktree');
      expect(outcome.error.role).toBe('output');
      expect(outcome.error.paths.length).toBeGreaterThan(0);
      // The message must carry the lower-bound caveat, so a reader cannot take a
      // pass from this checker as contract validity.
      expect(outcome.error.message).toMatch(/LOWER BOUND/);
    }
  });

  it('reports UNCHECKED for a method the contract does not cover — never ok', () => {
    // The rule this project keeps relearning: "I looked and it was fine" and
    // "I had nothing to look with" must not be spelled the same way.
    const outcome = checkPayload('nonexistent.method', 'output', { anything: true });
    expect(outcome.status).toBe('unchecked');
    expect(outcome.status).not.toBe('ok');
    if (outcome.status === 'unchecked') expect(outcome.reason).toMatch(/nonexistent\.method/);
  });

  it('reports UNCHECKED when the contract names no schema for the role', () => {
    // vcs.removeWorktree has `output: null` in the generated contract. That is a
    // real hole, and it must surface as one.
    const covered = checkableMethods();
    expect(covered).toContain('vcs.removeWorktree');
    const outcome = checkPayload('vcs.removeWorktree', 'output', { whatever: 1 });
    expect(outcome.status).toBe('unchecked');
  });

  it('rejects the call when an Exit payload fails its shape check', async () => {
    const sent: string[] = [];
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    const socket: SocketLike = {
      send: (data) => void sent.push(data),
      close: () => {},
      addEventListener: (type: string, listener: never) => {
        if (type === 'message') onMessage = listener as unknown as typeof onMessage;
      },
      readyState: 1,
    } as unknown as SocketLike;

    const client = new T3Client(socket);
    const promise = client.call('vcs.createWorktree', {});
    const id = JSON.parse(sent[0]).id;
    onMessage?.({ data: JSON.stringify([{ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { worktree: 'nope' } } }]) });

    await expect(promise).rejects.toThrow(PayloadShapeError);
  });

  it('records an unchecked method rather than letting the fact vanish', async () => {
    const sent: string[] = [];
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    const socket: SocketLike = {
      send: (data) => void sent.push(data),
      close: () => {},
      addEventListener: (type: string, listener: never) => {
        if (type === 'message') onMessage = listener as unknown as typeof onMessage;
      },
      readyState: 1,
    } as unknown as SocketLike;

    const seen: string[] = [];
    const client = new T3Client(socket, { onUnchecked: (method) => void seen.push(method) });
    const promise = client.call('some.unknown.method', {});
    const id = JSON.parse(sent[0]).id;
    onMessage?.({ data: JSON.stringify([{ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { any: 'thing' } } }]) });

    await expect(promise).resolves.toEqual({ any: 'thing' });
    expect(seen).toContain('some.unknown.method');
    expect(client.uncheckedMethods.get('some.unknown.method')).toMatch(/no generated contract entry/);
  });

  it('can be turned off, and then checks nothing at all', async () => {
    const sent: string[] = [];
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    const socket: SocketLike = {
      send: (data) => void sent.push(data),
      close: () => {},
      addEventListener: (type: string, listener: never) => {
        if (type === 'message') onMessage = listener as unknown as typeof onMessage;
      },
      readyState: 1,
    } as unknown as SocketLike;

    const client = new T3Client(socket, { checkPayloads: false });
    const promise = client.call('vcs.createWorktree', {});
    const id = JSON.parse(sent[0]).id;
    onMessage?.({ data: JSON.stringify([{ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { worktree: 'nope' } } }]) });

    // The same payload that rejects above resolves here. That is the point of the
    // switch, and asserting it means the switch is doing something rather than
    // being a flag nobody wired up.
    await expect(promise).resolves.toEqual({ worktree: 'nope' });
    expect(client.uncheckedMethods.size).toBe(0);
  });
});

// ---------------------------------------------------------------- resuming subscription

describe('spec 146 phase 2: a subscription that survives a drop', () => {
  /**
   * A fake client whose `stream` hands back a scripted set of values and then
   * either ends (server closed the stream) or throws (socket dropped).
   */
  function scriptedTransport(script: Array<{ values: unknown[]; drop?: boolean }>) {
    const calls: Array<Record<string, unknown>> = [];
    let turn = 0;
    const client = {
      async stream(_method: string, payload: Record<string, unknown>, onValue: (v: unknown) => void) {
        calls.push(payload);
        const step = script[turn] ?? { values: [], drop: false };
        turn += 1;
        for (const value of step.values) onValue(value);
        if (step.drop) throw new Error('socket dropped');
        return undefined;
      },
    };
    return { calls, connect: async () => ({ client: client as never, close: () => {} }) };
  }

  const event = (sequence: number) => ({ kind: 'event', event: { sequence } });
  const sync = { kind: 'synchronized' };
  const snap = { kind: 'snapshot', snapshot: { threads: [] } };

  const wiring = (onValue: (v: unknown, s: number | null) => void, onResume: (o: never, i: never) => void) => ({
    method: 'orchestration.subscribeThread',
    payload: { threadId: 't' },
    sequenceOf: (v: unknown) => (v as { event?: { sequence?: number } })?.event?.sequence ?? null,
    isSnapshot: (v: unknown) => (v as { kind?: string })?.kind === 'snapshot',
    isSynchronized: (v: unknown) => (v as { kind?: string })?.kind === 'synchronized',
    onValue,
    onResume: onResume as never,
  });

  it('sends NO afterSequence on a first subscription, and a snapshot then is not a gap', async () => {
    // The distinction that keeps gaps meaningful: reporting one at every startup
    // would train the caller to ignore them.
    const outcomes: string[] = [];
    const t = scriptedTransport([{ values: [snap, sync] }]);
    const sub = new ResumingSubscription(t.connect, {
      ...wiring(() => {}, ((o: { kind: string }) => void outcomes.push(o.kind)) as never),
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 5));
    sub.stop();
    await running;

    expect(t.calls[0]).not.toHaveProperty('afterSequence');
    expect(outcomes[0]).toBe('replayed');
  });

  it('resubscribes with afterSequence at the last APPLIED sequence after a drop', async () => {
    // The deliverable, asserted on the wire rather than in a comment.
    const t = scriptedTransport([
      { values: [event(10), event(11), sync], drop: true },
      { values: [event(12), sync] },
    ]);
    const sub = new ResumingSubscription(t.connect, { ...wiring(() => {}, (() => {}) as never) });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 10));
    sub.stop();
    await running;

    expect(t.calls[1].afterSequence).toBe(11);
    expect(sub.applied).toBe(12);
  });

  it('does not advance past an event whose handler threw, so it is redelivered', async () => {
    let attempts = 0;
    const t = scriptedTransport([
      { values: [event(10), sync], drop: true },
      { values: [event(10), sync] },
    ]);
    const sub = new ResumingSubscription(t.connect, {
      ...wiring(
        () => {
          attempts += 1;
          if (attempts === 1) throw new Error('handler failed');
        },
        (() => {}) as never,
      ),
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 10));
    sub.stop();
    await running;

    // Cursor never moved past 10 on the first pass, so the resubscription asked
    // for it again and the handler saw it twice. At-least-once, by construction.
    expect(t.calls[1].afterSequence).toBe(0);
    expect(attempts).toBe(2);
  });

  it('reports a GAP when a RESUME is answered with a snapshot', async () => {
    const outcomes: Array<{ kind: string }> = [];
    const t = scriptedTransport([
      { values: [event(10), sync], drop: true },
      { values: [snap, sync] },
    ]);
    const sub = new ResumingSubscription(t.connect, {
      ...wiring(() => {}, ((o: { kind: string }) => void outcomes.push(o)) as never),
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 10));
    sub.stop();
    await running;

    expect(outcomes[0].kind).toBe('replayed'); // first subscription
    expect(outcomes[1].kind).toBe('gap'); // the resume was declined
  });

  it('does not re-run the handler for events at or below the cursor', async () => {
    const seen: number[] = [];
    const t = scriptedTransport([
      { values: [event(10), event(11), sync], drop: true },
      // t3code overlaps deliberately: 11 comes back on the resume.
      { values: [event(11), event(12), sync] },
    ]);
    const sub = new ResumingSubscription(t.connect, {
      ...wiring((_v, s) => void (s !== null && seen.push(s)), (() => {}) as never),
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 10));
    sub.stop();
    await running;

    expect(seen).toEqual([10, 11, 12]);
  });
});

describe('spec 146 phase 2: a subscription never answers with silence', () => {
  const event = (sequence: number) => ({ kind: 'event', event: { sequence } });
  const sync = { kind: 'synchronized' };

  function scripted(script: Array<{ values: unknown[]; drop?: boolean }>) {
    let turn = 0;
    const client = {
      async stream(_m: string, _p: Record<string, unknown>, onValue: (v: unknown) => void) {
        const step = script[turn] ?? { values: [], drop: false };
        turn += 1;
        for (const value of step.values) onValue(value);
        if (step.drop) throw new Error('dropped');
        return undefined;
      },
    };
    return async () => ({ client: client as never, close: () => {} });
  }

  it('reports a GAP when the stream ends before the server says catch-up finished', async () => {
    // The failure this closes: the outcome callback fired only on `synchronized`,
    // so a stream cut short produced NO outcome — not success, not gap, nothing.
    // Silence is the one answer that must never be available here.
    const outcomes: Array<{ kind: string; reason?: string }> = [];
    const sub = new ResumingSubscription(scripted([{ values: [event(5)], drop: true }]), {
      method: 'orchestration.subscribeThread',
      payload: { threadId: 't' },
      sequenceOf: (v: unknown) => (v as { event?: { sequence?: number } })?.event?.sequence ?? null,
      isSnapshot: () => false,
      isSynchronized: (v: unknown) => (v as { kind?: string })?.kind === 'synchronized',
      onValue: () => {},
      onResume: ((o: { kind: string; reason?: string }) => void outcomes.push(o)) as never,
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 10));
    sub.stop();
    await running;

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0].kind).toBe('gap');
    expect(outcomes[0].reason).toMatch(/ended before/);
  });

  it('does not open another stream when stop() lands during connect', async () => {
    let opened = 0;
    const client = {
      async stream(_m: string, _p: Record<string, unknown>, onValue: (v: unknown) => void) {
        opened += 1;
        onValue(sync);
        return undefined;
      },
    };
    let releaseConnect: (() => void) | undefined;
    const connect = async () => {
      await new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
      return { client: client as never, close: () => {} };
    };

    const sub = new ResumingSubscription(connect, {
      method: 'orchestration.subscribeThread',
      payload: {},
      sequenceOf: () => null,
      isSnapshot: () => false,
      isSynchronized: (v: unknown) => (v as { kind?: string })?.kind === 'synchronized',
      onValue: () => {},
      onResume: () => {},
    });
    const running = sub.run();
    await new Promise((r) => setTimeout(r, 5));
    sub.stop();
    releaseConnect?.();
    await running;

    expect(opened).toBe(0);
  });
});
