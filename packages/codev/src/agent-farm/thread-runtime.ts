import {
  setSpawnThreadFactory,
  type SpawnThreadFactory,
} from './db/thread-identity.js';
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

export interface ThreadEngine {
  create(input: Parameters<SpawnThreadFactory>[0]): Promise<string>;
  startTurn(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<{ activeTurnId: null }>;
  worktreePath(threadId: string): string | undefined;
  removeWorktree(threadId: string, opts?: { force?: boolean }): Promise<'removed' | 'refused-unmerged'>;
  get(threadId: string): ThreadRecord | undefined;
}

let engine: ThreadEngine | undefined;

export function setThreadEngine(next: ThreadEngine | undefined): void {
  engine = next;
}

export function tryGetThreadEngine(): ThreadEngine | undefined {
  return engine;
}

export function getThreadEngine(): ThreadEngine {
  if (!engine) throw new Error('Thread engine is not registered');
  return engine;
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

export function installThreadSpawnFactory(): void {
  setSpawnThreadFactory(async (input) => getThreadEngine().create(input));
}

export async function deliverThreadTurn(threadId: string, text: string): Promise<void> {
  await getThreadEngine().startTurn(threadId, text);
}

export async function interruptThread(threadId: string): Promise<{ activeTurnId: null }> {
  return getThreadEngine().interrupt(threadId);
}

export function worktreeForThreadBuilder(builder: { threadId?: string; worktree?: string }): string {
  if (!builder.threadId) throw new Error('worktreeForThreadBuilder requires threadId');
  const fromEngine = tryGetThreadEngine()?.worktreePath(builder.threadId);
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
  return getThreadEngine().create({
    builderId: `architect-${input.name}`,
    worktreePath: input.workspaceRoot,
    branch: '',
    harnessName: input.harnessName,
    model: input.model,
    role: 'architect',
  });
}
