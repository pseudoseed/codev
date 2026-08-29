/**
 * Persistent Codev identity -> t3code thread joins (Spec 146, Phase 5).
 *
 * Porch state remains authoritative.  This registry reports disagreement and
 * never repairs either side; Phase 8 is the first writer of these columns.
 */

import type Database from 'better-sqlite3';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import type { AgentStateSignal, PorchStatusProjection, StatusReadResult } from './status-reader.js';

export interface LiveThread {
  readonly threadId: string;
  readonly state?: string;
}

export type T3codeThreadSnapshot =
  | { readonly status: 'not-provided' }
  | { readonly status: 'unreachable'; readonly message: string }
  | { readonly status: 'available'; readonly threads: readonly LiveThread[] };

export interface ThreadIdentity {
  readonly threadId: string;
  readonly role: 'architect' | 'builder' | 'unmanaged';
  readonly roleId?: string;
  readonly workspacePath: string;
  readonly worktree?: string;
  readonly management: 'managed' | 'unmanaged';
  readonly porch?: PorchStatusProjection;
}

export interface ThreadRegistrySnapshot {
  readonly architects: Readonly<Record<string, string>>;
  readonly builders: Readonly<Record<string, string>>;
  readonly identities: readonly ThreadIdentity[];
  readonly statuses: readonly PorchStatusProjection[];
  readonly signals: readonly AgentStateSignal[];
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
 * worktree. Real worktrees carry the whole `codev/projects/` tree — 289 of them in
 * this repository — so the join never resolved, every thread-backed builder was
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
function statusForWorktree(
  successful: readonly PorchStatusProjection[],
  worktree: string,
  threadId: string,
): { readonly status?: PorchStatusProjection; readonly candidates: number } {
  const canonical = normalizeWorkspacePath(worktree);
  const matches = successful.filter((status) => normalizeWorkspacePath(status.artifactRoot) === canonical);

  // THE DESIGNED JOIN. Unambiguous whatever else the worktree contains.
  const byThread = matches.filter((status) => status.threadId === threadId);
  if (byThread.length === 1) return { status: byThread[0], candidates: matches.length };

  // The single-project case still resolves, for worktrees that really do hold one.
  if (matches.length === 1) return { status: matches[0], candidates: 1 };

  // Zero, or several with no `thread_id` to choose between them. No record is
  // invented, and the caller is told which of the two it is.
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
      SELECT id, worktree, terminal_id, thread_id
      FROM builders WHERE workspace_path = ? ORDER BY id
    `).all(workspace) as BuilderRow[];
  } catch (error) {
    signals.push(dbSignal(error));
    return { architects: {}, builders: {}, identities: [], statuses, signals };
  }

  const architectMap: Record<string, string> = {};
  const builderMap: Record<string, string> = {};
  const identities: ThreadIdentity[] = [];
  const consumed = new Set<string>();
  const live = t3code.status === 'available'
    ? new Map(t3code.threads.map((thread) => [thread.threadId, thread]))
    : null;

  if (t3code.status === 'unreachable') {
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
    if (row.thread_id === null) continue;
    architectMap[row.id] = row.thread_id;
    consumed.add(row.thread_id);
    identities.push({
      threadId: row.thread_id,
      role: 'architect',
      roleId: row.id,
      workspacePath: workspace,
      management: 'unmanaged',
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
    if (row.thread_id === null) continue;
    builderMap[row.id] = row.thread_id;
    consumed.add(row.thread_id);
    const resolved = statusForWorktree(statuses, row.worktree, row.thread_id);
    const porch = resolved.status;
    const management = porch ? 'managed' : 'unmanaged';
    identities.push({
      threadId: row.thread_id,
      role: 'builder',
      roleId: row.id,
      workspacePath: workspace,
      worktree: row.worktree,
      management,
      ...(porch ? { porch } : {}),
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
      signals.push({
        code: live && !live.has(porch.threadId) ? 'PORCH_THREAD_NO_LONGER_EXISTS' : 'PORCH_RECORD_UNMAPPED',
        message: live && !live.has(porch.threadId)
          ? `Porch record ${porch.projectId} names thread ${porch.threadId}, which t3code did not return`
          : `Porch record ${porch.projectId} names thread ${porch.threadId} but has no global.db identity row`,
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
        threadId: thread.threadId,
        role: 'unmanaged',
        workspacePath: workspace,
        management: 'unmanaged',
      });
      signals.push({
        code: 'THREAD_UNMANAGED',
        message: `Thread ${thread.threadId} has no matching porch record or Codev identity`,
        threadId: thread.threadId,
        role: 'unmanaged',
      });
    }
  }

  return { architects: architectMap, builders: builderMap, identities, statuses, signals };
}
