import {
  clearSpawnThreadFactories,
  setSpawnThreadFactory,
  type SpawnThreadFactory,
} from './db/thread-identity.js';
import { clearCanonicalWorkspaceKeys, workspaceMapKey } from './workspace-key.js';
import { getArchitectByName, getBuilder } from './state.js';

// Re-exported because this module was where they lived until issue #227 item 1 keyed the
// spawn factory too, and a factory in `db/thread-identity.ts` reaching back up here for
// the key helper would be an import cycle. The definition moved down; the name did not.
export { canonicalWorkspaceKey, clearCanonicalWorkspaceKeys } from './workspace-key.js';

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

/**
 * What a `create` or `attach` that names no harness or model will actually use.
 *
 * WHY AN ENGINE HAS TO SAY THIS OUT LOUD (issue #227 item 3). An architect's thread is
 * created with neither, so the engine resolves both from the workspace's configuration
 * plus its own final fallback. Those are the values that must be written to the architect
 * row, because attaching later re-resolves them from configuration as it stands THEN —
 * and a `threads.model` edited between a spawn and a delivery would silently move an
 * existing thread onto a different model.
 *
 * Recomputing the resolution at the call site instead would put the fallback in two
 * places, which is how the two answers start to differ.
 */
export interface ThreadEngineDefaults {
  /** Never undefined: the engine has a final fallback, and this is it, resolved. */
  readonly harness: string;
  /** Undefined when nothing names one and the server chooses. */
  readonly model?: string;
}

export interface ThreadEngine {
  /**
   * Optional because an engine need not resolve defaults it can name — the in-memory one
   * ignores harness and model entirely, and saying `codex` there would be a claim it does
   * not honour. A caller reads `undefined` as "not recorded", the same as a NULL column.
   */
  readonly defaults?: ThreadEngineDefaults;
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
  /**
   * `ref` is the caller's identity for this turn — the mailbox row id — journalled with
   * the intent so `recoverTurn` can find exactly this attempt after a restart.
   */
  startTurn(threadId: string, text: string, ref?: string): Promise<void>;
  /**
   * Replay an unanswered turn for this thread under ITS ORIGINAL command id, instead of
   * issuing a new one.
   *
   * WHY A RETRY CANNOT JUST RE-SUBMIT.
   *
   * `dispatchCommand` deliberately leaves an UNANSWERED command pending: a dead socket or
   * a timed-out request does not say whether the server applied it, and recording that as
   * failed would spell "I could not tell" exactly like "no". So a turn whose
   * acknowledgement was lost is still, as far as anyone knows, running.
   *
   * A caller that then submits the same message again gets a FRESH `commandId`
   * (`startTurn` mints one per call), and t3code — which collapses duplicates by
   * `commandId` — sees two different commands and runs the turn TWICE. For a builder that
   * is two PRs, or the same destructive instruction carried out twice.
   *
   * Replaying under the original id is what makes it safe: the server returns the
   * original receipt if it already applied it, and applies it once if it did not.
   *
   * Matched on the caller's `ref`, because the journal on disk is the only record of the
   * attempt that survives a Tower restart — an in-process map does not.
   *
   * NOT on the message text, which is what this replaced. Two identical messages to one
   * agent are ordinary — a retried instruction, a repeated nudge, any templated notice —
   * and text matching let a STALE intent answer for the current message, reporting it
   * delivered when it had never been submitted. That trade goes the wrong way: a
   * duplicate turn is visible and recoverable, a false "delivered" is neither.
   *
   * Three answers, and `none` is not `recovered`: `none` means there is nothing pending
   * for this ref, so a fresh submit is safe. A caller must not read it as "the replay
   * failed".
   */
  recoverTurn(threadId: string, ref: string): Promise<'recovered' | 'none'>;
  interrupt(threadId: string): Promise<{ activeTurnId: null }>;
  worktreePath(threadId: string): string | undefined;
  removeWorktree(threadId: string, opts?: { force?: boolean }): Promise<'removed' | 'refused-unmerged'>;
  get(threadId: string): ThreadRecord | undefined;
  /**
   * Feed one subscription value (issue #241).
   *
   * This is the entry point that did not exist. `TurnTracker` resolves a turn's
   * `running` and `settled` from observed `thread.session-set` events and nothing
   * else, so with no caller here every turn stayed permanently active, `runTurn`
   * never returned, and `SessionStartFailedError` could not reach anyone.
   *
   * MUST be idempotent: the cursor advances after the handler by design, so
   * at-least-once delivery is the contract and every replay crosses this line.
   */
  observe(value: unknown): void;
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
 * The streaming half of a workspace's t3code connection.
 *
 * WHY THIS IS SEPARATE FROM `ThreadEngine`. The engine is a command surface —
 * create a thread, start a turn, interrupt one. Observing a thread is a
 * *subscription*, it belongs to a reader that never issues a command, and giving
 * the engine a `subscribe` would let any holder of a command surface open
 * streams. This is the read side, registered from the same socket.
 *
 * ONE SOCKET, NOT TWO. The obvious alternative — let the observer open its own
 * connection — is wrong here for a concrete reason: opening one costs a bootstrap
 * token exchange, and a pairing-issued token is ONE-TIME (`thread-backend.ts`
 * says so at the `token-refused` message). A second connection would spend the
 * credential the first one needs.
 */
/**
 * One open stream, and the means to stop it.
 *
 * `cancel` IS NOT OPTIONAL POLITENESS. A subscription whose reason has gone —
 * its thread left `global.db`, its workspace stopped being configured — used to
 * be forgotten from the cache while the stream itself ran on: the server kept
 * producing values for nobody, an orphaned stream and its replacement could both
 * write a recreated entry, and each cycle left another pending request behind.
 * Forgetting bookkeeping is not stopping work.
 */
export interface ThreadStream {
  /** Resolves when the server ends the stream; rejects when the socket does. */
  readonly done: Promise<unknown>;
  /** Interrupt it server-side and stop delivering values. Idempotent. */
  cancel(): void;
}

export interface ThreadStreamer {
  /** Call a streaming t3code method, invoking `onValue` per streamed value. */
  stream(method: string, payload: unknown, onValue: (value: unknown) => void): ThreadStream;
}

const streamers = new Map<string, ThreadStreamer>();

export function setThreadStreamer(next: ThreadStreamer | undefined, workspaceRoot?: string): void {
  const key = workspaceMapKey(workspaceRoot);
  if (next === undefined) streamers.delete(key);
  else streamers.set(key, next);
}

/**
 * The streamer for a workspace, or nothing.
 *
 * Deliberately has no throwing counterpart. A caller that cannot observe a
 * workspace reports that it could not, rather than failing — the whole point of
 * the status vocabulary this feeds is that "not watching" is an answer.
 */
export function tryGetThreadStreamer(workspaceRoot?: string): ThreadStreamer | undefined {
  return streamers.get(workspaceMapKey(workspaceRoot));
}

export function setThreadEngine(next: ThreadEngine | undefined, workspaceRoot?: string): void {
  const key = workspaceMapKey(workspaceRoot);
  if (next === undefined) engines.delete(key);
  else engines.set(key, next);
}

/** Every registered engine is dropped. For a test's teardown, not for production. */
export function clearThreadEngines(): void {
  engines.clear();
  streamers.clear();
  // The factory map is keyed by the same workspace and installed alongside the engine, so
  // leaving it behind would let one test's factory answer `chooseSpawnPath` in the next.
  clearSpawnThreadFactories();
  clearCanonicalWorkspaceKeys();
}

export function tryGetThreadEngine(workspaceRoot?: string): ThreadEngine | undefined {
  return engines.get(workspaceMapKey(workspaceRoot));
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
    // No journal, so nothing is ever ambiguous here: this engine's turns settle in
    // memory. `none` is the truthful answer, not a stub.
    async recoverTurn() {
      return 'none';
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
    /**
     * A no-op, and it must stay one.
     *
     * This engine's turns settle in memory the instant they are asked to — there is
     * no server, no tracker and no event stream, so there is nothing a stream value
     * could tell it that it does not already assert. Folding observed events into
     * these records would make the memory engine agree with a real one by imitation,
     * and #221's first finding is exactly that: the in-memory engine records what it
     * is handed and validates nothing, which is why in-memory tests could not see
     * that production had no subscriber at all.
     */
    observe() {},
  };
}

/**
 * The factory closes over the workspace it was installed for.
 *
 * `SpawnThreadFactory`'s input carries a worktree, not a workspace root, and a
 * builder's worktree is under `.builders/` rather than being the workspace — so the
 * root cannot be recovered from it. The installer knows it; the factory remembers it.
 *
 * `workspaceRoot` is REQUIRED and `undefined` must be written out, for the reason
 * `setSpawnThreadFactory` gives: an installer that forgets it fills the unkeyed slot, and
 * every keyed `chooseSpawnPath` then answers `pty` without saying why.
 */
export function installThreadSpawnFactory(workspaceRoot: string | undefined): void {
  // Registered UNDER that workspace as well as closed over it. The closure always
  // dispatched to the right engine; what was global was the module-level slot it sat in,
  // so the last workspace to install one decided whether every other workspace's
  // `chooseSpawnPath` said `thread` (issue #227 item 1).
  setSpawnThreadFactory(async (input) => getThreadEngine(workspaceRoot).create(input), workspaceRoot);
}

/**
 * Deliver one message as a turn, replaying an unanswered attempt rather than repeating it.
 *
 * The recovery check comes FIRST and it is the whole point. A previous attempt whose
 * acknowledgement was lost is still pending in the journal; submitting again would mint a
 * new `commandId` and t3code, which collapses by `commandId`, would run the turn twice.
 *
 * `recovered` means the original intent was re-dispatched under its original id and the
 * server has it exactly once. Nothing further is sent.
 */
export async function deliverThreadTurn(
  threadId: string,
  text: string,
  workspaceRoot?: string,
  ref?: string,
): Promise<'delivered' | 'recovered'> {
  const engine = getThreadEngine(workspaceRoot);
  // Without a ref there is nothing to recognise a previous attempt BY, so recovery is
  // not attempted rather than attempted on something weaker. A caller that can retry
  // must pass one; one that cannot (a one-shot CLI send) has nothing to recover.
  if (ref !== undefined && (await engine.recoverTurn(threadId, ref)) === 'recovered') {
    return 'recovered';
  }
  await engine.startTurn(threadId, text, ref);
  return 'delivered';
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

/**
 * The pair an architect thread created right now would run under.
 *
 * Read from the engine rather than recomputed, so the value written to the architect row
 * is the one `create` will use rather than a second opinion about it (issue #227 item 3).
 */
export function architectThreadDefaults(workspaceRoot: string): ThreadEngineDefaults | undefined {
  return tryGetThreadEngine(workspaceRoot)?.defaults;
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
