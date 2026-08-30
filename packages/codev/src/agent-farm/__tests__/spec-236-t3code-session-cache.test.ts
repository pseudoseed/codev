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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { applyFrame, T3codeSessionCache } from '../servers/t3code-session-cache.js';
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

/** A stream the test drives: it hands back the `onValue` sink and never settles. */
function heldStream() {
  const sinks = new Map<string, (value: unknown) => void>();
  const settle = new Map<string, () => void>();
  const stream = (_method: string, payload: unknown, onValue: (value: unknown) => void) => {
    const threadId = (payload as { threadId: string }).threadId;
    sinks.set(threadId, onValue);
    return new Promise<unknown>((resolve) => settle.set(threadId, () => resolve(undefined)));
  };
  return {
    stream,
    emit(threadId: string, frame: unknown) { sinks.get(threadId)?.(frame); },
    end(threadId: string) { settle.get(threadId)?.(); },
    subscribed() { return [...sinks.keys()].sort(); },
  };
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
