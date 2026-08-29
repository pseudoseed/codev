/**
 * The production `ThreadEngine`, backed by porch-driver against a t3code server.
 *
 * Spec 146 Phase 9, issue #179 item 1. Until now the only implementation of this
 * lived under `__tests__/helpers/`, importing porch-driver by a deep relative path
 * into its gitignored `dist/`. That is reachable from a test in the monorepo and
 * from nowhere else: `@cluesmith/codev` packs from `packages/codev`, so a relative
 * import climbing out of it does not survive packing, and `porch-driver` was
 * `private` and absent from this package's dependencies. "The only engine reachable
 * in production is none" was accurate.
 *
 * Fixed by making `porch-driver` a real workspace dependency rather than by
 * vendoring its surface into `packages/codev/src`. Vendoring is what Phase 1 did for
 * the t3code *contract* — a small, stable set of types. This is live logic (threads,
 * turns, the dispatch journal) with its own tests, and a second copy of it would
 * drift from the one under test. Publishing costs two manifest edits: `porch-driver`
 * and its own dependency `@cluesmith/t3-client` both drop `private: true`.
 */
import { DriverThread } from '@cluesmith/porch-driver/thread';
import {
  DispatchJournal,
  type CommandDispatcher,
} from '@cluesmith/porch-driver/commands';
import { TurnTracker } from '@cluesmith/porch-driver/turn';
import type { ThreadEngine, ThreadRecord } from './thread-runtime.js';
import type { SpawnThreadFactory } from './db/thread-identity.js';

export interface PorchThreadEngineOptions {
  readonly dispatcher: CommandDispatcher;
  readonly journal: DispatchJournal;
  readonly tracker: TurnTracker;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly defaultHarness?: string;
  readonly defaultModel?: string;
}

/**
 * Why a thread this engine has never heard of is not the same as a thread that does not exist.
 *
 * The engine holds its threads in process-local maps and cannot rehydrate one from the
 * server. Every `afx` invocation is a fresh process, so a thread created by `afx spawn` is
 * unknown to the `afx interrupt` that follows it — and `Unknown thread <id>` reads as "no
 * such thread", which is a different and wrong diagnosis. The limitation is real and is not
 * fixed here; the message at least names it.
 */
function unknownThread(threadId: string): string {
  return (
    `Thread ${threadId} was not created by this process. This engine keeps threads in memory `
    + `and cannot yet re-attach to one from a previous process or after a server restart, so `
    + `this is not evidence that the thread does not exist.`
  );
}

export function createPorchThreadEngine(options: PorchThreadEngineOptions): ThreadEngine {
  const threads = new Map<string, DriverThread>();
  const records = new Map<string, ThreadRecord>();

  /**
   * Follow one started turn onto the record, and off it again when it settles.
   *
   * `activeTurnId` was previously written as `turn-${threadId}` and cleared only by
   * `interrupt`, so a turn that finished normally left the record claiming one was still
   * running — and the id was invented rather than the server's.
   *
   * It is set from `commandId` first and refined to the real turn id when the server
   * names it. Waiting for `started.running` before writing anything would leave a window
   * where a turn IS running and the record reads `null`, which is an idle thread and a
   * thread whose turn has not been named yet spelled the same way. Both promises are
   * followed rather than awaited: the caller asked to start a turn, not to wait for it.
   *
   * The `activeTurnId === current` guards keep a late settle from clearing a newer turn's
   * id, and `finished` keeps a late `running` from resurrecting one that has already ended.
   */
  function track(record: ThreadRecord, started: { commandId: string; running: Promise<string>; settled: Promise<unknown> }): void {
    record.activeTurnId = started.commandId;
    let current = started.commandId;
    let finished = false;
    void started.running.then(
      (turnId) => {
        // `settled` can land first; without this the refinement would resurrect a turn
        // that has already finished.
        if (finished) return;
        if (record.activeTurnId === current) record.activeTurnId = turnId;
        current = turnId;
      },
      () => {},
    );
    const clear = () => {
      finished = true;
      if (record.activeTurnId === current) record.activeTurnId = null;
    };
    void started.settled.then(clear, clear);
  }

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
          // The PTY path injects a role through harness-specific script fragments and
          // env; a thread has none of that, and `DriverThread` already carries a role
          // into the first turn. Forwarded rather than reimplemented.
          roleContent: input.roleContent ?? undefined,
          roleFilePath: input.roleFilePath ?? undefined,
        },
      );
      threads.set(thread.threadId, thread);
      const record: ThreadRecord = {
        threadId: thread.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        launched: Boolean(input.launchScript || input.prompt || input.role === 'architect'),
      };
      records.set(thread.threadId, record);
      // The initial turn IS the spawn: without it the thread exists and the builder has
      // been given nothing to do. Tracked like any other turn so the record does not
      // read idle while the first one runs.
      if (input.prompt) track(record, await thread.beginTurn(input.prompt));
      return thread.threadId;
    },

    async startTurn(threadId, text) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(unknownThread(threadId));
      const record = records.get(threadId);
      const started = await thread.beginTurn(text);
      if (record) track(record, started);
    },

    async interrupt(threadId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(unknownThread(threadId));
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
      if (!path) throw new Error(unknownThread(threadId));
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
