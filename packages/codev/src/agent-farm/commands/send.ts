/**
 * Send command - send messages to agents via Tower POST /api/send endpoint.
 * Spec 0110: Messaging Infrastructure — Phase 4
 *
 * Delegates address resolution, message formatting, and terminal writing
 * to the Tower server. The CLI handles file reading, workspace detection,
 * and argument parsing.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { SendOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadState } from '../state.js';
import { getGlobalDbPath } from '../db/index.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { TowerClient } from '../lib/tower-client.js';

const MAX_FILE_SIZE = 48 * 1024; // 48KB limit per spec

/**
 * Detect workspace root from stable builder-session context, then CWD by
 * walking up to find .git or .codev/config.json. Builder worktrees are at
 * .builders/<id>/ which is inside the workspace root.
 *
 * Note: checks for .codev/config.json (not just .codev/) to avoid false
 * positives from ~/.codev/ which exists for global config.
 */
function lookupBuilderIdByThreadId(threadId: string): string {
  const dbPath = getGlobalDbPath();
  if (!existsSync(dbPath)) {
    throw new BuilderIdResolutionError(
      `Cannot resolve builder identity for thread '${threadId}': global.db not found at ${dbPath}.`,
    );
  }
  let gdb: Database.Database;
  try {
    gdb = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new BuilderIdResolutionError(
      describeStateDbOpenFailure(dbPath, threadId, err),
    );
  }
  try {
    const row = gdb.prepare('SELECT id, worktree FROM builders WHERE thread_id = ?').get(threadId) as
      | { id: string; worktree: string }
      | undefined;
    if (!row) {
      throw new BuilderIdResolutionError(
        `Cannot resolve builder identity for thread '${threadId}': no matching builder row in ${dbPath}.`,
      );
    }
    return row.id;
  } finally {
    gdb.close();
  }
}

export function detectWorkspaceRoot(): string | null {
  // Issue #47: builder identity belongs to the terminal session, not its
  // current directory. Prefer the launch-time worktree root while that stable
  // identity is present, so `cd` into the workspace (or elsewhere) cannot
  // silently change the sender into an architect.
  const sessionThreadId = process.env.CODEV_THREAD_ID?.trim();
  if (sessionThreadId) {
    const dbPath = getGlobalDbPath();
    if (existsSync(dbPath)) {
      try {
        const gdb = new Database(dbPath, { readonly: true });
        try {
          const row = gdb.prepare('SELECT worktree FROM builders WHERE thread_id = ?').get(sessionThreadId) as
            | { worktree: string }
            | undefined;
          if (row?.worktree) {
            const sessionMatch = row.worktree.replace(/\/+$/, '').match(/^(.+)\/\.builders\/[^/]+$/);
            if (sessionMatch) return sessionMatch[1];
          }
        } finally {
          gdb.close();
        }
      } catch {
        // Fall through to cwd detection; detectCurrentBuilderId throws if identity cannot be verified.
      }
    }
  }

  const sessionBuilderId = process.env.CODEV_BUILDER_ID?.trim();
  const sessionWorktree = process.env.CODEV_WORKTREE_ROOT?.trim().replace(/\/+$/, '');
  if (sessionBuilderId && sessionWorktree) {
    const sessionMatch = sessionWorktree.match(/^(.+)\/\.builders\/[^/]+$/);
    if (sessionMatch) return sessionMatch[1];
  }

  let dir = process.cwd();
  // If inside .builders/<id>/, the workspace root is the prefix before the
  // LAST `/.builders/`. Greedy `.+` (not lazy `.+?`) so a nested worktree path
  // like `<repo>/.builders/a/.builders/b` resolves the inner builder's
  // workspace, not the outer one — mirrors deriveWorkspaceFromWorktree's
  // lastIndexOf (Issue #1118 codex review). Nesting is an unsupported
  // anti-pattern, but the parse should be consistent with the rest of the code.
  const buildersMatch = dir.match(/^(.+)\/\.builders\/[^/]+/);
  if (buildersMatch) return buildersMatch[1];
  // Walk up looking for markers
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.codev', 'config.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Thrown when CWD is confirmed to be inside `.builders/<id>/` but the canonical
 * builder identity cannot be verified against `global.db`.
 *
 * We refuse to fall back to the bare worktree directory name (e.g. `bugfix-774`)
 * here: that non-canonical id does not match any `builders.id` (`builder-bugfix-774`),
 * so Tower's affinity resolver (`lookupBuilderSpawningArchitect` → undefined)
 * silently drops to the "non-builder sender → main first" branch — the builder's
 * `afx send architect` lands on `main` instead of its spawning architect.
 *
 * Per "fail fast, never implement fallbacks": a fatal environmental fault must
 * surface loudly, not be laundered into a subtle misroute (issue #1094).
 */
export class BuilderIdResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderIdResolutionError';
  }
}

/**
 * Build an actionable message for a `global.db` open failure, naming the likely
 * cause. A better-sqlite3 ABI mismatch (a `node` on PATH built for a different
 * NODE_MODULE_VERSION than codev's native module) is the real-world trigger
 * from issue #1094 and gets a specific reinstall hint.
 */
export function describeStateDbOpenFailure(dbPath: string, worktreeDirName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const abiMismatch = /NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(detail);
  const hint = abiMismatch
    ? "This is a better-sqlite3 native-module ABI mismatch: the 'node' on your PATH differs from the one codev was built for. Reinstall codev under your current node (e.g. `npm install -g @cluesmith/codev`)."
    : 'Check the file for corruption, a permissions problem, or a stale lock.';
  return (
    `Cannot resolve builder identity for worktree '${worktreeDirName}': ` +
    `failed to open global.db at ${dbPath} (${detail}). ${hint} ` +
    `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`
  );
}

/**
 * Detect the current builder ID from stable launch context or the worktree path.
 *
 * Issue #1118: builders live in the single shared `global.db`, scoped by
 * `workspace_path` (per-workspace `state.db` is retired). This resolves the
 * canonical builder ID by reading `global.db` (read-only), scoped to the
 * worktree's owning workspace — NOT the singleton `getDb()`. The miss must NOT
 * fall back to the bare worktree directory name (e.g. `bugfix-774`), because the
 * canonical ID is `builder-bugfix-774` and a non-canonical id misroutes affinity
 * routing downstream (issue #774, then issue #1094 for the silent-fallback class).
 *
 * Mirrors the workspace-scoped lookup used by `lookupBuilderSpawningArchitect`
 * in state.ts.
 *
 * Contract:
 *   - A complete `CODEV_BUILDER_ID` + `CODEV_WORKTREE_ROOT` pair wins over CWD
 *     and is verified against global.db, so builder identity survives `cd`.
 *   - Returns `null` when neither launch context nor CWD identifies a builder.
 *   - Returns the canonical builder ID when it can be verified against global.db.
 *   - **Throws `BuilderIdResolutionError`** when launch context or CWD identifies
 *     a builder worktree but the canonical ID cannot be verified (global.db
 *     missing, unopenable, or no matching row). Failing loud here is deliberate:
 *     returning a bare, unverified id silently misroutes to `main` (#1094).
 */
export function detectCurrentBuilderId(): string | null {
  const sessionThreadId = process.env.CODEV_THREAD_ID?.trim();
  if (sessionThreadId) {
    return lookupBuilderIdByThreadId(sessionThreadId);
  }

  const sessionBuilderId = process.env.CODEV_BUILDER_ID?.trim();
  const rawSessionWorktree = process.env.CODEV_WORKTREE_ROOT?.trim();
  if ((sessionBuilderId && !rawSessionWorktree) || (!sessionBuilderId && rawSessionWorktree)) {
    throw new BuilderIdResolutionError(
      'Cannot resolve builder identity: CODEV_BUILDER_ID and CODEV_WORKTREE_ROOT must both be set. ' +
        "Refusing to guess — an incomplete builder session identity could misroute 'afx send architect' (issue #47).",
    );
  }

  // The launch-time identity wins over cwd: a builder remains the same sender
  // after `cd`, including when cwd happens to be another worktree.
  const identityPath = rawSessionWorktree?.replace(/\/+$/, '') ?? process.cwd();
  // Builder worktrees are at .builders/<dir-name>/. Greedy `.+` (not lazy `.+?`)
  // so a nested worktree resolves the INNER builder (the LAST `/.builders/`).
  const match = identityPath.match(/^(.+)\/\.builders\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    if (sessionBuilderId) {
      throw new BuilderIdResolutionError(
        `Cannot resolve builder identity: CODEV_WORKTREE_ROOT '${rawSessionWorktree}' is not a builder worktree. ` +
          "Refusing to guess — an invalid builder session identity could misroute 'afx send architect' (issue #47).",
      );
    }
    return null;
  }

  const workspacePath = match[1];
  const worktreeDirName = match[2];

  // Issue #1118: builders live in the single shared global.db, scoped by
  // workspace_path (state.db is retired). Open global.db readonly and scope the
  // query to THIS workspace — so a same-id builder in another repo can't be
  // matched. From here on we are unambiguously in a builder worktree, so any
  // inability to resolve the canonical id is an ERROR condition, not a "this
  // isn't a builder" condition (issue #1094 anti-spoofing).
  const dbPath = getGlobalDbPath();
  if (!existsSync(dbPath)) {
    throw new BuilderIdResolutionError(
      `Cannot resolve builder identity for worktree '${worktreeDirName}': ` +
        `global.db not found at ${dbPath} (has Tower ever run?). ` +
        `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`,
    );
  }

  let gdb: Database.Database;
  try {
    gdb = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new BuilderIdResolutionError(describeStateDbOpenFailure(dbPath, worktreeDirName, err));
  }

  try {
    // Match by canonical worktree path first (most precise), then fall back
    // to a tail-segment match for legacy rows that recorded a different
    // absolute prefix. Scoped by workspace_path so only this workspace's
    // builders are considered.
    const ws = normalizeWorkspacePath(workspacePath);
    const canonicalWorktree = join(workspacePath, '.builders', worktreeDirName);
    const rows = gdb
      .prepare('SELECT id, worktree FROM builders WHERE workspace_path = ? AND worktree IS NOT NULL')
      .all(ws) as Array<{ id: string; worktree: string }>;

    const candidates = rows.filter(
      r => r.worktree === canonicalWorktree || r.worktree.split('/').pop() === worktreeDirName,
    );
    const verified = sessionBuilderId
      ? candidates.find(r => r.id === sessionBuilderId)
      : candidates[0];
    if (verified) return verified.id;

    throw new BuilderIdResolutionError(
      `Cannot resolve canonical builder id for worktree '${worktreeDirName}': ` +
        `no matching builder row in ${dbPath} for workspace ${ws} (the worktree may be stale or unregistered). ` +
        `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`,
    );
  } finally {
    gdb.close();
  }
}

/**
 * Thrown when `--worktree <path>` cannot be resolved to the builder that owns it.
 *
 * A miss must END the send. Issue #264's failure was a notification about a
 * project in one workspace arriving at a builder in another, and the reason it
 * arrived at all is that every hop had something plausible to fall back on. This
 * error exists so the last hop has nothing.
 */
export class RecipientResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientResolutionError';
  }
}

/** The workspace that owns a worktree, and the builder working in it. */
export interface RecipientWorktree {
  /** Canonical builder id, or null when no builder worktree is involved. */
  builderId: string | null;
  /** Normalized workspace path — the resolution scope for the address. */
  workspacePath: string;
}

/**
 * Resolve a worktree path to the workspace that owns it and the builder in it.
 *
 * This is `--worktree`'s whole point: the recipient and the workspace both come
 * from the PROJECT's location on disk, not from the sending process's session
 * environment or cwd. In issue #264 those two disagreed — a `porch approve` for a
 * project in a throwaway temp workspace ran in a process whose launch identity
 * belonged to a live builder elsewhere, and the notification followed the
 * process, not the project.
 *
 * A path with no `.builders/<dir>` segment is a workspace root: a project owned
 * by the main checkout rather than a builder. That resolves the workspace and
 * reports `builderId: null` — there is no builder to wake, and inventing one is
 * the bug.
 */
/**
 * The workspace that owns a worktree, from the path alone.
 *
 * Used when the caller already names its recipient and needs only the
 * resolution SCOPE pinned to the project — `notifyProtocolComplete` addresses
 * `architect`, and reading global.db to learn something the path already says
 * would let an orphaned worktree suppress the cleanup trigger.
 */
export function workspaceForWorktree(worktreePath: string): string {
  const trimmed = worktreePath.replace(/\/+$/, '');
  const match = trimmed.match(/^(.+)\/\.builders\/([^/]+)$/);
  return normalizeWorkspacePath(match ? match[1] : trimmed);
}

export function resolveRecipientWorktree(worktreePath: string): RecipientWorktree {
  const trimmed = worktreePath.replace(/\/+$/, '');
  const match = trimmed.match(/^(.+)\/\.builders\/([^/]+)$/);
  if (!match) {
    return { builderId: null, workspacePath: normalizeWorkspacePath(trimmed) };
  }

  const workspacePath = normalizeWorkspacePath(match[1]);
  const worktreeDirName = match[2];

  const dbPath = getGlobalDbPath();
  if (!existsSync(dbPath)) {
    throw new RecipientResolutionError(
      `Cannot resolve the builder owning worktree '${trimmed}': global.db not found at ${dbPath}.`,
    );
  }

  let gdb: Database.Database;
  try {
    gdb = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new RecipientResolutionError(describeStateDbOpenFailure(dbPath, worktreeDirName, err));
  }

  try {
    const rows = gdb
      .prepare('SELECT id, worktree FROM builders WHERE workspace_path = ? AND worktree IS NOT NULL')
      .all(workspacePath) as Array<{ id: string; worktree: string }>;
    // Scoped to this workspace, then matched on the full path or the worktree
    // directory name — which is unique within a workspace. Same shape as
    // detectCurrentBuilderId's lookup, and deliberately not a tail match on the
    // builder id.
    const owner = rows.find(
      r => normalizeWorkspacePath(r.worktree) === normalizeWorkspacePath(trimmed)
        || r.worktree.replace(/\/+$/, '').split('/').pop() === worktreeDirName,
    );
    if (owner) return { builderId: owner.id, workspacePath };

    throw new RecipientResolutionError(
      `No builder in workspace '${workspacePath}' owns worktree '${trimmed}' ` +
        `(registered: ${rows.length ? rows.map(r => r.id).join(', ') : '<none>'}). ` +
        `Refusing to guess a recipient — addressing a plausible neighbour is how a ` +
        `notification for one project reaches another (issue #264).`,
    );
  } finally {
    gdb.close();
  }
}

/**
 * Read file content for --file flag, with size validation.
 */
function readFileContent(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const fileBuffer = readFileSync(filePath);
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_SIZE} bytes / 48KB)`
    );
  }
  return fileBuffer.toString('utf-8');
}

/**
 * Read message from stdin
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Send a message to all builders via Tower API.
 */
interface SendToAllResults {
  delivered: string[];
  held: Array<{ id: string; reason?: string; mailboxId?: string }>;
  /** Spec 1307 `--delay`: accepted for later delivery, not sent now. */
  scheduled: string[];
  failed: string[];
}

async function sendToAll(
  client: TowerClient,
  message: string,
  workspace: string | undefined,
  from: string,
  options: SendOptions,
): Promise<SendToAllResults> {
  // Bugfix #826: loadState is workspace-scoped (for the architect read).
  // Builders are global per state.db; use the detected workspace root as
  // scope. `process.cwd()` is a safe fallback when detection fails — the
  // architect read returns [] and `--all` only uses `state.builders`.
  const state = loadState(detectWorkspaceRoot() ?? process.cwd());
  // Spec 1307 `--delay` + Spec 1313 mailbox: scheduled (delayed) and held
  // (persisted, awaiting a clean prompt) are tracked separately from delivered.
  // Reporting either as "Delivered" would claim a delivery that hasn't happened.
  const results: SendToAllResults = { delivered: [], held: [], scheduled: [], failed: [] };

  if (state.builders.length === 0) {
    logger.warn('No active builders found.');
    return results;
  }

  for (const builder of state.builders) {
    try {
      const result = await client.sendMessage(builder.id, message, {
        from,
        workspace,
        fromWorkspace: workspace,
        raw: options.raw,
        noEnter: options.noEnter,
        interrupt: options.interrupt,
        // Spec 1307: each target's delivery is scheduled independently.
        deliverAfter: options.delay,
      });
      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }
      // Distinct outcomes, kept distinct (Spec 1307 `--delay` + Spec 1313 mailbox):
      // a scheduled (delayed) or held (persisted, awaiting a clean prompt) message
      // has NOT been delivered now — classifying either as "delivered" would claim a
      // delivery that has not happened.
      if (result.scheduled) {
        results.scheduled.push(builder.id);
      } else if (result.refused) {
        // Checked BEFORE held and before the delivered fallthrough. A refusal reported
        // as held promises a retry that will never come; reported as neither, the
        // `else` below would call it delivered.
        logger.error(`Refused for ${builder.id}: ${result.refusedReason ?? 'no reason given'}`);
        results.failed.push(builder.id);
      } else if (result.held) {
        results.held.push({ id: builder.id, reason: result.reason, mailboxId: result.mailboxId });
      } else {
        results.delivered.push(builder.id);
      }
    } catch (error) {
      logger.error(`Failed to send to ${builder.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.failed.push(builder.id);
    }
  }

  return results;
}

/**
 * Main send command handler.
 *
 * Delegates to Tower's POST /api/send for address resolution, formatting,
 * and terminal writing. Supports [project:]agent addressing.
 */
export async function send(options: SendOptions): Promise<void> {
  // Determine the message
  let message = options.message;
  let target = options.builder;

  // When using --all, the first positional arg (builder) is actually the message.
  // `--worktree` names the recipient the same way, so it shifts the positionals
  // identically.
  if ((options.all || options.worktree) && target && !message) {
    message = target;
    target = undefined;
  }

  // Handle stdin input (message is "-")
  if (message === '-') {
    message = await readStdin();
  }

  // Validate inputs
  if (!message) {
    fatal('No message provided. Usage: afx send <builder> "message" or afx send --all "message"');
  }

  if (!options.all && !options.worktree && !target) {
    fatal('Must specify a builder ID or use --all flag. Usage: afx send <builder> "message"');
  }

  if (options.all && options.worktree) {
    fatal('Cannot use --all with --worktree: one addresses every builder, the other addresses exactly one.');
  }

  if (options.all && target) {
    fatal('Cannot use --all with a specific builder ID.');
  }

  // Append file content to message if --file specified
  if (options.file) {
    const fileContent = readFileContent(options.file);
    message = message + '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  logger.header('Sending Instruction');

  // Detect workspace for target resolution and sender provenance.
  //
  // Issue #264: these are two different questions and used to share one answer.
  // `fromWorkspace` is provenance — where the SENDER is — and belongs to the
  // session. The resolution scope belongs to the RECIPIENT, and when the caller
  // names the project's worktree it comes from there instead, so a notification
  // cannot follow the sending process into a workspace the project has nothing
  // to do with.
  const senderWorkspace = detectWorkspaceRoot() ?? undefined;
  let workspace = senderWorkspace;

  if (options.worktree && target) {
    // The recipient is already named; the worktree pins only the scope.
    workspace = workspaceForWorktree(options.worktree);
  } else if (options.worktree) {
    let recipient: RecipientWorktree;
    try {
      recipient = resolveRecipientWorktree(options.worktree);
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    }
    workspace = recipient!.workspacePath;
    if (!recipient!.builderId) {
      fatal(
        `--worktree '${options.worktree}' is not a builder worktree, so it names no recipient. ` +
          `Address the agent explicitly, or pass a '<workspace>/.builders/<id>' path.`,
      );
    }
    target = recipient!.builderId!;
  }

  // Detect sender identity (builder ID if in a worktree, otherwise 'architect').
  // In a confirmed builder worktree, detectCurrentBuilderId throws when the
  // canonical id can't be verified — abort loudly here rather than send an
  // unverified `from` that Tower would silently route to 'main' (issue #1094).
  let from: string;
  try {
    from = detectCurrentBuilderId() ?? 'architect';
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  // #47: `from` above is the sender's KIND — a builder id, or the literal
  // 'architect' for every architect alike. Six architects existed in one
  // database with no way to tell which had sent, which is what made a
  // 13-occurrence misroute report unfalsifiable: a builder that lost its
  // identity and got reclassified as 'architect' is byte-identical to an
  // architect that sent deliberately.
  //
  // CODEV_ARCHITECT_NAME is set per architect session at spawn, so it names the
  // sender when `from` cannot. Null when neither is available, which records
  // "not known" rather than guessing.
  const fromName = from !== 'architect' ? from : (process.env.CODEV_ARCHITECT_NAME || null);

  // Ensure Tower is running
  const client = new TowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    fatal('Tower is not running. Start it with: afx tower start');
  }

  if (options.all) {
    // Broadcast to all builders
    const results = await sendToAll(client, message, senderWorkspace, from, options);

    if (results.delivered.length > 0) {
      logger.success(`Delivered to ${results.delivered.length} builder(s): ${results.delivered.join(', ')}`);
    }
    if (results.held.length > 0) {
      const detail = results.held.map((h) => `${h.id} (${h.reason ?? 'pending'})`).join(', ');
      logger.info(
        `Held for ${results.held.length} builder(s): ${detail}. ` +
          `Each delivers automatically when its prompt is clear.`,
      );
    }
    if (results.scheduled.length > 0) {
      logger.success(
        `Scheduled for ${results.scheduled.length} builder(s) (+${options.delay}s): ${results.scheduled.join(', ')}`,
      );
      logger.info('Each is persisted and durable across a Tower restart; delivers onto a clear prompt when due. Inspect/cancel: afx inbox.');
    }
    if (results.failed.length > 0) {
      logger.error(`Failed for ${results.failed.length} builder(s): ${results.failed.join(', ')}`);
    }
  } else {
    // Send to specific target (architect, builder, or cross-project address)
    try {
      const result = await client.sendMessage(target!, message, {
        from,
        fromName: fromName ?? undefined,
        workspace,
        fromWorkspace: senderWorkspace,
        raw: options.raw,
        noEnter: options.noEnter,
        interrupt: options.interrupt,
        deliverAfter: options.delay,
        exact: options.exact,
      });

      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }

      // Report the real first outcome (Spec 1307 `--delay` + Spec 1313 mailbox). A
      // scheduled message is deferred to a future time; a held message is persisted
      // in the mailbox and delivers automatically once the target's prompt is clear
      // (empty and render-verified) — neither is a failure, and neither has been
      // delivered yet.
      if (result.scheduled) {
        logger.success(
          `Message scheduled for ${result.resolvedTo ?? target} (+${options.delay}s)` +
            `${result.mailboxId ? ` — mailbox id ${result.mailboxId}` : ''}`,
        );
        logger.info('Persisted and durable across a Tower restart; delivers onto a clear prompt when due. Inspect/cancel: afx inbox.');
      } else if (result.refused) {
        // Before `held` and before the delivered fallthrough. `held` promises "it
        // delivers automatically when the prompt is clear", which is false here, and the
        // final `else` would print "Message delivered" for a message that never will be.
        fatal(
          `Message REFUSED for ${result.resolvedTo ?? target}: ${result.refusedReason ?? 'no reason given'}` +
            `${result.mailboxId ? ` (mailbox id ${result.mailboxId})` : ''}`,
        );
      } else if (result.held) {
        logger.info(
          `Message held for ${result.resolvedTo ?? target} (${result.reason ?? 'pending'})` +
            `${result.mailboxId ? ` — mailbox id ${result.mailboxId}` : ''}. ` +
            `It delivers automatically when the prompt is clear.`,
        );
      } else {
        // Issue #196: name the keystrokes that actually went out. `--interrupt`'s bytes are
        // per-harness (Ctrl+C on claude/codex and shells, ESC then Ctrl+U on opencode), and
        // the complaint behind that issue was that nothing told the operator which one they
        // got — they found out by losing a session.
        const keys = result.interruptKeys?.length
          ? ` (sent ${result.interruptKeys.join(' then ')} first)`
          : '';
        logger.success(`Message delivered to ${result.resolvedTo ?? target}${keys}`);
      }
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  }
}
