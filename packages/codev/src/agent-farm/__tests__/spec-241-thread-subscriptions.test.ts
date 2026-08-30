/**
 * Issue #241 — the production thread subscriber.
 *
 * ## What these tests are for, and what they cannot be for
 *
 * #221's first finding is that the in-memory engine records what it is handed and
 * validates nothing, which is precisely why an in-memory suite could not see that
 * production had no subscriber at all. So these tests deliberately do NOT use
 * `createMemoryThreadEngine`. They drive the real `ThreadSubscriptionPool` and the
 * real `createPorchThreadEngine` against a scripted stream, so the thing under test
 * is the wiring between them rather than a mock's agreement with itself.
 *
 * What they still cannot establish is that a real t3code server emits the events in
 * the shape assumed here. That is `spec-241-live-settle.test.ts`, gated on a live
 * server, and it is named rather than implied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createPorchThreadEngine } from '../porch-thread-engine.js';
import {
  createThreadSubscriptionPool,
  SubscriptionNotAttachedError,
  UnsafeThreadIdError,
  type ThreadSubscriber,
} from '../thread-subscriptions.js';

const THREAD = 'thr-abc123';

/** A `thread.session-set` carrying `activeTurnId`, as the server emits it. */
function sessionSet(sequence: number, activeTurnId: string | null, aggregateId = THREAD) {
  return {
    kind: 'event',
    event: {
      sequence,
      aggregateId,
      type: 'thread.session-set',
      eventId: `e${sequence}`,
      payload: { session: { status: 'ready', activeTurnId } },
    },
  };
}

/** A `thread.session-set` reporting the session refused to start. */
function sessionError(sequence: number, lastError: string, aggregateId = THREAD) {
  return {
    kind: 'event',
    event: {
      sequence,
      aggregateId,
      type: 'thread.session-set',
      eventId: `e${sequence}`,
      payload: { session: { status: 'error', lastError, activeTurnId: null } },
    },
  };
}

/**
 * A subscriber that replays a script, then holds the stream open.
 *
 * Held open rather than resolved, because a stream that ends makes
 * `ResumingSubscription` resubscribe — which is correct behaviour and would turn
 * every one of these tests into a reconnect loop that obscures what it is measuring.
 * `endStream` is how a test asks for a drop on purpose.
 */
function scriptedSubscriber() {
  const opened: Array<{ method: string; payload: Record<string, unknown>; requestId: number }> = [];
  const cancelled: number[] = [];
  let nextId = 1;
  let live: { onValue: (v: unknown) => void; end: () => void } | null = null;

  const subscriber: ThreadSubscriber = {
    stream(method, payload, onValue, _timeoutMs, onRequestId) {
      const requestId = nextId++;
      onRequestId?.(requestId);
      opened.push({ method, payload: payload as Record<string, unknown>, requestId });
      return new Promise<unknown>((resolveStream) => {
        live = { onValue, end: () => resolveStream(undefined) };
        // The catch-up replay is empty and the server synchronizes immediately; a
        // test that wants a replay emits before awaiting `ensure`.
        queueMicrotask(() => onValue({ kind: 'synchronized' }));
      });
    },
    cancel(requestId) {
      cancelled.push(requestId);
      live?.end();
    },
  };

  return {
    subscriber,
    opened,
    cancelled,
    emit: (value: unknown) => live?.onValue(value),
    endStream: () => live?.end(),
  };
}

function makePool(dir: string, script: ReturnType<typeof scriptedSubscriber>, observe: (v: unknown) => void) {
  return createThreadSubscriptionPool({
    subscriber: script.subscriber,
    workspaceRoot: dir,
    observe,
    log: () => {},
    attachTimeoutMs: 2_000,
    retryDelayMs: 1,
  });
}

describe('ThreadSubscriptionPool (issue #241)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * THE HEADLINE SYMPTOM.
   *
   * `porch-thread-engine`'s `track()` sets `activeTurnId` at dispatch and clears it
   * from `started.settled`, which resolves only from an observed
   * `thread.session-set` with a null `activeTurnId` after one with a non-null. With
   * no subscriber that promise never resolved and the record read permanently
   * active. This asserts the whole chain: stream value → pool → engine.observe →
   * DriverThread → TurnTracker → the waiter → the record.
   */
  it('a settle event observed through the pool clears the record activeTurnId', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const script = scriptedSubscriber();
    const engineRef: { current?: ReturnType<typeof createPorchThreadEngine> } = {};
    const pool = makePool(dir, script, (value) => engineRef.current?.observe(value));

    const engine = createPorchThreadEngine({
      dispatcher: { async call() { return {}; } },
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
      subscriptions: pool,
    });
    engineRef.current = engine;

    const record = await engine.attach({
      threadId: THREAD,
      worktreePath,
      branch: 'builder/x',
      builderId: 'air-241',
    });
    await engine.startTurn(THREAD, 'go');

    // At dispatch the record claims a turn. That much always worked.
    expect(record.activeTurnId).not.toBeNull();

    script.emit(sessionSet(1, 'turn-9'));
    await vi.waitFor(() => expect(record.activeTurnId).toBe('turn-9'));

    script.emit(sessionSet(2, null));
    await vi.waitFor(() => expect(record.activeTurnId).toBeNull());

    pool.stopAll();
  });

  /**
   * #238's `SessionStartFailedError` was correct and unreachable: it is raised from
   * `TurnTracker.observe`, and nothing fed it. This is the same error arriving at a
   * caller through the production path.
   */
  it('a session refusal reaches the caller as SessionStartFailedError, not a timeout', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const script = scriptedSubscriber();
    const tracker = new TurnTracker();
    const pool = makePool(dir, script, (value) => tracker.observe(value));

    // The waiter, registered the way `startTurn` registers it.
    tracker.observe(sessionSet(1, null));
    await pool.ensure(THREAD);
    const expectation = tracker.expectTurn(THREAD);

    script.emit(sessionError(2, "Provider instance 'opencode' is disabled in T3 Code settings."));

    await expect(expectation.running).rejects.toThrow(/failed before the turn started/);
    await expect(expectation.running).rejects.toThrow(/disabled in T3 Code settings/);
    pool.stopAll();
  });

  /**
   * The other half of the same guard. Delivery is at-least-once, so a refusal from a
   * PREVIOUS turn is redelivered on every resubscription — and killing a healthy turn
   * with a stale refusal would be worse than the failure the guard fixes.
   */
  it('a refusal replayed at or below the waiter start sequence does not kill a healthy turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const tracker = new TurnTracker();
    const pool = makePool(dir, script, (value) => tracker.observe(value));
    await pool.ensure(THREAD);

    // A refusal happens, and the thread's sequence advances past it.
    script.emit(sessionError(5, 'an old refusal'));
    await vi.waitFor(() => expect(tracker.lastSequence(THREAD)).toBe(5));

    const expectation = tracker.expectTurn(THREAD);
    // The same refusal, redelivered. It is at or below `startSequence`.
    script.emit(sessionError(5, 'an old refusal'));
    script.emit(sessionSet(6, 'turn-11'));

    await expect(expectation.running).resolves.toBe('turn-11');
    pool.stopAll();
  });

  /**
   * `start` is for adoption and `ensure` is for dispatch, and the split is not
   * cosmetic: the sweeper reconciles every thread on an interval, so an awaiting
   * adoption would charge a thread whose subscription cannot come up the whole attach
   * budget on every pass and delay every thread behind it.
   */
  it('start opens the subscription without waiting for it to attach', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const neverAttaches: ThreadSubscriber = {
      stream: () => new Promise<unknown>(() => {}),
      cancel: () => {},
    };
    const pool = createThreadSubscriptionPool({
      subscriber: neverAttaches,
      workspaceRoot: dir,
      observe: () => {},
      log: () => {},
      attachTimeoutMs: 30_000,
      retryDelayMs: 1,
    });
    const began = Date.now();
    pool.start(THREAD);
    // Returned immediately, and did NOT pay the 30s budget.
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(pool.threadIds.has(THREAD)).toBe(true);
    expect(pool.attached(THREAD)).toBe(false);
    pool.stopAll();
  });

  it('start refuses an unusable thread id synchronously rather than deferring it', () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    expect(() => pool.start('../../etc/passwd')).toThrow(UnsafeThreadIdError);
    expect(script.opened).toHaveLength(0);
  });

  it('start is idempotent and does not displace a running subscription', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    await pool.ensure(THREAD);
    pool.start(THREAD);
    pool.start(THREAD);
    expect(script.opened).toHaveLength(1);
    expect(pool.attached(THREAD)).toBe(true);
    pool.stopAll();
  });

  it('ensure is idempotent and opens exactly one stream', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    await pool.ensure(THREAD);
    await pool.ensure(THREAD);
    await pool.ensure(THREAD);
    expect(script.opened).toHaveLength(1);
    expect(pool.attached(THREAD)).toBe(true);
    pool.stopAll();
  });

  /**
   * The Tower-restart property, in the shape `air-235-resubscribe.mjs` proves it: the
   * position is read off DISK by something that shares nothing with what wrote it.
   */
  it('a second pool resumes from the cursor file the first one wrote', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const first = scriptedSubscriber();
    const poolA = makePool(dir, first, () => {});
    await poolA.ensure(THREAD);
    // A first subscription sends no `afterSequence`; that is a snapshot, not a gap.
    expect(first.opened[0].payload.afterSequence).toBeUndefined();

    first.emit(sessionSet(1, 'turn-1'));
    first.emit(sessionSet(2, null));
    await vi.waitFor(() =>
      expect(readFileSync(poolA.cursorPath(THREAD), 'utf-8').trim()).toBe('2'),
    );
    poolA.stopAll();

    // Nothing is carried across. A new pool, a new subscriber, a new everything —
    // only the file is shared, which is the whole point.
    const second = scriptedSubscriber();
    const poolB = makePool(dir, second, () => {});
    await poolB.ensure(THREAD);
    expect(second.opened[0].payload.afterSequence).toBe(2);
    poolB.stopAll();
  });

  /**
   * A damaged cursor MUST NOT read as a cold start.
   *
   * Resubscribing from 0 replays the thread from the beginning and is
   * indistinguishable from a first subscription, so it spells "I could not read where
   * I was" exactly like "there was nothing to read".
   */
  it('a corrupt cursor file surfaces CursorUnreadableError rather than resubscribing from zero', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    mkdirSync(join(dir, '.codev', 'thread-cursors'), { recursive: true });
    writeFileSync(pool.cursorPath(THREAD), 'not-a-sequence\n');

    await expect(pool.ensure(THREAD)).rejects.toThrow(/does not hold a sequence/);
    // And nothing was opened: a subscription from the wrong place is worse than none.
    expect(script.opened).toHaveLength(0);
  });

  it('an absent cursor file is a cold start and is not an error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    await expect(pool.ensure(THREAD)).resolves.toBeUndefined();
    expect(script.opened[0].payload.afterSequence).toBeUndefined();
    pool.stopAll();
  });

  it('refuses a thread id that cannot be a cursor filename, before opening anything', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    await expect(pool.ensure('../../etc/passwd')).rejects.toThrow(UnsafeThreadIdError);
    await expect(pool.ensure('has a space')).rejects.toThrow(UnsafeThreadIdError);
    expect(script.opened).toHaveLength(0);
  });

  /**
   * `ResumingSubscription` closes the transport in the `finally` of every attempt.
   * The socket is shared with the dispatch path, so `close` must cancel this stream's
   * request id and nothing else.
   */
  it('stopping cancels the stream request id rather than the shared socket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    await pool.ensure(THREAD);
    const requestId = script.opened[0].requestId;

    pool.stop(THREAD);
    expect(script.cancelled).toContain(requestId);
    // The dispatch path is untouched: the subscriber is still usable.
    expect(pool.attached(THREAD)).toBe(false);
  });

  /**
   * FOUND BY TWO REVIEW LANES INDEPENDENTLY, and it is the race this module exists to
   * close arriving through the failure path instead of the happy one.
   *
   * `ResumingSubscription` calls `onResume` with a `gap` from the `finally` of an
   * attempt that ended BEFORE the server signalled catch-up was complete. That attempt
   * never came up — `#everSubscribed` stays false and the cursor stays put, so the next
   * attempt is another COLD subscribe whose snapshot carries no observable events. The
   * pool used to mark that attached, so `ensure` resolved and a turn could dispatch
   * into precisely the snapshot the guard exists to avoid.
   */
  it('a stream that dies before synchronizing does not count as attached', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    let attempts = 0;
    let live: { end: () => void } | null = null;
    const diesBeforeSync: ThreadSubscriber = {
      stream(_method, _payload, _onValue, _timeoutMs, onRequestId) {
        attempts += 1;
        onRequestId?.(attempts);
        // Ends without ever emitting `synchronized`.
        return new Promise<unknown>((resolveStream) => {
          live = { end: () => resolveStream(undefined) };
          queueMicrotask(() => resolveStream(undefined));
        });
      },
      cancel: () => live?.end(),
    };
    const warnings: string[] = [];
    const pool = createThreadSubscriptionPool({
      subscriber: diesBeforeSync,
      workspaceRoot: dir,
      observe: () => {},
      log: (level, message) => { if (level === 'WARN') warnings.push(message); },
      attachTimeoutMs: 300,
      retryDelayMs: 1,
    });

    await expect(pool.ensure(THREAD)).rejects.toThrow(SubscriptionNotAttachedError);
    expect(pool.attached(THREAD)).toBe(false);
    // And it said which of the two gaps this was, rather than reporting a hole in a
    // subscription that never existed.
    expect(warnings.join('\n')).toContain('ended before the server signalled');
    pool.stopAll();
  });

  /**
   * The other direction of the same distinction, and why `outcome.kind !== 'gap'` —
   * the fix both lanes proposed — would have been wrong. A server that SYNCHRONIZES
   * and declines to resume from the cursor reports a gap too. That subscription is up:
   * the caller reconciles, it does not wait. Refusing to attach on it would turn a
   * recoverable condition into a permanent refusal to dispatch turns.
   */
  it('a gap reported after synchronizing still counts as attached', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    // A cursor on disk, so the subscription resumes and a gap is classifiable.
    const script = scriptedSubscriber();
    const seeded = makePool(dir, script, () => {});
    mkdirSync(join(dir, '.codev', 'thread-cursors'), { recursive: true });
    writeFileSync(seeded.cursorPath(THREAD), '10\n');

    let live: { onValue: (v: unknown) => void } | null = null;
    const gapAfterSync: ThreadSubscriber = {
      stream(_method, _payload, onValue, _timeoutMs, onRequestId) {
        onRequestId?.(1);
        return new Promise<unknown>(() => {
          live = { onValue };
          queueMicrotask(() => {
            // A snapshot instead of the requested replay — the server declining to
            // resume — and then synchronization.
            onValue({ kind: 'snapshot' });
            onValue({ kind: 'synchronized' });
          });
        });
      },
      cancel: () => {},
    };
    const warnings: string[] = [];
    const pool = createThreadSubscriptionPool({
      subscriber: gapAfterSync,
      workspaceRoot: dir,
      observe: () => {},
      log: (level, message) => { if (level === 'WARN') warnings.push(message); },
      attachTimeoutMs: 2_000,
      retryDelayMs: 1,
    });

    await expect(pool.ensure(THREAD)).resolves.toBeUndefined();
    expect(pool.attached(THREAD)).toBe(true);
    // Attached AND reported, because a gap is never absorbed silently.
    expect(warnings.join('\n')).toContain('GAP');
    expect(live).not.toBeNull();
    pool.stopAll();
  });

  it('ensure names the failure when a subscription never attaches', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const neverAttaches: ThreadSubscriber = {
      stream: () => new Promise<unknown>(() => {}),
      cancel: () => {},
    };
    const pool = createThreadSubscriptionPool({
      subscriber: neverAttaches,
      workspaceRoot: dir,
      observe: () => {},
      log: () => {},
      attachTimeoutMs: 50,
      retryDelayMs: 1,
    });
    await expect(pool.ensure(THREAD)).rejects.toThrow(SubscriptionNotAttachedError);
    await expect(pool.ensure(THREAD)).rejects.toThrow(/did not attach/);
    pool.stopAll();
  });

  /**
   * A value for a thread the engine does not hold still has to move `lastSequence`.
   * That number is what `expectTurn` captures as a waiter's `startSequence`, and a
   * tracker that skipped it would hand the next adoption a start sequence below
   * events it had already been shown — the condition under which a replayed refusal
   * kills a healthy turn.
   */
  it('a value for an unadopted thread still advances the tracker sequence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const tracker = new TurnTracker();
    const engine = createPorchThreadEngine({
      dispatcher: { async call() { return {}; } },
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker,
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
    });

    engine.observe(sessionSet(7, null, 'thr-never-adopted'));
    expect(tracker.lastSequence('thr-never-adopted')).toBe(7);
  });

  /**
   * A record and a subscription are two different things, and `attach` was only
   * checking one. The pool drops an entry on a non-retryable failure, so every later
   * sweeper pass hit `attach`'s early return, never reached `start`, and the thread
   * stayed permanently unwatched — while the log said a later pass would adopt it.
   */
  it('re-adopting a thread whose subscription terminated opens a new one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    const engine = createPorchThreadEngine({
      dispatcher: { async call() { return {}; } },
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
      subscriptions: pool,
    });

    const input = { threadId: THREAD, worktreePath, branch: 'b', builderId: 'air-241' };
    await engine.attach(input);
    await vi.waitFor(() => expect(pool.attached(THREAD)).toBe(true));

    // The subscription goes, the record stays — the state the early return could not
    // recover from.
    pool.stop(THREAD);
    expect(pool.threadIds.has(THREAD)).toBe(false);
    expect(engine.get(THREAD)).toBeDefined();

    await engine.attach(input);
    expect(pool.threadIds.has(THREAD)).toBe(true);
    await vi.waitFor(() => expect(pool.attached(THREAD)).toBe(true));
    pool.stopAll();
  });

  it('removeWorktree stops the thread subscription', async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-sub-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const script = scriptedSubscriber();
    const pool = makePool(dir, script, () => {});
    const engine = createPorchThreadEngine({
      dispatcher: { async call() { return {}; } },
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
      subscriptions: pool,
    });

    await engine.attach({ threadId: THREAD, worktreePath, branch: 'b', builderId: 'air-241' });
    // `attach` starts the subscription without awaiting it — adoption is not dispatch.
    await vi.waitFor(() => expect(pool.attached(THREAD)).toBe(true));

    await engine.removeWorktree(THREAD);
    expect(pool.attached(THREAD)).toBe(false);
    expect(script.cancelled).toContain(script.opened[0].requestId);
  });
});
