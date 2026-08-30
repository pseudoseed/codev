import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  applyArchitectAgentMigration,
  applyThreadIdentityMigration,
  threadIdentityBackupPath,
} from '../db/index.js';
import {
  allocateSpawnThread,
  architectWriteValues,
  assertExclusiveIdentity,
  chooseSpawnPath,
  countPtyDrainFromBuilders,
  DualIdentityError,
  setSpawnThreadFactory,
  setThreadBackedSpawnsEnabled,
  THREAD_ARCHITECT_SENTINEL,
} from '../db/thread-identity.js';
import { launchSpawnedBuilder } from '../commands/spawn.js';
import { readState, recordThreadId, writeState } from '../../commands/porch/state.js';
import type { ProjectState } from '../../commands/porch/types.js';
import type { Builder } from '../types.js';

/**
 * The pre-v21 fixture is DERIVED from the shipped `GLOBAL_SCHEMA`, not hand-typed.
 *
 * The iteration-1 `codex` and `opencode` lanes both flagged that a typed fixture is a claim
 * about the schema, and a claim can drift from the thing it describes: a column added to
 * `architect` in `schema.ts` would leave this test passing against a table that no longer
 * exists in production. Deriving it makes the fixture a fact about the real schema instead.
 *
 * `stripThreadId` asserts its own reach — it fails if it did not actually remove a column —
 * so a rename of `thread_id` breaks this by name rather than silently producing a fixture
 * identical to the post-migration shape, which would make every migration test vacuous.
 */
function extractCreateTable(schema: string, table: string): string {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'm');
  const match = schema.match(re);
  if (!match) throw new Error(`GLOBAL_SCHEMA has no CREATE TABLE for ${table}`);
  return match[0].replace('IF NOT EXISTS ', '');
}

function stripColumn(createTable: string, table: string, column: string): string {
  const lines = createTable.split('\n');
  const pattern = new RegExp(`^\\s*${column}\\s+TEXT\\s*,?\\s*$`);
  const columnIndex = lines.findIndex((line) => pattern.test(line));
  if (columnIndex === -1) {
    throw new Error(`Expected a ${column} column to strip from ${table}; the schema changed`);
  }
  // Drop the column and the comment block that documents it, so the fixture reads as a
  // real pre-v21 table rather than one with a dangling explanation of a missing column.
  let firstIndex = columnIndex;
  while (firstIndex > 0 && /^\s*--/.test(lines[firstIndex - 1])) firstIndex -= 1;
  const stripped = [...lines.slice(0, firstIndex), ...lines.slice(columnIndex + 1)];
  if (stripped.length === lines.length) {
    throw new Error(`stripColumn removed nothing from ${table}.${column}`);
  }
  return stripped.join('\n');
}

function stripColumns(createTable: string, table: string, columns: readonly string[]): string {
  return columns.reduce((sql, column) => stripColumn(sql, table, column), createTable);
}

/**
 * `harness` and `model` come off `architect` too (#227 item 3, migration v22).
 *
 * They were added AFTER `thread_id` in `GLOBAL_SCHEMA` precisely so a fresh install
 * matches the ADD COLUMN order of an upgraded one. Leaving them in the pre-v21 fixture put
 * them BEFORE the thread_id that v21 appends, and the convergence assertion below — which
 * compares column order, deliberately — caught it.
 */
const PRE_V21_ARCHITECT = stripColumns(
  extractCreateTable(GLOBAL_SCHEMA, 'architect'),
  'architect',
  ['thread_id', 'harness', 'model'],
);
const PRE_V21_BUILDERS = stripColumn(extractCreateTable(GLOBAL_SCHEMA, 'builders'), 'builders', 'thread_id');

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
    setSpawnThreadFactory(undefined, undefined);
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
    const builders: Builder[] = [
      { id: 'pty-1', name: 'a', status: 'implementing', phase: '', worktree: '', branch: '', type: 'spec', terminalId: 'term-1' },
      { id: 'thr-1', name: 'a', status: 'implementing', phase: '', worktree: '', branch: '', type: 'spec', threadId: 'thread-1' },
      { id: 'pty-done', name: 'a', status: 'complete', phase: '', worktree: '', branch: '', type: 'spec', terminalId: 'term-2' },
    ];
    expect(countPtyDrainFromBuilders(builders)).toBe(1);
    builders[0] = { ...builders[0], status: 'complete' };
    expect(countPtyDrainFromBuilders(builders)).toBe(0);
  });
});

/**
 * The plan originally specified three architect sentinels: pid 0, port 0, cmd ''.
 * The architect ruled on #170 that the plan was wrong and the code is right — pid, port
 * and terminal_id are PTY-specific and meaningless for a thread-backed row, but `cmd` is
 * how the architect was launched and an architect restart reads it. The plan is amended.
 *
 * These are characterization tests. They exist to stop the next reader seeing a two-field
 * sentinel against what looks like a three-field intent and "fixing" the code back.
 */
describe('Spec 146 Phase 8 — architect sentinels (#170)', () => {
  const base = { id: 'main', pid: 4242, port: 4100, cmd: 'claude --dangerously', startedAt: 'x' };

  it('blanks pid and port on a thread-backed architect but never cmd', () => {
    const written = architectWriteValues({ ...base, threadId: 'thr-1' } as never);
    expect(written.pid).toBe(0);
    expect(written.port).toBe(0);
    expect(written.cmd).toBe('claude --dangerously');
    expect(written.terminalId).toBeNull();
    expect(written.threadId).toBe('thr-1');
  });

  it('carries cmd through unchanged on a terminal-backed architect too', () => {
    const written = architectWriteValues({ ...base, terminalId: 'term-1' } as never);
    expect(written.cmd).toBe('claude --dangerously');
    expect(written.terminalId).toBe('term-1');
    expect(written.threadId).toBeNull();
  });

  it('the sentinel names exactly two fields — cmd is deliberately not one', () => {
    expect(Object.keys(THREAD_ARCHITECT_SENTINEL).sort()).toEqual(['pid', 'port']);
    expect(THREAD_ARCHITECT_SENTINEL).not.toHaveProperty('cmd');
  });

  it('refuses to write an architect row carrying both identities', () => {
    expect(() => architectWriteValues({ ...base, terminalId: 't', threadId: 'h' } as never))
      .toThrow(DualIdentityError);
  });

  it('an empty cmd is preserved as empty rather than substituted', () => {
    const written = architectWriteValues({ ...base, cmd: '', threadId: 'thr-2' } as never);
    expect(written.cmd).toBe('');
  });
});

describe('Spec 146 Phase 8 — spawn path', () => {
  afterEach(() => {
    setSpawnThreadFactory(undefined, undefined);
    setThreadBackedSpawnsEnabled(true);
  });

  it('takes the thread path when a factory is registered', async () => {
    setSpawnThreadFactory(async () => 'thread-from-factory', undefined);
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
    setSpawnThreadFactory(async () => 'thread-orphaned', undefined);
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
    expect(chooseSpawnPath(undefined, undefined)).toBe('pty');
  });

  it('does not migrate an in-flight PTY builder onto the thread path', async () => {
    setSpawnThreadFactory(async () => 'thread-new', undefined);
    const pty = vi.fn(async () => ({ terminalId: 'term-existing' }));
    const identity = await launchSpawnedBuilder({
      existing: { terminalId: 'term-existing' },
      builderId: 'air-1',
      worktreePath: '/ws/.builders/air-1',
      branch: 'builder/air-1',
      startPty: pty,
    });
    expect(identity).toEqual({ terminalId: 'term-existing' });
    expect(chooseSpawnPath({ terminalId: 'term-existing' }, undefined)).toBe('pty');
  });

  it('keeps a thread-backed builder on the thread path after rollback of new spawns', () => {
    setThreadBackedSpawnsEnabled(false);
    expect(chooseSpawnPath({ threadId: 'thr-live' }, undefined)).toBe('thread');
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

  it('fails loudly when status.yaml is missing', () => {
    const statusPath = resolve(dir, 'codev/projects/163-missing/status.yaml');
    expect(() => recordThreadId(statusPath, 'thr-1')).toThrow(/Project not found/);
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
    // v22 (#227 item 3) is part of the upgrade path now, and this assertion compares
    // column ORDER — so the test has to walk the same migrations in the same sequence a
    // real upgrade does, not just the one it was written for.
    applyArchitectAgentMigration(db);
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

  /**
   * The reuse branch is the one that protects the restore point. A second migration
   * attempt — a crash between the backup and the ALTER, then a retry — must NOT
   * overwrite the backup, because by then the live database may already be half
   * migrated and a fresh VACUUM INTO would capture that instead of the pre-v21 state.
   * Flagged as untested by the phase_8 iteration-2 `claude` lane.
   */
  it('reuses an existing pre-v21 backup instead of overwriting the restore point', () => {
    const backupPath = threadIdentityBackupPath(dbPath);
    writeFileSync(backupPath, 'ORIGINAL RESTORE POINT');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const db = openPreV21();
    const result = applyThreadIdentityMigration(db, dbPath);

    expect(result.backupPath).toBe(backupPath);
    expect(readFileSync(backupPath, 'utf8')).toBe('ORIGINAL RESTORE POINT');
    expect(logs.some((l) => l.includes('Reusing pre-v21 global.db backup') && l.includes(backupPath))).toBe(true);
    expect(logs.some((l) => l.includes('Backed up global.db before'))).toBe(false);

    // The migration still completes: reuse governs the backup, never the ALTER.
    expect(columnOrder(db, 'architect')).toContain('thread_id');
    expect(columnOrder(db, 'builders')).toContain('thread_id');

    db.close();
    spy.mockRestore();
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

  it('does not swallow a missing status.yaml when recording thread_id', () => {
    const spawnSrc = readFileSync(resolve(import.meta.dirname, '../commands/spawn.ts'), 'utf8');
    expect(spawnSrc).not.toMatch(/if \(existsSync\(statusPath\)\) recordThreadId/);
    expect(spawnSrc).toMatch(/could not record thread_id=/);
    expect(spawnSrc).toMatch(/findStatusPath/);
  });
});
