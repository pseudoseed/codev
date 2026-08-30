/**
 * Persistent Codev identity -> t3code thread joins (Spec 146, Phase 5).
 *
 * Porch state remains authoritative.  This registry reports disagreement and
 * never repairs either side; Phase 8 is the first writer of these columns.
 */

import type Database from 'better-sqlite3';
import { recentByAgent, type RecentAgentMessage } from '../db/mailbox.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import type { AgentStateSignal, PorchStatusProjection, StatusReadResult } from './status-reader.js';

/**
 * What t3code says about one thread's session, kept STRUCTURED rather than
 * flattened to a word.
 *
 * It was one optional string, and that could not carry this phase's mapping:
 * t3code reports a session `status` (`idle | starting | running | ready |
 * interrupted | stopped | error`) and carries settledness SEPARATELY, on the
 * thread, as `settledAt` / `settledOverride`. A consumer deciding whether a row
 * is finished needs both — a `stopped` session on a settled thread finished,
 * and a `stopped` session on an unsettled one did not — and one string cannot
 * say both without inventing a vocabulary neither side speaks.
 *
 * `status` is t3code's own word, VERBATIM and unmapped. Translating here would
 * put the mapping in two places and would silently swallow a status a newer
 * server invented; the consumer maps, and says so when it meets a word it does
 * not know.
 */
export interface LiveThreadSession {
  /** t3code's `session.status`, unmapped. */
  readonly status: string;
  /** From the thread's `settledAt` / `settledOverride`, not from the session. */
  readonly settled: boolean;
  /** Present only when the session reported one. */
  readonly lastError?: string;
}

export interface LiveThread {
  readonly threadId: string;
  readonly session?: LiveThreadSession;
}

/**
 * What the provider can say about its own answer, beyond the status word.
 *
 * ON THE WIRE AS A SIBLING OF `t3code`, NOT FOLDED INTO IT. A cached snapshot
 * that cannot say how old it is reintroduces exactly the failure the STALE band
 * exists to prevent: "it had finished when I last looked" rendered as "it has
 * finished". `ageMs` is computed where the snapshot is built rather than by the
 * consumer, because the consumer's clock is a different clock.
 *
 * EVERY MEMBER IS OPTIONAL BECAUSE DIFFERENT STATUSES HAVE DIFFERENT THINGS TO
 * SAY, and the alternative was worse: `message` and `since` previously died at
 * this boundary, so `cooling-down` reached the client as a bare word with no
 * when and no why, and `misconfigured`'s explanation of what is half-written
 * reached it nowhere at all — an operator told only "your configuration is
 * incomplete" has to go and diff it themselves. A status with nothing to add
 * carries no observation, which is not the same as carrying an empty one.
 *
 * `observedAt` and `ageMs` travel together or not at all. Absence of `ageMs` is
 * an UNKNOWN age, and a consumer must not read that as a small one.
 */
export interface T3codeObservation {
  /** Present only when content was actually observed. */
  readonly observedAt?: string;
  /** Present only alongside `observedAt`. */
  readonly ageMs?: number;
  /** The provider's own words, for a status that has some. */
  readonly message?: string;
  /** `cooling-down` only: when the failure that started the timer happened. */
  readonly since?: string;
}

/**
 * Whether session state was observable, and if not, WHICH not.
 *
 * Eight statuses, and none of them is a taxonomy for its own sake — six are the
 * exact answers `requestThreadBackend` already computes, and collapsing any pair
 * spells two different operator remedies with one word.
 *
 * `connecting` and `cooling-down` are the pair most likely to be merged into
 * `unreachable` by someone tidying up, and they must not be: one resolves on its
 * own, the other will not until a timer passes. That is the difference between
 * "wait" and "go look at your server".
 *
 * `not-provided` is a host that wires no provider at all. It is NOT the same as
 * `not-configured`, which is a host that asked and found this workspace names no
 * t3code server.
 *
 * ## `unreachable` is RESERVED, not emitted by Tower's provider
 *
 * Stated here because a status a consumer is told to expect and no producer can
 * emit is worse than one that does not exist: it invites a branch nothing will
 * ever take, and a reader who sees it in the union assumes somebody sends it.
 *
 * `ThreadBackendAvailability` — what Tower's connector actually answers — has no
 * `unreachable` kind. A failed connect becomes `cooling-down`, which is strictly
 * MORE informative: it carries when the failure was, why, and that no retry
 * happens until a timer passes. A connect in flight is `connecting`. There is no
 * third state where Tower knows the server is unreachable and has nothing to add.
 *
 * It is kept rather than deleted, deliberately. Deleting it would fold
 * "unreachable" into "cooling-down" at the type level, and the next producer that
 * genuinely observes unreachability — a host watching a socket it did not open,
 * a future connector that reports a hard refusal separately from a backoff —
 * would have to reintroduce it or lie. `readThreadRegistry` signals
 * `T3CODE_UNREACHABLE` on it, and `agent-failure-matrix` carries that row.
 *
 * `spec-236-t3code-session-cache.test.ts` pins the set Tower's provider can
 * actually emit, so this paragraph cannot quietly stop being true.
 */
export type T3codeThreadSnapshot =
  | { readonly status: 'not-provided' }
  | { readonly status: 'not-configured' }
  | { readonly status: 'misconfigured'; readonly message: string }
  | { readonly status: 'connecting' }
  | { readonly status: 'cooling-down'; readonly message: string; readonly since: string }
  | { readonly status: 'unreachable'; readonly message: string }
  | {
      readonly status: 'available';
      readonly observedAt: string;
      readonly threads: readonly LiveThread[];
    }
  | {
      /**
       * Observed, but no longer being watched. The content is last-known and is
       * labelled as such; a consumer must not derive "finished" from it.
       */
      readonly status: 'stale';
      readonly observedAt: string;
      readonly ageMs: number;
      readonly threads: readonly LiveThread[];
    };

export interface ThreadIdentity {
  /**
   * How this row is driven today.
   *
   * The dual-write window is real: on 2026-08-29 every architect and builder row
   * in `global.db` was terminal-backed and none carried a `thread_id`. A registry
   * that publishes only thread-backed rows therefore reports a busy workspace as
   * EMPTY, which is the same words as "nothing is running here" for a completely
   * different situation. Terminal-backed rows are published and labelled instead.
   */
  readonly backing: 'thread' | 'terminal';
  /** Absent on a terminal-backed row, which has no t3code thread yet. */
  readonly threadId?: string;
  readonly role: 'architect' | 'builder' | 'unmanaged';
  readonly roleId?: string;
  readonly workspacePath: string;
  readonly worktree?: string;
  readonly management: 'managed' | 'unmanaged';
  readonly porch?: PorchStatusProjection;
  /**
   * Which architect spawned this builder, when `global.db` recorded one. The
   * client groups builders under their architect; without this the grouping
   * would be a guess, and a guessed parent is a wrong answer wearing a tree.
   */
  readonly spawnedByArchitect?: string;
  /**
   * The live t3code session, present ONLY when t3code was observed AND returned
   * one for this thread. Its absence is not "settled" — see `t3code` on the
   * snapshot for which of the two this is.
   *
   * Structured rather than a bare word because deciding whether a row is
   * finished needs the session's status AND the thread's settledness, and those
   * are two facts on two objects in t3code's own contract.
   */
  readonly session?: LiveThreadSession;
  /**
   * The last few messages addressed to this agent, newest first (Spec 146,
   * Phase 12). Absent when this agent has none.
   *
   * "Absent" is not "unknown": whether the log could be read AT ALL is
   * {@link ThreadRegistrySnapshot.messageLog}, exactly as `sessionState`'s
   * absence is disambiguated by `t3code`. A pane that renders an agent with no
   * messages the same way it renders an agent whose messages would not load is
   * reporting a fact it does not have.
   */
  readonly messages?: readonly RecentAgentMessage[];
}

export interface ThreadRegistrySnapshot {
  /**
   * Whether session state was observable at all when this snapshot was built.
   * A consumer that cannot see this cannot tell "t3code says every thread is
   * settled" from "t3code was never asked", and would render the second as the
   * first. Same word, two different situations.
   */
  readonly t3code: T3codeThreadSnapshot['status'];
  /**
   * When the reported content was observed, present on `available` and `stale`.
   *
   * A SIBLING FIELD RATHER THAN A PROMOTION OF `t3code` TO AN OBJECT, and the
   * reason is cross-version. A consumer that predates this field distinguishes
   * "older server" from "unreadable payload" by whether `t3code` is ABSENT, so
   * turning `t3code` into an object makes a NEWER consumer reject an OLDER
   * server's bare string as corrupt and blank the whole machine. A sibling
   * leaves that direction validating, carrying no observation, which reads as an
   * unknown age — and an unknown age is not freshness.
   */
  readonly t3codeObservation?: T3codeObservation;
  readonly architects: Readonly<Record<string, string>>;
  readonly builders: Readonly<Record<string, string>>;
  readonly identities: readonly ThreadIdentity[];
  readonly statuses: readonly PorchStatusProjection[];
  readonly signals: readonly AgentStateSignal[];
  /**
   * Whether the mailbox — the durable record of `afx send` traffic, and the only
   * source of per-agent messages — could be read when this snapshot was built.
   *
   * Same shape and same reason as {@link t3code}: a consumer that cannot see
   * this cannot tell "this agent has no messages" from "the message log would
   * not open", and would render the second as the first.
   */
  readonly messageLog: 'available' | 'unreadable';
}

interface ArchitectRow {
  readonly id: string;
  readonly pid: number;
  readonly port: number;
  readonly cmd: string;
  readonly terminal_id: string | null;
  readonly thread_id: string | null;
}

interface BuilderRow {
  readonly id: string;
  readonly worktree: string;
  readonly terminal_id: string | null;
  readonly thread_id: string | null;
  readonly spawned_by_architect: string | null;
}

/**
 * The live session state for a thread, or nothing.
 *
 * Nothing is returned when t3code was not consulted AND when it was consulted
 * and returned a thread carrying no state. Those are the same fact at this
 * layer — no state was observed for this thread — and the snapshot's `t3code`
 * field is what distinguishes "we could not ask" from "we asked".
 */
function sessionOf(
  live: Map<string, LiveThread> | null,
  threadId: string,
): { session?: LiveThreadSession } {
  const session = live?.get(threadId)?.session;
  return session === undefined ? {} : { session };
}

/**
 * The observation to publish for a snapshot, or nothing.
 *
 * `available` is fresh by construction — the provider only calls it that while
 * it is still watching — so its age is zero rather than absent. Publishing no
 * age there would make "fresh" and "age unknown" the same payload.
 *
 * The failure statuses publish their MESSAGE, and `cooling-down` also publishes
 * `since`. This function used to return `{}` for all of them, which meant the
 * provider computed a reason and the wire threw it away: the client could say
 * "this server is waiting before it retries" and never why, or for how long.
 * A status word with the detail stripped off is a diagnosis with the evidence
 * removed.
 */
function observationOf(t3code: T3codeThreadSnapshot): { t3codeObservation?: T3codeObservation } {
  switch (t3code.status) {
    case 'available':
      return { t3codeObservation: { observedAt: t3code.observedAt, ageMs: 0 } };
    case 'stale':
      return { t3codeObservation: { observedAt: t3code.observedAt, ageMs: t3code.ageMs } };
    case 'cooling-down':
      return { t3codeObservation: { message: t3code.message, since: t3code.since } };
    case 'unreachable':
    case 'misconfigured':
      return { t3codeObservation: { message: t3code.message } };
    default:
      // `not-provided`, `not-configured` and `connecting` have nothing to add
      // beyond the word itself. Carrying an empty object would say they did.
      return {};
  }
}

function dbSignal(error: unknown): AgentStateSignal {
  const code = (error as { code?: string }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return {
      code: 'GLOBAL_DB_LOCKED',
      message: 'global.db is locked; identity maps are temporarily unavailable',
    };
  }
  return {
    code: 'GLOBAL_DB_UNREADABLE',
    message: `global.db cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Resolve the porch record for a builder worktree.
 *
 * **"A worktree owns one project" was false, and it was load-bearing.** The previous
 * version returned a match only when exactly one `status.yaml` lived under the
 * worktree. Real worktrees carry the whole `codev/projects/` tree: counted
 * 2026-08-29, **302 project directories, 289 of them holding a `status.yaml`**, and
 * 303 directories on `main`. (An earlier version of this comment said "289 of them"
 * where the test said 302 — two real measurements of different things, written as
 * though they were one. Both numbers are stated now, with what each counts.)
 * So the join never resolved, every thread-backed builder was
 * reported `THREAD_UNMANAGED`, and `THREAD_ID_DISAGREEMENT` could not fire at all
 * because it sits behind a resolved record. The phase's own reconciliation criterion
 * was therefore unreachable in production while its tests passed on single-project
 * fixtures that shared the code's false premise.
 *
 * `thread_id` is the designed join and Phase 8 is its first writer, so it is tried
 * first and simply finds nothing until then. That is honest, and it is why the
 * ambiguous case must NOT be reported as "no porch record": one says nobody is
 * managing this thread, the other says several records could be and we will not
 * guess. Same word, two different situations, which is the failure this phase exists
 * to prevent.
 */
/**
 * The porch project ids a builder id could name, most specific first.
 *
 * **THE PROTOCOLS GENUINELY DIFFER, and no single parse covers both.** Verified by
 * reading real `status.yaml` files on 2026-08-29:
 *
 * | `builders.id`          | porch `id:`         | matched by      |
 * |------------------------|---------------------|-----------------|
 * | `builder-spir-146`     | `'146'`             | trailing digits |
 * | `builder-air-173`      | `'173'`             | trailing digits |
 * | `builder-bugfix-1137`  | `bugfix-1137`       | stripped id     |
 * | `builder-task-nhnj`    | `builder-task-nhnj` | **raw** id      |
 *
 * **All 12 real `builders.id` rows carry the `builder-` prefix**, so the strip is the
 * only path that resolves a normal builder — and the raw form must still be tried
 * FIRST, because `codev/projects/builder-task-nhnj-task-NHnJ` is named for the
 * prefixed id. Stripping first loses it.
 *
 * Every one of these four shapes was found by reading the two real stores. Three
 * earlier versions of this comment each asserted a rule that one of them refutes,
 * written as settled without opening the files. Two review lanes then each found a
 * shape the other missed — both had been sitting in `codev/projects` the whole time.
 * The test now generates its shape list from disk for that reason: a list you type is
 * a claim, one you read is a fact.
 *
 * **This association is deliberately independent of `thread_id`.** Matching on the
 * thread only resolves when the two stores AGREE, which makes disagreement between
 * them structurally undetectable — and reporting that disagreement is one of this
 * phase's acceptance criteria. Identity has to come from something that stays true
 * while the two stores differ.
 *
 * There is no `project_id` column to use instead; these conventions are the available
 * association, so they are parsed here in one place rather than assumed at call sites.
 */
function projectIdCandidates(builderId: string): { readonly exact: string[]; readonly digits?: string } {
  // THE STRIP IS LOAD-BEARING, NOT DEFENSIVE. All 12 rows in `builders.id` carry the
  // prefix — `builder-spir-146`, `builder-air-173` — and `row.id` is exactly what
  // this function receives, so the stripped form is the only path that resolves for
  // a normal builder. The earlier comment called it defensive without querying the
  // table.
  //
  // But the RAW id has to be tried first, because a project can legitimately be
  // named for the prefixed id: `codev/projects/builder-task-nhnj-task-NHnJ` has
  // `id: builder-task-nhnj`. Stripping first loses it.
  const bare = builderId.replace(/^builder-/, '');
  const exact = builderId === bare ? [bare] : [builderId, bare];

  // Task builders take their identity from the id itself, never from digits: their
  // suffix is a random short id (`task-nhnj`) that can be all-digits by chance, and
  // matching a project by it would be a coincidence rather than an association.
  if (/(^|-)task-/.test(bare)) return { exact };

  const digits = /-(\d+)$/.exec(bare);
  return digits ? { exact, digits: digits[1] } : { exact };
}

function statusForWorktree(
  successful: readonly PorchStatusProjection[],
  worktree: string,
  builderId: string,
  threadId: string,
): { readonly status?: PorchStatusProjection; readonly candidates: number } {
  const canonical = normalizeWorkspacePath(worktree);
  const matches = successful.filter((status) => normalizeWorkspacePath(status.artifactRoot) === canonical);

  // IDENTITY FIRST, because it survives the two stores disagreeing. Exact forms
  // before digits: raw id, then `builder-`-stripped, then the trailing digits.
  const { exact, digits } = projectIdCandidates(builderId);
  for (const projectId of exact) {
    const byProject = matches.filter((status) => status.projectId === projectId);
    if (byProject.length === 1) return { status: byProject[0], candidates: matches.length };
  }

  // DIGITS ONLY WHEN THEY CANNOT MEAN TWO THINGS.
  //
  // Project ids are not all unpadded: '0087', '0088', '0092', '0120' and '0124' all
  // exist, and `0120` (spir) coexists with `120` (air) right now. So a digit match
  // can name the wrong project across protocols — and it would do so with a RESOLVED
  // record, which is a confident wrong answer rather than an ambiguous one. That is
  // strictly worse than not resolving, exactly as a wrong diagnosis is worse than a
  // missing one.
  //
  // So a digit candidate is used only when no other record in this worktree is
  // numerically equal to it. A collision falls through to PORCH_JOIN_AMBIGUOUS,
  // which is the honest answer: we know it is one of these and not which.
  if (digits !== undefined) {
    // An EXACT textual match is the better evidence and is used when present —
    // otherwise the existence of `0120` would stop the legitimate `120` builder
    // resolving, trading a rare wrong answer for a common missing one.
    const exactDigits = matches.filter((status) => status.projectId === digits);
    if (exactDigits.length === 1) return { status: exactDigits[0], candidates: matches.length };

    // No exact match, but something numerically equal: that is a guess across the
    // padding boundary, and it would resolve WRONG rather than not at all. Refuse.
    const numerically = matches.filter(
      (status) => /^\d+$/.test(status.projectId) && Number(status.projectId) === Number(digits),
    );
    if (numerically.length === 1) {
      // KNOWN LIMIT, stated rather than silently accepted: if a builder id ever drops
      // a project's zero padding (`spir-120` for project `0120`), the exact branch
      // above resolves it to `120` instead, which is a confident wrong answer. No
      // such builder exists in the 12 real rows, so this is not designed around — but
      // it is the case to check first if a builder is ever seen joined to the wrong
      // project.
      return { candidates: matches.length };
    }
  }

  // Then the thread, for ids that do not carry a project (and once Phase 8 writes it).
  const byThread = matches.filter((status) => status.threadId === threadId);
  if (byThread.length === 1) return { status: byThread[0], candidates: matches.length };

  // The single-project case still resolves, for worktrees that really do hold one.
  if (matches.length === 1) return { status: matches[0], candidates: 1 };

  // Zero, or several with nothing to choose between them. No record is invented, and
  // the caller is told which of the two it is.
  return { candidates: matches.length };
}

/**
 * Build the complete join, including live threads unknown to porch/Codev.
 * Unknown live threads are explicit unmanaged rows, never filtered out.
 */
export function readThreadRegistry(
  db: Database.Database,
  workspacePath: string,
  statusResults: readonly StatusReadResult[],
  t3code: T3codeThreadSnapshot = { status: 'not-provided' },
): ThreadRegistrySnapshot {
  const workspace = normalizeWorkspacePath(workspacePath);
  const signals: AgentStateSignal[] = statusResults
    .filter((result): result is Extract<StatusReadResult, { ok: false }> => !result.ok)
    .map((result) => result.signal);
  const statuses = statusResults
    .filter((result): result is Extract<StatusReadResult, { ok: true }> => result.ok)
    .map((result) => result.status);

  let architects: ArchitectRow[];
  let builders: BuilderRow[];
  try {
    architects = db.prepare(`
      SELECT id, pid, port, cmd, terminal_id, thread_id
      FROM architect WHERE workspace_path = ? ORDER BY id
    `).all(workspace) as ArchitectRow[];
    builders = db.prepare(`
      SELECT id, worktree, terminal_id, thread_id, spawned_by_architect
      FROM builders WHERE workspace_path = ? ORDER BY id
    `).all(workspace) as BuilderRow[];
  } catch (error) {
    signals.push(dbSignal(error));
    return {
      t3code: t3code.status,
      ...observationOf(t3code),
      architects: {},
      builders: {},
      identities: [],
      statuses,
      signals,
      messageLog: 'unreadable',
    };
  }

  const architectMap: Record<string, string> = {};
  const builderMap: Record<string, string> = {};
  const identities: ThreadIdentity[] = [];
  const consumed = new Set<string>();
  // STALE CARRIES CONTENT TOO, and it has to.
  //
  // This attached only on `available`, so a stale snapshot published no per-row
  // session at all — and the stale rule downstream ("a row whose last-known
  // content would read as finished renders UNKNOWN with the age") had nothing to
  // act on. Withholding the content does not make the answer safer; it makes it
  // indistinguishable from "t3code returned no state for this thread", which is
  // a different fact. The snapshot's `t3code` field is what says the content is
  // last-known, and the consumer is what must not derive "finished" from it.
  const live = t3code.status === 'available' || t3code.status === 'stale'
    ? new Map(t3code.threads.map((thread) => [thread.threadId, thread]))
    : null;

  // `cooling-down` IS a form of unreachable and emits the same signal, carrying
  // its own message so the timer is visible. `misconfigured` and `not-configured`
  // deliberately emit NOTHING here: neither is a statement about reachability,
  // and borrowing T3CODE_UNREACHABLE for a workspace that simply names no server
  // would send an operator to check a server that does not exist. Both are
  // carried by the snapshot status itself and stated once at the machine.
  if (t3code.status === 'unreachable' || t3code.status === 'cooling-down') {
    signals.push({ code: 'T3CODE_UNREACHABLE', message: t3code.message });
  }

  for (const row of architects) {
    // `cmd` IS NOT TERMINAL-BACKED STATE. Issue #170.
    //
    // `terminal_id`, `pid` and `port` are genuinely PTY-specific, and null/0/0 are
    // honest sentinels for a thread-backed architect. `cmd` is not: it records how
    // the architect was launched, which is meaningful either way, it is NOT NULL in
    // the schema, and `status.ts` renders it. Phase 8 therefore writes `cmd` for
    // thread-backed architects — correctly — and this detector then reported every
    // one of them as IDENTITY_SHAPE_CONFLICT, forever.
    //
    // Two merged phases in direct contradiction, latent only because no factory is
    // registered yet. The detector moves rather than the writer, because the writer
    // is right about what `cmd` means.
    if (row.thread_id !== null && (
      row.terminal_id !== null || row.pid !== 0 || row.port !== 0
    )) {
      signals.push({
        code: 'IDENTITY_SHAPE_CONFLICT',
        message: `Architect ${row.id} carries both terminal-backed and thread-backed state`,
        role: 'architect',
        roleId: row.id,
        threadId: row.thread_id,
      });
      continue;
    }
    if (row.thread_id === null) {
      if (row.terminal_id !== null) {
        identities.push({
          backing: 'terminal',
          role: 'architect',
          roleId: row.id,
          workspacePath: workspace,
          management: 'unmanaged',
        });
      }
      continue;
    }
    architectMap[row.id] = row.thread_id;
    consumed.add(row.thread_id);
    identities.push({
      backing: 'thread',
      threadId: row.thread_id,
      role: 'architect',
      roleId: row.id,
      workspacePath: workspace,
      management: 'unmanaged',
      ...sessionOf(live, row.thread_id),
    });
    if (live && !live.has(row.thread_id)) {
      signals.push({
        code: 'PORCH_THREAD_NO_LONGER_EXISTS',
        message: `Architect ${row.id} maps to thread ${row.thread_id}, which t3code did not return`,
        threadId: row.thread_id,
        role: 'architect',
        roleId: row.id,
      });
    }
  }

  for (const row of builders) {
    if (row.thread_id !== null && row.terminal_id !== null) {
      signals.push({
        code: 'IDENTITY_SHAPE_CONFLICT',
        message: `Builder ${row.id} carries both terminal_id and thread_id`,
        role: 'builder',
        roleId: row.id,
        threadId: row.thread_id,
      });
      continue;
    }
    if (row.thread_id === null) {
      if (row.terminal_id !== null) {
        const terminalPorch = statusForWorktree(statuses, row.worktree, row.id, '').status;
        identities.push({
          backing: 'terminal',
          role: 'builder',
          roleId: row.id,
          workspacePath: workspace,
          worktree: row.worktree,
          management: terminalPorch ? 'managed' : 'unmanaged',
          ...(terminalPorch ? { porch: terminalPorch } : {}),
          ...(row.spawned_by_architect ? { spawnedByArchitect: row.spawned_by_architect } : {}),
        });
      }
      continue;
    }
    builderMap[row.id] = row.thread_id;
    consumed.add(row.thread_id);
    const resolved = statusForWorktree(statuses, row.worktree, row.id, row.thread_id);
    const porch = resolved.status;
    const management = porch ? 'managed' : 'unmanaged';
    identities.push({
      backing: 'thread',
      threadId: row.thread_id,
      role: 'builder',
      roleId: row.id,
      workspacePath: workspace,
      worktree: row.worktree,
      management,
      ...(porch ? { porch } : {}),
      ...(row.spawned_by_architect ? { spawnedByArchitect: row.spawned_by_architect } : {}),
      ...sessionOf(live, row.thread_id),
    });
    if (!porch && resolved.candidates > 1) {
      // NOT "unmanaged". Several porch records live under this worktree and none
      // names this thread, so which one manages it is unknown — which is a different
      // fact, with a different remedy, from nothing managing it at all. Phase 8
      // writing `thread_id` is what resolves this.
      signals.push({
        code: 'PORCH_JOIN_AMBIGUOUS',
        message:
          `Thread ${row.thread_id} has ${resolved.candidates} candidate porch records under ` +
          `${row.worktree} and none names it; the managing record is unknown, not absent`,
        threadId: row.thread_id,
        role: 'builder',
        roleId: row.id,
      });
    } else if (!porch) {
      signals.push({
        code: 'THREAD_UNMANAGED',
        message: `Thread ${row.thread_id} has no matching porch record`,
        threadId: row.thread_id,
        role: 'builder',
        roleId: row.id,
      });
    } else if (porch.threadId !== undefined && porch.threadId !== row.thread_id) {
      signals.push({
        code: 'THREAD_ID_DISAGREEMENT',
        message: `status.yaml names ${porch.threadId}, while global.db names ${row.thread_id}; porch remains authoritative`,
        source: porch.statusPath,
        projectId: porch.projectId,
        threadId: porch.threadId,
        role: 'builder',
        roleId: row.id,
      });
    }
    if (live && !live.has(row.thread_id)) {
      signals.push({
        code: 'PORCH_THREAD_NO_LONGER_EXISTS',
        message: `Builder ${row.id} maps to thread ${row.thread_id}, which t3code did not return`,
        source: porch?.statusPath,
        projectId: porch?.projectId,
        threadId: row.thread_id,
        role: 'builder',
        roleId: row.id,
      });
    }
  }

  // Phase 8 makes this normally redundant, but it is deliberately independent:
  // a porch record may survive after its DB row has been removed.
  for (const porch of statuses) {
    if (porch.threadId === undefined) continue;
    const matching = identities.find((identity) => identity.porch?.statusPath === porch.statusPath);
    if (!matching) {
      // "has no global.db identity row" WAS A FALSE DIAGNOSIS, not merely a vague
      // one. A row can exist and name a different thread, and telling an operator
      // the row is missing sends them to create one instead of reconciling two that
      // disagree. The message now states what is actually known — this record joined
      // to no identity — and leaves why to the signals that can tell.
      signals.push({
        code: live && !live.has(porch.threadId) ? 'PORCH_THREAD_NO_LONGER_EXISTS' : 'PORCH_RECORD_UNMAPPED',
        message: live && !live.has(porch.threadId)
          ? `Porch record ${porch.projectId} names thread ${porch.threadId}, which t3code did not return`
          : `Porch record ${porch.projectId} names thread ${porch.threadId} and joined to no identity; ` +
            `a global.db row may be absent, or may exist naming a different thread`,
        source: porch.statusPath,
        projectId: porch.projectId,
        threadId: porch.threadId,
      });
    }
  }

  if (live) {
    for (const thread of live.values()) {
      if (consumed.has(thread.threadId)) continue;
      identities.push({
        backing: 'thread',
        threadId: thread.threadId,
        role: 'unmanaged',
        workspacePath: workspace,
        management: 'unmanaged',
        ...(thread.session !== undefined ? { session: thread.session } : {}),
      });
      signals.push({
        code: 'THREAD_UNMANAGED',
        message: `Thread ${thread.threadId} has no matching porch record or Codev identity`,
        threadId: thread.threadId,
        role: 'unmanaged',
      });
    }
  }

  /*
   * Messages are attached in ONE PASS over the finished identities rather than at
   * each of the six `identities.push` sites, so a new identity kind cannot be
   * added later that silently carries none.
   *
   * A mailbox that will not read is a SIGNAL AND A FLAG, not an empty list. The
   * signal tells an operator what broke; the flag stops every pane rendering
   * "no messages" for an agent that may have several.
   */
  let messageLog: 'available' | 'unreadable' = 'available';
  let recent: Map<string, RecentAgentMessage[]>;
  try {
    recent = recentByAgent(db, workspace);
  } catch (error) {
    recent = new Map();
    messageLog = 'unreadable';
    signals.push({
      code: 'MESSAGE_LOG_UNREADABLE',
      message: `The mailbox could not be read, so no row can show its messages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  const withMessages = identities.map((identity) => {
    const forAgent = identity.roleId !== undefined ? recent.get(identity.roleId) : undefined;
    return forAgent && forAgent.length > 0 ? { ...identity, messages: forAgent } : identity;
  });

  return {
    t3code: t3code.status,
    ...observationOf(t3code),
    architects: architectMap,
    builders: builderMap,
    identities: withMessages,
    statuses,
    signals,
    messageLog,
  };
}
