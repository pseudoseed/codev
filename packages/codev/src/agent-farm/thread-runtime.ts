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
const canonicalKeys = new Map<string, string>();

export function canonicalWorkspaceKey(workspaceRoot: string): string {
  // CACHED, because this is on Tower's drain loop.
  //
  // `realpathSync` is a synchronous filesystem syscall, and this runs on every engine
  // lookup — once per agent per 1.5 s tick, inside the sequential loop that three rounds
  // of this issue went into clearing of blocking work. A network call and a blocking
  // syscall on that loop differ in magnitude, not in kind.
  //
  // Keyed on the RAW input, so two spellings of one workspace each resolve once and then
  // both hit. The trade is stated rather than hidden: a symlink repointed while Tower is
  // running keeps its old resolution for the life of the process. That is deliberate — a
  // workspace root moving underneath a running Tower is not a supported operation, and
  // re-resolving every tick to catch it costs every tick.
  const cached = canonicalKeys.get(workspaceRoot);
  if (cached !== undefined) return cached;

  const absolute = resolve(workspaceRoot).replace(/\/+$/, '') || '/';
  let key: string;
  try {
    key = realpathSync(absolute);
  } catch {
    key = absolute;
  }
  canonicalKeys.set(workspaceRoot, key);
  return key;
}

/**
 * Forget cached path resolutions.
 *
 * For a test that creates and removes temp directories — a path resolving differently
 * across two tests in one process is otherwise a stale hit. Not for production.
 */
export function clearCanonicalWorkspaceKeys(): void {
  canonicalKeys.clear();
}

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
export interface ThreadStreamer {
  /**
   * Call a streaming t3code method, invoking `onValue` per streamed value.
   * Resolves when the server ends the stream; rejects when the socket does.
   */
  stream(method: string, payload: unknown, onValue: (value: unknown) => void): Promise<unknown>;
}

const streamers = new Map<string, ThreadStreamer>();

export function setThreadStreamer(next: ThreadStreamer | undefined, workspaceRoot?: string): void {
  const key = workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot);
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
  return streamers.get(workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot));
}

export function setThreadEngine(next: ThreadEngine | undefined, workspaceRoot?: string): void {
  const key = workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot);
  if (next === undefined) engines.delete(key);
  else engines.set(key, next);
}

/** Every registered engine is dropped. For a test's teardown, not for production. */
export function clearThreadEngines(): void {
  engines.clear();
  streamers.clear();
  canonicalKeys.clear();
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
