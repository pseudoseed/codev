/**
 * Issue #2 — builders.harness / builders.model migration (v18).
 *
 * Migration v18 adds two additive, nullable columns so `afx spawn --resume` can
 * relaunch a builder on the pair it was spawned with. Before this, every spawn
 * path recomputed its agent from workspace config — harmless while the agent WAS
 * the config value, but once the pair is per-spawn a resume would silently drop
 * it and come back on the workspace default, with no error and no warning.
 *
 * Follows the inline-replication convention of spec-1313-migration.test.ts: an
 * old database is built by hand, a faithful replica of the v18 block drives it
 * forward, and the result is compared against the REAL production GLOBAL_SCHEMA.
 * Drift between the two definitions fails this test. Migrations are forward-only
 * by project convention; there is no reverse SQL to test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';

describe('Issue #2 — builders harness/model migration (v18)', () => {
  const testDir = resolve(process.cwd(), '.test-issue-2-migration');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(resolve(testDir, 'global.db'));
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** A pre-v18 builders table: the v17-era shape, without the two columns. */
  const PRE_V18_BUILDERS = `
    CREATE TABLE builders (
      workspace_path TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      pid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'spawning',
      phase TEXT NOT NULL DEFAULT '',
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'spec',
      task_text TEXT,
      protocol_name TEXT,
      issue_number TEXT,
      terminal_id TEXT,
      spawned_by_architect TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_path, id)
    );
  `;

  /** Faithful replica of the v18 block in db/index.ts. */
  function applyV18(target: Database.Database): void {
    const cols = (target.prepare(`PRAGMA table_info(builders)`).all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('harness')) target.exec(`ALTER TABLE builders ADD COLUMN harness TEXT`);
    if (!cols.includes('model')) target.exec(`ALTER TABLE builders ADD COLUMN model TEXT`);
  }

  function builderColumns(target: Database.Database): string[] {
    return (target.prepare(`PRAGMA table_info(builders)`).all() as Array<{ name: string }>)
      .map(c => c.name).sort();
  }

  it('adds both columns to a pre-v18 database', () => {
    db.exec(PRE_V18_BUILDERS);
    expect(builderColumns(db)).not.toContain('harness');

    applyV18(db);

    expect(builderColumns(db)).toContain('harness');
    expect(builderColumns(db)).toContain('model');
  });

  it('an upgraded database converges on the same shape as a fresh one', () => {
    // The invariant that matters: the migration and GLOBAL_SCHEMA cannot drift.
    db.exec(PRE_V18_BUILDERS);
    applyV18(db);
    // Spec 146 Phase 5 (v21) added builders.thread_id to GLOBAL_SCHEMA after v18.
    db.exec('ALTER TABLE builders ADD COLUMN thread_id TEXT');

    const fresh = new Database(resolve(testDir, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);
      expect(builderColumns(db)).toEqual(builderColumns(fresh));
    } finally {
      fresh.close();
    }
  });

  it('is idempotent — re-running leaves the shape unchanged', () => {
    // The production block is PRAGMA-gated rather than try/catch'd precisely so a
    // real ALTER failure can't be recorded as "migrated". Re-running must be safe.
    db.exec(PRE_V18_BUILDERS);
    applyV18(db);
    const after = builderColumns(db);
    expect(() => applyV18(db)).not.toThrow();
    expect(builderColumns(db)).toEqual(after);
  });

  it('GLOBAL_CURRENT_VERSION covers v18, so a fresh install records it', () => {
    // Caught by running the real CLI, not by a unit test: a fresh global.db seeds
    // `_migrations` with 1..GLOBAL_CURRENT_VERSION and returns EARLY, before the
    // migration blocks. Forgetting the bump leaves a fresh install reporting v17
    // and re-running the v18 block on its next open. The columns still arrive
    // (GLOBAL_SCHEMA has them), so nothing breaks loudly — which is exactly why
    // this needs a test rather than trust.
    const src = readFileSync(
      resolve(__dirname, '..', 'db', 'index.ts'),
      'utf8',
    );
    const declared = src.match(/GLOBAL_CURRENT_VERSION = (\d+)/)?.[1];
    const highest = Math.max(
      ...[...src.matchAll(/VALUES \((\d+)\)'\)\.run\(\)/g)].map(m => Number(m[1])),
    );
    expect(Number(declared)).toBe(highest);
  });

  it('existing rows survive with NULL for both columns', () => {
    // Legacy rows predate per-spawn selection, so "not recorded" is the honest
    // value — and it is what makes `selectionForResume` fall back to today's
    // behaviour instead of inventing a pair.
    db.exec(PRE_V18_BUILDERS);
    db.prepare(`INSERT INTO builders (workspace_path, id, name, worktree, branch)
                VALUES ('/ws', 'pir-9', 'legacy', '/wt', 'b')`).run();

    applyV18(db);

    const row = db.prepare(`SELECT harness, model FROM builders WHERE id = 'pir-9'`).get() as Record<string, unknown>;
    expect(row.harness).toBeNull();
    expect(row.model).toBeNull();
  });
});
