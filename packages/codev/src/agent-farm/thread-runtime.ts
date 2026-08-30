import {
  setSpawnThreadFactory,
  type SpawnThreadFactory,
} from './db/thread-identity.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getArchitectByName, getBuilder } from './state.js';

export const THREAD_BACKED_UNSUPPORTED = 'thread-backed, unsupported here';

export function isThreadBacked(row: { threadId?: string | null }): boolean {
  return typeof row.threadId === 'string' && row.threadId.length > 0;
}

export function isAgentRunning(row: { terminalId?: string | null; threadId?: string | null }): boolean {
  return !!(row.terminalId || row.threadId);
}

export function refuseUnsupportedThreadCommand(row: { threadId?: string | null }): void {
  if (isThreadBacked(row)) throw new Error(THREAD_BACKED_UNSUPPORTED);
}

export interface ThreadRecord {
  readonly threadId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly builderId: string;
  activeTurnId: string | null;
  merged: boolean;
  launched: boolean;
}

/**
 * What `ThreadEngine.attach` needs to adopt a thread it did not create.
 *
 * The worktree and branch are NOT re-derivable from the thread id by this
 * process — they come from the row that recorded them at spawn. An architect's
 * worktree is the workspace root and its branch is empty, which is the shape
 * `createArchitectThread` writes.
 */
export interface AttachThreadInput {
  readonly threadId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly builderId: string;
  readonly harnessName?: string;
  readonly model?: string;
}

export interface ThreadEngine {
  create(input: Parameters<SpawnThreadFactory>[0]): Promise<string>;
  /**
   * Adopt a thread that already exists on the server.
   *
   * This is the difference between "the thread is gone" and "this process has
   * never heard of it", and until it existed the engine could only say the
   * second in the first's words. A thread survives a server restart; the
   * in-process map that knew about it does not.
   */
  attach(input: AttachThreadInput): Promise<ThreadRecord>;
  startTurn(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<{ activeTurnId: null }>;
  worktreePath(threadId: string): string | undefined;
  removeWorktree(threadId: string, opts?: { force?: boolean }): Promise<'removed' | 'refused-unmerged'>;
  get(threadId: string): ThreadRecord | undefined;
}

/**
 * One engine PER WORKSPACE, not one per process.
 *
 * This was a bare `let engine`, and in the CLI that was harmless: an `afx` process
 * serves one workspace and exits. Tower does not. It drains mail for every workspace
 * in `global.db` from a single process, so a process-global engine meant the FIRST
 * thread-configured workspace to deliver pinned the socket, the projectId, the
 * dispatcher and the journal — and workspace B's turns then ran against workspace A's
 * server, under A's project. Silently, because a turn dispatched to the wrong server
 * succeeds.
 *
 * The bug was created by moving engine registration into Tower, which is what the
 * delivery fix required. It is the shape of that seam, not an accident of it.
 */
const engines = new Map<string, ThreadEngine>();

/**
 * The slot for a caller that names no workspace.
 *
 * Deliberately NOT a fallback for keyed lookups. A keyed read that missed and then
 * took this one would restore exactly the bug above, one indirection further away.
 * A caller either names a workspace or it does not, and the two never see each
 * other's engine.
 */
const UNKEYED = '\u0000unkeyed';

/**
 * The canonical key for a workspace root.
 *
 * `/var` and `/private/var` are the same directory on macOS, and `.`-relative and
 * trailing-slash forms are the same workspace. Two keys for one workspace is two
 * engines, two sockets and two projects for it — which is the failure this map exists
 * to prevent, wearing a different hat.
 */
export function canonicalWorkspaceKey(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot).replace(/\/+$/, '') || '/';
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function setThreadEngine(next: ThreadEngine | undefined, workspaceRoot?: string): void {
  const key = workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot);
  if (next === undefined) engines.delete(key);
  else engines.set(key, next);
}

/** Every registered engine is dropped. For a test's teardown, not for production. */
export function clearThreadEngines(): void {
  engines.clear();
}

export function tryGetThreadEngine(workspaceRoot?: string): ThreadEngine | undefined {
  return engines.get(workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot));
}

export function getThreadEngine(workspaceRoot?: string): ThreadEngine {
  const found = tryGetThreadEngine(workspaceRoot);
  if (!found) {
    // "No engine registered" was true and useless: it is the same sentence for a
    // workspace that has no t3code server configured, and for one that has a server but
    // reached this line from a command that never called `ensureThreadBackendReady`.
    // Only the second is a bug in this repo, and a caller cannot tell them apart from
    // the old message.
    throw new Error(
      `No thread engine is registered in this process for ${workspaceRoot ?? '(no workspace named)'}. `
      + 'Either this workspace has no t3code server configured (in which case nothing should be '
      + 'thread-backed), or this command reached a thread-backed row without calling '
      + 'ensureThreadBackendReady() for THAT workspace first. An engine registered for a different '
      + 'workspace is deliberately not used here: it holds another workspace\'s server and project.',
    );
  }
  return found;
}

export function createMemoryThreadEngine(): ThreadEngine {
  const threads = new Map<string, ThreadRecord>();
  return {
    async create(input) {
      const threadId = `thr-${input.builderId}`;
      threads.set(threadId, {
        threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        launched: Boolean(input.launchScript || input.prompt || input.role === 'architect'),
      });
      return threadId;
    },
    async attach(input) {
      const existing = threads.get(input.threadId);
      if (existing) return existing;
      const record: ThreadRecord = {
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        // An attached thread was launched before this process existed. Reporting
        // `false` would say "it was never given anything to do", which is a claim
        // about the thread rather than about this engine's memory of it.
        launched: true,
      };
      threads.set(input.threadId, record);
      return record;
    },
    async startTurn(threadId, _text) {
      const record = threads.get(threadId);
      if (!record) throw new Error(`Unknown thread ${threadId}`);
      record.activeTurnId = `turn-${threadId}`;
    },
    async interrupt(threadId) {
      const record = threads.get(threadId);
      if (!record) throw new Error(`Unknown thread ${threadId}`);
      record.activeTurnId = null;
      return { activeTurnId: null };
    },
    worktreePath(threadId) {
      return threads.get(threadId)?.worktreePath;
    },
    async removeWorktree(threadId) {
      const record = threads.get(threadId);
      if (!record) throw new Error(`Unknown thread ${threadId}`);
      threads.delete(threadId);
      return 'removed';
    },
    get(threadId) {
      return threads.get(threadId);
    },
  };
}

/**
 * The factory closes over the workspace it was installed for.
 *
 * `SpawnThreadFactory`'s input carries a worktree, not a workspace root, and a
 * builder's worktree is under `.builders/` rather than being the workspace — so the
 * root cannot be recovered from it. The installer knows it; the factory remembers it.
 */
export function installThreadSpawnFactory(workspaceRoot?: string): void {
  setSpawnThreadFactory(async (input) => getThreadEngine(workspaceRoot).create(input));
}

export async function deliverThreadTurn(
  threadId: string,
  text: string,
  workspaceRoot?: string,
): Promise<void> {
  await getThreadEngine(workspaceRoot).startTurn(threadId, text);
}

export async function interruptThread(
  threadId: string,
  workspaceRoot?: string,
): Promise<{ activeTurnId: null }> {
  return getThreadEngine(workspaceRoot).interrupt(threadId);
}

export function worktreeForThreadBuilder(
  builder: { threadId?: string; worktree?: string },
  workspaceRoot?: string,
): string {
  if (!builder.threadId) throw new Error('worktreeForThreadBuilder requires threadId');
  const fromEngine = tryGetThreadEngine(workspaceRoot)?.worktreePath(builder.threadId);
  const path = fromEngine ?? builder.worktree;
  if (!path) throw new Error(`Thread ${builder.threadId} has no worktree`);
  return path;
}

export function threadIdForAgent(
  workspacePath: string,
  agent: string,
  kind: 'builder' | 'architect',
): string | undefined {
  if (kind === 'builder') return getBuilder(agent, workspacePath)?.threadId;
  return getArchitectByName(workspacePath, agent)?.threadId;
}

export async function createArchitectThread(input: {
  name: string;
  workspaceRoot: string;
  harnessName?: string;
  model?: string;
}): Promise<string> {
  return getThreadEngine(input.workspaceRoot).create({
    builderId: `architect-${input.name}`,
    worktreePath: input.workspaceRoot,
    branch: '',
    harnessName: input.harnessName,
    model: input.model,
    role: 'architect',
  });
}
