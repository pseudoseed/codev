import { DriverThread } from '../../../../../porch-driver/dist/thread.js';
import {
  DispatchJournal,
  type CommandDispatcher,
} from '../../../../../porch-driver/dist/commands.js';
import { TurnTracker } from '../../../../../porch-driver/dist/turn.js';
import type { ThreadEngine, ThreadRecord } from '../../thread-runtime.js';
import type { SpawnThreadFactory } from '../../db/thread-identity.js';

export interface PorchThreadEngineOptions {
  readonly dispatcher: CommandDispatcher;
  readonly journal: DispatchJournal;
  readonly tracker: TurnTracker;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly defaultHarness?: string;
  readonly defaultModel?: string;
}

export function createPorchThreadEngine(options: PorchThreadEngineOptions): ThreadEngine {
  const threads = new Map<string, DriverThread>();
  const records = new Map<string, ThreadRecord>();

  return {
    async create(input: Parameters<SpawnThreadFactory>[0]) {
      const thread = await DriverThread.create(
        {
          dispatcher: options.dispatcher,
          journal: options.journal,
          tracker: options.tracker,
        },
        {
          projectId: options.projectId,
          title: input.builderId,
          harnessName: input.harnessName ?? options.defaultHarness ?? 'codex',
          model: input.model,
          defaultModel: options.defaultModel,
          worktreePath: input.worktreePath,
          branch: input.branch,
        },
      );
      threads.set(thread.threadId, thread);
      records.set(thread.threadId, {
        threadId: thread.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        launched: Boolean(input.launchScript || input.prompt || input.role === 'architect'),
      });
      if (input.prompt) await thread.beginTurn(input.prompt);
      return thread.threadId;
    },

    async startTurn(threadId, text) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(`Unknown thread ${threadId}`);
      const record = records.get(threadId);
      if (record) record.activeTurnId = `turn-${threadId}`;
      await thread.beginTurn(text);
    },

    async interrupt(threadId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(`Unknown thread ${threadId}`);
      await thread.interrupt();
      const record = records.get(threadId);
      if (record) record.activeTurnId = null;
      return { activeTurnId: null };
    },

    worktreePath(threadId) {
      return threads.get(threadId)?.worktreePath ?? records.get(threadId)?.worktreePath;
    },

    async removeWorktree(threadId, opts) {
      const thread = threads.get(threadId);
      const record = records.get(threadId);
      const path = thread?.worktreePath ?? record?.worktreePath;
      if (!path) throw new Error(`Unknown thread ${threadId}`);
      await options.dispatcher.call('vcs.removeWorktree', {
        cwd: options.workspaceRoot,
        path,
        force: opts?.force ?? false,
      });
      threads.delete(threadId);
      records.delete(threadId);
      return 'removed';
    },

    get(threadId) {
      return records.get(threadId);
    },
  };
}
