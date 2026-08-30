/**
 * Mailbox repository (Spec 1313 — mailbox-first delivery).
 *
 * Pure, unit-testable data operations over the `mailbox` table. Every `afx send`
 * is persisted here *before* the send response returns, so nothing is lost to a
 * Tower crash, restart, or shutdown. This module is deliberately decoupled from
 * delivery: it never writes to a PTY and never runs the render-gate. The delivery
 * orchestration (Phase 4) wires against these proven operations.
 *
 * Design notes:
 * - Functions take an explicit `db` handle first (matching `db/consolidate.ts`),
 *   which keeps them trivially testable against any better-sqlite3 database.
 * - Timestamps are epoch-ms integers supplied by the caller (defaulting to
 *   `Date.now()`), so ordering and age math are deterministic and test-injectable.
 * - `workspace_path` is treated as an opaque addressing key: callers pass a
 *   canonical path (the send boundary canonicalizes in Phase 4), mirroring how
 *   `cron_tasks` scopes by workspace. This module does not canonicalize.
 * - The lifecycle state machine (`held → delivered | superseded | dismissed`) is
 *   enforced here: every transition targets only `held` rows, so a terminal row
 *   can never revert (no `delivered → held`) and `supersede` only replaces a row
 *   that is still `held`.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DbMailbox, MailboxReason } from './types.js';

/**
 * Fields a caller supplies to persist a new held row. The repository fills in the
 * id, `held` status, `escalated=0`, and the timestamps.
 */
export interface EnqueueInput {
  workspacePath: string;
  toAgent: string;
  /** Raw message body (never logged). */
  body: string;
  /** Exact bytes written to the PTY on delivery. */
  formattedMessage: string;
  /** Last-known PTY hint; the recipient is the agent, not this terminal. */
  terminalId?: string | null;
  fromAgent?: string | null;
  /**
   * The sender's IDENTITY, as distinct from its kind (#47).
   *
   * `fromAgent` records a builder id or the literal 'architect', so every
   * architect collapses to one string and a misroute cannot be attributed. This
   * carries the architect's actual name (or the builder id, so the column is
   * always populated with something answerable).
   */
  fromAgentName?: string | null;
  /**
   * What the caller typed as the target, before resolution (#47).
   *
   * `toAgent` holds the RESOLVED recipient, so `architect` and `architect:main`
   * are indistinguishable after the fact -- and those two forms are exactly what
   * the anti-spoofing rules treat differently.
   */
  requestedTo?: string | null;
  fromWorkspace?: string | null;
  /** Stage the text without submitting (no trailing Enter). */
  noEnter?: boolean;
  /** Initial why-held reason; null if it will be delivered immediately. */
  reason?: MailboxReason | null;
  /** Cron-only coalescing key; null for direct sends. */
  supersedeKey?: string | null;
  /**
   * Delayed-send due time in epoch-ms (Spec 1313 round 3 — `--delay`). null means
   * deliver-ASAP (every non-delayed send). A row is deliverable only once
   * `not_before IS NULL OR not_before <= now`; a delayed send persists this at REQUEST
   * time so the delay is durable across a Tower restart.
   */
  notBefore?: number | null;
}

const INSERT_SQL = `
  INSERT INTO mailbox (
    id, workspace_path, to_agent, terminal_id, from_agent, from_agent_name,
    requested_to, from_workspace,
    body, formatted_message, no_enter, status, reason, hold_detail, supersede_key,
    escalated, not_before, created_at, updated_at, resolved_at
  ) VALUES (
    @id, @workspace_path, @to_agent, @terminal_id, @from_agent, @from_agent_name,
    @requested_to, @from_workspace,
    @body, @formatted_message, @no_enter, @status, @reason, @hold_detail, @supersede_key,
    @escalated, @not_before, @created_at, @updated_at, @resolved_at
  )
`;

function buildRow(input: EnqueueInput, now: number): DbMailbox {
  return {
    id: randomUUID(),
    workspace_path: input.workspacePath,
    to_agent: input.toAgent,
    terminal_id: input.terminalId ?? null,
    from_agent: input.fromAgent ?? null,
    from_agent_name: input.fromAgentName ?? null,
    requested_to: input.requestedTo ?? null,
    hold_detail: null, // set by the gate when a delivery attempt holds (#21)
    from_workspace: input.fromWorkspace ?? null,
    body: input.body,
    formatted_message: input.formattedMessage,
    no_enter: input.noEnter ? 1 : 0,
    status: 'held',
    reason: input.reason ?? null,
    supersede_key: input.supersedeKey ?? null,
    escalated: 0,
    not_before: input.notBefore ?? null,
    created_at: now,
    updated_at: now,
    resolved_at: null,
  };
}

/**
 * Persist a new `held` row and return it. This is the persist-first step: the row
 * exists (and survives a crash) before any delivery is attempted.
 */
export function enqueue(db: Database.Database, input: EnqueueInput, now: number = Date.now()): DbMailbox {
  const row = buildRow(input, now);
  db.prepare(INSERT_SQL).run(row);
  return row;
}

/** Fetch a single row by id, or null if it does not exist. */
export function getById(db: Database.Database, id: string): DbMailbox | null {
  const row = db.prepare('SELECT * FROM mailbox WHERE id = ?').get(id) as DbMailbox | undefined;
  return row ?? null;
}

/**
 * List all currently-held rows, oldest first. Scoped to `workspacePath` when
 * provided, else workspace-wide (for `afx inbox`). `id` breaks created_at ties
 * for deterministic ordering.
 */
export function listHeld(db: Database.Database, workspacePath?: string): DbMailbox[] {
  if (workspacePath !== undefined) {
    return db
      .prepare(
        "SELECT * FROM mailbox WHERE workspace_path = ? AND status = 'held' ORDER BY created_at ASC, id ASC"
      )
      .all(workspacePath) as DbMailbox[];
  }
  return db
    .prepare("SELECT * FROM mailbox WHERE status = 'held' ORDER BY created_at ASC, id ASC")
    .all() as DbMailbox[];
}

/**
 * ELIGIBLE held rows addressed to a specific agent, in enqueue order (`created_at ASC`).
 * This is the per-agent drain order a delivery pass walks.
 *
 * Spec 1313 round 3 (`--delay`): a row is deliverable only when
 * `not_before IS NULL OR not_before <= now` — a pre-due delayed send is EXCLUDED here, so it
 * neither delivers early nor blocks a later normal message (the drainer picks `held[0]`, the
 * oldest ELIGIBLE row). It becomes eligible on the first pass at/after its due time. `now`
 * defaults to `Date.now()` and is injectable for deterministic tests.
 */
export function findHeldForAgent(
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  now: number = Date.now()
): DbMailbox[] {
  return db
    .prepare(
      "SELECT * FROM mailbox WHERE workspace_path = ? AND to_agent = ? AND status = 'held' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at ASC, id ASC"
    )
    .all(workspacePath, toAgent, now) as DbMailbox[];
}

/**
 * SQL for a held row's escalation-age START — the moment it became *deliverable-but-stuck*.
 * For a normal row that is `created_at` (born held then). For a delayed row (`not_before`
 * set) it is the DUE time, so a still-scheduled row's clock has not started (Spec 1313 round
 * 3: "measure escalation age from max(created_at, not_before)"). `not_before` is always ≥
 * `created_at` when set (due = created + delay), so MAX == COALESCE(not_before, created_at);
 * MAX is kept so a hand-written earlier not_before can never move the start before enqueue.
 */
const ESCALATION_START_SQL = 'MAX(created_at, COALESCE(not_before, created_at))';

/**
 * Held rows whose escalation age ({@link ESCALATION_START_SQL} → now) has crossed `maxAgeMs`
 * and that have NOT yet been escalated. Tower-global (every workspace) — the drainer's
 * escalation pass walks these once per tick to flip `escalated` and emit the visibility
 * broadcast. Bounded by the (small) held set, so a full scan is fine. Oldest effective-start
 * escalates first.
 *
 * Spec 1313 round 3: a PRE-DUE delayed row never escalates — its effective start is its
 * future `not_before`, which cannot be `< cutoff` (cutoff = now − maxAgeMs ≤ now), so the
 * age filter excludes it by construction. A delayed row escalates only after it has been
 * deliverable-but-stuck (past its due time) for the window.
 */
export function findEscalatable(
  db: Database.Database,
  maxAgeMs: number,
  now: number = Date.now()
): DbMailbox[] {
  const cutoff = now - maxAgeMs;
  return db
    .prepare(
      `SELECT * FROM mailbox WHERE status = 'held' AND escalated = 0 AND ${ESCALATION_START_SQL} < ? ORDER BY ${ESCALATION_START_SQL} ASC, id ASC`
    )
    .all(cutoff) as DbMailbox[];
}

/** Per-agent held tally within a workspace (drives the overview's live indicator). */
export interface HeldAgentCount {
  toAgent: string;
  count: number;
  /** True if any of this agent's held rows has crossed the escalation age. */
  escalated: boolean;
}

/** Workspace-level held summary: total, whether any row is escalated, and the per-agent split. */
export interface WorkspaceHeldSummary {
  total: number;
  escalated: boolean;
  byAgent: HeldAgentCount[];
}

/**
 * Count currently-held rows for a workspace, grouped by recipient agent, with an
 * escalation flag. Counts only — **no message bodies** are read or returned, so this is
 * safe to fold into the overview payload that the dashboard/VSCode indicator renders
 * (spec: the indicator is count-only; bodies live only in `afx inbox`). Aggregated in
 * SQL so cost is bounded by the (small) held set, not the row bodies.
 *
 * ELIGIBLE rows only (Spec 1313 round 3): a PRE-DUE delayed send (`not_before` in the
 * future) is "scheduled, not stuck" and must NOT inflate the attention count/indicator —
 * this is the same `not_before IS NULL OR not_before <= now` eligibility every other
 * count/alarm surface uses (`findHeldForAgent`, `findEscalatable`, `findStarvingAgents`),
 * so `afx status` / the dashboard badge report deliverable-but-stuck mail, not scheduled
 * sends. (Pre-due rows are still visible in `afx inbox`, which lists ALL held rows and
 * labels these "scheduled" — only the count/alarm surfaces exclude them.) The `escalated`
 * flag was already pre-due-safe (a pre-due row never escalates); this aligns the raw count.
 */
export function heldSummaryForWorkspace(
  db: Database.Database,
  workspacePath: string,
  now: number = Date.now()
): WorkspaceHeldSummary {
  const rows = db
    .prepare(
      "SELECT to_agent AS toAgent, COUNT(*) AS count, MAX(escalated) AS esc FROM mailbox WHERE workspace_path = ? AND status = 'held' AND (not_before IS NULL OR not_before <= ?) GROUP BY to_agent"
    )
    .all(workspacePath, now) as Array<{ toAgent: string; count: number; esc: number }>;
  let total = 0;
  let escalated = false;
  const byAgent: HeldAgentCount[] = rows.map((r) => {
    total += r.count;
    const rowEsc = r.esc === 1;
    if (rowEsc) escalated = true;
    return { toAgent: r.toAgent, count: r.count, escalated: rowEsc };
  });
  return { total, escalated, byAgent };
}

/**
 * Transition a held row to `delivered` (clearing its why-held reason and stamping
 * `resolved_at`). Returns true if it transitioned; false if the row was already
 * terminal or does not exist — so a re-delivery attempt (backstop racing a submit
 * trigger) is a safe no-op and can never revert or double-deliver a row.
 */
export function markDelivered(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'delivered', reason = NULL, updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'held'"
    )
    .run(now, now, id);
  return info.changes > 0;
}

/**
 * Refresh the why-held `reason` on a still-held row (informational — the value
 * `afx inbox` shows and the send response reports). Only touches `held` rows, so
 * it can never relabel or resurrect a terminal row. Returns true if a held row was
 * updated. The delivery pass calls this so a held row's reason tracks the current
 * gate verdict (e.g. `busy` → `no-live-pty` when the terminal dies).
 */
export function setHeldReason(
  db: Database.Database,
  id: string,
  reason: MailboxReason | null,
  now: number = Date.now(),
  detail: string | null = null,
): boolean {
  // #21: `reason` alone is 'busy' for every not-clean verdict, and the two that
  // matter most are opposite situations — an abandoned draft a human can clear,
  // and a live turn that must not be touched. The gate knows which; this is
  // where that knowledge stopped.
  const info = db
    .prepare("UPDATE mailbox SET reason = ?, hold_detail = ?, updated_at = ? WHERE id = ? AND status = 'held'")
    .run(reason, detail, now, id);
  return info.changes > 0;
}

/**
 * Flag a still-held row as escalated — **visibility only, NEVER affects delivery**. The
 * drainer's escalation pass calls this when a row crosses the escalation age, then emits
 * the escalation broadcast; the row still delivers only on a later clean gate pass.
 * Held-only and idempotent (the `escalated = 0` guard), so a terminal or already-escalated
 * row is untouched. Returns true if it flipped.
 */
export function markEscalated(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare("UPDATE mailbox SET escalated = 1, updated_at = ? WHERE id = ? AND status = 'held' AND escalated = 0")
    .run(now, id);
  return info.changes > 0;
}

/**
 * Supersede-key prefix for architect starvation notices (Spec 1313 round 3, change 3). A
 * notice row carries `${NOTICE_SUPERSEDE_PREFIX}<starving-agent>` so (a) one pending notice
 * per starving agent coalesces via {@link supersede}, and (b) notice rows are recognizable by
 * prefix and EXCLUDED from {@link findStarvingAgents} — a notice can never itself trigger a
 * notice ("no notice about a notice"). Cron uses bare task names as keys, which never collide
 * with this prefix.
 */
export const NOTICE_SUPERSEDE_PREFIX = 'mailbox-notice:';

/** Per-agent aggregate over an agent's ELIGIBLE, non-notice held rows (Spec 1313 round 3). */
export interface StarvingAgent {
  workspacePath: string;
  toAgent: string;
  /**
   * Escalation-start ({@link ESCALATION_START_SQL}) of the OLDEST eligible held row — the
   * moment this agent's oldest deliverable mail became stuck. Its age is `now - stuckSince`.
   */
  stuckSince: number;
  /** How many eligible non-notice rows are held for this agent. */
  count: number;
  /** Representative why-held reason (held rows for one agent share the gate's verdict). */
  reason: MailboxReason | null;
  /**
   * The gate detail behind that reason (#21) — 'user-text', 'busy-indicator', etc.
   *
   * Null on rows held before the migration. That is "not recorded", and the alarm
   * says so rather than guessing which remedy applies.
   */
  detail: string | null;
}

/**
 * Per-agent view of currently-STARVING mail (Spec 1313 round 3, change 3): agents with at
 * least one ELIGIBLE (`not_before IS NULL OR not_before <= now`) held row that is NOT itself a
 * notice ({@link NOTICE_SUPERSEDE_PREFIX}). Tower-global (every workspace), aggregated in SQL
 * so cost is bounded by the (small) held set. The drainer's notice pass compares each agent's
 * `stuckSince` against the owner-notice threshold to decide whether to alarm, and uses the
 * membership of the returned set to decide when a prior notice can be cleared (agent no longer
 * has any eligible non-notice held row → drained). PRE-DUE delayed rows are excluded (not
 * stuck), so a scheduled send never trips the alarm nor keeps one alive.
 */
export function findStarvingAgents(db: Database.Database, now: number = Date.now()): StarvingAgent[] {
  return db
    .prepare(
      `SELECT workspace_path AS workspacePath, to_agent AS toAgent,
              MIN(${ESCALATION_START_SQL}) AS stuckSince,
              COUNT(*) AS count,
              MAX(reason) AS reason,
              -- #21: the gate detail alongside the reason, so the alarm can name a
              -- remedy that works. MAX() like reason: every row for an agent was set
              -- by the same verdict on the same pass, so the aggregate is that value.
              MAX(hold_detail) AS detail
         FROM mailbox
        WHERE status = 'held'
          AND (not_before IS NULL OR not_before <= ?)
          AND (supersede_key IS NULL OR supersede_key NOT LIKE ?)
        GROUP BY workspace_path, to_agent`
    )
    .all(now, `${NOTICE_SUPERSEDE_PREFIX}%`) as StarvingAgent[];
}

/**
 * Dismiss every still-`held` row matching `(workspacePath, supersedeKey)` (Spec 1313 round 3).
 * Used to clear a pending architect notice once its starving agent recovers (the notice is
 * moot). Audit-preserving (soft transition), and a no-op on an already-delivered notice.
 * Returns the number of rows dismissed.
 */
export function dismissHeldWithKey(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string,
  now: number = Date.now()
): number {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    )
    .run(now, now, workspacePath, supersedeKey);
  return info.changes;
}

/**
 * Dismiss every still-`held` row addressed to an agent (Spec 1313 round 3, take-now B). Called
 * when an agent is cleaned up (`afx cleanup`) so its orphaned held rows stop pinning
 * `heldCount`/escalated forever — the terminal-row prune only removes delivered/superseded/
 * dismissed rows, never held ones. Audit-preserving. Returns the number of rows dismissed.
 */
export function dismissHeldForAgent(
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  now: number = Date.now()
): number {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND to_agent = ? AND status = 'held'"
    )
    .run(now, now, workspacePath, toAgent);
  return info.changes;
}

/**
 * Transition a held row to `dismissed`. Returns true if it transitioned; a dismissed row
 * is never delivered. The why-held reason is preserved for audit.
 *
 * **`dismissed` NOW MEANS TWO THINGS, and the row does not say which.**
 *
 * It was one: an operator cleared the row with `afx inbox dismiss`. Since #219 the
 * delivery path also calls this for a message it will never be able to deliver — today,
 * a `--no-enter` message to a thread-backed agent, which a thread cannot honour because
 * it has no composer. Both land here, and nothing on the row distinguishes a human's
 * decision from the system's refusal.
 *
 * The only thing that currently tells them apart is `refusedReasonFor` in
 * `tower-routes.ts` sniffing `no_enter === 1`, which works because there is exactly one
 * system refusal. **The next one added will mislabel itself**, and whoever adds it will
 * be reading this definition rather than that call site — which is why the warning is
 * here and not only there.
 *
 * Giving the two a distinguishable state is #226's migration, together with the
 * `MailboxReason` vocabulary. Until then: if you add a system refusal, add its case to
 * `refusedReasonFor` in the same change, or it will be reported as the `--no-enter` one.
 */
export function dismiss(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare(
      "UPDATE mailbox SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'held'"
    )
    .run(now, now, id);
  return info.changes > 0;
}

/**
 * Count currently-`held` rows sharing `(workspacePath, supersedeKey)`. Cron reads
 * this immediately before {@link supersede} — with no `await` between the two calls,
 * so on better-sqlite3's synchronous, single-threaded handle the pair cannot
 * interleave with another run — to log an honest outcome: a newer run that finds a
 * prior held row of the same task reports `superseded`, otherwise `held`. The
 * `(supersede_key)` index keeps this cheap.
 */
export function countHeldWithKey(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mailbox WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    )
    .get(workspacePath, supersedeKey) as { n: number };
  return row.n;
}

/**
 * Replace the held row sharing `(workspacePath, supersedeKey)` — if any — with a
 * fresh held row carrying the same key, atomically. Only `held` rows are
 * superseded (a delivered/dismissed row is untouched), so a newer cron run
 * collapses a stale backlog without disturbing history. When no held row matches,
 * this is just an enqueue. Returns the newly-enqueued replacement row.
 */
export function supersede(
  db: Database.Database,
  workspacePath: string,
  supersedeKey: string,
  input: EnqueueInput,
  now: number = Date.now()
): DbMailbox {
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE mailbox SET status = 'superseded', updated_at = ?, resolved_at = ? WHERE workspace_path = ? AND supersede_key = ? AND status = 'held'"
    ).run(now, now, workspacePath, supersedeKey);
    return enqueue(db, { ...input, workspacePath, supersedeKey }, now);
  });
  return run();
}

/**
 * Delete terminal rows (delivered/superseded/dismissed) whose `resolved_at` is
 * older than `retentionDays`. Held rows are never removed — the `status != 'held'`
 * and `resolved_at IS NOT NULL` guards make that impossible even if a held row
 * somehow carried a stale timestamp. Returns the number of rows deleted.
 */
export function pruneTerminal(
  db: Database.Database,
  retentionDays: number,
  now: number = Date.now()
): number {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const info = db
    .prepare(
      "DELETE FROM mailbox WHERE status != 'held' AND resolved_at IS NOT NULL AND resolved_at < ?"
    )
    .run(cutoff);
  return info.changes;
}

/**
 * The last N messages addressed to each agent in a workspace (Spec 146, Phase 12).
 *
 * Criterion 4 asks every builder pane to show "the last three agent messages" and
 * criterion 4b the architect's last one. Nothing on the agent wire carried
 * messages, and this table is the only durable record of them: `pruneTerminal`
 * keeps resolved rows for a retention window, so a delivered message is still
 * here after it reached its recipient.
 *
 * ONE QUERY, NOT ONE PER AGENT. The snapshot is rebuilt on every SSE tick, so a
 * per-identity query would multiply by the number of agents on every tick.
 *
 * BODIES ARE TRUNCATED AND THE CUT IS REPORTED. A body silently cut at the limit
 * reads as a complete short message, which misreports what was said. `truncated`
 * travels with the row so the surface rendering it can say so.
 *
 * This is the AGENT surface only. The v2/overview surface stays count-only —
 * `heldCount` and nothing else — because it is reached with Tower's shared key
 * rather than a per-machine credential.
 */
export interface RecentAgentMessage {
  readonly id: string;
  /** Sender identity when one was recorded: an architect name or a builder id. */
  readonly from: string;
  /** ISO-8601, from `created_at`. */
  readonly at: string;
  readonly body: string;
  /** Present and true only when `body` was cut. Never written as false. */
  readonly truncated?: true;
  /** Present and true only while the row is still held (never delivered). */
  readonly held?: true;
}

export const RECENT_MESSAGE_BODY_LIMIT = 240;

interface RecentRow {
  readonly to_agent: string;
  readonly id: string;
  readonly from_agent: string | null;
  readonly from_agent_name: string | null;
  readonly body: string;
  readonly status: string;
  readonly created_at: number;
}

/**
 * @throws whatever better-sqlite3 throws. The caller distinguishes "no messages"
 *   from "could not read the messages"; swallowing the error here would collapse
 *   those two into the same empty map.
 */
export function recentByAgent(
  db: Database.Database,
  workspacePath: string,
  perAgent = 3,
  bodyLimit: number = RECENT_MESSAGE_BODY_LIMIT,
): Map<string, RecentAgentMessage[]> {
  const rows = db.prepare(`
    SELECT to_agent, id, from_agent, from_agent_name, body, status, created_at FROM (
      SELECT to_agent, id, from_agent, from_agent_name, body, status, created_at,
             ROW_NUMBER() OVER (PARTITION BY to_agent ORDER BY created_at DESC, id DESC) AS rn
      FROM mailbox WHERE workspace_path = ?
    ) WHERE rn <= ?
    ORDER BY to_agent, created_at DESC, id DESC
  `).all(workspacePath, perAgent) as RecentRow[];

  const out = new Map<string, RecentAgentMessage[]>();
  for (const row of rows) {
    const cut = row.body.length > bodyLimit;
    const list = out.get(row.to_agent) ?? [];
    list.push({
      id: row.id,
      from: row.from_agent_name ?? row.from_agent ?? 'unknown',
      at: new Date(row.created_at).toISOString(),
      body: cut ? row.body.slice(0, bodyLimit) : row.body,
      ...(cut ? { truncated: true as const } : {}),
      ...(row.status === 'held' ? { held: true as const } : {}),
    });
    out.set(row.to_agent, list);
  }
  return out;
}
