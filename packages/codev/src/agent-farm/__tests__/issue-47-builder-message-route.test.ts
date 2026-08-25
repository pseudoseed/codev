/** Issue #47: a builder must keep its identity after `cd` leaves its worktree. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

const mocks = vi.hoisted(() => ({
  globalDbPath: '',
  workspace: '',
  owner: 'uiv2',
}));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => mocks.globalDbPath };
});

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => new Map<string, WorkspaceTerminals>([[mocks.workspace, {
    architects: new Map([['main', 'term-main'], ['uiv2', 'term-uiv2']]),
    builders: new Map([['builder-bugfix-47', 'term-builder']]),
    shells: new Map(),
    fileTabs: new Map(),
  }]]),
}));

vi.mock('../state.js', () => ({
  lookupBuilderSpawningArchitect: (id: string) => id === 'builder-bugfix-47' ? mocks.owner : undefined,
}));

const { detectCurrentBuilderId, detectWorkspaceRoot } = await import('../commands/send.js');
const { addressSpoofingErrorMessage, isResolveError, resolveTarget } = await import('../servers/tower-messages.js');

describe('issue #47 builder message routing after cd', () => {
  const originalCwd = process.cwd();
  const originalBuilderId = process.env.CODEV_BUILDER_ID;
  const originalWorktreeRoot = process.env.CODEV_WORKTREE_ROOT;
  let temp: string;
  let worktree: string;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'issue-47-route-'));
    mocks.workspace = join(temp, 'workspace');
    worktree = join(mocks.workspace, '.builders', 'bugfix-47');
    mkdirSync(worktree, { recursive: true });
    mocks.workspace = realpathSync(mocks.workspace);
    worktree = realpathSync(worktree);
    mocks.globalDbPath = join(temp, 'global.db');

    const db = new Database(mocks.globalDbPath);
    db.exec(GLOBAL_SCHEMA);
    db.prepare(
      `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, spawned_by_architect)
       VALUES (?, 'builder-bugfix-47', 'bugfix-47', ?, 'builder/bugfix-47', 'bugfix', 'implementing', 'uiv2')`,
    ).run(mocks.workspace, worktree);
    db.close();

    process.env.CODEV_BUILDER_ID = 'builder-bugfix-47';
    process.env.CODEV_WORKTREE_ROOT = worktree;
    process.chdir(mocks.workspace); // The triggering action: leave the worktree.
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalBuilderId === undefined) delete process.env.CODEV_BUILDER_ID;
    else process.env.CODEV_BUILDER_ID = originalBuilderId;
    if (originalWorktreeRoot === undefined) delete process.env.CODEV_WORKTREE_ROOT;
    else process.env.CODEV_WORKTREE_ROOT = originalWorktreeRoot;
    rmSync(temp, { recursive: true, force: true });
  });

  it('routes bare architect to the spawning architect, not main', () => {
    const sender = detectCurrentBuilderId() ?? 'architect';
    const result = resolveTarget('architect', detectWorkspaceRoot()!, sender);

    expect(sender).toBe('builder-bugfix-47');
    if (isResolveError(result)) throw new Error(result.message);
    expect(result.terminalId).toBe('term-uiv2');
    expect(result.terminalId).not.toBe('term-main');
  });

  it('still rejects an explicit cross-architect target', () => {
    const sender = detectCurrentBuilderId() ?? 'architect';
    const result = resolveTarget('architect:main', detectWorkspaceRoot()!, sender);

    expect(isResolveError(result)).toBe(true);
    if (!isResolveError(result)) throw new Error('expected spoofing rejection');
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe(addressSpoofingErrorMessage('builder-bugfix-47'));
  });
});
