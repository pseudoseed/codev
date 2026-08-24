/**
 * Issue #120: orphan count in afx status, and cleanup of a merged
 * non-ephemeral builder must leave no directory and no git worktree list entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  cleanupNonEphemeralWorktree,
  formatReclaimableBytes,
  listOrphanWorktrees,
  measureOrphanBytes,
} from '../commands/cleanup.js';
import { collectOrphanStatus, orphanStatusLabel } from '../commands/status.js';

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
}

function worktreeList(repo: string): string {
  return git('worktree list --porcelain', repo);
}

describe('listOrphanWorktrees', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'issue-120-orphans-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('counts directories under .builders/ that have no live builder row', () => {
    mkdirSync(join(root, '.builders', 'air-112'), { recursive: true });
    mkdirSync(join(root, '.builders', 'spir-83'), { recursive: true });
    mkdirSync(join(root, '.builders', 'air-120'), { recursive: true });

    const orphans = listOrphanWorktrees(root, [
      { worktree: join(root, '.builders', 'air-120') },
    ]);

    expect(orphans.map((o) => o.dirName).sort()).toEqual(['air-112', 'spir-83']);
  });

  it('returns none when every directory has a live row', () => {
    mkdirSync(join(root, '.builders', 'air-120'), { recursive: true });
    expect(listOrphanWorktrees(root, [
      { worktree: join(root, '.builders', 'air-120') },
    ])).toEqual([]);
  });

  it('returns none when .builders/ is missing', () => {
    expect(listOrphanWorktrees(root, [])).toEqual([]);
  });
});

describe('measureOrphanBytes / formatReclaimableBytes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'issue-120-du-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 0 for an empty path list and never guesses a failed du as 0', () => {
    expect(measureOrphanBytes([])).toBe(0);
    expect(measureOrphanBytes([join(root, 'does-not-exist')])).toBeNull();
  });

  it('reports a positive size for a directory with a file', () => {
    const dir = join(root, 'wt');
    mkdirSync(dir);
    writeFileSync(join(dir, 'blob'), 'x'.repeat(4096));
    const bytes = measureOrphanBytes([dir]);
    expect(bytes).toBeGreaterThan(0);
  });

  it('formats bytes without collapsing unknown into a number', () => {
    expect(formatReclaimableBytes(512)).toBe('512 B');
    expect(formatReclaimableBytes(1536)).toBe('1.5 KB');
    expect(formatReclaimableBytes(8.5 * 1024 * 1024 * 1024)).toBe('8.5 GB');
  });
});

describe('orphanStatusLabel / collectOrphanStatus', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'issue-120-status-'));
    mkdirSync(join(root, '.builders', 'air-112'), { recursive: true });
    mkdirSync(join(root, '.builders', 'spir-83'), { recursive: true });
    writeFileSync(join(root, '.builders', 'air-112', 'blob'), 'x'.repeat(4096));
    writeFileSync(join(root, '.builders', 'spir-83', 'blob'), 'x'.repeat(4096));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('counts eagerly and leaves bytes null unless sized', () => {
    const unsized = collectOrphanStatus(root, [], false);
    expect(unsized).toEqual({ count: 2, bytes: null });
    expect(orphanStatusLabel(unsized, false)).toBe('2');

    const sized = collectOrphanStatus(root, [], true);
    expect(sized.count).toBe(2);
    expect(sized.bytes).toBeGreaterThan(0);
    expect(orphanStatusLabel(sized, true)).toBe(`2 (${formatReclaimableBytes(sized.bytes!)})`);
  });

  it('says none at zero and size unknown when du cannot tell', () => {
    expect(orphanStatusLabel({ count: 0, bytes: null }, false)).toBe('none');
    expect(orphanStatusLabel({ count: 3, bytes: null }, true)).toBe('3 (size unknown)');
  });
});

describe('cleanupNonEphemeralWorktree', () => {
  let repo: string;
  let worktreePath: string;

  function initRepo(): void {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'issue-120-wt-')));
    git('init -b main -q', repo);
    git('config user.email test@test.local', repo);
    git('config user.name Test', repo);
    git('config commit.gpgsign false', repo);
    writeFileSync(join(repo, 'README'), 'init\n');
    git('add README', repo);
    git('commit -q -m init', repo);
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

  it('removes a merged non-ephemeral worktree from disk and git worktree list', async () => {
    writeFileSync(join(worktreePath, 'done.txt'), 'merged\n');
    git('add done.txt', worktreePath);
    git('commit -q -m done', worktreePath);
    git('merge --no-ff builder/air-120 -m merge', repo);

    expect(existsSync(worktreePath)).toBe(true);
    expect(worktreeList(repo)).toContain(worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('removed-merged');
    expect(existsSync(worktreePath)).toBe(false);
    expect(worktreeList(repo)).not.toContain(worktreePath);
  });

  it('preserves an unmerged non-ephemeral worktree', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'unmerged\n');
    git('add wip.txt', worktreePath);
    git('commit -q -m wip', worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath);

    expect(result).toBe('preserved-unmerged');
    expect(existsSync(worktreePath)).toBe(true);
    expect(worktreeList(repo)).toContain(worktreePath);
  });

  it('removes an unmerged non-ephemeral worktree when --force is set', async () => {
    writeFileSync(join(worktreePath, 'wip.txt'), 'unmerged\n');
    git('add wip.txt', worktreePath);
    git('commit -q -m wip', worktreePath);

    const result = await cleanupNonEphemeralWorktree(repo, worktreePath, true);

    expect(result).toBe('removed-force');
    expect(existsSync(worktreePath)).toBe(false);
    expect(worktreeList(repo)).not.toContain(worktreePath);
  });
});
