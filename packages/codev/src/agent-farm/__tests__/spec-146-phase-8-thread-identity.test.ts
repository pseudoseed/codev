import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  applyThreadIdentityMigration,
  threadIdentityBackupPath,
} from '../db/index.js';
import {
  allocateSpawnThread,
  assertExclusiveIdentity,
  chooseSpawnPath,
  countPtyDrain,
  countPtyDrainFromBuilders,
  DualIdentityError,
  setSpawnThreadFactory,
  setThreadBackedSpawnsEnabled,
} from '../db/thread-identity.js';
import { launchSpawnedBuilder } from '../commands/spawn.js';
import { readState, recordThreadId, writeState } from '../../commands/porch/state.js';
import type { ProjectState } from '../../commands/porch/types.js';
import type { Builder } from '../types.js';

const PRE_V21_ARCHITECT = `
  CREATE TABLE architect (
    workspace_path TEXT NOT NULL,
    id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    port INTEGER NOT NULL,
    cmd TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    terminal_id TEXT,
    session_id TEXT,
    PRIMARY KEY (workspace_path, id)
  );
`;

const PRE_V21_BUILDERS = `
  CREATE TABLE builders (
    workspace_path TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 0,
    pid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'spawning'
      CHECK(status IN ('spawning', 'implementing', 'blocked', 'pr', 'complete')),
    phase TEXT NOT NULL DEFAULT '',
    worktree TEXT NOT NULL,
    branch TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'spec'
      CHECK(type IN ('spec', 'task', 'protocol', 'shell', 'worktree', 'bugfix', 'pir')),
    task_text TEXT,
    protocol_name TEXT,
    issue_number TEXT,
    terminal_id TEXT,
    spawned_by_architect TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    harness TEXT,
    model TEXT,
    PRIMARY KEY (workspace_path, id)
  );
`;

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

function tableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function columnOrder(db: Database.Database, table: string): string[] {
  return tableInfo(db, table).map((c) => c.name);
}

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '163',
    title: 'thread-identi',
    protocol: 'air',
    phase: 'implement',
    plan_phases: [],
    current_plan_phase: null,
    gates: { pr: { status: 'pending' } },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('Spec 146 Phase 8 — exclusivity and drain', () => {
  afterEach(() => {
    setSpawnThreadFactory(undefined);
    setThreadBackedSpawnsEnabled(true);
  });

  it('rejects a dual identity', () => {
    expect(() => assertExclusiveIdentity({ terminalId: 't', threadId: 'h' }))
      .toThrow(DualIdentityError);
  });

  it('allows terminal-only, thread-only, and neither', () => {
    expect(() => assertExclusiveIdentity({ terminalId: 't' })).not.toThrow();
    expect(() => assertExclusiveIdentity({ threadId: 'h' })).not.toThrow();
    expect(() => assertExclusiveIdentity({})).not.toThrow();
  });

  it('counts PTY drain rows and drops to zero as they complete', () => {
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, status)
                VALUES ('/ws', 'pty-1', 'a', '/wt', 'b', 'term-1', 'implementing')`).run();
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id, status)
                VALUES ('/ws', 'thr-1', 'a', '/wt', 'b', 'thread-1', 'implementing')`).run();
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, status)
                VALUES ('/ws', 'pty-done', 'a', '/wt', 'b', 'term-2', 'complete')`).run();
    expect(countPtyDrain(db)).toBe(1);
    db.prepare(`UPDATE builders SET status = 'complete' WHERE id = 'pty-1'`).run();
    expect(countPtyDrain(db)).toBe(0);
    db.close();
  });

  it('counts drain from in-memory builders the same way', () => {
    const builders: Builder[] = [
      { id: '1', name: 'a', status: 'implementing', phase: '', worktree: '', branch: '', type: 'spec', terminalId: 't' },
      { id: '2', name: 'a', status: 'implementing', phase: '', worktree: '', branch: '', type: 'spec', threadId: 'h' },
      { id: '3', name: 'a', status: 'complete', phase: '', worktree: '', branch: '', type: 'spec', terminalId: 't2' },
    ];
    expect(countPtyDrainFromBuilders(builders)).toBe(1);
  });
});

describe('Spec 146 Phase 8 — spawn path', () => {
  afterEach(() => {
    setSpawnThreadFactory(undefined);
    setThreadBackedSpawnsEnabled(true);
  });

  it('takes the thread path when a factory is registered', async () => {
    setSpawnThreadFactory(async () => 'thread-from-factory');
    const pty = vi.fn(async () => ({ terminalId: 'term-should-not-run' }));
    const identity = await launchSpawnedBuilder({
      builderId: 'air-163',
      worktreePath: '/ws/.builders/air-163',
      branch: 'builder/air-163',
      startPty: pty,
    });
    expect(identity).toEqual({ threadId: 'thread-from-factory' });
    expect(pty).not.toHaveBeenCalled();
  });

  it('returns to the PTY path immediately when thread-backed spawns are stopped', async () => {
    setSpawnThreadFactory(async () => 'thread-orphaned');
    setThreadBackedSpawnsEnabled(false);
    const pty = vi.fn(async () => ({ terminalId: 'term-pty' }));
    const identity = await launchSpawnedBuilder({
      builderId: 'air-1',
      worktreePath: '/ws/.builders/air-1',
      branch: 'builder/air-1',
      startPty: pty,
    });
    expect(identity).toEqual({ terminalId: 'term-pty' });
    expect(pty).toHaveBeenCalledOnce();
    expect(chooseSpawnPath()).toBe('pty');
  });

  it('does not migrate an in-flight PTY builder onto the thread path', async () => {
    setSpawnThreadFactory(async () => 'thread-new');
    const pty = vi.fn(async () => ({ terminalId: 'term-existing' }));
    const identity = await launchSpawnedBuilder({
      existing: { terminalId: 'term-existing' },
      builderId: 'air-1',
      worktreePath: '/ws/.builders/air-1',
      branch: 'builder/air-1',
      startPty: pty,
    });
    expect(identity).toEqual({ terminalId: 'term-existing' });
    expect(chooseSpawnPath({ terminalId: 'term-existing' })).toBe('pty');
  });

  it('keeps a thread-backed builder on the thread path after rollback of new spawns', () => {
    setThreadBackedSpawnsEnabled(false);
    expect(chooseSpawnPath({ threadId: 'thr-live' })).toBe('thread');
  });

  it('allocateSpawnThread fails loud with no factory', async () => {
    await expect(allocateSpawnThread({
      builderId: 'x', worktreePath: '/w', branch: 'b',
    })).rejects.toThrow(/no factory/);
  });
});

describe('Spec 146 Phase 8 — status.yaml round-trip', () => {
  let dir: string;

  beforeEach(() => {
    dir = resolve(tmpdir(), `phase8-status-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a pre-change status.yaml unchanged', () => {
    const statusPath = resolve(dir, 'status.yaml');
    writeState(statusPath, baseState());
    const loaded = readState(statusPath);
    expect(loaded.thread_id).toBeUndefined();
    expect(loaded.id).toBe('163');
    expect(loaded.phase).toBe('implement');
  });

  it('records thread_id on a new status.yaml', () => {
    const statusPath = resolve(dir, 'status.yaml');
    writeState(statusPath, baseState());
    recordThreadId(statusPath, 'thread-abc');
    const loaded = readState(statusPath);
    expect(loaded.thread_id).toBe('thread-abc');
    expect(readFileSync(statusPath, 'utf8')).toMatch(/thread_id: thread-abc/);
  });
});

describe('Spec 146 Phase 8 — v21 migration, backup, restore, convergence', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = resolve(tmpdir(), `phase8-mig-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, 'global.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function openPreV21(): Database.Database {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(PRE_V21_ARCHITECT);
    db.exec(PRE_V21_BUILDERS);
    db.prepare(`INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
                VALUES ('/ws', 'main', 1, 4100, 'claude', 'term-arch')`).run();
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, status)
                VALUES ('/ws', 'pty-live', 'live', '/wt', 'b', 'term-b', 'implementing')`).run();
    return db;
  }

  it('applies to a populated database and every existing row survives', () => {
    const db = openPreV21();
    applyThreadIdentityMigration(db, dbPath);
    const architects = db.prepare('SELECT id, cmd, terminal_id, thread_id FROM architect').all();
    const builders = db.prepare('SELECT id, terminal_id, thread_id, status FROM builders').all();
    expect(architects).toEqual([{ id: 'main', cmd: 'claude', terminal_id: 'term-arch', thread_id: null }]);
    expect(builders).toEqual([{ id: 'pty-live', terminal_id: 'term-b', thread_id: null, status: 'implementing' }]);
    db.close();
  });

  it('fresh GLOBAL_SCHEMA and a migrated database have identical schemas', () => {
    const db = openPreV21();
    applyThreadIdentityMigration(db, dbPath);
    const freshPath = resolve(dir, 'fresh.db');
    const fresh = new Database(freshPath);
    fresh.exec(GLOBAL_SCHEMA);
    expect(tableInfo(db, 'architect')).toEqual(tableInfo(fresh, 'architect'));
    expect(tableInfo(db, 'builders')).toEqual(tableInfo(fresh, 'builders'));
    fresh.close();
    db.close();
  });

  it('takes an automatic backup, logs the path, and restore yields a pre-v21 database', () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const db = openPreV21();
    const { backupPath } = applyThreadIdentityMigration(db, dbPath);
    expect(backupPath).toBe(threadIdentityBackupPath(dbPath));
    expect(existsSync(backupPath)).toBe(true);
    expect(logs.some((l) => l.includes('[info]') && l.includes(backupPath))).toBe(true);
    db.close();
    spy.mockRestore();

    const restoredPath = resolve(dir, 'restored.db');
    copyFileSync(backupPath, restoredPath);
    const restored = new Database(restoredPath);
    expect(columnOrder(restored, 'architect')).not.toContain('thread_id');
    expect(columnOrder(restored, 'builders')).not.toContain('thread_id');
    const row = restored.prepare('SELECT id, cmd FROM architect WHERE id = ?').get('main') as { id: string; cmd: string };
    expect(row).toEqual({ id: 'main', cmd: 'claude' });
    restored.close();
  });

  it('a migrated database accepts previous-release writes that do not name thread_id', () => {
    const db = openPreV21();
    applyThreadIdentityMigration(db, dbPath);
    db.prepare(`INSERT INTO architect (workspace_path, id, pid, port, cmd)
                VALUES ('/ws', 'sibling', 0, 0, 'claude')`).run();
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id)
                VALUES ('/ws', 'legacy-write', 'n', '/wt', 'b', 'term-x')`).run();
    const arch = db.prepare('SELECT cmd FROM architect WHERE id = ?').get('sibling') as { cmd: string };
    const bld = db.prepare('SELECT terminal_id FROM builders WHERE id = ?').get('legacy-write') as { terminal_id: string };
    expect(arch.cmd).toBe('claude');
    expect(bld.terminal_id).toBe('term-x');
    db.close();
  });
});

describe('Spec 146 Phase 8 — no in-flight path migration in source', () => {
  it('contains no UPDATE that copies terminal_id onto thread_id', () => {
    const src = [
      readFileSync(resolve(import.meta.dirname, '../state.ts'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../commands/spawn.ts'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../db/index.ts'), 'utf8'),
    ].join('\n');
    expect(src).not.toMatch(/SET\s+thread_id\s*=\s*terminal_id/i);
    expect(src).not.toMatch(/thread_id\s*=\s*builders\.terminal_id/i);
  });
});
