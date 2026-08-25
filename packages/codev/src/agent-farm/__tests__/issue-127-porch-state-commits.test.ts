/**
 * Issue #127: a merged builder plus porch's post-merge state commit is
 * not an ancestor of main, but its only unique content is bookkeeping.
 * cleanup must still remove the worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  cleanupNonEphemeralWorktree,
  isPorchBookkeepingPath,
  isWorktreeMerged,
} from '../commands/cleanup.js';

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
}

function worktreeList(repo: string): string {
  return git('worktree list --porcelain', repo);
}

describe('isPorchBookkeepingPath', () => {
  it('accepts the codev/projects tree, which porch regenerates', () => {
    expect(isPorchBookkeepingPath('codev/projects/120-x/status.yaml')).toBe(true);
    expect(isPorchBookkeepingPath('codev/projects')).toBe(true);
    expect(isPorchBookkeepingPath('codev/specs/120-x.md')).toBe(false);
    expect(isPorchBookkeepingPath('packages/codev/src/cli.ts')).toBe(false);
    expect(isPorchBookkeepingPath('codev/projects-backup/x')).toBe(false);
  });

  it('does NOT accept codev/state — a thread log has no other copy', () => {
    // CLAUDE.md: the log is in-flight in the worktree and on main only AFTER
    // the PR merges. Until it lands, the worktree copy is the only copy, so
    // classifying it as regenerable makes cleanup delete it with no --force
    // and no warning. status.yaml is different in kind: porch rewrites it.
    expect(isPorchBookkeepingPath('codev/state/air-120_thread.md')).toBe(false);
    expect(isPorchBookkeepingPath('codev/state')).toBe(false);
  });
});

describe('cleanup after porch post-merge state commit', () => {
  let repo: string;
  let worktreePath: string;

  function initRepo(): void {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'issue-127-wt-')));
    git('init -b main -q', repo);
    git('config user.email test@test.local', repo);
    git('config user.name Test', repo);
    git('config commit.gpgsign false', repo);
    writeFileSync(join(repo, 'README'), 'init\n');
    git('add README', repo);
    git('commit -q -m init', repo);
  }

  function commitPorchState(message: string): void {
    const statusDir = join(worktreePath, 'codev', 'projects', '120-x');
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, 'status.yaml'), 'phase: complete\n');
    git('add codev/projects/120-x/status.yaml', worktreePath);
    git(`commit -q -m "${message}"`, worktreePath);
  }

  beforeEach(() => {
    initRepo();
    worktreePath = join(repo, '.builders', 'air-120');
    mkdirSync(join(repo, '.builders'), { recursive: true });
    git(`worktree add "${worktreePath}" -b builder/air-120`, repo);
  });

  afterEach(() => {
    try {
      git(`worktree remove "${worktreePath}" --force`, repo);
    } catch {
      // already removed
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it('removes a merged worktree whose only extra commits are porch bookkeeping', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('merge --no-ff builder/air-120 -m merge', repo);
    commitPorchState('chore(porch): 120 pr gate-approved');

    expect(await isWorktreeMerged(repo, worktreePath)).toBe(true);
    expect(worktreeList(repo)).toContain(worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('removed-merged');
    expect(existsSync(worktreePath)).toBe(false);
    expect(worktreeList(repo)).not.toContain(worktreePath);
    expect(git('branch --list builder/air-120', repo).trim()).toBe('');
  });

  it('still removes when main has moved on after the merge', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('merge --no-ff builder/air-120 -m merge', repo);
    commitPorchState('chore(porch): 120 protocol complete');
    writeFileSync(join(repo, 'README'), 'init\nlater\n');
    git('add README', repo);
    git('commit -q -m later-on-main', repo);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('removed-merged');
    expect(existsSync(worktreePath)).toBe(false);
    expect(worktreeList(repo)).not.toContain(worktreePath);
  });

  it('PRESERVES a worktree whose only unlanded file is its thread log', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('merge --no-ff builder/air-120 -m merge', repo);
    const stateDir = join(worktreePath, 'codev', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'air-120_thread.md'), 'done\n');
    git('add codev/state/air-120_thread.md', worktreePath);
    git('commit -q -m "chore(porch): thread"', worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    // Measured twice in one day before this flipped: three logs hand-salvaged
    // from orphan worktrees (#124, #125), and air-106's closing entry stranded
    // on its branch and rescued by hand (#134).
    expect(result).toBe('preserved-unmerged');
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('preserves a branch that still has unmerged real work', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'unmerged\n');
    git('add wip.txt', worktreePath);
    git('commit -q -m wip', worktreePath);
    commitPorchState('chore(porch): 120 implement');

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('preserved-unmerged');
    expect(existsSync(worktreePath)).toBe(true);
    expect(worktreeList(repo)).toContain(worktreePath);
  });

  it('removes a never-merged branch whose only commits are porch bookkeeping', async () => {
    commitPorchState('chore(porch): 120 init air');

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('removed-merged');
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('preserves a rename of real work into a bookkeeping path', async () => {
    writeFileSync(join(worktreePath, 'src.ts'), 'work\n');
    git('add src.ts', worktreePath);
    git('commit -q -m work', worktreePath);
    mkdirSync(join(worktreePath, 'codev', 'state'), { recursive: true });
    git('mv src.ts codev/state/src.ts', worktreePath);
    git('commit -q -m rename', worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('preserved-unmerged');
    expect(existsSync(worktreePath)).toBe(true);
  });
});
