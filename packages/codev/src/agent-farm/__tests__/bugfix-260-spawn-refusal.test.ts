/**
 * Issue #260 — a session refusal must FAIL the spawn, not merely be logged.
 *
 * ## What these tests are for
 *
 * `SessionStartFailedError` reached three of its four states before this. #238 gave it
 * a name distinct from a timeout, #241 supplied the subscription that lets it be raised
 * at all, and #258 gave `track()` a rejection handler so it was at least logged. Nothing
 * ACTED on it: `engine.create` returned a thread id, the caller wrote a builder row, and
 * the operator got an agent that had spawned fine and would never do anything.
 *
 * So these tests drive the real `createPorchThreadEngine` against the real
 * `ThreadSubscriptionPool` — the shape `spec-241-thread-subscriptions.test.ts`
 * established, and for its reason: an in-memory engine records what it is handed and
 * would agree with itself here. What is under test is the seam between the tracker's
 * rejection and `create`'s return, and only the production engine has one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import {
  createPorchThreadEngine,
  SESSION_REFUSAL_GRACE_MS,
} from '../porch-thread-engine.js';
import {
  createThreadSubscriptionPool,
  type ThreadSubscriber,
} from '../thread-subscriptions.js';

/** The sentence the server actually returns for the case that motivated #238. */
const OPENCODE_DISABLED = "Provider instance 'opencode' is disabled in T3 Code settings.";

/** A `thread.session-set` reporting the session refused to start. */
function sessionError(sequence: number, aggregateId: string, lastError: string) {
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

/** A `thread.session-set` carrying `activeTurnId`, as a healthy start emits it. */
function sessionSet(sequence: number, aggregateId: string, activeTurnId: string | null) {
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

/**
 * A subscriber that holds the stream open, so a test drives it by hand.
 *
 * Held open rather than resolved: a stream that ends makes `ResumingSubscription`
 * resubscribe, which would turn each of these into a reconnect loop.
 */
function scriptedSubscriber() {
  let live: { onValue: (v: unknown) => void; end: () => void } | null = null;
  let nextId = 1;
  const subscriber: ThreadSubscriber = {
    stream(_method, _payload, onValue, _timeoutMs, onRequestId) {
      onRequestId?.(nextId++);
      return new Promise<unknown>((resolveStream) => {
        live = { onValue, end: () => resolveStream(undefined) };
        queueMicrotask(() => onValue({ kind: 'synchronized' }));
      });
    },
    cancel: () => live?.end(),
  };
  return { subscriber, emit: (value: unknown) => live?.onValue(value) };
}

/**
 * An engine wired to a server that answers the first `thread.turn.start` with `reply`.
 *
 * The reply is scheduled from inside the dispatcher rather than emitted by the test,
 * because that is where the server emits it: after the command lands, and while
 * `create` is still in flight. A test that emitted it afterwards would be measuring a
 * refusal that arrived too late to be raced, which is a different thing.
 */
function engineOn(dir: string, reply: (threadId: string) => unknown, refusalGraceMs?: number) {
  const script = scriptedSubscriber();
  const engineRef: { current?: ReturnType<typeof createPorchThreadEngine> } = {};
  const pool = createThreadSubscriptionPool({
    subscriber: script.subscriber,
    workspaceRoot: dir,
    observe: (value) => engineRef.current?.observe(value),
    log: () => {},
    attachTimeoutMs: 2_000,
    retryDelayMs: 1,
  });

  let threadId = '';
  let turns = 0;
  const engine = createPorchThreadEngine({
    dispatcher: {
      async call(_method: string, payload: unknown) {
        const command = payload as Record<string, unknown>;
        if (command?.type === 'thread.create') threadId = String(command.threadId);
        if (command?.type === 'thread.turn.start' && turns++ === 0) {
          const value = reply(threadId);
          if (value !== undefined) setTimeout(() => script.emit(value), 1);
        }
        return {};
      },
    },
    journal: new DispatchJournal(join(dir, 'commands.jsonl')),
    tracker: new TurnTracker(),
    projectId: 'p1',
    workspaceRoot: dir,
    defaultHarness: 'codex',
    defaultModel: 'gpt-5.6-luna',
    subscriptions: pool,
    ...(refusalGraceMs === undefined ? {} : { refusalGraceMs }),
  });
  engineRef.current = engine;

  return { engine, pool, script, threadId: () => threadId };
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bugfix-260-'));
  mkdirSync(join(dir, 'wt'));
  return dir;
}

const spawn = { builderId: 'bugfix-260', branch: 'builder/bugfix-260', prompt: 'go' };

describe('a session refusal fails the spawn (issue #260)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * THE HEADLINE. Before the fix this resolved with a thread id and the caller went on
   * to write a builder row for an agent the server had already refused to run.
   */
  it('create rejects with the server sentence rather than returning a thread id', async () => {
    dir = workspace();
    const { engine, pool } = engineOn(dir, (threadId) => sessionError(1, threadId, OPENCODE_DISABLED));

    await expect(
      engine.create({ ...spawn, worktreePath: join(dir, 'wt') }),
    ).rejects.toThrow(/failed before the turn started/);

    pool.stopAll();
  });

  /**
   * The sentence itself has to survive. A refusal that reaches the operator as
   * "the spawn failed" sends them to Tower's log for the part that mattered — which is
   * the experience this issue exists to end.
   */
  it('the rejection carries the server reason and is a refusal, not a timeout', async () => {
    dir = workspace();
    const { engine, pool } = engineOn(dir, (threadId) => sessionError(1, threadId, OPENCODE_DISABLED));

    const error = await engine
      .create({ ...spawn, worktreePath: join(dir, 'wt') })
      .then(() => null, (thrown: unknown) => thrown as Error);

    expect(error?.name).toBe('SessionStartFailedError');
    expect(error?.message).toContain(OPENCODE_DISABLED);
    expect(error?.message).toContain('This is a refusal, not a timeout');
    pool.stopAll();
  });

  /**
   * The engine must not keep the refused thread.
   *
   * A record left behind is adopted by `attach`, which returns early on an existing
   * one — so a thread that can never run would be handed back as a live builder, and
   * the pool would keep a stream open for it. This is the "a row for an agent that can
   * never run is its own small version of this bug" half of the issue.
   */
  it('the refused thread is not left in the engine or subscribed to', async () => {
    dir = workspace();
    const { engine, pool, threadId } = engineOn(dir, (id) => sessionError(1, id, OPENCODE_DISABLED));

    await expect(
      engine.create({ ...spawn, worktreePath: join(dir, 'wt') }),
    ).rejects.toThrow(/failed before the turn started/);

    expect(engine.get(threadId())).toBeUndefined();
    expect(engine.worktreePath(threadId())).toBeUndefined();
    expect(pool.threadIds.has(threadId())).toBe(false);
    pool.stopAll();
  });

  /**
   * THE OTHER HALF, and the reason this is a bounded race rather than an await.
   *
   * `running` does not resolve until the server actually starts the turn, which is
   * provider-latency-bound. A spawn that waited for it would have traded an invisible
   * failure for a slow success. Nothing is emitted here at all, so the window can only
   * expire — and the spawn still returns its thread id.
   */
  it('a start slower than the window is not a refusal: the spawn returns', async () => {
    dir = workspace();
    const { engine, pool, threadId } = engineOn(dir, () => undefined, 25);

    const created = await engine.create({ ...spawn, worktreePath: join(dir, 'wt') });

    expect(created).toBe(threadId());
    expect(engine.get(created)?.builderId).toBe('bugfix-260');
    pool.stopAll();
  });

  /**
   * A healthy start inside the window returns immediately and does not sit out the
   * remaining bound — the window is a ceiling, not a delay.
   */
  it('a turn that starts inside the window returns without waiting the window out', async () => {
    dir = workspace();
    const { engine, pool } = engineOn(dir, (threadId) => sessionSet(1, threadId, 'turn-7'), 5_000);

    const began = Date.now();
    const created = await engine.create({ ...spawn, worktreePath: join(dir, 'wt') });

    expect(Date.now() - began).toBeLessThan(2_000);
    await vi.waitFor(() => expect(engine.get(created)?.activeTurnId).toBe('turn-7'));
    pool.stopAll();
  });

  /**
   * A thread created with nothing to say starts no turn, so there is no refusal to
   * race and nothing to wait for. `createArchitectThread` is exactly this call.
   */
  it('a create with no prompt starts no turn and pays no window', async () => {
    dir = workspace();
    const { engine, pool } = engineOn(dir, () => undefined, 5_000);

    const began = Date.now();
    const created = await engine.create({
      builderId: 'architect-main',
      worktreePath: dir,
      branch: '',
      role: 'architect',
    });

    expect(Date.now() - began).toBeLessThan(2_000);
    expect(engine.get(created)?.builderId).toBe('architect-main');
    pool.stopAll();
  });

  it('the production bound is short enough to separate a refusal from a slow start', () => {
    expect(SESSION_REFUSAL_GRACE_MS).toBeLessThanOrEqual(2_000);
  });
});
