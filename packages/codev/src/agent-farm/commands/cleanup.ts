/**
 * Cleanup command - removes builder worktrees and branches
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import type { Builder, Config } from '../types.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { loadState, removeBuilder } from '../state.js';
import { TowerClient } from '../lib/tower-client.js';
import { getGlobalDb, closeGlobalDb } from '../db/index.js';
import { deleteFileTabsByPathPrefix } from '../utils/file-tabs.js';
import { dismissHeldForAgent } from '../db/mailbox.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { executeForgeCommand } from '../../lib/forge.js';
import { resolveDefaultBranch } from '../../lib/default-branch.js';
import {
  isThreadBacked,
} from '../thread-runtime.js';
import { adoptThreadInThisProcess, closeThreadBackend } from '../thread-backend.js';

/**
 * Clean porch review artifacts for a project from codev/projects/,
 * preserving status.yaml for analytics and historical tracking.
 */
async function cleanupPorchState(projectId: string, config: Config): Promise<void> {
  const projectsDir = join(config.codevDir, 'projects');

  if (!existsSync(projectsDir)) {
    return;
  }

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${projectId}-`)) {
        const projectDir = join(projectsDir, entry.name);
        const children = readdirSync(projectDir);

        // Delete review artifacts but preserve status.yaml
        for (const child of children) {
          if (child === 'status.yaml') continue;
          await rm(join(projectDir, child), { recursive: true, force: true });
        }

        // Log what we did
        const hasStatus = children.includes('status.yaml');
        if (hasStatus) {
          logger.info(`Cleaned porch artifacts: ${entry.name} (preserved status.yaml)`);
        } else {
          // No status.yaml — remove the empty directory
          await rm(projectDir, { recursive: true, force: true });
          logger.info(`Removed porch state: ${entry.name}`);
        }
      }
    }
  } catch (error) {
    logger.warn(`Warning: Failed to cleanup porch state: ${error}`);
  }
}

/**
 * Find and kill shellper processes associated with a worktree path (Bugfix #389).
 *
 * When Tower is not running (or the terminal was already removed from Tower's
 * registry), the Tower API kill path silently fails, leaving shellper processes
 * orphaned. This function searches `ps` output for shellper-main.js processes
 * whose JSON config contains the worktree path as `cwd`, and kills them directly.
 *
 * Uses process group kill (-pid) to also terminate PTY children (Claude, bash).
 */
export async function killShellperProcesses(worktreePath: string): Promise<number> {
  let killed = 0;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      // -ww prevents arg truncation on macOS/Linux
      execFile('ps', ['-ww', '-eo', 'pid,args'], (err, out) => {
        if (err) { reject(err); return; }
        resolve(out);
      });
    });

    // Match shellper-main.js processes whose JSON config cwd is this worktree.
    // The shellper is spawned with JSON as argv[2]: {"cwd":"/path/to/worktree",...}
    const cwdPattern = `"cwd":"${worktreePath}"`;

    for (const line of stdout.split('\n')) {
      if (!line.includes('shellper-main.js')) continue;
      if (!line.includes(cwdPattern)) continue;

      const pid = parseInt(line.trim(), 10);
      if (isNaN(pid) || pid <= 0 || pid === process.pid) continue;

      try {
        // Kill process group (shellper + its PTY child) to prevent orphaned
        // PTY processes. Shellper is spawned with detached:true, so it's a
        // process group leader.
        process.kill(-pid, 'SIGTERM');
        killed++;
      } catch {
        // Process group kill failed — try individual PID
        try {
          process.kill(pid, 'SIGTERM');
          killed++;
        } catch {
          // Process already dead
        }
      }
    }
  } catch {
    // ps not available or failed — non-fatal
  }
  return killed;
}

export interface CleanupOptions {
  project?: string;
  issue?: number;
  task?: string;
  force?: boolean;
}

export type OrphanLookup =
  | { status: 'none' }
  | { status: 'one'; dirName: string; worktreePath: string }
  | { status: 'ambiguous'; dirNames: string[] };

export class UnmergedOrphanError extends Error {
  constructor(readonly worktreePath: string) {
    super(
      `Branch is not merged. Use --force to remove the orphan worktree anyway: ${worktreePath}`,
    );
    this.name = 'UnmergedOrphanError';
  }
}

export class DirtyOrphanError extends Error {
  constructor(readonly worktreePath: string, readonly details: string) {
    super(
      `Worktree has uncommitted changes (${details}). Use --force to remove the orphan worktree anyway: ${worktreePath}`,
    );
    this.name = 'DirtyOrphanError';
  }
}

function parseWorktreeId(value: string): { prefix: string | null; id: string } | null {
  const bare = value.match(/^0*(\d+)$/);
  if (bare) return { prefix: null, id: bare[1] };
  const prefixed = value.match(/^([a-z]+)-0*(\d+)(?:-|$)/);
  if (prefixed) return { prefix: prefixed[1], id: prefixed[2] };
  return null;
}

export function orphanDirMatches(dirName: string, projectId: string): boolean {
  if (dirName === projectId) return true;
  const wanted = parseWorktreeId(projectId);
  const have = parseWorktreeId(dirName);
  if (!wanted || !have || wanted.id !== have.id) return false;
  if (wanted.prefix === null) return true;
  return wanted.prefix === have.prefix;
}

export function isLiveBuilderWorktree(
  builders: ReadonlyArray<{ worktree: string }>,
  worktreePath: string,
): boolean {
  const dirName = basename(worktreePath);
  return builders.some((b) => b.worktree === worktreePath || basename(b.worktree) === dirName);
}

export function listOrphanWorktrees(
  workspaceRoot: string,
  builders: ReadonlyArray<{ worktree: string }>,
): { dirName: string; worktreePath: string }[] {
  const buildersDir = join(workspaceRoot, '.builders');
  if (!existsSync(buildersDir)) return [];

  let entries;
  try {
    entries = readdirSync(buildersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dirName: entry.name, worktreePath: join(buildersDir, entry.name) }))
    .filter((entry) => !isLiveBuilderWorktree(builders, entry.worktreePath));
}

export function measureOrphanBytes(paths: string[]): number | null {
  if (paths.length === 0) return 0;
  try {
    const result = spawnSync('du', ['-sk', ...paths], { encoding: 'utf-8', timeout: 30000 });
    if (result.status !== 0 || !result.stdout) return null;
    let totalKb = 0;
    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const kb = parseInt(line.trim().split(/\s+/)[0], 10);
      if (!Number.isFinite(kb)) return null;
      totalKb += kb;
    }
    return totalKb * 1024;
  } catch {
    return null;
  }
}

export function formatReclaimableBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export type NonEphemeralCleanupResult = 'removed-merged' | 'removed-force' | 'preserved-unmerged';

export async function cleanupNonEphemeralWorktree(
  workspaceRoot: string,
  worktreePath: string,
  force?: boolean,
): Promise<NonEphemeralCleanupResult> {
  const merged = await isWorktreeMerged(workspaceRoot, worktreePath);
  if (!merged && !force) return 'preserved-unmerged';
  await removeOrphanWorktree(workspaceRoot, worktreePath, force);
  return merged ? 'removed-merged' : 'removed-force';
}

export function findOrphanWorktree(workspaceRoot: string, projectId: string): OrphanLookup {
  const buildersDir = join(workspaceRoot, '.builders');
  if (!existsSync(buildersDir)) return { status: 'none' };

  let entries;
  try {
    entries = readdirSync(buildersDir, { withFileTypes: true });
  } catch {
    return { status: 'none' };
  }

  const matches = entries
    .filter((entry) => entry.isDirectory() && orphanDirMatches(entry.name, projectId))
    .map((entry) => ({ dirName: entry.name, worktreePath: join(buildersDir, entry.name) }));

  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'one', ...matches[0] };
  return { status: 'ambiguous', dirNames: matches.map((m) => m.dirName) };
}

/**
 * Paths porch REGENERATES, and therefore may be deleted with the worktree (#127).
 *
 * `codev/state/` is deliberately NOT here. It holds each builder's narrative
 * log, and CLAUDE.md is explicit that the log lives in the worktree in flight
 * and on `main` only AFTER the PR merges:
 *
 *   > Each builder keeps a narrative log at `codev/state/<builder-id>_thread.md`
 *   > — in-flight at `.builders/<id>/codev/state/`, and on `main` after the PR
 *   > merges.
 *
 * Until it lands, the worktree copy is the ONLY copy. status.yaml is different
 * in kind: porch owns it and rewrites it, so losing it costs nothing.
 *
 * Treating the two alike made a branch whose only unlanded file was its thread
 * log read as merged, so cleanup removed the worktree with no `--force` and no
 * warning — and the orphan path deletes the branch too (#126), leaving the log
 * nowhere. Measured twice in one day: three logs hand-salvaged from orphan
 * worktrees (#124, #125), and air-106's closing entry stranded on its branch
 * and rescued by hand (#134).
 */
const PORCH_BOOKKEEPING_PREFIXES = ['codev/projects/'] as const;
const PORCH_BOOKKEEPING_EXACT = new Set(['codev/projects']);

export function isPorchBookkeepingPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return PORCH_BOOKKEEPING_EXACT.has(normalized)
    || PORCH_BOOKKEEPING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

async function isOnlyPorchBookkeepingDelta(
  workspaceRoot: string,
  defaultBranch: string,
  sha: string,
): Promise<boolean> {
  try {
    const { stdout } = await run(
      `git log --name-only --pretty=format: "${defaultBranch}..${sha}"`,
      { cwd: workspaceRoot },
    );
    if (!stdout) return true;
    return stdout.split('\n').filter(Boolean).every(isPorchBookkeepingPath);
  } catch {
    return false;
  }
}

export async function isWorktreeMerged(workspaceRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout: sha } = await run('git rev-parse HEAD', { cwd: worktreePath });
    const defaultBranch = resolveDefaultBranch(workspaceRoot);
    try {
      await run(`git merge-base --is-ancestor ${sha} "${defaultBranch}"`, { cwd: workspaceRoot });
      return true;
    } catch {
      return await isOnlyPorchBookkeepingDelta(workspaceRoot, defaultBranch, sha);
    }
  } catch {
    return false;
  }
}

async function worktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await run('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath });
    if (!stdout || stdout === 'HEAD') return null;
    return stdout;
  } catch {
    return null;
  }
}

export async function removeOrphanWorktree(
  workspaceRoot: string,
  worktreePath: string,
  force?: boolean,
): Promise<void> {
  const merged = await isWorktreeMerged(workspaceRoot, worktreePath);
  if (!merged && !force) {
    throw new UnmergedOrphanError(worktreePath);
  }

  const { dirty, scaffoldOnly, details } = await hasUncommittedChanges(worktreePath);
  if (dirty && !force) {
    throw new DirtyOrphanError(worktreePath, details);
  }

  const branch = await worktreeBranch(worktreePath);
  if (existsSync(worktreePath)) {
    const gitForce = force || scaffoldOnly ? ' --force' : '';
    await run(`git worktree remove "${worktreePath}"${gitForce}`, { cwd: workspaceRoot });
  }

  if (merged && branch && branch !== 'main' && branch !== 'master') {
    try {
      await run(`git branch -D "${branch}"`, { cwd: workspaceRoot });
    } catch {
      // Branch may already be gone
    }
  }

  try {
    await run('git worktree prune', { cwd: workspaceRoot });
  } catch {
    // Non-fatal
  }
}

/**
 * Check if a worktree has uncommitted changes
 * Returns: dirty (has real changes), scaffoldOnly (only has .builder-* files)
 */
async function hasUncommittedChanges(worktreePath: string): Promise<{ dirty: boolean; scaffoldOnly: boolean; details: string }> {
  if (!existsSync(worktreePath)) {
    return { dirty: false, scaffoldOnly: false, details: '' };
  }

  try {
    // Check for uncommitted changes (staged and unstaged)
    const result = await run('git status --porcelain', { cwd: worktreePath });

    if (result.stdout.trim()) {
      // Count changed files, excluding builder scaffold files
      const scaffoldPattern = /^\?\? \.builder-/;
      const allLines = result.stdout.trim().split('\n').filter(Boolean);
      const nonScaffoldLines = allLines.filter((line) => !scaffoldPattern.test(line));

      if (nonScaffoldLines.length > 0) {
        return {
          dirty: true,
          scaffoldOnly: false,
          details: `${nonScaffoldLines.length} uncommitted file(s)`,
        };
      }

      // Only scaffold files present
      if (allLines.length > 0) {
        return { dirty: false, scaffoldOnly: true, details: '' };
      }
    }

    return { dirty: false, scaffoldOnly: false, details: '' };
  } catch {
    // If git status fails, assume dirty to be safe
    return { dirty: true, scaffoldOnly: false, details: 'Unable to check status' };
  }
}

/**
 * Delete a remote branch
 */
async function deleteRemoteBranch(branch: string, config: Config): Promise<void> {
  logger.info('Deleting remote branch...');
  try {
    await run(`git push origin --delete "${branch}"`, { cwd: config.workspaceRoot });
    logger.info('Remote branch deleted');
  } catch {
    logger.warn('Warning: Failed to delete remote branch (may not exist on remote)');
  }
}

/**
 * Cleanup a builder's worktree and branch
 */
export async function cleanup(options: CleanupOptions): Promise<void> {
  const config = getConfig();

  // Load state to find the builder.
  // Bugfix #826: loadState scopes the architect read by workspace_path;
  // builders are global per state.db, so this workspace's scope is fine.
  const state = loadState(config.workspaceRoot);
  let builder: Builder | undefined;

  if (options.issue) {
    // Find bugfix builder by issue number
    const builderId = `bugfix-${options.issue}`;
    builder = state.builders.find((b) => b.id === builderId);

    if (!builder) {
      // Also check by issueNumber field (in case ID format differs)
      builder = state.builders.find((b) => b.issueNumber === options.issue);
    }

    if (!builder) {
      fatal(`Bugfix builder not found for issue #${options.issue}`);
    }
  } else if (options.task) {
    // Find task builder by worktree name (e.g., "task-bEPd")
    const taskName = options.task;
    // Task builder IDs are "builder-task-<lowercased shortId>" (via buildAgentName)
    // Extract the shortId from the worktree name (e.g., "task-bEPd" → "bEPd" → "bepd")
    const shortId = taskName.startsWith('task-') ? taskName.slice(5) : taskName;
    const normalizedId = `builder-task-${shortId.toLowerCase()}`;
    builder = state.builders.find((b) => b.id === normalizedId);

    if (!builder) {
      // Fallback: check by worktree path containing the task name
      builder = state.builders.find((b) => b.worktree.endsWith(`/${taskName}`) || b.worktree.endsWith(`/${taskName}/`));
    }

    if (!builder) {
      fatal(`Task builder not found for: ${taskName}`);
    }
  } else if (options.project) {
    const projectId = options.project;
    builder = state.builders.find((b) => b.id === projectId);

    if (!builder) {
      // Try normalized task ID (e.g., "task-bEPd" → "builder-task-bepd")
      if (projectId.startsWith('task-')) {
        const shortId = projectId.slice(5);
        const normalizedId = `builder-task-${shortId.toLowerCase()}`;
        builder = state.builders.find((b) => b.id === normalizedId);
      }
    }

    if (!builder) {
      // Try to find by name pattern
      const byName = state.builders.find((b) => b.name.includes(projectId));
      if (byName) {
        return cleanupBuilder(byName, options.force, options.issue);
      }

      const orphan = findOrphanWorktree(config.workspaceRoot, projectId);
      if (orphan.status === 'ambiguous') {
        fatal(
          `Multiple orphan worktrees match project ${projectId}: ${orphan.dirNames.join(', ')}`,
        );
      }
      if (orphan.status === 'one' && !isLiveBuilderWorktree(state.builders, orphan.worktreePath)) {
        return cleanupOrphan(orphan.dirName, orphan.worktreePath, options.force);
      }

      fatal(`Builder not found for project: ${projectId}`);
    }
  } else {
    fatal('Must specify either --project, --issue, or --task');
  }

  await cleanupBuilder(builder, options.force, options.issue);
}

async function cleanupOrphan(dirName: string, worktreePath: string, force?: boolean): Promise<void> {
  const config = getConfig();
  logger.header(`Cleaning up orphan worktree ${dirName}`);
  logger.kv('Worktree', worktreePath);

  const shellpersKilled = await killShellperProcesses(worktreePath);
  if (shellpersKilled > 0) {
    logger.info(`Killed ${shellpersKilled} shellper process(es)`);
  }

  try {
    const db = getGlobalDb();
    const deleted = deleteFileTabsByPathPrefix(db, worktreePath);
    if (deleted > 0) {
      logger.info(`Removed ${deleted} stale file tab(s)`);
    }
    closeGlobalDb();
  } catch {
    // Non-fatal
  }

  try {
    await removeOrphanWorktree(config.workspaceRoot, worktreePath, force);
  } catch (error) {
    if (error instanceof UnmergedOrphanError || error instanceof DirtyOrphanError) {
      fatal(error.message);
    }
    fatal(`Failed to remove orphan worktree: ${error instanceof Error ? error.message : error}`);
  }
  logger.info('Worktree removed');

  try {
    const client = new TowerClient();
    await client.refreshOverview();
  } catch {
    // Tower not running
  }

  logger.blank();
  logger.success(`Orphan worktree ${dirName} cleaned up!`);
}

export async function cleanupThreadBackedBuilder(
  builder: Builder,
  force?: boolean,
): Promise<'removed' | 'refused-unmerged'> {
  if (!builder.threadId) throw new Error('cleanupThreadBackedBuilder requires threadId');
  const config = getConfig();
  const merged = builder.worktree ? await isWorktreeMerged(config.workspaceRoot, builder.worktree) : false;
  if (!merged && !force) return 'refused-unmerged';
  // Register the backend in THIS process and adopt the thread from the row before asking
  // it to remove anything (issue #227 item 2).
  //
  // `afx cleanup` is a fresh process, so nothing had registered an engine and this threw —
  // and the throw was about the right workspace, which made it an accurate description of
  // a command that did not work. Attaching is what makes it work: the engine keeps threads
  // in memory, and a thread created by `afx spawn` is unknown to the process that cleans it
  // up until `attach` adopts it. Without that, `removeWorktree` reports the thread unknown,
  // which reads as "no such thread" and is a different, wrong diagnosis.
  const engine = await adoptThreadInThisProcess({
    threadId: builder.threadId,
    workspaceRoot: config.workspaceRoot,
    worktreePath: builder.worktree,
    branch: builder.branch,
    builderId: builder.id,
    harnessName: builder.harness,
    model: builder.model,
  });
  let result: 'removed' | 'refused-unmerged';
  try {
    result = await engine.removeWorktree(builder.threadId, { force: !!force });
  } finally {
    // Hang up, so a one-shot command can exit. An open WebSocket is a live handle and
    // Node's loop does not drain while one exists — measured on the first live run of
    // `afx interrupt`, which did its work and then hung until it was killed.
    closeThreadBackend(config.workspaceRoot);
  }
  if (result === 'refused-unmerged') return result;
  removeBuilder(builder.id, config.workspaceRoot);
  return 'removed';
}

async function cleanupBuilder(builder: Builder, force?: boolean, issueNumber?: number): Promise<void> {
  if (isThreadBacked(builder)) {
    const result = await cleanupThreadBackedBuilder(builder, force);
    if (result === 'refused-unmerged') {
      logger.info(`Worktree preserved (unmerged) at: ${builder.worktree}`);
      fatal('Refusing to remove a thread-backed builder with unmerged work');
    }
    logger.success(`Thread-backed builder ${builder.id} cleaned up`);
    return;
  }

  const config = getConfig();
  const isShellMode = builder.type === 'shell';
  const isBugfixMode = builder.type === 'bugfix';
  const isTaskMode = builder.type === 'task';
  // Ephemeral builders (bugfix, task) get full cleanup: remove worktree + delete branches
  const isEphemeral = isBugfixMode || isTaskMode;

  const typeLabel = isShellMode ? 'Shell' : isBugfixMode ? 'Bugfix Builder' : isTaskMode ? 'Task Builder' : 'Builder';
  logger.header(`Cleaning up ${typeLabel} ${builder.id}`);
  logger.kv('Name', builder.name);
  if (!isShellMode) {
    logger.kv('Worktree', builder.worktree);
    logger.kv('Branch', builder.branch);
  }

  // Check for uncommitted changes (informational - worktree is preserved)
  if (!isShellMode) {
    const { dirty, details } = await hasUncommittedChanges(builder.worktree);
    if (dirty) {
      logger.info(`Worktree has uncommitted changes: ${details}`);
    }
  }

  // Kill Tower terminal if exists
  if (builder.terminalId) {
    try {
      const client = new TowerClient();
      const killed = await client.killTerminal(builder.terminalId);
      if (killed) {
        logger.info('Killed Tower terminal');
      }
    } catch {
      // Tower may not be running
    }
  }

  // Bugfix #389: Kill shellper processes directly by worktree path.
  // The Tower API kill may fail if Tower isn't running, the terminal was already
  // removed, or Tower was restarted. This catches any surviving shellper processes.
  if (!isShellMode && builder.worktree) {
    const shellpersKilled = await killShellperProcesses(builder.worktree);
    if (shellpersKilled > 0) {
      logger.info(`Killed ${shellpersKilled} shellper process(es)`);
    }
  }

  // Bugfix #474: Delete file tabs whose file_path points into this worktree
  if (!isShellMode && builder.worktree) {
    try {
      const db = getGlobalDb();
      const deleted = deleteFileTabsByPathPrefix(db, builder.worktree);
      if (deleted > 0) {
        logger.info(`Removed ${deleted} stale file tab(s)`);
      }
      closeGlobalDb();
    } catch {
      // Non-fatal — Tower may handle cleanup on its own
    }
  }

  // For ephemeral builders (bugfix, task): actually remove worktree and delete branches
  if (isEphemeral && !isShellMode) {
    // Remove worktree
    if (existsSync(builder.worktree)) {
      logger.info('Removing worktree...');
      try {
        await run(`git worktree remove "${builder.worktree}" --force`, { cwd: config.workspaceRoot });
        logger.info('Worktree removed');
      } catch {
        logger.warn('Warning: Failed to remove worktree');
      }
    }

    // Delete local branch
    if (builder.branch) {
      logger.info('Deleting local branch...');
      try {
        await run(`git branch -D "${builder.branch}"`, { cwd: config.workspaceRoot });
        logger.info('Local branch deleted');
      } catch {
        // Branch may not exist locally
      }
    }

    // Delete remote branch
    // Task builders typically don't push to remote, so skip PR verification for them
    if (builder.branch) {
      if (isTaskMode) {
        // Task builders are ephemeral — always delete remote branch if it exists
        await deleteRemoteBranch(builder.branch, config);
      } else if (!force) {
        // Verify PR is merged first unless --force, using pr-search concept
        try {
          const mergedResult = await executeForgeCommand('pr-search', {
            CODEV_SEARCH_QUERY: `head:${builder.branch} is:merged`,
          }, { cwd: config.workspaceRoot });
          const mergedPRs = Array.isArray(mergedResult) ? mergedResult : [];
          if (mergedPRs.length === 0) {
            // Check for open PRs
            const openResult = await executeForgeCommand('pr-search', {
              CODEV_SEARCH_QUERY: `head:${builder.branch} is:open`,
            }, { cwd: config.workspaceRoot });
            const openPRs = Array.isArray(openResult) ? openResult : [];
            if (openPRs.length > 0) {
              logger.warn(`Warning: Branch ${builder.branch} has an open PR. Skipping remote deletion.`);
              logger.info('Use --force to delete anyway.');
            } else {
              logger.warn(`Warning: No merged PR found for ${builder.branch}. Skipping remote deletion.`);
              logger.info('Use --force to delete anyway.');
            }
          } else {
            // PR is merged, safe to delete remote
            await deleteRemoteBranch(builder.branch, config);
          }
        } catch {
          logger.warn('Warning: Could not verify PR status. Skipping remote deletion.');
        }
      } else {
        // --force: delete remote branch without checking PR status
        await deleteRemoteBranch(builder.branch, config);
      }
    }
  } else if (!isShellMode) {
    if (!existsSync(builder.worktree)) {
      logger.info('Worktree already gone');
    } else {
      try {
        const result = await cleanupNonEphemeralWorktree(
          config.workspaceRoot,
          builder.worktree,
          force,
        );
        if (result === 'preserved-unmerged') {
          logger.info(`Worktree preserved (unmerged) at: ${builder.worktree}`);
          logger.info('To remove: git worktree remove "' + builder.worktree + '"');
          if (builder.branch) {
            logger.info(`Branch preserved: ${builder.branch}`);
            logger.info('To delete: git branch -d "' + builder.branch + '"');
          }
        } else {
          const reason = result === 'removed-merged' ? 'merged' : '--force';
          logger.info(`Worktree removed (${reason})`);
          if (result === 'removed-force' && builder.branch) {
            logger.info(`Branch preserved: ${builder.branch}`);
          }
        }
      } catch (error) {
        if (error instanceof UnmergedOrphanError || error instanceof DirtyOrphanError) {
          fatal(error.message);
        }
        fatal(`Failed to remove worktree: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Spec 1313 round 3 (take-now B): dismiss this agent's still-HELD mailbox rows. The
  // terminal-row prune only removes delivered/superseded/dismissed rows, never held ones, so a
  // removed agent's orphaned held mail would otherwise pin `heldCount`/escalated (and the
  // starvation alarm) forever. Soft transition (audit-preserving); keyed by the same normalized
  // workspace path the mailbox stores under, and by the canonical agent id (`builder.id`).
  // Non-fatal: a mailbox hiccup must not block worktree/state cleanup.
  try {
    const dismissed = dismissHeldForAgent(getGlobalDb(), normalizeWorkspacePath(config.workspaceRoot), builder.id);
    if (dismissed > 0) logger.info(`Dismissed ${dismissed} held mailbox message(s) for ${builder.id}`);
  } catch {
    // Non-fatal — the prune/backstop will not resurrect a removed agent's rows regardless.
  }

  // Remove from state. Issue #1118: scope by workspace (the builder was loaded
  // via loadState(config.workspaceRoot), so its row is keyed to this workspace).
  removeBuilder(builder.id, config.workspaceRoot);

  // Clean up porch state (codev/projects/NNNN-*/) so fresh kickoff gets fresh state
  if (!isShellMode) {
    await cleanupPorchState(builder.id, config);
  }

  // Always prune stale worktree entries to prevent "can't find session" errors
  // This catches any orphaned worktrees from crashes or manual kills
  if (!isShellMode) {
    try {
      await run('git worktree prune', { cwd: config.workspaceRoot });
    } catch {
      // Non-fatal - prune is best-effort cleanup
    }
  }

  // Invalidate Tower's overview cache + broadcast an `overview-changed`
  // SSE event. Connected clients (VSCode sidebar, dashboard) subscribe
  // to SSE and re-fetch on any event — without this, the just-removed
  // builder would linger in their UI until some unrelated SSE event
  // happened to trigger an incidental refresh. Best-effort — silently
  // no-ops if Tower isn't running.
  try {
    const client = new TowerClient();
    await client.refreshOverview();
  } catch {
    // Tower not running or unreachable — non-fatal.
  }

  logger.blank();
  logger.success(`Builder ${builder.id} cleaned up!`);
}
