/**
 * Issue #100: afx cleanup must resolve a .builders/ worktree when no global.db
 * row exists, refuse an unmerged branch without --force, and leave discoverBuilders
 * (GET /v2/events) with nothing to report.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  DirtyOrphanError,
  findOrphanWorktree,
  isLiveBuilderWorktree,
  orphanDirMatches,
  removeOrphanWorktree,
  UnmergedOrphanError,
} from '../commands/cleanup.js';
import { discoverBuilders } from '../servers/overview.js';
import { projectHierarchy, type V2Deps } from '../servers/v2-projection.js';

function eventsBuilderNames(workspaceRoot: string): string[] {
  const deps: V2Deps = {
    listWorkspaces: () => [workspaceRoot],
    discoverBuilders: (ws) =>
      discoverBuilders(ws).map((b) => ({
        worktreePath: b.worktreePath,
        roleId: b.roleId,
        blockedGate: b.blockedGate,
      })),
    getBuilders: () => [],
    getArchitects: () => [],
    heldByAgent: () => false,
    sessionForRole: () => false,
    sessionForTerminal: () => false,
    terminalsForWorkspace: () => 0,
    lastDataAt: () => null,
    bytesWritten: () => 0,
  };
  return projectHierarchy(Date.now(), deps)
    .nodes
    .filter((n) => n.kind === 'builder')
    .map((n) => n.name);
}

describe('orphanDirMatches', () => {
  it('matches air-78 by project number, padded number, and directory name', () => {
    expect(orphanDirMatches('air-78', '78')).toBe(true);
    expect(orphanDirMatches('air-78', '078')).toBe(true);
    expect(orphanDirMatches('air-78', 'air-78')).toBe(true);
  });

  it('matches experiment-62 and bugfix-1455 by number', () => {
    expect(orphanDirMatches('experiment-62', '62')).toBe(true);
    expect(orphanDirMatches('bugfix-1455', '1455')).toBe(true);
    expect(orphanDirMatches('pir-4', '4')).toBe(true);
    expect(orphanDirMatches('spir-52', '52')).toBe(true);
  });

  it('does not treat a prefix of the number as a match', () => {
    expect(orphanDirMatches('air-14', '1')).toBe(false);
    expect(orphanDirMatches('air-78', '8')).toBe(false);
    expect(orphanDirMatches('air-78', '7')).toBe(false);
    expect(orphanDirMatches('experiment-62', '6')).toBe(false);
  });

  it('does not match across protocol prefixes', () => {
    expect(orphanDirMatches('air-62', 'experiment-62')).toBe(false);
    expect(orphanDirMatches('experiment-62', 'air-62')).toBe(false);
    expect(orphanDirMatches('air-62', 'pir-62')).toBe(false);
    expect(orphanDirMatches('bugfix-1455', 'air-1455')).toBe(false);
  });
});

describe('findOrphanWorktree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleanup-orphan-lookup-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds .builders/air-78 when targeting project 78', () => {
    mkdirSync(join(root, '.builders', 'air-78'), { recursive: true });
    expect(findOrphanWorktree(root, '78')).toEqual({
      status: 'one',
      dirName: 'air-78',
      worktreePath: join(root, '.builders', 'air-78'),
    });
  });

  it('returns none when the directory is missing', () => {
    mkdirSync(join(root, '.builders'), { recursive: true });
    expect(findOrphanWorktree(root, '78')).toEqual({ status: 'none' });
  });

  it('finds experiment-62 by directory name or project number', () => {
    mkdirSync(join(root, '.builders', 'experiment-62'), { recursive: true });
    expect(findOrphanWorktree(root, '62')).toEqual({
      status: 'one',
      dirName: 'experiment-62',
      worktreePath: join(root, '.builders', 'experiment-62'),
    });
    expect(findOrphanWorktree(root, 'experiment-62')).toEqual({
      status: 'one',
      dirName: 'experiment-62',
      worktreePath: join(root, '.builders', 'experiment-62'),
    });
  });

  it('does not resolve air-62 to a lone experiment-62 directory', () => {
    mkdirSync(join(root, '.builders', 'experiment-62'), { recursive: true });
    expect(findOrphanWorktree(root, 'air-62')).toEqual({ status: 'none' });
  });

  it('targets only the named protocol when both share the number', () => {
    mkdirSync(join(root, '.builders', 'air-62'), { recursive: true });
    mkdirSync(join(root, '.builders', 'experiment-62'), { recursive: true });
    expect(findOrphanWorktree(root, 'experiment-62')).toEqual({
      status: 'one',
      dirName: 'experiment-62',
      worktreePath: join(root, '.builders', 'experiment-62'),
    });
    expect(findOrphanWorktree(root, 'air-62')).toEqual({
      status: 'one',
      dirName: 'air-62',
      worktreePath: join(root, '.builders', 'air-62'),
    });
  });

  it('returns ambiguous when two directories share the number', () => {
    mkdirSync(join(root, '.builders', 'air-62'), { recursive: true });
    mkdirSync(join(root, '.builders', 'experiment-62'), { recursive: true });
    const found = findOrphanWorktree(root, '62');
    expect(found.status).toBe('ambiguous');
    if (found.status === 'ambiguous') {
      expect(found.dirNames.sort()).toEqual(['air-62', 'experiment-62']);
    }
  });
});

describe('isLiveBuilderWorktree', () => {
  it('matches on exact path or worktree basename when the prefix differs', () => {
    expect(isLiveBuilderWorktree(
      [{ worktree: '/workspace/.builders/air-78' }],
      '/workspace/.builders/air-78',
    )).toBe(true);
    expect(isLiveBuilderWorktree(
      [{ worktree: '/other/abs/.builders/air-78' }],
      '/workspace/.builders/air-78',
    )).toBe(true);
    expect(isLiveBuilderWorktree(
      [{ worktree: '/workspace/.builders/air-14' }],
      '/workspace/.builders/air-78',
    )).toBe(false);
    expect(isLiveBuilderWorktree([], '/workspace/.builders/air-78')).toBe(false);
  });
});

describe('removeOrphanWorktree', () => {
  let repo: string;
  let worktreePath: string;

  function git(args: string, cwd = repo): string {
    return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
  }

  function initRepo(): void {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-orphan-wt-')));
    git('init -b main -q');
    git('config user.email test@test.local');
    git('config user.name Test');
    git('config commit.gpgsign false');
    writeFileSync(join(repo, 'README'), 'init\n');
    git('add README');
    git('commit -q -m init');
  }

  function addOrphan(dirName: string, branch: string): string {
    const path = join(repo, '.builders', dirName);
    mkdirSync(join(repo, '.builders'), { recursive: true });
    git(`worktree add "${path}" -b "${branch}"`);
    return path;
  }

  beforeEach(() => {
    initRepo();
    worktreePath = addOrphan('air-78', 'builder/air-78');
  });

  afterEach(() => {
    try {
      git(`worktree remove "${worktreePath}" --force`);
    } catch {
      // already removed
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it('targets a row-less worktree and refuses when the branch is unmerged without --force', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'unmerged\n');
    git('add wip.txt', worktreePath);
    git('commit -q -m wip', worktreePath);

    const found = findOrphanWorktree(repo, '78');
    expect(found).toEqual({
      status: 'one',
      dirName: 'air-78',
      worktreePath,
    });
    expect(eventsBuilderNames(repo)).toContain('air-78');

    await expect(removeOrphanWorktree(repo, worktreePath)).rejects.toBeInstanceOf(UnmergedOrphanError);
    expect(existsSync(worktreePath)).toBe(true);
    expect(eventsBuilderNames(repo)).toContain('air-78');
  });

  it('removes a merged orphan and GET /v2/events stops reporting it', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('merge --no-ff builder/air-78 -m merge');

    expect(eventsBuilderNames(repo)).toContain('air-78');

    await removeOrphanWorktree(repo, worktreePath);

    expect(existsSync(worktreePath)).toBe(false);
    expect(discoverBuilders(repo)).toEqual([]);
    expect(eventsBuilderNames(repo)).not.toContain('air-78');
  });

  it('removes an unmerged orphan with --force but preserves its branch', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'unmerged\n');
    git('add wip.txt', worktreePath);
    git('commit -q -m wip', worktreePath);

    await removeOrphanWorktree(repo, worktreePath, true);

    expect(existsSync(worktreePath)).toBe(false);
    expect(eventsBuilderNames(repo)).not.toContain('air-78');
    expect(git('branch --list builder/air-78')).toContain('builder/air-78');
  });

  it('refuses a merged orphan that holds uncommitted work without --force', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'untracked\n');

    await expect(removeOrphanWorktree(repo, worktreePath)).rejects.toBeInstanceOf(DirtyOrphanError);
    expect(existsSync(join(worktreePath, 'wip.txt'))).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('removes a merged orphan that holds only .builder-* scaffold without --force', async () => {
    writeFileSync(join(worktreePath, '.builder-prompt.txt'), 'scaffold\n');

    await removeOrphanWorktree(repo, worktreePath);

    expect(existsSync(worktreePath)).toBe(false);
  });

  it('removes a dirty merged orphan when --force is set', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'untracked\n');

    await removeOrphanWorktree(repo, worktreePath, true);

    expect(existsSync(worktreePath)).toBe(false);
  });

  it('refuses when commits are on workspace HEAD but not the default branch', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('checkout -b other');
    git('merge --no-ff builder/air-78 -m merge');

    await expect(removeOrphanWorktree(repo, worktreePath)).rejects.toBeInstanceOf(UnmergedOrphanError);
    expect(existsSync(worktreePath)).toBe(true);
  });
});
