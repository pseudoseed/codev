/**
 * The production `t3codeSnapshot` provider (Spec 236, phase 2).
 *
 * The recurring defect in spec 146 is code that passes its tests and that
 * production never reaches, so these tests are written against the two things
 * that decide whether this provider is real:
 *
 *  1. the **synchronous reader performs no I/O** — it is called inside request
 *     handling, and a provider that connects on read is a request that can hang;
 *  2. `observedAt` tracks **subscription liveness**, not event arrival — because
 *     `subscribeThread` has no cadence and an idle session emits nothing, so a
 *     window keyed on events would age a healthy watched session into `stale`.
 *
 * No live t3code server exists on this machine, so the subscription is driven
 * through an injected stream. That limit is stated rather than implied: what is
 * verified here is the cache's behaviour against the vendored contract's frame
 * shapes, not a live server's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { applyFrame, T3codeSessionCache } from '../servers/t3code-session-cache.js';
import {
  buildAgentProtocolSnapshot,
  HumanPairedSessionRegistry,
  type AgentRouteContext,
} from '../servers/agent-routes.js';
import { ApprovalCapabilityStore, ApprovalNonceStore } from '../lib/approval-capability.js';
import { MachineCredentialStore } from '../lib/machine-credentials.js';
import { PairingStore } from '../lib/pairing.js';
import { clearThreadEngines } from '../thread-runtime.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import type { LiveThreadSession } from '../servers/thread-registry.js';
import type { ThreadBackendAvailability } from '../thread-backend.js';

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearThreadEngines();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-236-cache-'));
  dirs.push(dir);
  return normalizeWorkspacePath(dir);
}

function seededDb(workspace: string, threadIds: readonly string[]): Database.Database {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(GLOBAL_SCHEMA);
  db.prepare('INSERT OR IGNORE INTO known_workspaces (workspace_path, name) VALUES (?, ?)')
    .run(workspace, 'ws');
  threadIds.forEach((threadId, index) => {
    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, spawned_by_architect)
      VALUES (?, ?, ?, ?, ?, ?, 'main')
    `).run(workspace, `builder-${index}`, `builder-${index}`,
      join(workspace, '.builders', `b${index}`), `builder/b${index}`, threadId);
  });
  return db;
}

/**
 * A stream the test drives: it hands back the `onValue` sink and never settles.
 *
 * ## `cancel` REMOVES THE SINK, AND THE TEST NEVER DOES
 *
 * This used to expose a `forget(threadId)` that the tests called by hand to make
 * a re-subscribe observable — **a thing production never does.** So the tests
 * passed while `#forget` cancelled nothing: the test performed the cleanup whose
 * absence was the defect, and hid it perfectly.
 *
 * Now the fake behaves like the real one: only `cancel()` removes the sink, and
 * only production calls `cancel()`. If `#forget` stops cancelling, the sink stays
 * and the re-subscribe assertions fail — which is what a test of cancellation
 * has to be.
 */
function heldStream() {
  const sinks = new Map<string, (value: unknown) => void>();
  const settle = new Map<string, () => void>();
  const cancelled: string[] = [];
  const stream = (_method: string, payload: unknown, onValue: (value: unknown) => void) => {
    const threadId = (payload as { threadId: string }).threadId;
    sinks.set(threadId, onValue);
    const done = new Promise<unknown>((resolve) => settle.set(threadId, () => resolve(undefined)));
    return {
      done,
      cancel: () => {
        // Idempotent, like the real one, and it stops delivery — a cancelled
        // stream that kept calling `onValue` would let an orphan write a
        // recreated entry, which is half of what cancellation is for.
        if (!sinks.has(threadId)) return;
        cancelled.push(threadId);
        sinks.delete(threadId);
        settle.delete(threadId);
      },
    };
  };
  return {
    stream,
    emit(threadId: string, frame: unknown) { sinks.get(threadId)?.(frame); },
    end(threadId: string) { settle.get(threadId)?.(); },
    /** Which threads production actually cancelled, in order. */
    cancelled() { return [...cancelled]; },
    subscribed() { return [...sinks.keys()].sort(); },
  };
}

/**
 * The same database with `prepare` broken, so a read throws where a locked or
 * corrupt `global.db` would. Not a mock of the module — the real object, with the
 * one call under test made to fail.
 */
function brokenDb(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function snapshotFrame(over: Record<string, unknown> = {}): unknown {
  return {
    kind: 'snapshot',
    snapshot: {
      snapshotSequence: 1,
      thread: { id: 'th-1', settledAt: null, settledOverride: null, session: { status: 'running' }, ...over },
    },
  };
}

function cacheFor(options: {
  db: Database.Database;
  workspace: string;
  stream?: ReturnType<typeof heldStream>['stream'];
  availability?: ThreadBackendAvailability;
  now?: () => number;
  freshForMs?: number;
  discardAfterMs?: number;
}) {
  return new T3codeSessionCache({
    db: () => options.db,
    log: () => {},
    now: options.now,
    freshForMs: options.freshForMs,
    discardAfterMs: options.discardAfterMs,
    availabilityFor: () => options.availability ?? { kind: 'ready' },
    streamerFor: () => (options.stream ? { stream: options.stream } : undefined),
  });
}

describe('applyFrame folds a subscription into what is known', () => {
  /*
   * A FOLD, NOT A READ, and this is the test that says why.
   *
   * A subscription sends the full snapshot ONCE and everything after it is an
   * event. A reader that only understood the snapshot would freeze each session
   * at subscription time and go on reporting it as current — the exact "it had
   * finished when I last looked" failure this phase exists to prevent, produced
   * from inside the mechanism built to prevent it.
   */
  it('takes both halves from a snapshot frame', () => {
    expect(applyFrame(undefined, snapshotFrame())).toEqual({ status: 'running', settled: false });
  });

  it('reads settledness from the thread, not from the session', () => {
    expect(applyFrame(undefined, snapshotFrame({ settledAt: '2026-08-30T10:00:00Z' })))
      .toEqual({ status: 'running', settled: true });
  });

  /*
   * `settledOverride` is `'settled' | 'active' | null`, NOT a boolean — a first
   * reading of the contract had it as one. An explicit `'active'` means the
   * thread is not settled even though `settledAt` carries a timestamp, so
   * treating `settledAt` as decisive would report a thread its owner explicitly
   * un-settled as finished.
   */
  it('lets an explicit override win over settledAt in both directions', () => {
    expect(applyFrame(undefined, snapshotFrame({
      settledAt: '2026-08-30T10:00:00Z', settledOverride: 'active',
    }))).toEqual({ status: 'running', settled: false });
    expect(applyFrame(undefined, snapshotFrame({
      settledAt: null, settledOverride: 'settled',
    }))).toEqual({ status: 'running', settled: true });
  });

  it('carries lastError when the session reports one', () => {
    expect(applyFrame(undefined, snapshotFrame({ session: { status: 'error', lastError: 'boom' } })))
      .toEqual({ status: 'error', settled: false, lastError: 'boom' });
  });

  it('reports a thread with no session as having none, not as its previous one', () => {
    const previous: LiveThreadSession = { status: 'running', settled: false };
    expect(applyFrame(previous, snapshotFrame({ session: null }))).toBeUndefined();
  });

  const event = (type: string, payload: unknown) => ({ kind: 'event', event: { type, payload } });

  it('replaces the status on thread.session-set and carries settledness forward', () => {
    const current: LiveThreadSession = { status: 'running', settled: true };
    expect(applyFrame(current, event('thread.session-set', { session: { status: 'idle' } })))
      .toEqual({ status: 'idle', settled: true });
  });

  it('moves settledness on thread.settled and thread.unsettled', () => {
    const current: LiveThreadSession = { status: 'idle', settled: false };
    const settled = applyFrame(current, event('thread.settled', { settledAt: 'x' }));
    expect(settled).toEqual({ status: 'idle', settled: true });
    expect(applyFrame(settled, event('thread.unsettled', { reason: 'user' })))
      .toEqual({ status: 'idle', settled: false });
  });

  /*
   * SILENCE ABOUT A FACT IS NOT EVIDENCE AGAINST IT. Most frames say nothing
   * about the session — a message, a checkpoint, a turn event — and erasing the
   * session on each would flip the row to UNKNOWN whenever the agent was busy,
   * which is exactly backwards.
   */
  it.each([
    ['an unrelated event', { kind: 'event', event: { type: 'thread.message-appended', payload: {} } }],
    ['the synchronized marker', { kind: 'synchronized' }],
    ['a frame shape this build cannot parse', { kind: 'something-new', body: 1 }],
    ['a non-object', 'nonsense'],
  ])('leaves what is known untouched on %s', (_name, frame) => {
    const current: LiveThreadSession = { status: 'running', settled: false };
    expect(applyFrame(current, frame)).toEqual(current);
  });

  it('does not invent a status when settledness moves before any session is known', () => {
    expect(applyFrame(undefined, event('thread.settled', { settledAt: 'x' }))).toBeUndefined();
  });
});

describe('the synchronous reader', () => {
  /*
   * THE PROPERTY THE WHOLE DESIGN RESTS ON. `t3codeSnapshot` is called inside
   * request handling. `requestThreadBackend` starts a connect AND performs a
   * five-layer config read on every call, so a reader that asked it would put
   * per-request file I/O and a socket on a code path whose contract is that it
   * returns immediately.
   */
  it('never asks the connector, so no read starts a connect', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const availabilityFor = vi.fn(() => ({ kind: 'ready' }) as ThreadBackendAvailability);
    const cache = new T3codeSessionCache({
      db: () => db,
      log: () => {},
      availabilityFor,
      streamerFor: () => undefined,
    });
    cache.sweep();
    availabilityFor.mockClear();

    for (let i = 0; i < 5; i += 1) cache.snapshot(workspace);
    expect(availabilityFor).not.toHaveBeenCalled();
  });

  it('never reads the database on the read path', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const cache = cacheFor({ db, workspace, stream: heldStream().stream });
    cache.sweep();

    // Closing the database makes any read from it throw. A reader that touched it
    // would fail here rather than answer, which is the point.
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    expect(() => cache.snapshot(workspace)).not.toThrow();
  });

  it('reports connecting for a workspace the maintainer has not reached', () => {
    const workspace = tmp();
    const cache = cacheFor({ db: seededDb(workspace, []), workspace });
    // Not `not-configured`: that would assert a config read that never happened.
    expect(cache.snapshot('/some/other/workspace')).toEqual({ status: 'connecting' });
  });
});

describe('the connector answer reaches the wire as itself', () => {
  it.each([
    [{ kind: 'not-configured' } as const, { status: 'not-configured' }],
    [
      { kind: 'misconfigured', message: 'serverUrl without bootstrapToken' } as const,
      { status: 'misconfigured', message: 'serverUrl without bootstrapToken' },
    ],
    [{ kind: 'connecting' } as const, { status: 'connecting' }],
  ])('maps %o without collapsing it into unreachable', (availability, expected) => {
    const workspace = tmp();
    const cache = cacheFor({ db: seededDb(workspace, ['th-1']), workspace, availability });
    cache.sweep();
    expect(cache.snapshot(workspace)).toEqual(expected);
  });

  it('reports cooling-down with when it started and why', () => {
    const workspace = tmp();
    const cache = cacheFor({
      db: seededDb(workspace, ['th-1']),
      workspace,
      availability: { kind: 'cooling-down', since: 1_700_000_000_000, message: 'ECONNREFUSED' },
    });
    cache.sweep();
    expect(cache.snapshot(workspace)).toEqual({
      status: 'cooling-down',
      message: 'ECONNREFUSED',
      since: new Date(1_700_000_000_000).toISOString(),
    });
  });

  /*
   * A workspace that has opted out must not keep last-known content: there is
   * nothing for it to become current again, so publishing it would be a
   * permanently stale answer about a workspace that simply named no server.
   */
  it('drops content when a workspace stops being configured', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    let availability: ThreadBackendAvailability = { kind: 'ready' };
    const cache = new T3codeSessionCache({
      db: () => db,
      log: () => {},
      availabilityFor: () => availability,
      streamerFor: () => ({ stream: held.stream }),
    });
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    expect(cache.snapshot(workspace).status).toBe('available');

    availability = { kind: 'not-configured' };
    cache.sweep();
    expect(cache.snapshot(workspace)).toEqual({ status: 'not-configured' });
  });
});

describe('observedAt tracks subscription liveness, not event arrival', () => {
  /*
   * THE CORRECTION THAT MATTERS MOST IN THIS PHASE.
   *
   * `orchestration.subscribeThread` is an event stream with NO cadence: a session
   * that is genuinely idle emits nothing at all. A freshness window keyed on
   * event arrival would therefore mark a live, watched, perfectly healthy idle
   * session `stale` — inventing a doubt about the one kind of session there is
   * least reason to doubt.
   */
  it('keeps a watched but silent session available however long it is quiet', () => {
    const workspace = tmp();
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({
      db: seededDb(workspace, ['th-1']),
      workspace,
      stream: held.stream,
      now: () => clock,
      freshForMs: 60_000,
    });
    cache.sweep();
    held.emit('th-1', snapshotFrame());

    clock += 10 * 60_000; // ten minutes of silence on a live subscription
    const snapshot = cache.snapshot(workspace);
    expect(snapshot.status).toBe('available');
    expect(snapshot.status === 'available' && snapshot.threads[0].session)
      .toEqual({ status: 'running', settled: false });
  });

  it('starts ageing when the subscription drops, and says how old the content is', async () => {
    const workspace = tmp();
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({
      db: seededDb(workspace, ['th-1']),
      workspace,
      stream: held.stream,
      now: () => clock,
      freshForMs: 60_000,
      discardAfterMs: 600_000,
    });
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    held.end('th-1');
    await Promise.resolve();
    await Promise.resolve();

    clock += 30_000;
    expect(cache.snapshot(workspace).status).toBe('available');

    clock += 60_000;
    const stale = cache.snapshot(workspace);
    expect(stale.status).toBe('stale');
    expect(stale.status === 'stale' && stale.ageMs).toBe(90_000);
    // The last-known content still travels: withholding it would be
    // indistinguishable from "t3code returned no state for this thread".
    expect(stale.status === 'stale' && stale.threads[0].session?.status).toBe('running');
  });

  it('discards content too old to be worth a disclaimer', async () => {
    const workspace = tmp();
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({
      db: seededDb(workspace, ['th-1']),
      workspace,
      stream: held.stream,
      now: () => clock,
      freshForMs: 60_000,
      discardAfterMs: 120_000,
    });
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    held.end('th-1');
    await Promise.resolve();
    await Promise.resolve();

    clock += 200_000;
    // Falls back to reachability on its own merits rather than publishing content
    // that is a wrong answer with a disclaimer on it.
    expect(cache.snapshot(workspace).status).toBe('connecting');
  });
});

describe('a status is never claimed that was not established', () => {
  /*
   * BOTH OF THESE SHIPPED IN THE FIRST CUT AND BOTH WERE FOUND BY REVIEW. They
   * are the same defect from two directions: a word that asserts more than the
   * process actually knows.
   */

  it('does not call a thread available before any frame has arrived', () => {
    const workspace = tmp();
    const held = heldStream();
    const cache = cacheFor({ db: seededDb(workspace, ['th-1']), workspace, stream: held.stream });
    cache.sweep();
    // The subscription is open and has delivered nothing. Publishing the entry
    // here reported `available` with an age of ~0 for a thread whose state
    // nothing had seen — a claim to have observed something unobserved.
    expect(cache.snapshot(workspace)).toEqual({ status: 'connecting' });

    held.emit('th-1', snapshotFrame());
    expect(cache.snapshot(workspace).status).toBe('available');
  });

  it('does not age a subscription that ended without ever delivering a frame', async () => {
    const workspace = tmp();
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({
      db: seededDb(workspace, ['th-1']), workspace, stream: held.stream, now: () => clock,
    });
    cache.sweep();
    held.end('th-1');
    await Promise.resolve();
    await Promise.resolve();

    clock += 10 * 60_000;
    // Not `stale`: there is nothing to be stale. Stamping a time on the drop
    // would turn "never seen" into "seen just now, then lost".
    expect(cache.snapshot(workspace)).toEqual({ status: 'connecting' });
  });

  /*
   * THE STATE EVERY REAL WORKSPACE IS IN. No row in `global.db` carries a
   * `thread_id`, so a connected, healthy, correctly configured Tower reported
   * "still connecting to t3code" for as long as it ran — the connector's word for
   * a connect in flight, said after the connector had already answered `ready`.
   */
  it('reports a ready backend with no threads as available and empty, not connecting', () => {
    const workspace = tmp();
    const cache = cacheFor({ db: seededDb(workspace, []), workspace, stream: heldStream().stream });
    cache.sweep();
    const snapshot = cache.snapshot(workspace);
    expect(snapshot.status).toBe('available');
    expect(snapshot.status === 'available' && snapshot.threads).toEqual([]);
  });

  it('keeps connecting for a ready backend whose threads have not answered yet', () => {
    const workspace = tmp();
    const cache = cacheFor({ db: seededDb(workspace, ['th-1']), workspace, stream: heldStream().stream });
    cache.sweep();
    // Distinct from the case above: subscriptions ARE open and have not answered,
    // which resolves on its own. "Nothing to watch" never will.
    expect(cache.snapshot(workspace)).toEqual({ status: 'connecting' });
  });
});

describe('against the real connector, not an injected one', () => {
  /*
   * Every other test here injects `availabilityFor`, which proves nothing about
   * what `requestThreadBackend` does. The plan's deliverable is that a workspace
   * with no `threads` block causes NO CONNECTION ATTEMPT — asserted by observing
   * that none was attempted, not by observing the status alone.
   */
  it('starts nothing for a workspace with no threads configuration', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const streamerFor = vi.fn(() => undefined);
    const cache = new T3codeSessionCache({ db: () => db, log: () => {}, streamerFor });
    cache.sweep();

    // The real `requestThreadBackend` read the real (absent) config and answered
    // `not-configured`, so the maintainer never reached the streamer at all — no
    // subscription, no connect, and no cooldown entry to heal later.
    expect(cache.snapshot(workspace)).toEqual({ status: 'not-configured' });
    expect(streamerFor).not.toHaveBeenCalled();
  });
});

describe('a failed read is not an answer', () => {
  /*
   * THE SAME DEFECT AS THE TWO ITERATION-1 BUGS, ONE LAYER DOWN, and found by
   * review after both were fixed. `#threadIds` caught a failed query and returned
   * an empty array; the sweep then stamped a zero count, dropped every entry, and
   * published `available` with nothing to watch. A locked `global.db` says
   * nothing whatever about how many threads a workspace has.
   */
  it('keeps the previous thread set when global.db cannot be read', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    let readable = true;
    const cache = new T3codeSessionCache({
      // `#workspaces` keeps its own last answer, so this only breaks the
      // thread-set read — which is the path under test.
      db: () => (readable ? db : brokenDb(db)),
      log: () => {},
      availabilityFor: () => ({ kind: 'ready' }),
      streamerFor: () => ({ stream: held.stream }),
    });
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    expect(cache.snapshot(workspace).status).toBe('available');

    readable = false;
    cache.sweep();
    const snapshot = cache.snapshot(workspace);
    // NOT `available` with an empty list, which would assert that this workspace
    // has no threads on the strength of a query that never ran.
    expect(snapshot.status).toBe('available');
    expect(snapshot.status === 'available' && snapshot.threads.map((t) => t.threadId)).toEqual(['th-1']);
  });

  /*
   * PER WORKSPACE, NOT PER PASS. One throwing workspace used to skip every
   * workspace after it in the same sweep, and their entries then aged into
   * `stale` — which reads as a t3code problem in workspaces that never had one.
   */
  it('lets one workspace fail without skipping the rest of the pass', () => {
    const first = tmp();
    const second = tmp();
    const db = new Database(':memory:');
    dbs.push(db);
    db.exec(GLOBAL_SCHEMA);
    for (const workspace of [first, second].sort()) {
      db.prepare('INSERT OR IGNORE INTO known_workspaces (workspace_path, name) VALUES (?, ?)')
        .run(workspace, 'ws');
      db.prepare(`
        INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, spawned_by_architect)
        VALUES (?, ?, ?, ?, 'b', ?, 'main')
      `).run(workspace, `b-${workspace}`, `b-${workspace}`, join(workspace, '.builders', 'b'), `th-${workspace}`);
    }
    const [earlier, later] = [first, second].sort();
    const held = heldStream();
    const cache = new T3codeSessionCache({
      db: () => db,
      log: () => {},
      availabilityFor: (workspace) => {
        if (workspace === earlier) throw new Error('connector exploded');
        return { kind: 'ready' };
      },
      streamerFor: () => ({ stream: held.stream }),
    });
    cache.sweep();
    expect(held.subscribed()).toEqual([`th-${later}`]);
  });
});

describe('a subscription does not outlive its reason', () => {
  /*
   * Deleting the entry alone left the `#subscribed` key behind, so the stream ran
   * on for a thread nothing was reading. Worse than the live socket: if the
   * thread came back, the maintainer considered it already subscribed and never
   * opened a stream for it again — silently unwatched forever.
   */
  it('re-subscribes to a thread that leaves global.db and returns', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1']);

    db.prepare('DELETE FROM builders WHERE thread_id = ?').run('th-1');
    cache.sweep();
    // NOT `held.forget(...)`. The sweep must have cancelled it, and the sink is
    // gone only because production did that — which is the whole assertion.
    expect(held.cancelled()).toEqual(['th-1']);
    expect(held.subscribed()).toEqual([]);

    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, spawned_by_architect)
      VALUES (?, 'again', 'again', ?, 'b', 'th-1', 'main')
    `).run(workspace, join(workspace, '.builders', 'again'));
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1']);
  });

  it('re-subscribes after a workspace stops and resumes being configured', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    let availability: ThreadBackendAvailability = { kind: 'ready' };
    const cache = new T3codeSessionCache({
      db: () => db,
      log: (level, message) => console.log('LOG', level, message),
      availabilityFor: () => availability,
      streamerFor: () => ({ stream: held.stream }),
    });
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1']);

    availability = { kind: 'not-configured' };
    cache.sweep();
    // A workspace that stops being configured cancels its streams, rather than
    // leaving the server producing values for a workspace nobody is reading.
    expect(held.cancelled()).toEqual(['th-1']);
    expect(held.subscribed()).toEqual([]);

    availability = { kind: 'ready' };
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1']);
  });
});

describe('the thread set is re-read, not read once', () => {
  /*
   * A maintainer that reads `global.db` once at boot goes permanently blind to
   * every agent spawned afterwards — which, on a Tower that runs for days, is
   * most of them.
   */
  it('subscribes to a thread that appears after the first pass', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1']);

    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, spawned_by_architect)
      VALUES (?, 'builder-late', 'builder-late', ?, 'builder/late', 'th-2', 'main')
    `).run(workspace, join(workspace, '.builders', 'late'));
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-1', 'th-2']);
  });

  it('drops a thread that has left global.db rather than reporting it forever', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1', 'th-2']);
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    held.emit('th-2', snapshotFrame());
    expect(cache.snapshot(workspace).status === 'available'
      && cache.snapshot(workspace).status).toBe('available');

    db.prepare('DELETE FROM builders WHERE thread_id = ?').run('th-2');
    cache.sweep();
    const snapshot = cache.snapshot(workspace);
    expect(snapshot.status === 'available' && snapshot.threads.map((t) => t.threadId)).toEqual(['th-1']);
  });

  it('subscribes to an architect thread as well as a builder thread', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-builder']);
    db.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, thread_id)
      VALUES (?, 'main', 0, 0, 'seeded', 'th-architect')
    `).run(workspace);
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    expect(held.subscribed()).toEqual(['th-architect', 'th-builder']);
  });
});

/**
 * THE WIRED-UP QUESTION, which is the one this initiative keeps getting wrong.
 *
 * Every test above drives the cache directly. This one drives what a client
 * actually receives: the cache installed as `AgentRouteContext.t3codeSnapshot`,
 * read through `buildAgentProtocolSnapshot`, exactly as the route does.
 */
describe('through buildAgentProtocolSnapshot, as the route builds it', () => {
  function contextFor(db: Database.Database, cache: T3codeSessionCache, root: string): AgentRouteContext {
    return {
      db: () => db,
      log: () => {},
      isKnownWorkspace: () => true,
      humanSessions: new HumanPairedSessionRegistry(),
      approvalCapabilities: new ApprovalCapabilityStore({ root: join(root, 'approval'), machine: 'test' }),
      approvalNonces: new ApprovalNonceStore({ root: join(root, 'approval') }),
      machineCredentials: new MachineCredentialStore({ root: join(root, 'machines') }),
      pairings: new PairingStore({ root: join(root, 'pairing') }),
      t3codeSnapshot: (workspacePath) => cache.snapshot(workspacePath),
    };
  }

  it('publishes an observed session on the row that carries the thread', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    held.emit('th-1', snapshotFrame({ settledAt: '2026-08-30T10:00:00Z' }));

    const { payload } = buildAgentProtocolSnapshot(contextFor(db, cache, tmp()), workspace);
    expect(payload.protocol.t3code).toBe('available');
    expect(payload.protocol.t3codeObservation?.ageMs).toBe(0);
    const row = payload.protocol.identities.find((identity) => identity.threadId === 'th-1');
    expect(row?.session).toEqual({ status: 'running', settled: true });
  });

  /*
   * THE BOUND ON CRITERION 3, ASSERTED RATHER THAN DESCRIBED. Wiring the provider
   * does not give a terminal-backed row a session, because such a row has no
   * thread for one to attach to — and every real row in `global.db` is
   * terminal-backed today. What the wiring buys is that this is now SAYABLE:
   * `available` at the machine, no session on the row.
   */
  it('gives a terminal-backed row no session even when t3code is observed', () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, spawned_by_architect)
      VALUES (?, 'builder-pty', 'builder-pty', ?, 'builder/pty', 'term-pty', 'main')
    `).run(workspace, join(workspace, '.builders', 'pty'));
    const held = heldStream();
    const cache = cacheFor({ db, workspace, stream: held.stream });
    cache.sweep();
    held.emit('th-1', snapshotFrame());

    const { payload } = buildAgentProtocolSnapshot(contextFor(db, cache, tmp()), workspace);
    expect(payload.protocol.t3code).toBe('available');
    const terminalRow = payload.protocol.identities.find((identity) => identity.roleId === 'builder-pty');
    expect(terminalRow?.backing).toBe('terminal');
    expect(terminalRow?.session).toBeUndefined();
  });

  it('publishes not-configured through the route for a workspace naming no server', () => {
    const workspace = tmp();
    const db = seededDb(workspace, []);
    const cache = new T3codeSessionCache({ db: () => db, log: () => {} });
    cache.sweep();
    const { payload } = buildAgentProtocolSnapshot(contextFor(db, cache, tmp()), workspace);
    // NOT `not-provided`: a provider is wired and it answered. The two are
    // different facts and this is the seam where they used to be one.
    expect(payload.protocol.t3code).toBe('not-configured');
  });
});

/*
 * A FAILING RETRY MUST NOT KEEP OLD CONTENT FRESH.
 *
 * The maintainer resubscribes every sweep. The end of each attempt stamped the
 * entry's drop time, so an entry that was observed once and whose subscription
 * then failed permanently had that time reset twelve times a minute, forever:
 * the content never aged past the freshness window, never became `stale`, and
 * was never discarded. THE FAILURE REFRESHED THE FRESHNESS — which is the
 * staleness guarantee this cache exists to provide, defeated by the retry path.
 *
 * The age is measured from when watching STOPPED, and it stops once.
 */
describe('a subscription that keeps failing', () => {
  /** The drop is recorded in a `.then`, so each end needs a microtask to land. */
  const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

  it('lets the content it once observed age to stale and be discarded', async () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({
      db, workspace, stream: held.stream, now: () => clock, freshForMs: 60_000,
    });

    // OBSERVED ONCE, for real.
    cache.sweep();
    held.emit('th-1', snapshotFrame());
    expect(cache.snapshot(workspace).status).toBe('available');

    // Then the subscription drops and every retry drops too, without ever
    // delivering a frame. Twelve attempts is one minute of the 5s sweep.
    held.end('th-1');
    await settled();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      clock += 5_000;
      cache.sweep();
      held.end('th-1');
      await settled();
    }

    // Now past the freshness window measured from the FIRST drop, not from the
    // last failed attempt. Before this fix it was still `available` here, and
    // would have stayed `available` for as long as the retries continued.
    const after = cache.snapshot(workspace);
    expect(after.status, 'a failing retry loop kept old content fresh').not.toBe('available');
    expect(['stale', 'connecting']).toContain(after.status);

    db.close();
    dbs.splice(dbs.indexOf(db), 1);
  });

  /*
   * AND AN ENTRY THAT WAS NEVER OBSERVED STAYS UNOBSERVED. A failed attempt on a
   * thread that has delivered nothing must not stamp a drop time either, or
   * "never seen" becomes "seen just now, then lost".
   */
  it('does not invent an observation for a thread that never delivered one', async () => {
    const workspace = tmp();
    const db = seededDb(workspace, ['th-1']);
    const held = heldStream();
    let clock = 1_000;
    const cache = cacheFor({ db, workspace, stream: held.stream, now: () => clock, freshForMs: 60_000 });

    cache.sweep();
    held.end('th-1');
    await settled();
    clock += 120_000;

    const after = cache.snapshot(workspace);
    expect(after.status).not.toBe('available');
    expect(after.status).not.toBe('stale');

    db.close();
    dbs.splice(dbs.indexOf(db), 1);
  });
});

/**
 * WHICH STATUSES THIS PROVIDER CAN ACTUALLY EMIT (Spec 236, phase 2, revised).
 *
 * The spec's status table promised eight and the provider can reach SIX. Two are
 * out, for two different reasons, and the reasons are not interchangeable:
 *
 * - `unreachable` — `ThreadBackendAvailability` has no such kind, so a failed
 *   connect becomes `cooling-down` and no path reaches it. Reserved for a
 *   producer that genuinely observes it; the registry still signals
 *   `T3CODE_UNREACHABLE` on it.
 * - `not-provided` — what a host that wires NO provider reports. This one IS the
 *   provider, so it can never be the answer here.
 *
 * A status a consumer is told to expect and no producer can emit is worse than
 * one that does not exist — it invites a branch nothing will ever take. This
 * comment and the docs said SEVEN while the assertion below listed six, which is
 * the same defect one level up: a count nobody recomputed after the second
 * exclusion was found.
 *
 * The contract was revised deliberately rather than the variant deleted: deleting
 * it folds "unreachable" into "cooling-down" at the type level, which is the
 * conflation the eight statuses exist to prevent, and the registry still signals
 * `T3CODE_UNREACHABLE` on it for a producer that genuinely observes it.
 *
 * This test is what stops the table and the code drifting apart again. It is
 * exhaustive over the connector's OWN union, so a new connector state that this
 * provider forgets to map fails here rather than reaching a client as something
 * misleading.
 */
describe('the statuses Tower\'s provider can emit', () => {
  const CONNECTOR_STATES: ThreadBackendAvailability[] = [
    { kind: 'ready' },
    { kind: 'connecting' },
    { kind: 'cooling-down', since: 1_700_000_000_000, message: 'ECONNREFUSED' },
    { kind: 'not-configured' },
    { kind: 'misconfigured', message: 'serverUrl without bootstrapToken' },
  ];

  it('emits six of the eight, and never `unreachable` or `not-provided`', async () => {
    const emitted = new Set<string>();
    for (const availability of CONNECTOR_STATES) {
      for (const threads of [[] as string[], ['th-1']]) {
        for (const observe of [false, true]) {
          const workspace = tmp();
          const db = seededDb(workspace, threads);
          const held = heldStream();
          let clock = 1_000;
          const cache = cacheFor({
            db, workspace, stream: held.stream, availability, now: () => clock, freshForMs: 60_000,
          });
          cache.sweep();
          if (observe && threads.length > 0) held.emit('th-1', snapshotFrame());
          emitted.add(cache.snapshot(workspace).status);
          // And again once the content has aged, which is the only path to `stale`.
          if (observe && threads.length > 0) {
            held.end('th-1');
            // The drop is recorded in a `.then`, so the ageing this asserts only
            // starts after a microtask. Reading the snapshot synchronously here
            // would sample the entry while it still counts as watched.
            await Promise.resolve();
            await Promise.resolve();
            clock += 120_000;
            emitted.add(cache.snapshot(workspace).status);
          }
          db.close();
          dbs.splice(dbs.indexOf(db), 1);
        }
      }
    }
    // A workspace the maintainer has never reached is the eighth path.
    emitted.add(cacheFor({ db: seededDb(tmp(), []), workspace: '/x' }).snapshot('/never-swept').status);

    expect([...emitted].sort()).toEqual([
      'available', 'connecting', 'cooling-down', 'misconfigured', 'not-configured', 'stale',
    ]);
    // The two the provider cannot produce, for two different reasons:
    // `unreachable` has no connector state behind it, and `not-provided` is what
    // a host that wires NO provider reports — this one is the provider.
    expect(emitted.has('unreachable')).toBe(false);
    expect(emitted.has('not-provided')).toBe(false);
  });

  /*
   * The connector's union is the input side of the same claim. If a state is
   * added there, this fails and whoever added it has to decide what the provider
   * says — rather than it silently falling through to `connecting`.
   */
  it('is exhaustive over the connector states that exist', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'thread-backend.ts'),
      'utf8',
    );
    // Ends at the blank line after the union, NOT at the first `;` — the members
    // carry their own semicolons (`{ kind: 'cooling-down'; since: number; … }`),
    // so slicing there read three of the five kinds and the test would have
    // "passed" over a list it could not see.
    const from = source.indexOf('export type ThreadBackendAvailability');
    const union = source.slice(from, source.indexOf('\n\n', from));
    const kinds = [...union.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(kinds.length, 'the connector union could not be read; this test has gone blind')
      .toBeGreaterThan(0);
    expect(kinds).toEqual([...CONNECTOR_STATES.map((s) => s.kind)].sort());
  });
});
