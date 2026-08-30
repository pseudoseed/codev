/**
 * The eight-status snapshot vocabulary, and the observation that travels with it
 * (Spec 236, phase 1).
 *
 * WHAT THIS PHASE FIXED, so the tests below are read as the record of a defect
 * rather than as coverage for its own sake. `ThreadRegistrySnapshot.t3code` was a
 * bare status string with nothing beside it, and `ThreadIdentity.sessionState`
 * was one opaque word. Between them they could not carry:
 *
 *  - **how old the content is**, so a cached snapshot could not distinguish "it
 *    has finished" from "it had finished when I last looked"; and
 *  - **thread settledness**, which t3code reports SEPARATELY from session status,
 *    and without which `stopped` cannot be told from `finished`.
 *
 * So the mapping this spec pins was unimplementable against the wire that was
 * there. These tests pin the wire.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { readThreadRegistry, type T3codeThreadSnapshot } from '../servers/thread-registry.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-236-vocab-'));
  dirs.push(dir);
  return dir;
}

/** A workspace with one thread-backed builder, which is the row a session attaches to. */
function seeded(): { db: Database.Database; workspace: string; threadId: string } {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  const workspace = normalizeWorkspacePath(tmp());
  const threadId = 'thr-builder-1';
  db.prepare(`
    INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
    VALUES (?, 'main', 0, 0, 'seeded', 'term-main')
  `).run(workspace);
  db.prepare(`
    INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, spawned_by_architect)
    VALUES (?, 'builder-236', 'builder-236', ?, 'builder/236', ?, 'main')
  `).run(workspace, join(workspace, '.builders', '236'), threadId);
  return { db, workspace, threadId };
}

function read(t3code: T3codeThreadSnapshot) {
  const { db, workspace, threadId } = seeded();
  const snapshot = readThreadRegistry(db, workspace, [], t3code);
  db.close();
  return { snapshot, threadId };
}

describe('the snapshot carries eight distinct statuses', () => {
  /*
   * Six of these are the exact answers `requestThreadBackend` already computes.
   * The point of the test is that each survives to the wire as ITSELF: collapsing
   * any pair spells two different operator remedies with one word, and the pair
   * most likely to be tidied together is `connecting` and `cooling-down` — one
   * resolves on its own, the other will not until a timer passes.
   */
  it.each([
    [{ status: 'not-provided' } as const, 'not-provided'],
    [{ status: 'not-configured' } as const, 'not-configured'],
    [{ status: 'misconfigured', message: 'serverUrl without bootstrapToken' } as const, 'misconfigured'],
    [{ status: 'connecting' } as const, 'connecting'],
    [{ status: 'cooling-down', message: 'connect failed', since: '2026-08-29T10:00:00Z' } as const, 'cooling-down'],
    [{ status: 'unreachable', message: 'ECONNREFUSED' } as const, 'unreachable'],
  ])('publishes %o as its own status', (t3code, expected) => {
    expect(read(t3code).snapshot.t3code).toBe(expected);
  });

  it('publishes available and stale as distinct statuses', () => {
    expect(read({ status: 'available', observedAt: '2026-08-29T10:00:00Z', threads: [] }).snapshot.t3code)
      .toBe('available');
    expect(read({ status: 'stale', observedAt: '2026-08-29T10:00:00Z', ageMs: 1000, threads: [] }).snapshot.t3code)
      .toBe('stale');
  });
});

describe('the observation travels with the content', () => {
  it('reports available as observed now, not as an absent age', () => {
    // "Fresh" and "age unknown" must not be the same payload: a consumer that
    // cannot see an age must not be free to assume it is small.
    const { snapshot } = read({ status: 'available', observedAt: '2026-08-29T10:00:00Z', threads: [] });
    expect(snapshot.t3codeObservation).toEqual({ observedAt: '2026-08-29T10:00:00Z', ageMs: 0 });
  });

  it('reports the age of stale content verbatim from the provider', () => {
    const { snapshot } = read({
      status: 'stale', observedAt: '2026-08-29T10:00:00Z', ageMs: 240_000, threads: [],
    });
    expect(snapshot.t3codeObservation).toEqual({ observedAt: '2026-08-29T10:00:00Z', ageMs: 240_000 });
  });

  it.each(['not-provided', 'not-configured', 'connecting'] as const)(
    'publishes no observation for %s, which has nothing to add beyond the word',
    (status) => {
      expect(read({ status }).snapshot.t3codeObservation).toBeUndefined();
    },
  );

  /*
   * THE FAILURE STATUSES CARRY THEIR OWN WORDS, and this is a regression test
   * for a real gap rather than coverage of a feature. The provider computed a
   * message and this boundary threw it away, so `cooling-down` reached the client
   * as a bare word — waiting, with no when and no why — and `misconfigured`'s
   * account of WHICH part of the config is half-written reached it nowhere at
   * all. A status word with its evidence stripped off sends an operator nowhere.
   */
  it('carries when the cooling-down timer started, and why', () => {
    const { snapshot } = read({
      status: 'cooling-down',
      message: 'ECONNREFUSED 127.0.0.1:3799',
      since: '2026-08-29T10:00:00Z',
    });
    expect(snapshot.t3codeObservation)
      .toEqual({ message: 'ECONNREFUSED 127.0.0.1:3799', since: '2026-08-29T10:00:00Z' });
  });

  it('carries the unreachability message', () => {
    expect(read({ status: 'unreachable', message: 'socket closed' }).snapshot.t3codeObservation)
      .toEqual({ message: 'socket closed' });
  });

  it('carries which part of the configuration is half-written', () => {
    expect(read({ status: 'misconfigured', message: 'serverUrl without bootstrapToken' })
      .snapshot.t3codeObservation).toEqual({ message: 'serverUrl without bootstrapToken' });
  });

  it('never publishes an age on a status that observed nothing', () => {
    for (const t3code of [
      { status: 'cooling-down', message: 'm', since: 's' },
      { status: 'unreachable', message: 'm' },
      { status: 'misconfigured', message: 'm' },
    ] as const) {
      const observation = read(t3code).snapshot.t3codeObservation;
      expect(observation?.observedAt).toBeUndefined();
      expect(observation?.ageMs).toBeUndefined();
    }
  });
});

describe('per-row session content', () => {
  it('carries status, settledness and lastError as three separate facts', () => {
    const { db, workspace, threadId } = seeded();
    const snapshot = readThreadRegistry(db, workspace, [], {
      status: 'available',
      observedAt: '2026-08-29T10:00:00Z',
      threads: [{ threadId, session: { status: 'error', settled: false, lastError: 'provider crashed' } }],
    });
    db.close();
    const row = snapshot.identities.find((identity) => identity.threadId === threadId);
    expect(row?.session).toEqual({ status: 'error', settled: false, lastError: 'provider crashed' });
  });

  it('distinguishes a settled thread from an unsettled one under the same session status', () => {
    // The whole reason settledness is on the wire: `stopped` + settled finished,
    // `stopped` + unsettled did not, and one word could never say both.
    for (const settled of [false, true]) {
      const { db, workspace, threadId } = seeded();
      const snapshot = readThreadRegistry(db, workspace, [], {
        status: 'available',
        observedAt: '2026-08-29T10:00:00Z',
        threads: [{ threadId, session: { status: 'stopped', settled } }],
      });
      db.close();
      expect(snapshot.identities.find((i) => i.threadId === threadId)?.session?.settled).toBe(settled);
    }
  });

  it('attaches nothing when t3code returned the thread with no session', () => {
    const { db, workspace, threadId } = seeded();
    const snapshot = readThreadRegistry(db, workspace, [], {
      status: 'available', observedAt: '2026-08-29T10:00:00Z', threads: [{ threadId }],
    });
    db.close();
    expect(snapshot.identities.find((i) => i.threadId === threadId)?.session).toBeUndefined();
  });

  /*
   * STALE CARRIES CONTENT, and it has to.
   *
   * This attached only on `available`, so a stale snapshot published no per-row
   * session at all — and the downstream stale rule ("a row that last looked
   * finished reports the age instead of the word") had nothing to act on.
   * Withholding the content does not make the answer safer: it makes it
   * indistinguishable from "t3code returned no state for this thread", which is a
   * different fact with a different remedy.
   */
  it('publishes last-known content on a stale snapshot rather than withholding it', () => {
    const { db, workspace, threadId } = seeded();
    const snapshot = readThreadRegistry(db, workspace, [], {
      status: 'stale',
      observedAt: '2026-08-29T10:00:00Z',
      ageMs: 240_000,
      threads: [{ threadId, session: { status: 'idle', settled: true } }],
    });
    db.close();
    expect(snapshot.identities.find((i) => i.threadId === threadId)?.session)
      .toEqual({ status: 'idle', settled: true });
    // And the reader is told the content is last-known, which is what stops it
    // being read as "finished".
    expect(snapshot.t3code).toBe('stale');
    expect(snapshot.t3codeObservation?.ageMs).toBe(240_000);
  });

  it.each(['not-configured', 'connecting', 'cooling-down', 'misconfigured'] as const)(
    'attaches no session under %s, so absence is never mistaken for settled',
    (status) => {
      const t3code = (status === 'cooling-down'
        ? { status, message: 'connect failed', since: '2026-08-29T10:00:00Z' }
        : status === 'misconfigured'
          ? { status, message: 'half-written threads block' }
          : { status }) as T3codeThreadSnapshot;
      const { snapshot, threadId } = read(t3code);
      expect(snapshot.identities.find((i) => i.threadId === threadId)?.session).toBeUndefined();
    },
  );
});

describe('which statuses are a statement about reachability', () => {
  it.each([
    [{ status: 'unreachable', message: 'ECONNREFUSED' } as const, 'ECONNREFUSED'],
    [{ status: 'cooling-down', message: 'connect failed', since: '2026-08-29T10:00:00Z' } as const, 'connect failed'],
  ])('emits T3CODE_UNREACHABLE for %o', (t3code, message) => {
    const signals = read(t3code).snapshot.signals.filter((s) => s.code === 'T3CODE_UNREACHABLE');
    expect(signals).toHaveLength(1);
    expect(signals[0].message).toBe(message);
  });

  /*
   * A workspace that names no t3code server has nothing to be unreachable.
   * Borrowing the unreachability signal for it would send an operator to check a
   * server that does not exist — a confident wrong diagnosis, which is worse than
   * a missing one. Both are carried by the snapshot status instead, and stated
   * once at the machine.
   */
  it.each([
    { status: 'not-configured' } as const,
    { status: 'misconfigured', message: 'half-written threads block' } as const,
    { status: 'not-provided' } as const,
    { status: 'connecting' } as const,
  ])('emits no unreachability signal for %o', (t3code) => {
    expect(read(t3code).snapshot.signals.filter((s) => s.code === 'T3CODE_UNREACHABLE')).toHaveLength(0);
  });
});
