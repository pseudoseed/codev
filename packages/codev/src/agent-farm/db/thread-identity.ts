import type { ArchitectState, Builder } from '../types.js';
import { workspaceMapKey } from '../workspace-key.js';

export const THREAD_ARCHITECT_SENTINEL = { pid: 0, port: 0 } as const;

export class DualIdentityError extends Error {
  constructor(detail: string) {
    super(`A row must be terminal-backed or thread-backed, never both: ${detail}`);
    this.name = 'DualIdentityError';
  }
}

export function assertExclusiveIdentity(ids: {
  terminalId?: string | null;
  threadId?: string | null;
}): void {
  const terminal = ids.terminalId != null && ids.terminalId !== '';
  const thread = ids.threadId != null && ids.threadId !== '';
  if (terminal && thread) {
    throw new DualIdentityError(`terminal_id=${ids.terminalId} thread_id=${ids.threadId}`);
  }
}

export function architectWriteValues(architect: ArchitectState): {
  pid: number;
  port: number;
  cmd: string;
  terminalId: string | null;
  threadId: string | null;
} {
  assertExclusiveIdentity(architect);
  if (architect.threadId) {
    return {
      pid: THREAD_ARCHITECT_SENTINEL.pid,
      port: THREAD_ARCHITECT_SENTINEL.port,
      cmd: architect.cmd,
      terminalId: null,
      threadId: architect.threadId,
    };
  }
  return {
    pid: 0,
    port: 0,
    cmd: architect.cmd,
    terminalId: architect.terminalId ?? null,
    threadId: null,
  };
}

export type SpawnThreadFactory = (input: {
  builderId: string;
  worktreePath: string;
  branch: string;
  harnessName?: string;
  model?: string;
  prompt?: string;
  launchScript?: string;
  role?: 'builder' | 'architect';
  /**
   * The role prompt, and where the PTY path writes it.
   *
   * On the PTY path a role is injected by harness-specific script fragments and env
   * (`startBuilderSession`), which a thread has no equivalent of. `DriverThread.create`
   * already takes both and carries the role into the thread's first turn, so the thread
   * path needs them forwarded, not reimplemented. Without them a thread-backed builder
   * comes up with no role at all while the PTY path gives it one.
   */
  roleContent?: string | null;
  roleFilePath?: string | null;
}) => Promise<string>;

/**
 * One spawn factory PER WORKSPACE, not one per process (issue #227 item 1).
 *
 * This was a bare `let spawnThreadFactory`, which is the bug the engine map in
 * `thread-runtime.ts` had already been fixed for, one door down. `ensureThreadBackendReady`
 * installs a factory on every successful init and Tower calls that for every workspace it
 * delivers to — so the LAST workspace to connect owned the module singleton, and the first
 * caller to read `chooseSpawnPath` inside Tower would have been answered about a workspace
 * it never named.
 *
 * The factory closes over the workspace it was installed for, so it always dispatched to
 * the right engine. It was the SELECTION that was global: `chooseSpawnPath` said "thread"
 * on the strength of some other workspace's factory existing, and `allocateSpawnThread`
 * then created a thread on that other workspace's server.
 *
 * Unreachable today only because `chooseSpawnPath`'s single consumer is `afx spawn`, which
 * is one workspace per process. "Unreachable" is a property of today's callers, not of the
 * code, and the per-workspace engine map exists because that property stopped holding once.
 */
const spawnThreadFactories = new Map<string, SpawnThreadFactory>();
let threadBacked = true;

export function setSpawnThreadFactory(
  fn: SpawnThreadFactory | undefined,
  workspaceRoot?: string,
): void {
  const key = workspaceMapKey(workspaceRoot);
  if (fn === undefined) spawnThreadFactories.delete(key);
  else spawnThreadFactories.set(key, fn);
}

/** Every registered factory is dropped. For a test's teardown, not for production. */
export function clearSpawnThreadFactories(): void {
  spawnThreadFactories.clear();
}

export function setThreadBackedSpawnsEnabled(enabled: boolean): void {
  threadBacked = enabled;
}

export function threadBackedSpawnsEnabled(): boolean {
  return threadBacked;
}

/**
 * `workspaceRoot` names WHOSE factory decides. A caller that omits it asks about the
 * unkeyed slot and is never answered from a keyed one — a keyed miss falling back to
 * some other workspace's factory is exactly the process-global behaviour this replaced.
 */
export function chooseSpawnPath(
  existing?: {
    terminalId?: string;
    threadId?: string;
  },
  workspaceRoot?: string,
): 'thread' | 'pty' {
  if (existing?.terminalId) return 'pty';
  if (existing?.threadId) return 'thread';
  if (!threadBacked) return 'pty';
  if (!spawnThreadFactories.has(workspaceMapKey(workspaceRoot))) return 'pty';
  return 'thread';
}

export async function allocateSpawnThread(
  input: Parameters<SpawnThreadFactory>[0],
  workspaceRoot?: string,
): Promise<string> {
  const factory = spawnThreadFactories.get(workspaceMapKey(workspaceRoot));
  if (!factory) {
    // Names the workspace, because "no factory" and "no factory FOR THAT WORKSPACE" send a
    // reader to different places, and only the second is true once the map is keyed.
    throw new Error(
      `Thread-backed spawn has no factory for ${workspaceRoot ?? '(no workspace named)'}`,
    );
  }
  return factory(input);
}

export function countPtyDrainFromBuilders(builders: ReadonlyArray<Builder>): number {
  return builders.filter(
    (b) => b.terminalId != null && b.threadId == null && b.status !== 'complete',
  ).length;
}
