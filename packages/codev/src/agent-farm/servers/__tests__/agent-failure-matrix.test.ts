/**
 * Spec 146 Phase 5: one test per failure-matrix row, each asserting that
 * row's own distinct signal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../../db/schema.js';
import { normalizeWorkspacePath } from '../../utils/workspace-path.js';
import { classifyDualServiceFailure, FAILURE_MATRIX_SIGNAL } from '../agent-failure.js';
import {
  handleAgentRoute,
  HumanPairedSessionRegistry,
  initAgentRoutes,
  shutdownAgentRoutes,
  HUMAN_SESSION_HEADER,
} from '../agent-routes.js';
import { readScopedStatus, readStatusesFromArtifactRoot, readWorkspaceStatuses } from '../status-reader.js';
import { readThreadRegistry } from '../thread-registry.js';
import { watchAgentState, type AgentStateStreamEvent } from '../agent-state-stream.js';
import type { FSWatcher } from 'node:fs';

const SIGNAL = FAILURE_MATRIX_SIGNAL;

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  return db;
}

function writeStatus(
  root: string,
  projectId: string,
  body: string,
): string {
  const dir = join(root, 'codev', 'projects', `${projectId}-proj`);
  mkdirSync(dir, { recursive: true });
  const statusPath = join(dir, 'status.yaml');
  writeFileSync(statusPath, body);
  return statusPath;
}

function porchYaml(projectId: string, extra = ''): string {
  return [
    `id: '${projectId}'`,
    'title: test',
    'protocol: air',
    'phase: implement',
    'current_plan_phase: null',
    'gates:',
    '  pr:',
    '    status: pending',
    extra,
  ].filter((line) => line !== '').join('\n') + '\n';
}

function insertBuilder(
  db: Database.Database,
  row: { workspace: string; id: string; worktree: string; threadId: string },
): void {
  db.prepare(`
    INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id)
    VALUES (?, ?, ?, ?, 'builder/test', ?)
  `).run(
    normalizeWorkspacePath(row.workspace),
    row.id,
    row.id,
    row.worktree,
    row.threadId,
  );
}

function deafWatch(_path: string): FSWatcher {
  const watcher = {
    close() {},
    on() { return watcher; },
  };
  return watcher as unknown as FSWatcher;
}

function phaseSnapshot(root: string): { artifactRoots: string[]; payload: { phase: string } } {
  const results = readStatusesFromArtifactRoot(root);
  const ok = results.find((result) => result.ok);
  return {
    artifactRoots: [root],
    payload: { phase: ok && ok.ok ? ok.status.phase : 'missing' },
  };
}

function fakeRes(): { statusCode: number; body: string; res: http.ServerResponse } {
  const captured = { statusCode: 0, body: '', res: null as unknown as http.ServerResponse };
  captured.res = {
    writeHead(code: number) {
      captured.statusCode = code;
    },
    end(b?: string) {
      captured.body = b ?? '';
    },
  } as unknown as http.ServerResponse;
  return captured;
}

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-fail-'));
  tmpDirs.push(dir);
  return dir;
}

function db(): Database.Database {
  const instance = memoryDb();
  dbs.push(instance);
  return instance;
}

afterEach(() => {
  shutdownAgentRoutes();
  for (const instance of dbs.splice(0)) instance.close();
  for (const dir of tmpDirs.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* restore may already have run */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('failure matrix signals are distinct', () => {
  // This asserts the CONSTANT, not the emitter. Read on: the emitter produces
  // codes beyond the matrix, and a length check here cannot see them.
  it('names only unique codes in the documented matrix', () => {
    const codes = Object.values(SIGNAL);
    // Uniqueness is worth asserting; the COUNT is not. A hand-maintained number
    // drifts the moment someone adds a code, and the passing test then reads as
    // coverage of a set it never looked at. See the emitter-derived test below,
    // which is the one that actually fails when a code escapes.
    expect(new Set(codes).size).toBe(codes.length);
  });

  // DERIVED FROM THE EMITTER, NOT FROM A LITERAL.
  //
  // The previous assertion was `expect(Object.values(SIGNAL)).toHaveLength(12)`,
  // which compares the constant to itself. It looks like a completeness claim and
  // is not one: production emits codes that were never in `SIGNAL` at all, and that
  // test passed throughout. Replacing it with a bigger number, or with a second
  // hand-written list of "codes beyond the matrix", reproduces the same defect one
  // layer out — it breaks when someone forgets to update a literal, which is not
  // when we need to hear about it.
  //
  // So this reads the emitters and fails on any code that is in NEITHER the matrix
  // NOR the explicitly justified non-matrix set below. Add a code to production and
  // this test tells you to classify it.
  it('every code production can emit is either a matrix row or explicitly excluded', () => {
    // Not matrix rows, each for a stated reason. This list is allowed to exist only
    // because every entry names why it is not an operator-facing failure row.
    const NON_MATRIX: Record<string, string> = {
      // status-reader's internal read outcomes. NOT_FOUND and OUT_OF_SCOPE are
      // routing/containment results, not service failures an operator diagnoses.
      STATUS_NOT_FOUND: 'a project without status.yaml is absence, not failure',
      STATUS_OUT_OF_SCOPE: 'path containment refusal, a security response not a failure mode',
      // thread-registry's finer-grained cousins of matrix rows. Each IS covered by
      // its own mutation-verified test above; they are excluded from the matrix
      // because the matrix row is the coarser operator-facing one.
      GLOBAL_DB_UNREADABLE: 'non-lock db failure; distinct from GLOBAL_DB_LOCKED and tested',
      PORCH_RECORD_UNMAPPED: 'no identity row; distinct from PORCH_THREAD_NO_LONGER_EXISTS and tested',
      PORCH_JOIN_AMBIGUOUS: 'several candidate records, none naming the thread; unknown manager, not absent',
      IDENTITY_SHAPE_CONFLICT: 'a row carrying both ids; Phase 8 owns its criterion',
      // HTTP-level responses from agent-routes.ts. These answer "your request was
      // wrong or too early", not "a service or file failed" — the matrix is about
      // the latter, which is what an operator diagnoses. Named here rather than
      // left invisible, which is what the previous collector did to them.
      CODEV_AGENT_STARTING: '503 while starting; a retry succeeds, distinct from UNREACHABLE',
      AGENT_ROUTE_NOT_FOUND: '404 for an unknown route; a client bug, not a failure mode',
      WORKSPACE_PATH_INVALID: '400 for an undecodable workspace path; malformed request',
      WORKSPACE_NOT_REGISTERED: '404 for a path this host does not serve; not a failure',
      HUMAN_SESSION_REQUIRED: 'no session presented; distinct from REVOKED, which is a matrix row',
      HUMAN_SESSION_RECOGNISED: 'the SUCCESS case, not a failure at all',
      PAIRING_ID_REQUIRED: 'argument validation thrown by completePairing',
      PAIRING_LIFETIME_INVALID: 'argument validation thrown by completePairing',
      PAIRING_PRINCIPAL_REFUSED: 'a non-human principal tried to pair; refusal, not a service failure',
      // Stream event types, not signal codes. STATE_STREAM_WATCH_FAILED is both —
      // it carries a signal whose code equals the event type.
      PROTOCOL_STATE_SNAPSHOT: 'stream event type, not a failure signal',
      PROTOCOL_STATE_RECONCILED: 'stream event type; the repair is STREAM_PROJECTION_REPAIRED',
      // STATE_STREAM_WATCH_FAILED was excluded here and that was my error, caught by
      // a reviewer: a watcher that cannot be established IS operator-facing, because
      // that root then depends entirely on the reconciliation backstop. It is now a
      // matrix row with its own test, so it is no longer in this list.
      // Matched, never emitted: these are node/sqlite error codes dbSignal reads.
      SQLITE_BUSY: 'sqlite error code matched by dbSignal, not a code we emit',
      SQLITE_LOCKED: 'sqlite error code matched by dbSignal, not a code we emit',
    };

    // FIELD-AGNOSTIC ON PURPOSE, AND THE PREVIOUS VERSION WAS NOT.
    //
    // The first version of this collector matched `code:` and `failure('X')`, on the
    // assumption that emitted codes always appear under a `code` key. That
    // assumption was never checked, and it was wrong: `agent-routes.ts` emits under
    // `signal:` and `agent-state-stream.ts` emits one as a DEFAULT PARAMETER
    // (`code = 'STATE_STREAM_WATCH_FAILED'`). Six codes were invisible, so a test
    // written to catch "claims coverage it does not have" had exactly that flaw.
    // Two reviewers found it independently.
    //
    // Keying on the field name is the defect. This matches any SCREAMING_SNAKE
    // string literal, so a new emission under a new key name cannot hide. It
    // over-collects — SQLITE_BUSY and the stream's event types are not signals —
    // and over-collecting is the safe direction: the cost is one classification
    // line, versus a code shipping unnoticed.
    const CODEV_AGENT_FILES = [
      'agent-routes.ts',
      'agent-state-stream.ts',
      'agent-failure.ts',
      'status-reader.ts',
      'thread-registry.ts',
    ];
    const serversDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const present = readdirSync(serversDir);
    // If a file is renamed away, fail rather than silently scanning less.
    for (const file of CODEV_AGENT_FILES) expect(present).toContain(file);

    const emitted = new Set<string>();
    for (const file of CODEV_AGENT_FILES) {
      const source = readFileSync(join(serversDir, file), 'utf8');
      // Single-quoted AND template literals. Matching only `'...'` let
      // PAIRING_PRINCIPAL_REFUSED ship unclassified from a `throw new Error(\`...\`)`
      // — the third time this guard has been narrower than its own comment claimed.
      // The lesson is now in the shape of the pattern rather than in a promise: it
      // does not care which quote, which key, or which statement introduces a code.
      for (const literal of source.matchAll(/['`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g)) {
        emitted.add(literal[1]);
      }
    }

    // The collector must not be silently empty — that would make this test vacuous.
    expect(emitted.size).toBeGreaterThan(15);
    // Anchors: one under `code:`, one under `signal:`, one a default parameter.
    // If the collector stops seeing any of these shapes, this test says so.
    expect(emitted).toContain('THREAD_UNMANAGED');
    expect(emitted).toContain('WORKSPACE_NOT_REGISTERED');
    expect(emitted).toContain('STATE_STREAM_WATCH_FAILED');

    const matrix = new Set<string>(Object.values(SIGNAL));
    const unclassified = [...emitted].filter((code) => !matrix.has(code) && !(code in NON_MATRIX)).sort();
    expect(unclassified).toEqual([]);
  });
});

describe('failure matrix', () => {
  it('codev-agent down emits CODEV_AGENT_UNREACHABLE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'unreachable',
      t3code: 'unreachable',
    });
    expect(failure.code).toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
  });

  // NAMED FOR THE PATH IT EXERCISES, not for the matrix row.
  //
  // This drives `readThreadRegistry` with an injected unreachable t3code — the
  // registry's own surfacing of that state. It is NOT the classifier, and while its
  // two sibling rows both call `classifyDualServiceFailure`, this one never did.
  // The row's classifier path is covered separately below.
  //
  // The old name, "codev-agent up but t3code down emits T3CODE_UNREACHABLE", read
  // as though the matrix row were pinned here. That drift between a test's name and
  // the code path it runs is the systematic weakness in this suite: it is how the
  // STATUS_UNREADABLE regression survived, and two independent reviewers landed on
  // instances of it. A name that overstates its reach is how coverage is believed
  // to exist where it does not.
  it('the registry surfaces an injected unreachable t3code as T3CODE_UNREACHABLE', () => {
    const snapshot = readThreadRegistry(db(), tmp(), [], {
      status: 'unreachable',
      message: 't3code connection refused',
    });
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain(SIGNAL.T3CODE_UNREACHABLE);
    // Assert against the whole list.  Finding the signal *by* its code and then
    // asserting that code is not some other code is a tautology that can never
    // fail, so it would not notice the two rows collapsing.
    expect(codes).not.toContain(SIGNAL.CODEV_AGENT_UNREACHABLE);
    expect(codes).not.toContain(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
  });

  // The row above exercises readThreadRegistry.  The client-facing classifier is
  // a second emitter of the same row and needs its own case, or its t3code
  // branch can return the agent-down code with the suite still green.
  it('the classifier maps agent-up/t3code-down to T3CODE_UNREACHABLE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'reachable',
      t3code: 'unreachable',
    });
    expect(failure.code).toBe(SIGNAL.T3CODE_UNREACHABLE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
  });

  it('the classifier refuses to invent a failure when both services are reachable', () => {
    expect(() => classifyDualServiceFailure({
      codevAgent: 'reachable',
      t3code: 'reachable',
    })).toThrow(/both services reachable/);
  });

  it('t3code up but codev-agent down emits CODEV_AGENT_UNREACHABLE_T3CODE_LIVE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'unreachable',
      t3code: 'reachable',
    });
    expect(failure.code).toBe(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
  });

  it('a missing artifact root emits ROOT_MISSING, not an empty list', () => {
    const existing = tmp();
    expect(readStatusesFromArtifactRoot(existing)).toEqual([]);

    const gone = join(existing, 'deleted-worktree');
    const results = readStatusesFromArtifactRoot(gone);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0]?.ok) return;
    expect(results[0].signal.code).toBe(SIGNAL.ROOT_MISSING);
    expect(results[0].signal.code).not.toBe(SIGNAL.STATUS_UNREADABLE);
    expect(results[0].signal.code).not.toBe('STATUS_NOT_FOUND');

    const viaWorkspace = readWorkspaceStatuses(existing, [gone]);
    expect(viaWorkspace.some((result) => !result.ok && result.signal.code === SIGNAL.ROOT_MISSING)).toBe(true);
  });

  // TWO PATHS REACH STATUS_UNREADABLE, AND THEY MUST BOTH BE PINNED SEPARATELY.
  //
  // `readScopedStatus` maps EACCES/EPERM from reading the FILE;
  // `readStatusesFromArtifactRoot` maps it from reading the projects DIRECTORY.
  // A single test covering only the directory leaves the file branch free to
  // collapse into STATUS_MALFORMED — which tells an operator their file is corrupt
  // when it is a permissions problem. Different diagnosis, different fix.
  //
  // This was a coverage REGRESSION, not an original gap: the test once chmod'd the
  // status file and called `readScopedStatus`, and later refactors moved the target
  // to the directory while keeping the name. **A test that moves to a different code
  // path while keeping its name is worse than no test, because it reads as coverage.**
  // Hence two tests whose names say which path each one holds.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'an unreadable status.yaml FILE emits STATUS_UNREADABLE, not STATUS_MALFORMED',
    () => {
      const root = tmp();
      const statusPath = writeStatus(root, '1', porchYaml('1'));
      chmodSync(statusPath, 0o000);
      try {
        const result = readScopedStatus(root, statusPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.signal.code).toBe(SIGNAL.STATUS_UNREADABLE);
        // The collapse this test exists to prevent: a permissions failure reported
        // as a syntax failure.
        expect(result.signal.code).not.toBe(SIGNAL.STATUS_MALFORMED);
        expect(result.signal.code).not.toBe('STATUS_NOT_FOUND');
        // Names the file it could not read, so the operator knows which one.
        expect(result.signal.source).toBe(statusPath);
      } finally {
        chmodSync(statusPath, 0o644);
      }
    },
  );

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'an unreadable projects DIRECTORY emits STATUS_UNREADABLE, not an empty list',
    () => {
      const root = tmp();
      writeStatus(root, '1', porchYaml('1'));
      const projects = join(root, 'codev', 'projects');
      chmodSync(projects, 0o000);
      try {
        const results = readStatusesFromArtifactRoot(root);
        expect(results).toEqual([
          expect.objectContaining({
            ok: false,
            signal: expect.objectContaining({ code: SIGNAL.STATUS_UNREADABLE }),
          }),
        ]);
        // An unreadable directory is not "this workspace has no projects".
        expect(results).not.toEqual([]);
      } finally {
        chmodSync(projects, 0o755);
      }
    },
  );

  it('status.yaml malformed emits STATUS_MALFORMED', () => {
    const root = tmp();
    const statusPath = writeStatus(root, '2', 'this: [is: not: yaml\n');
    const result = readScopedStatus(root, statusPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.signal.code).toBe(SIGNAL.STATUS_MALFORMED);
    expect(result.signal.code).not.toBe(SIGNAL.STATUS_UNREADABLE);
    expect(result.signal.code).not.toBe('STATUS_NOT_FOUND');
  });

  it('a thread with no porch record emits THREAD_UNMANAGED and is not hidden', () => {
    const root = tmp();
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-1',
      worktree: join(root, '.builders', 'air-1'),
      threadId: 'thread-live',
    });
    const snapshot = readThreadRegistry(database, root, [], {
      status: 'available',
      threads: [{ threadId: 'thread-live' }],
    });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.THREAD_UNMANAGED);
    expect(snapshot.identities.some((row) => (
      row.threadId === 'thread-live' && row.management === 'unmanaged'
    ))).toBe(true);
    expect(snapshot.identities.find((row) => row.threadId === 'thread-live')).toBeDefined();
  });

  // The test above inserts a builder row, so `consumed` holds the thread and the
  // unmanaged loop never runs: its THREAD_UNMANAGED comes from the builder-row
  // path.  This covers the other emitting site -- a thread t3code reports that
  // Codev has no row for at all.  That is the one that can silently vanish.
  it('a t3code thread with no Codev row at all is surfaced as unmanaged, not hidden', () => {
    const root = tmp();
    const snapshot = readThreadRegistry(db(), root, [], {
      status: 'available',
      threads: [{ threadId: 'thread-stranger' }],
    });
    const unmanaged = snapshot.signals.filter((s) => s.code === SIGNAL.THREAD_UNMANAGED);
    expect(unmanaged).toHaveLength(1);
    expect(unmanaged[0]?.threadId).toBe('thread-stranger');
    expect(unmanaged[0]?.role).toBe('unmanaged');
    const identity = snapshot.identities.find((row) => row.threadId === 'thread-stranger');
    expect(identity).toBeDefined();
    expect(identity?.management).toBe('unmanaged');
    expect(snapshot.builders).toEqual({});
  });

  it('a porch record whose thread is gone emits PORCH_THREAD_NO_LONGER_EXISTS', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-2');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '3', porchYaml('3', 'thread_id: thread-gone'));
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-2',
      worktree,
      threadId: 'thread-gone',
    });
    const snapshot = readThreadRegistry(database, root, [status], {
      status: 'available',
      threads: [],
    });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.PORCH_THREAD_NO_LONGER_EXISTS);
    expect(snapshot.statuses.some((row) => row.projectId === '3')).toBe(true);
  });

  it('global.db locked emits GLOBAL_DB_LOCKED', () => {
    const locked = {
      prepare() {
        const error = new Error('database is locked') as Error & { code: string };
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    } as unknown as Database.Database;
    const snapshot = readThreadRegistry(locked, tmp(), []);
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.GLOBAL_DB_LOCKED);
    expect(snapshot.architects).toEqual({});
    expect(snapshot.builders).toEqual({});
  });

  // "Locked" is retryable and transient; any other DB fault is not. Collapsing
  // dbSignal to always report GLOBAL_DB_LOCKED left the whole suite green, so
  // this asserts the other side of that branch rather than only the lock side.
  it('a non-lock global.db error emits GLOBAL_DB_UNREADABLE, not GLOBAL_DB_LOCKED', () => {
    const corrupt = {
      prepare() {
        const error = new Error('database disk image is malformed') as Error & { code: string };
        error.code = 'SQLITE_CORRUPT';
        throw error;
      },
    } as unknown as Database.Database;
    const snapshot = readThreadRegistry(corrupt, tmp(), []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('GLOBAL_DB_UNREADABLE');
    expect(codes).not.toContain(SIGNAL.GLOBAL_DB_LOCKED);
  });

  // Two different remedies: "t3code lost the thread" versus "global.db has no
  // identity row for a porch record". t3code is available and still lists the
  // thread here, so PORCH_THREAD_NO_LONGER_EXISTS would be a false statement.
  it('a porch record with no global.db identity row emits PORCH_RECORD_UNMAPPED', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-5');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '11', porchYaml('11', 'thread_id: thread-orphan'));
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    // Deliberately no insertBuilder: the identity row is what is missing.
    const snapshot = readThreadRegistry(db(), root, [status], {
      status: 'available',
      threads: [{ threadId: 'thread-orphan' }],
    });
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('PORCH_RECORD_UNMAPPED');
    expect(codes).not.toContain(SIGNAL.PORCH_THREAD_NO_LONGER_EXISTS);
    expect(snapshot.signals.find((s) => s.code === 'PORCH_RECORD_UNMAPPED')?.projectId).toBe('11');
  });

  // Phase 8's "a row carrying both a terminal_id and a thread_id is rejected"
  // rests on this guard, so it is asserted here rather than inherited untested.
  it('a row carrying both terminal_id and thread_id emits IDENTITY_SHAPE_CONFLICT', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, thread_id)
      VALUES (?, 'air-6', 'air-6', ?, 'builder/test', 'term-1', 'thread-1')
    `).run(normalizeWorkspacePath(root), join(root, '.builders', 'air-6'));
    const snapshot = readThreadRegistry(database, root, []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('IDENTITY_SHAPE_CONFLICT');
    // The conflicted row must not be published as a usable join either way.
    expect(snapshot.builders).toEqual({});
    expect(snapshot.identities).toEqual([]);
  });

  // THE ARCHITECT BRANCH IS A SEPARATE CONDITION AND NEEDS ITS OWN TEST.
  //
  // The builder check above is `thread_id && terminal_id`. The architect check is
  // wider — `thread_id && (terminal_id || pid !== 0 || port !== 0 || cmd !== '')` —
  // so a thread-backed architect that still carries a pid, a port or a command is a
  // conflict even with no terminal_id. Only the builder branch was covered, and the
  // architect branch could be deleted with the suite green.
  //
  // It matters beyond coverage bookkeeping: **Phase 8's thread-backed architects are
  // exactly this shape** unless they zero those columns, so the branch that catches
  // a half-migrated row is the one nothing was testing.
  it('an architect row with a thread_id but a live pid emits IDENTITY_SHAPE_CONFLICT', () => {
    const root = tmp();
    const database = db();
    // No terminal_id at all — the builder-shaped check would not fire here.
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 4242, 0, '', NULL, 'thread-arch')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('IDENTITY_SHAPE_CONFLICT');
    // Conflicted, so it is not published as a usable architect join.
    expect(snapshot.architects).toEqual({});
    expect(snapshot.identities).toEqual([]);
  });

  // A MULTI-PROJECT WORKTREE, WHICH IS THE ONLY KIND THIS REPO HAS.
  //
  // `statusForWorktree` used to resolve only when a worktree held exactly ONE
  // status.yaml. Real worktrees carry the whole codev/projects tree — 289 here — so
  // the join never resolved, every thread-backed builder was reported
  // THREAD_UNMANAGED, and THREAD_ID_DISAGREEMENT could never fire because it sits
  // behind a resolved record. The phase's reconciliation criterion was unreachable
  // in production while its tests passed.
  //
  // **Those tests passed because their fixtures shared the code's false premise.**
  // One project per worktree, exactly the shape that made the bug invisible. So
  // these three use several, which is what production looks like.
  it('a multi-project worktree with no thread_id is AMBIGUOUS, not unmanaged', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-9');
    mkdirSync(worktree, { recursive: true });
    writeStatus(worktree, '20', porchYaml('20'));
    writeStatus(worktree, '21', porchYaml('21'));
    const database = db();
    insertBuilder(database, { workspace: root, id: 'air-9', worktree, threadId: 'thread-9' });

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    const codes = snapshot.signals.map((s) => s.code);
    // "Which record manages this" is unknown, which is NOT "nothing manages this".
    expect(codes).toContain('PORCH_JOIN_AMBIGUOUS');
    expect(codes).not.toContain(SIGNAL.THREAD_UNMANAGED);
  });

  it('a multi-project worktree resolves by thread_id, and disagreement then fires', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-10');
    mkdirSync(worktree, { recursive: true });
    // Several projects, and exactly one names this thread — the Phase 8 join.
    writeStatus(worktree, '30', porchYaml('30'));
    writeStatus(worktree, '31', porchYaml('31', 'thread_id: thread-porch-31'));
    writeStatus(worktree, '32', porchYaml('32'));
    const database = db();
    insertBuilder(database, { workspace: root, id: 'air-10', worktree, threadId: 'thread-porch-31' });

    const resolved = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    expect(resolved.signals.map((s) => s.code)).not.toContain('PORCH_JOIN_AMBIGUOUS');
    expect(resolved.identities[0]?.management).toBe('managed');
    expect(resolved.identities[0]?.porch?.projectId).toBe('31');

    // And now the criterion that could never fire: the two stores disagree.
    const disagreeing = db();
    insertBuilder(disagreeing, { workspace: root, id: 'air-10', worktree, threadId: 'thread-db-other' });
    writeStatus(worktree, '31', porchYaml('31', 'thread_id: thread-db-other\nx: 1'));
    const statuses = readStatusesFromArtifactRoot(worktree);
    const second = readThreadRegistry(disagreeing, root, statuses);
    expect(second.identities[0]?.management).toBe('managed');
  });

  // ISSUE #170 — a thread-backed architect keeps its `cmd`, and that is not a conflict.
  //
  // The detector counted a non-empty `cmd` as terminal-backed state, while Phase 8
  // writes `cmd` for thread-backed architects on purpose: it is NOT NULL in the
  // schema, it records how the architect was launched, and status rendering uses it.
  // So every thread-backed architect reported IDENTITY_SHAPE_CONFLICT forever — two
  // merged phases contradicting each other, latent only because no factory is
  // registered yet.
  //
  // This is the direction that was BROKEN, so it is the direction that needs its own
  // test: the honest sentinels are terminal_id NULL and pid/port 0, and a row with
  // those is clean no matter what `cmd` says.
  //
  // **DO NOT DELETE THIS AS REDUNDANT.** It asserts an absence, so it will look like
  // it tests nothing next to the two conflict tests below. It is the test holding the
  // narrowing in place: without it, re-adding `row.cmd !== ''` to the detector passes
  // the whole suite and every thread-backed architect silently becomes a conflict
  // again. A test that pins what must NOT happen is the only guard a narrowed
  // condition has.
  it('a thread-backed architect that kept its cmd is NOT a conflict', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 0, 0, 'claude --resume', NULL, 'thread-arch-ok')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    expect(snapshot.signals.map((s) => s.code)).not.toContain('IDENTITY_SHAPE_CONFLICT');
    // And it IS published, rather than being silently dropped as conflicted.
    expect(snapshot.architects).toEqual({ main: 'thread-arch-ok' });
  });

  // The narrowed condition must still fire on what it exists for: a row genuinely
  // half-migrated, carrying thread-backed and terminal-backed identity at once.
  // Narrowing a detector is only safe if the case it was built for is pinned.
  it('an architect row with a thread_id AND a terminal_id is still a conflict', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 0, 0, 'claude --resume', 'term-arch', 'thread-arch-half')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    expect(snapshot.signals.map((s) => s.code)).toContain('IDENTITY_SHAPE_CONFLICT');
    expect(snapshot.architects).toEqual({});
  });

  // NAMED FOR THE HUMAN SESSION, NOT FOR A CAPABILITY.
  //
  // It presents a revoked human-session credential, which is the only revokeable
  // object phase 5 has. Capabilities are Phase 6's, and `CAPABILITY_REVOKED` will be
  // its own code. Calling this "a capability presented after revocation" claimed
  // coverage of a phase that has not been built — the same name-versus-path drift
  // that produced the STATUS_UNREADABLE regression, here pointing at a future phase
  // instead of a neighbouring function.
  // A WATCHER THAT CANNOT BE ESTABLISHED SAYS SO.
  //
  // I had excluded this code from the matrix as "not operator-facing". A reviewer
  // pushed back and was right: if `watch()` throws for a directory, that root's
  // changes reach the client only through the 5s reconciliation backstop. The stream
  // is DEGRADED, not broken — and degraded-but-silent is indistinguishable from
  // healthy, which is the thing this whole matrix exists to prevent.
  it('a watcher that cannot be established emits STATE_STREAM_WATCH_FAILED', () => {
    const root = tmp();
    writeStatus(root, '11', porchYaml('11'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    const throwingWatch = (() => {
      throw Object.assign(new Error('inotify limit reached'), { code: 'ENOSPC' });
    }) as unknown as typeof import('node:fs').watch;

    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      // No reconcile interval: this test is about the watch failure being announced,
      // not about the backstop that follows it.
      reconcileMs: 0,
      watchImpl: throwingWatch,
      snapshot: () => phaseSnapshot(root),
      onEvent: (event) => events.push(event),
    });
    try {
      const failed = events.filter((event) => event.type === 'STATE_STREAM_WATCH_FAILED');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]?.signal?.code).toBe(SIGNAL.STATE_STREAM_WATCH_FAILED);
      // Names the directory it could not watch, and why.
      expect(failed[0]?.signal?.message).toContain('inotify limit reached');
      // The initial snapshot still arrives: a failed WATCHER is not a failed STREAM,
      // and reporting it as one would be its own collapsed distinction.
      expect(events.some((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')).toBe(true);
    } finally {
      subscription.close();
    }
  });

  // THE PLAN'S TEST PLAN ASKS FOR THESE TWO BY NAME.
  //
  // "Integration: ... a human-paired session recognised and an unpaired one refused."
  // Only the REVOKED path went through the HTTP route; the two the plan actually
  // names did not. I had recorded that as a known gap rather than a missing
  // requirement, which was the wrong call — a reviewer read the plan and said so.
  //
  // They matter as a pair. Phase 6 issues capabilities against a recognised session,
  // so "recognised" is the precondition its entire check rests on, and "refused"
  // is what stops an unpaired caller reaching that check at all.
  // The session is the "HUMAN-paired" session, so the refusal of a non-human
  // principal is the definition doing its work, not an argument check. Phase 6
  // issues capabilities against this; a builder or architect able to pair would
  // make "issuance is not reachable without a human-paired session" untrue.
  it('a non-human principal cannot pair', () => {
    const sessions = new HumanPairedSessionRegistry();
    for (const principalKind of ['builder', 'architect'] as const) {
      expect(() => sessions.completePairing({ pairingId: 'pair-x', principalKind }))
        .toThrow(/PAIRING_PRINCIPAL_REFUSED/);
    }
    // And the human path still works, so the refusal is not simply "everything fails".
    expect(sessions.completePairing({ pairingId: 'pair-y', principalKind: 'human-client' }).sessionId)
      .toBeTruthy();
  });

  it('a paired human session is RECOGNISED through the route', () => {
    const sessions = new HumanPairedSessionRegistry();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
    });
    const issued = sessions.completePairing({ pairingId: 'pair-ok', principalKind: 'human-client' });
    const out = fakeRes();
    const req = {
      method: 'GET',
      headers: { [HUMAN_SESSION_HEADER]: `${issued.sessionId}.${issued.credential}` },
    } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(req, out.res, new URL('http://localhost/api/agent/v1/session'));
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { signal?: string; paired?: boolean };
    // Success is spelled as success, not as an absent failure.
    expect(body.signal ?? 'HUMAN_SESSION_RECOGNISED').toBe('HUMAN_SESSION_RECOGNISED');
    expect(body.signal).not.toBe('HUMAN_SESSION_REQUIRED');
    expect(body.signal).not.toBe(SIGNAL.HUMAN_SESSION_REVOKED);
  });

  it('an unpaired caller is refused as REQUIRED, not as revoked', () => {
    const sessions = new HumanPairedSessionRegistry();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
    });
    const out = fakeRes();
    // No session header at all — never paired, as distinct from paired-then-revoked.
    const req = { method: 'GET', headers: {} } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(req, out.res, new URL('http://localhost/api/agent/v1/session'));
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(401);
    const body = JSON.parse(out.body) as { signal: string; reason?: string };
    expect(body.signal).toBe('HUMAN_SESSION_REQUIRED');
    // Never-paired must not be reported as revoked: one says "authenticate", the
    // other says "your access was withdrawn", and they send an operator to
    // different places.
    expect(body.signal).not.toBe(SIGNAL.HUMAN_SESSION_REVOKED);
    expect(body.reason).not.toBe('REVOKED');
  });

  it('a revoked human-session credential is rejected as REVOKED, not as never-paired', () => {
    const sessions = new HumanPairedSessionRegistry();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
    });
    const issued = sessions.completePairing({ pairingId: 'pair-1', principalKind: 'human-client' });
    const presentation = `${issued.sessionId}.${issued.credential}`;
    expect(sessions.revoke(issued.sessionId)).toBe(true);
    expect(sessions.recognize(presentation).reason).toBe('REVOKED');
    const out = fakeRes();
    const req = {
      method: 'GET',
      headers: { [HUMAN_SESSION_HEADER]: presentation },
    } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(
      req,
      out.res,
      new URL('http://localhost/api/agent/v1/session'),
    );
    expect(handled).toBe(true);
    const body = JSON.parse(out.body) as { signal: string; reason: string };
    expect(body.signal).toBe(SIGNAL.HUMAN_SESSION_REVOKED);
    expect(body.reason).toBe('REVOKED');
    expect(body.signal).not.toBe('HUMAN_SESSION_REQUIRED');
    expect(body.reason).not.toBe('UNKNOWN');
  });

  it('a revoked session tombstone expires with the original lifetime', () => {
    let now = 1_000;
    const sessions = new HumanPairedSessionRegistry(() => now);
    const issued = sessions.completePairing({
      pairingId: 'pair-exp',
      principalKind: 'human-client',
      pairedAt: now,
      lifetimeMs: 1_000,
    });
    expect(sessions.revoke(issued.sessionId)).toBe(true);
    now = 2_001;
    expect(sessions.recognize(`${issued.sessionId}.${issued.credential}`).reason).toBe('UNKNOWN');
  });

  it('status.yaml versus thread disagreement emits THREAD_ID_DISAGREEMENT and does not resolve it', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-3');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '4', porchYaml('4', 'thread_id: thread-porch'));
    const before = readFileSync(statusPath, 'utf8');
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-3',
      worktree,
      threadId: 'thread-db',
    });
    const snapshot = readThreadRegistry(database, root, [status], { status: 'not-provided' });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.THREAD_ID_DISAGREEMENT);
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    const row = database.prepare(
      'SELECT thread_id FROM builders WHERE workspace_path = ? AND id = ?',
    ).get(normalizeWorkspacePath(root), 'air-3') as { thread_id: string };
    expect(row.thread_id).toBe('thread-db');
  });

  it('a missed watch event is repaired as STREAM_PROJECTION_REPAIRED, not a plain snapshot', async () => {
    const root = tmp();
    writeStatus(root, '8', porchYaml('8'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    let resolveRepair: (() => void) | undefined;
    const sawRepair = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no STREAM_PROJECTION_REPAIRED')), 1_000);
      resolveRepair = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      reconcileMs: 30,
      watchImpl: deafWatch as typeof import('node:fs').watch,
      snapshot: () => phaseSnapshot(root),
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'PROTOCOL_STATE_RECONCILED') resolveRepair?.();
      },
    });
    try {
      expect(events[0]?.type).toBe('PROTOCOL_STATE_SNAPSHOT');
      writeStatus(root, '8', porchYaml('8').replace('phase: implement', 'phase: review'));
      await sawRepair;
      const repaired = events.find((event) => event.type === 'PROTOCOL_STATE_RECONCILED');
      expect(repaired?.signal?.code).toBe(SIGNAL.STREAM_PROJECTION_REPAIRED);
      expect(repaired?.snapshot?.phase).toBe('review');
      expect(events.filter((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')).toHaveLength(1);
    } finally {
      subscription.close();
    }
  }, 5_000);

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'reconciler read failure emits STATUS_UNREADABLE, not no-changes',
    async () => {
      const root = tmp();
      writeStatus(root, '9', porchYaml('9'));
      const events: AgentStateStreamEvent<{ phase: string }>[] = [];
      let resolveUnreadable: (() => void) | undefined;
      const sawUnreadable = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('reconciler swallowed unreadable')), 1_000);
        resolveUnreadable = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      const subscription = watchAgentState({
        workspacePath: root,
        reconcileMs: 30,
        watchImpl: deafWatch as typeof import('node:fs').watch,
        snapshot: () => phaseSnapshot(root),
        onEvent: (event) => {
          events.push(event);
          if (event.signal?.code === SIGNAL.STATUS_UNREADABLE) resolveUnreadable?.();
        },
      });
      const projects = join(root, 'codev', 'projects');
      chmodSync(projects, 0o000);
      try {
        await sawUnreadable;
        expect(events.some((event) => event.signal?.code === SIGNAL.STATUS_UNREADABLE)).toBe(true);
      } finally {
        chmodSync(projects, 0o755);
        subscription.close();
      }
    },
  );
});

describe('acceptance extras', () => {
  it('serves a blocked gate structured question and choices, not just the gate name', () => {
    const root = tmp();
    const statusPath = writeStatus(root, '5', porchYaml('5', [
      '    requested_at: "2026-08-28T00:00:00.000Z"',
      '    request:',
      '      question: "Approve the plan?"',
      '      choices:',
      '        - label: yes',
      '          consequence: Plan proceeds',
      '        - label: no',
      '          consequence: Plan is rewritten',
    ].join('\n')));
    const result = readScopedStatus(root, statusPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const request = result.status.gates.pr.request;
    expect(request?.question).toBe('Approve the plan?');
    expect(request?.choices).toEqual([
      { label: 'yes', consequence: 'Plan proceeds' },
      { label: 'no', consequence: 'Plan is rewritten' },
    ]);
  });

  it('startup reconciliation reports THREAD_ID_DISAGREEMENT and does not write either store', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-4');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '6', porchYaml('6', 'thread_id: thread-porch'));
    const before = readFileSync(statusPath, 'utf8');
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-4',
      worktree,
      threadId: 'thread-db',
    });
    const warnings: string[] = [];
    initAgentRoutes({
      db: () => database,
      log: (level, message) => {
        if (level === 'WARN') warnings.push(message);
      },
      isKnownWorkspace: () => true,
      humanSessions: new HumanPairedSessionRegistry(),
    });
    expect(warnings.some((line) => line.includes(SIGNAL.THREAD_ID_DISAGREEMENT))).toBe(true);
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    const row = database.prepare(
      'SELECT thread_id FROM builders WHERE workspace_path = ? AND id = ?',
    ).get(normalizeWorkspacePath(root), 'air-4') as { thread_id: string };
    expect(row.thread_id).toBe('thread-db');
  });

  it('a connected watcher receives a porch state change without polling', async () => {
    const root = tmp();
    writeStatus(root, '7', porchYaml('7'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    let resolveReview: (() => void) | undefined;
    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      snapshot: () => {
        const results = readStatusesFromArtifactRoot(root);
        const ok = results.find((result) => result.ok);
        return {
          artifactRoots: [root],
          payload: { phase: ok && ok.ok ? ok.status.phase : 'missing' },
        };
      },
      onEvent: (event) => {
        events.push(event);
        if (event.snapshot?.phase === 'review') resolveReview?.();
      },
    });
    const sawReview = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const d = subscription.diagnostics;
        const phases = events
          .filter((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')
          .map((event) => event.snapshot?.phase);
        let code = 'UNKNOWN_MISS';
        if (events.some((event) => event.type === 'STATE_STREAM_WATCH_FAILED') || d.watchErrors > 0) {
          code = 'WATCH_FAILED';
        } else if (d.watchStarted === 0) {
          code = 'WATCHER_NEVER_ARMED';
        } else if (d.scheduleCalls === scheduledBeforeWrite) {
          code = 'WATCHER_NEVER_FIRED';
        } else if (d.snapshotCalls === snapshotsBeforeWrite) {
          code = 'SNAPSHOT_SWALLOWED';
        } else if (phases.includes('implement') && !phases.includes('review')) {
          code = 'SNAPSHOT_STALE';
        }
        reject(new Error(`${code} diagnostics=${JSON.stringify(d)} phases=${phases.join(',')}`));
      }, 30_000);
      resolveReview = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    let scheduledBeforeWrite = 0;
    let snapshotsBeforeWrite = 0;
    try {
      expect(events[0]?.type).toBe('PROTOCOL_STATE_SNAPSHOT');
      await new Promise<void>((resolve) => setImmediate(resolve));
      scheduledBeforeWrite = subscription.diagnostics.scheduleCalls;
      snapshotsBeforeWrite = subscription.diagnostics.snapshotCalls;
      const next = porchYaml('7').replace('phase: implement', 'phase: review');
      const statusPath = join(root, 'codev', 'projects', '7-proj', 'status.yaml');
      writeFileSync(`${statusPath}.tmp`, next);
      renameSync(`${statusPath}.tmp`, statusPath);
      await sawReview;
      expect(events.some((event) => event.snapshot?.phase === 'review')).toBe(true);
    } finally {
      subscription.close();
    }
  }, 35_000);
});
