import type { ArchitectState, Builder } from '../types.js';

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
}) => Promise<string>;

let spawnThreadFactory: SpawnThreadFactory | undefined;
let threadBacked = true;

export function setSpawnThreadFactory(fn: SpawnThreadFactory | undefined): void {
  spawnThreadFactory = fn;
}

export function setThreadBackedSpawnsEnabled(enabled: boolean): void {
  threadBacked = enabled;
}

export function threadBackedSpawnsEnabled(): boolean {
  return threadBacked;
}

export function chooseSpawnPath(existing?: {
  terminalId?: string;
  threadId?: string;
}): 'thread' | 'pty' {
  if (existing?.terminalId) return 'pty';
  if (existing?.threadId) return 'thread';
  if (!threadBacked) return 'pty';
  if (!spawnThreadFactory) return 'pty';
  return 'thread';
}

export async function allocateSpawnThread(
  input: Parameters<SpawnThreadFactory>[0],
): Promise<string> {
  if (!spawnThreadFactory) {
    throw new Error('Thread-backed spawn has no factory');
  }
  return spawnThreadFactory(input);
}

export function countPtyDrainFromBuilders(builders: ReadonlyArray<Builder>): number {
  return builders.filter(
    (b) => b.terminalId != null && b.threadId == null && b.status !== 'complete',
  ).length;
}
