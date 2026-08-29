/**
 * Spec 146 Phase 5: one test per failure-matrix row, each asserting that
 * row's own distinct signal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('names eleven unique codes', () => {
    const codes = Object.values(SIGNAL);
    expect(codes).toHaveLength(11);
    expect(new Set(codes).size).toBe(11);
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

  it('codev-agent up but t3code down emits T3CODE_UNREACHABLE', () => {
    const snapshot = readThreadRegistry(db(), tmp(), [], {
      status: 'unreachable',
      message: 't3code connection refused',
    });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.T3CODE_UNREACHABLE);
    expect(snapshot.signals.find((s) => s.code === SIGNAL.T3CODE_UNREACHABLE)?.code)
      .not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
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

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'status.yaml unreadable emits STATUS_UNREADABLE',
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

  it('a capability presented after revocation emits HUMAN_SESSION_REVOKED', () => {
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
    let resolveReview: (() => void) | undefined;
    const sawReview = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no review snapshot')), 30_000);
      resolveReview = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
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
    try {
      expect(events[0]?.type).toBe('PROTOCOL_STATE_SNAPSHOT');
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
