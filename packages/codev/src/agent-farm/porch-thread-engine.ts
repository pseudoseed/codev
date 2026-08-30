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
  DISPATCH_METHOD,
  isServerRefusal,
  type CommandDispatcher,
} from '@cluesmith/porch-driver/commands';
import { asThreadEvent, TurnTracker } from '@cluesmith/porch-driver/turn';
import type { AttachThreadInput, ThreadEngine, ThreadRecord } from './thread-runtime.js';
import type { ThreadSubscriptionPool } from './thread-subscriptions.js';
import { logger } from './utils/logger.js';
import type { SpawnThreadFactory } from './db/thread-identity.js';

export interface PorchThreadEngineOptions {
  readonly dispatcher: CommandDispatcher;
  readonly journal: DispatchJournal;
  readonly tracker: TurnTracker;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly defaultHarness?: string;
  readonly defaultModel?: string;
  /**
   * The subscriptions that make turns settle (issue #241).
   *
   * OPTIONAL, and the reason matters: an engine built against a fake dispatcher with
   * no server has nothing to subscribe to, and every existing unit test is that
   * engine. Absent, this engine behaves exactly as it did before — which is to say
   * no turn it starts will ever settle, and a caller in that position must not be
   * told otherwise. Production always passes one.
   */
  readonly subscriptions?: ThreadSubscriptionPool;
}

/**
 * Why a thread this engine has never heard of is not the same as a thread that does not exist.
 *
 * The engine holds its threads in process-local maps. Every `afx` invocation is a fresh
 * process, so a thread created by `afx spawn` is unknown to the `afx interrupt` that
 * follows it — and `Unknown thread <id>` reads as "no such thread", which is a different
 * and wrong diagnosis.
 *
 * `attach` is now the way out, and the message says so. It is not automatic: the worktree
 * and branch are not derivable from a thread id here, so a caller that holds the row must
 * hand them over. Until it does, this remains "I have not been told about it".
 */
function unknownThread(threadId: string): string {
  return (
    `Thread ${threadId} was not created by this process and has not been attached. This engine `
    + `keeps threads in memory, so a thread from a previous process or from before a server `
    + `restart is unknown here until \`attach\` adopts it — this is not evidence that the thread `
    + `does not exist. The caller holds the worktree and branch that \`attach\` needs; this engine `
    + `cannot recover them from the id alone.`
  );
}

/**
 * The harness used when neither the caller nor the workspace names one.
 *
 * Named once because three places consulted it — `create`, `attach`, and now the
 * `defaults` an architect row is written from. A literal in each is three chances for the
 * recorded pair to disagree with the pair actually used (issue #227 item 3).
 */
export const DEFAULT_THREAD_HARNESS = 'codex';

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
      (error: unknown) => {
        /*
         * LOGGED, not swallowed — and this is the last step of #238's chain.
         *
         * `SessionStartFailedError` exists so that a server REFUSING a session is
         * spelled differently from a caller giving up on it, and it carries the
         * server's own sentence. Until issue #241 nothing fed `TurnTracker.observe`, so
         * it could not be raised at all. Feeding it makes it fire — but this handler was
         * `() => {}`, so it fired into nothing and the refusal was still invisible.
         *
         * `track` cannot THROW it: its caller asked to start a turn, not to wait for one,
         * and both promises are followed rather than awaited on purpose. So the honest
         * thing it can do is say what happened. A caller that wants to fail on a refusal
         * has to await `running` itself, and none does today — that is a real remaining
         * gap and it is stated in the review rather than implied away.
         *
         * `TurnDisplacedError` comes through here too, and means something different:
         * a second turn replaced this waiter. Both are worth a line; neither is worth
         * losing.
         */
        logger.error(
          `Thread ${record.threadId} (${record.builderId}): the turn started as ${started.commandId} `
          + `will not report a turn id — ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    const clear = () => {
      finished = true;
      if (record.activeTurnId === current) record.activeTurnId = null;
    };
    void started.settled.then(clear, clear);
  }

  return {
    // What a create/attach naming neither will use, resolved here rather than recomputed
    // by the caller that records it (issue #227 item 3).
    defaults: { harness: options.defaultHarness ?? DEFAULT_THREAD_HARNESS, model: options.defaultModel },
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
          harnessName: input.harnessName ?? options.defaultHarness ?? DEFAULT_THREAD_HARNESS,
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
      // BEFORE the first turn, and this ordering is the point of issue #241.
      //
      // `ResumingSubscription` hands the server's snapshot frame to `onValue` and
      // `asThreadEvent` returns null for it, so anything the server compacted into
      // that snapshot is never observed. A turn dispatched first can therefore have
      // its `running` transition land inside the snapshot, and the waiter then waits
      // for a transition that already happened.
      //
      // It is driver-dependent, which is what makes it dangerous: the same race
      // passed under claude and timed out under opencode/grok-4.6, which finishes a
      // trivial turn in ~14s and beat the subscribe. A spawn that feels slower here
      // is the cost of a turn that settles; it is not a latency bug to be optimised
      // back into fire-and-forget.
      await options.subscriptions?.ensure(thread.threadId);
      // The initial turn IS the spawn: without it the thread exists and the builder has
      // been given nothing to do. Tracked like any other turn so the record does not
      // read idle while the first one runs.
      if (input.prompt) track(record, await thread.beginTurn(input.prompt));
      return thread.threadId;
    },

    /**
     * Adopt a thread that already exists on the server.
     *
     * `DriverThread.attach` rather than `create`: creating would dispatch a second
     * `thread.create` and re-apply the worktree setup, so "resume the thread from
     * before the restart" would silently become "make a new one and overwrite the
     * worktree".
     *
     * Idempotent, because the caller cannot always know whether this process has
     * already adopted the thread and a second attach must not replace a
     * `DriverThread` that is tracking a live turn.
     */
    async attach(input: AttachThreadInput) {
      const existing = records.get(input.threadId);
      if (existing) {
        // BEFORE the early return, and `start` is idempotent so this costs nothing on
        // the ordinary path.
        //
        // Without it, adoption could never recover a subscription that had terminated:
        // the pool drops its entry on a non-retryable failure, but every later sweeper
        // pass hit this early return and never reached `start`, so the thread stayed
        // permanently unwatched while the log said a later pass would adopt it. A
        // record and a subscription are two different things, and only one of them was
        // being checked here.
        options.subscriptions?.start(input.threadId);
        return existing;
      }
      const thread = DriverThread.attach(
        {
          dispatcher: options.dispatcher,
          journal: options.journal,
          tracker: options.tracker,
        },
        {
          threadId: input.threadId,
          harnessName: input.harnessName ?? options.defaultHarness ?? DEFAULT_THREAD_HARNESS,
          model: input.model,
          defaultModel: options.defaultModel,
          worktreePath: input.worktreePath,
          branch: input.branch,
        },
      );
      threads.set(thread.threadId, thread);
      const record: ThreadRecord = {
        threadId: thread.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        // `null` means "this engine is not following a turn", and no caller may read
        // it as "the thread is idle".
        //
        // ADOPTION DOES NOT MAKE IT KNOWABLE, and an earlier version of this comment
        // claimed the subscription would. It does not: only `track` writes this field,
        // and `track` runs from `create` and `startTurn` — the paths that register a
        // waiter with the tracker. A turn started on this thread by a PREVIOUS process
        // is observed by the tracker (it advances `lastSequence` and `activeThreads`)
        // and still leaves this field null, because no waiter here is following it.
        //
        // What the subscription changes is the turns this process starts from now on:
        // before it, those could never settle either. Reading the server's current
        // turn onto an adopted record would be a further change, and it is not made
        // here rather than being implied.
        activeTurnId: null,
        merged: false,
        launched: true,
      };
      records.set(thread.threadId, record);
      // `start`, not `ensure`: adoption is not dispatch.
      //
      // This runs on every mailbox delivery AND on every sweeper pass, so awaiting
      // attachment here would charge a thread whose subscription cannot come up the
      // whole attach budget on every pass, forever, and delay every thread behind it
      // in the same pass. The guard that matters is at dispatch, and `startTurn` and
      // `create` hold it.
      options.subscriptions?.start(thread.threadId);
      return record;
    },

    /**
     * Replay this thread's unanswered turn under its original command id.
     *
     * The journal is the durable record — an in-process map does not survive the Tower
     * restart this is most likely to follow — so the pending intent is found by the
     * caller's `ref` rather than by anything held in memory. NOT by message text: two
     * identical messages to one agent are ordinary, and text matching made a stale intent
     * answer for the current one, reporting delivered without delivering.
     *
     * ONLY this intent is replayed. `recoverPendingCommands` — which drains the whole
     * workspace journal — is deliberately NOT used, and the reason is worth stating
     * because an earlier version of this did use it: replaying a sibling agent's intent
     * marks it dispatched while its mailbox row is still held, so that row's next tick
     * finds nothing pending and submits a fresh command id. Draining the journal to
     * prevent a duplicate turn produced one, one agent over.
     *
     * That leaves `recoverPendingCommands` still without a production caller, which is
     * an honest outcome rather than a gap to paper over: whole-journal replay is a
     * process-startup operation, and doing it from a per-row delivery is what makes it
     * wrong here.
     */
    async recoverTurn(threadId: string, ref: string) {
      const mine = options.journal.pending().find((intent) => {
        if (intent.type !== 'thread.turn.start' || intent.ref !== ref) return false;
        // The thread too, so a ref reused across threads — which nothing does today, and
        // which a future caller might — cannot match the wrong one.
        return (intent.command as { threadId?: unknown }).threadId === threadId;
      });
      if (!mine) return 'none';

      // MINE, and nothing else.
      //
      // The first version of this called `recoverPendingCommands`, which replays EVERY
      // pending intent in the workspace journal and marks them all dispatched. Since
      // round 6 submissions are concurrent across agents — the per-agent guard does not
      // serialise them and the tick does not await — so two lost acknowledgements in one
      // workspace is a state this code can produce. Draining the journal then marked the
      // SIBLING's intent dispatched while its mailbox row stayed held: on the next tick
      // its `recoverTurn` found nothing pending, `startTurn` minted a fresh id, and the
      // duplicate turn this whole path exists to prevent appeared one agent over. A
      // mid-loop throw was worse, because the intents replayed before it were already
      // marked dispatched.
      //
      // So this is `recoverPendingCommands`' per-intent body, scoped to one intent. The
      // split is the same and it is the load-bearing part: a REFUSAL is settled and is
      // journalled, an UNANSWERED replay stays pending so the next attempt can try again.
      try {
        await options.dispatcher.call(DISPATCH_METHOD, mine.command);
        options.journal.recordOutcome(mine.commandId, 'dispatched');
        return 'recovered';
      } catch (error) {
        if (isServerRefusal(error)) {
          options.journal.recordOutcome(mine.commandId, 'failed', (error as Error).message);
        }
        throw error;
      }
    },

    async startTurn(threadId, text, ref) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(unknownThread(threadId));
      const record = records.get(threadId);
      // Cheap when the subscription is already up, and what it guards is the COLD
      // case: a thread this process has adopted but never successfully subscribed to.
      //
      // It is deliberately NOT a guard against a stream that attached once and later
      // dropped, and an earlier version of this comment claimed it was. `isAttached`
      // is monotonic, so it could not be. The safety argument for a dropped stream is
      // a different one and it does not need a wait: every resubscription after the
      // first sends `afterSequence`, so events emitted during the drop are REPLAYED
      // rather than compacted into a snapshot. Only the first subscription can lose
      // history, which is exactly the case this waits for.
      //
      // This runs on Tower's mailbox drain, which awaits agents sequentially — so a
      // new await here is the thing `mailbox-wiring`'s "NOTHING HERE AWAITS A CONNECT"
      // comment warns about. It DOES lengthen that path's worst case, and an earlier
      // version of this comment claimed it did not: a thread whose subscription never
      // attaches now costs 30s here plus 30s on the `beginTurn` below, where it used to
      // cost 30s. Both bounds are `T3Client.requestTimeoutMs` on the same socket, and
      // doubling a bound that is already reached only when the server has stopped
      // answering is the price of not dispatching turns that cannot settle.
      await options.subscriptions?.ensure(threadId);
      const started = await thread.beginTurn(text, ref);
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
      // The thread's reason is gone, so the stream must go with it. Forgetting the
      // bookkeeping while the stream ran on is how a server keeps producing values
      // for nobody.
      options.subscriptions?.stop(threadId);
      return 'removed';
    },

    get(threadId) {
      return records.get(threadId);
    },

    /**
     * Route one subscription value to the thread it belongs to (issue #241).
     *
     * Routing on `aggregateId` rather than broadcasting: `DriverThread.observe`
     * appends to its own event log after filtering, so handing every thread every
     * value would be correct and would also make the retention cap meaningless work.
     *
     * A value for a thread this engine does not hold still reaches the TRACKER. That
     * is not tidiness — `lastSequence` is what `expectTurn` captures as a waiter's
     * `startSequence`, and a tracker that skipped events for an unadopted thread
     * would hand the next `attach` a start sequence below events it had already been
     * shown, which is exactly the condition under which a replayed refusal kills a
     * healthy turn.
     */
    observe(value: unknown) {
      const aggregateId = asThreadEvent(value)?.aggregateId;
      const thread = aggregateId === undefined ? undefined : threads.get(aggregateId);
      if (thread) thread.observe(value);
      else options.tracker.observe(value);
    },
  };
}
