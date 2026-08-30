/**
 * Live-Tower wiring for mailbox delivery (Spec 1313, Phase 4).
 *
 * `mailbox-delivery.ts` holds the PURE orchestration (persist → gate → deliver |
 * hold) behind the {@link DeliveryPorts} seam. This module binds those ports to
 * the real Tower — the live terminal registry, the render-gate, paced PTY writes,
 * and the WebSocket message bus — and owns the backstop drainer's lifecycle,
 * which replaces the retired in-memory `SendBuffer`.
 *
 * Keeping the wiring here (not in the pure module) is what lets the orchestration
 * be unit-tested without a live Tower, and lets `handleSend` and the drainer share
 * exactly one delivery path (and one per-agent write serializer).
 */

import { homedir } from 'node:os';
import { loadConfig } from '../../lib/config.js';
import { terminalDeliverySignals, type PtySession } from '../../terminal/pty-session.js';
import { getWorkspaceTerminals, getTerminalManager } from './tower-terminals.js';
import { broadcastMessage, resolveAgentInRegistry, isResolveError } from './tower-messages.js';
import { writeMessagePaced } from './message-write.js';
import { classifyBuffer, type GateProfile, type GateVerdict } from './render-gate.js';
import { resolveProfile } from './gate-profiles.js';
import {
  clearDraftKeyForHarness,
  detectHarnessFromCommand,
  interruptSignalForHarness,
  isShellCommand,
  CLEAR_DRAFT_BYTES,
  INTERRUPT_BYTES,
  SHELL_TARGET,
  type ClearDraftKey,
} from '../utils/harness.js';
import {
  buildContextFsPort,
  harnessFromLaunchScript,
  type ContextFsPort,
} from '../commands/reset/context.js';
import { getGlobalDb } from '../db/index.js';
import { getArchitectByName, getBuilder } from '../state.js';
import { deliverThreadTurn, getThreadEngine } from '../thread-runtime.js';
import { requestThreadBackend, type ThreadBackendAvailability } from '../thread-backend.js';
import {
  threadCanHonourNoEnter,
  THREAD_HAS_NO_COMPOSER,
  THREAD_NO_ENTER_REMEDY,
} from './thread-no-enter.js';
import { formatBuilderMessage } from '../utils/message-format.js';
import { supersede as supersedeMailbox, dismissHeldWithKey, NOTICE_SUPERSEDE_PREFIX } from '../db/mailbox.js';
import path from 'node:path';
import {
  MailboxDrainer,
  isThreadDeliverySession,
  threadDeliverySession,
  type DeliveryPorts,
  type DeliverySession,
  type ThreadDeliveryContext,
  type HeldRecoveryResult,
  type DeliveredBroadcast,
  type EscalationInfo,
  type LivenessInfo,
  type HeldOwnerNoticeInfo,
  type HeldRecoveryInfo,
} from './mailbox-delivery.js';
import type { MailboxEscalationPayload } from '@cluesmith/codev-types';
import {
  heldRecoveryAction,
  heldRecoveryKeystroke,
  type HeldRecoveryAction,
} from './mailbox-hold-policy.js';

/**
 * "Recent output" window for the liveness diagnostic (Spec 1313, Phase 7 — spec line
 * 91). A `no-profile` streak only raises the loud log/broadcast when the session emitted
 * output within this window: that distinguishes a genuinely broken/unknown classifier on
 * a LIVE, producing app (worth alarming) from a dormant unknown session (still visible in
 * `afx inbox`, but no loud alarm). Sized well above the streak's own duration
 * (threshold × backstop interval ≈ 15s) so an actively-failing app comfortably qualifies.
 */
const LIVENESS_RECENT_OUTPUT_MS = 30_000;

type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

/**
 * The SSE broadcast fn (Tower's `broadcastNotification`), wired once at boot via
 * {@link setMailboxBroadcaster}. Mirrors `codev-config-watcher.ts`'s
 * `setCodevConfigNotifier` pattern: the pure delivery module and the boot-time drainer
 * have no `RouteContext`, so the two held-set SSE events they raise
 * (`overview-changed` on a held-state change, `mailbox-escalation` on an age crossing)
 * are fanned out through this module singleton instead. Undefined until boot wires it,
 * so `makeDeliveryPorts` is safe to call before Tower is up (unit tests never set it,
 * making the ports genuine no-ops).
 */
type MailboxBroadcastFn = (n: { type: string; title: string; body: string; workspace?: string }) => void;
let mailboxBroadcaster: MailboxBroadcastFn | undefined;

/** Wire the SSE broadcast fn once at Tower startup (see {@link MailboxBroadcastFn}). */
export function setMailboxBroadcaster(fn: MailboxBroadcastFn): void {
  mailboxBroadcaster = fn;
}

/**
 * The shared node-fs adapter for {@link ContextFsPort}.
 *
 * Was a hand-rolled copy — one of three identical ones. A stub in any copy
 * silently nulls the porch context for that path, and a regression test can only
 * observe the copy it imports, so the implementations are now one.
 */
const NODE_FS_PORT: ContextFsPort = buildContextFsPort();

/**
 * The live, writable {@link PtySession} for an agent in a workspace, or `null`
 * when there is no usable live PTY — unknown agent, an exited session (the
 * PtyManager keeps an exited session for 30 s, so a stale hit is still filtered
 * here), or a session whose shellper connection is down (#1198). A `null` result
 * makes the delivery hold `no-live-pty` rather than write into the void.
 *
 * `toAgent` is the canonical identity stored on the row (a builder id or a
 * specific architect name), so an exact key match against the routing sub-maps is
 * correct — and because rows address the AGENT, a respawned terminal (new id, same
 * builder id) transparently drains its predecessor's held mail.
 */
export function resolveLiveSessionForAgent(
  workspacePath: string,
  toAgent: string,
  log?: LogFn,
): DeliverySession | null {
  /**
   * A live, writable PTY for this agent — looked up BEFORE the thread branch decides.
   *
   * The thread branch used to win unconditionally, so a STALE `thread_id` on a row
   * silently shadowed a live PTY: the agent was there, typing, and its mail went to a
   * thread that no longer served it. Low probability and completely silent, which is the
   * combination this project keeps paying for.
   *
   * The two are mutually exclusive by construction (`assertExclusiveIdentity`), so both
   * being present is a contradiction in the state rather than a choice to make quietly.
   * The PTY wins because it is the one that was observed live, and the contradiction is
   * logged rather than resolved in silence.
   */
  const livePty = (): DeliverySession | null => {
    const entry = getWorkspaceTerminals().get(workspacePath);
    if (!entry) return null;
    const tid = entry.builders.get(toAgent) ?? entry.architects.get(toAgent) ?? entry.shells.get(toAgent);
    if (!tid) return null;
    const session = getTerminalManager().getSession(tid);
    if (!session || !session.writable) return null;
    return session;
  };

  try {
    const builder = getBuilder(toAgent, workspacePath);
    if (builder?.threadId) {
      const pty = livePty();
      if (pty) {
        log?.('ERROR', `[mailbox] ${toAgent} @ ${workspacePath} has BOTH a thread id (${builder.threadId}) `
          + `and a live PTY. Those are mutually exclusive, so one of them is stale. Delivering to the `
          + `PTY, which is the one observed live; the thread id on the row should be cleared.`);
        return pty;
      }
      return threadDeliverySession(builder.threadId, {
        workspaceRoot: workspacePath,
        worktreePath: builder.worktree,
        branch: builder.branch,
        agent: toAgent,
        harness: builder.harness,
        model: builder.model,
      });
    }
    const architect = getArchitectByName(workspacePath, toAgent);
    if (architect?.threadId) {
      const pty = livePty();
      if (pty) {
        log?.('ERROR', `[mailbox] architect ${toAgent} @ ${workspacePath} has BOTH a thread id `
          + `(${architect.threadId}) and a live PTY. Those are mutually exclusive, so one of them is `
          + `stale. Delivering to the PTY, which is the one observed live; the thread id on the row `
          + `should be cleared.`);
        return pty;
      }
      // An architect's worktree IS the workspace root, and it has no branch —
      // the shape `createArchitectThread` writes.
      return threadDeliverySession(architect.threadId, {
        workspaceRoot: workspacePath,
        worktreePath: workspacePath,
        branch: '',
        agent: toAgent,
        // Issue #227 item 3. These were absent, so `attach` fell through to the engine's
        // defaults — read from `.codev/config.json` at attach time. A `threads.model`
        // edited between the spawn and this delivery moved a live thread onto a different
        // model, silently. Now they come off the row, the way the builder branch above
        // takes them off the builder row. Undefined for a row written before the columns
        // existed, which restores the old fallback for exactly those rows and no others.
        harness: architect.harness,
        model: architect.model,
      });
    }
  } catch {
    // Registry unreadable: fall through to the PTY map.
  }

  return livePty();
}

/**
 * The inverse of {@link resolveLiveSessionForAgent}: reverse-map a live session id to
 * the agent it serves (`{ workspacePath, toAgent }`), or `null` when the id belongs to
 * no registered agent — a plain shell nobody addresses, or a session already torn
 * down. Drives the Phase 5 fast triggers: a submit/quiescence signal carries only the
 * session id, and delivery is keyed on the canonical agent, so the id must be resolved
 * back before scheduling a drain. Iterates the routing registry (agents per active
 * workspace — small) which is cheap at trigger frequency and coalesced downstream. The
 * agent name it returns is the same canonical identity the row is addressed to, so a
 * respawned terminal's signal still resolves to the right held mail.
 */
export function resolveAgentForSession(
  sessionId: string
): { workspacePath: string; toAgent: string } | null {
  for (const [workspacePath, entry] of getWorkspaceTerminals()) {
    for (const registry of [entry.builders, entry.architects, entry.shells]) {
      for (const [agent, tid] of registry) {
        if (tid === sessionId) return { workspacePath, toAgent: agent };
      }
    }
  }
  return null;
}

/**
 * The classifier profile for a session, resolving the wrapped-launch case. A real
 * builder runs through `.builder-start.sh`, so `session.command` is the shell, not
 * the agent, and the pure {@link resolveProfile} returns `null`. We then read the
 * launch script (exactly as `afx refresh` does) to recover the underlying harness
 * command and resolve against that. Still `null` → the delivery holds `no-profile`
 * (fail-safe by construction: an unknown agent is held and surfaced, never guessed
 * — this is what correctly trips on wrapper/boot/relaunch screens too).
 *
 * Stale-identity note (Spec 1313): `session.command` is now sourced from the
 * persisted `terminal_sessions.command` on reconnect. If it ever goes stale (a
 * user re-points `shell.architect` at a different harness and the shellper later
 * auto-restarts into it while the row still names the old one), this can resolve
 * the WRONG profile — but it fails CLOSED today, not misdelivered: CLAUDE_PROFILE
 * and CODEX_PROFILE are behaviourally identical (same marker + region patterns),
 * and any cross-family mismatch (e.g. agy's `> ` marker) fails the composer-marker
 * test → not clean → held. That safety is a property of the current profile TABLE,
 * not of this design; the day codex/claude markers diverge, stale identity becomes
 * a live bug and the authoritative fix is WELCOME-frame hydration (see review).
 */
export function resolveProfileForSession(session: DeliverySession): GateProfile | null {
  const direct = resolveProfile({ command: session.command, args: session.launchArgs });
  if (direct) return direct;
  const harness = harnessFromLaunchScript(NODE_FS_PORT, session.cwd);
  if (!harness) return null;
  return resolveProfile({ command: harness });
}

/**
 * The harness a live session is running, or `null` when it cannot be identified
 * (Issue #196). Same two-step resolution {@link resolveProfileForSession} uses, so
 * the interrupt table and the gate table can never disagree about what app a
 * terminal is: the launch `command`'s basename first, then the worktree's
 * `.builder-start.sh` for the wrapped-launch case (a builder runs through the
 * script, so `session.command` is the shell).
 */
export function resolveHarnessForSession(session: DeliverySession): string | null {
  // Both fields are defensively re-checked: a reconnected terminal row can carry an
  // empty `command` (see db/index.ts), and an unidentified session must fall through
  // to the fail-safe `esc` rather than throw inside an interrupt write.
  const command = typeof session.command === 'string' ? session.command : '';
  const detected = command ? detectHarnessFromCommand(command) : undefined;
  if (detected) return detected;
  const cwd = typeof session.cwd === 'string' ? session.cwd : '';
  return cwd ? harnessFromLaunchScript(NODE_FS_PORT, cwd) : null;
}

/**
 * The keystroke that clears a leftover draft in THIS session's composer, or `'none'`
 * when the agent is unidentified or has no known safe clear (Issue #196).
 */
export function clearDraftKeyForSession(session: DeliverySession): ClearDraftKey {
  const harness = resolveHarnessForSession(session);
  if (harness) return clearDraftKeyForHarness(harness);
  return isPlainShellSession(session) ? SHELL_TARGET.clearDraftKey : 'none';
}

/**
 * Whether this session is a PLAIN SHELL rather than an agent (Issue #196, CMAP finding 1).
 *
 * Order is load-bearing and this is why it is a separate predicate rather than a branch
 * inside {@link resolveHarnessForSession}: a builder's `session.command` IS a shell — the
 * `.builder-start.sh` wrapper — so this may only be consulted once harness detection AND
 * the launch-script lookup have both come back empty. Reversing that would send Ctrl+C to
 * an opencode builder, which is the bug this whole change exists to fix.
 */
function isPlainShellSession(session: DeliverySession): boolean {
  if (resolveHarnessForSession(session) !== null) return false;
  return isShellCommand(typeof session.command === 'string' ? session.command : '');
}

/**
 * The bytes `afx send --interrupt` must write to make this session's prompt READY to
 * receive a message (Issue #196), in order.
 *
 * `--interrupt`'s contract is neither "end the turn" nor "clear the draft" — it is
 * *whatever it takes to get a clean prompt*, and the two intents were never separated
 * because one byte did both on the only harnesses that existed. From source:
 *
 * - Spec 0020 introduced it as "Send Ctrl+C first to ensure prompt is ready", mitigating
 *   the "Vim trap" — a RUNNING process to escape.
 * - Spec 1273 then gave "end the turn" its own command (`afx interrupt`, ESC) and recorded
 *   `--interrupt` as "a different signal", explicitly NOT the mid-turn unwedge.
 * - Issue #21 adopted it as the remedy for an abandoned composer, because Ctrl+C "does"
 *   clear typed text where ESC does not.
 *
 * So it owns BOTH halves, and on opencode they are two different bytes: ESC ends the turn
 * (`session_interrupt`) and Ctrl+U clears the line (`input_delete_to_line_start`). Sending
 * only the interrupt would leave `--interrupt` safe but useless for the job #21 documents —
 * the operator would have no way to clear an opencode composer while the auto-recovery does.
 *
 * Deduplicated, so claude and codex — where one `\x03` is both halves — get exactly one
 * write, byte-identical to the behaviour before this fix. A harness with no known clear key
 * gets the interrupt alone rather than a guessed byte.
 */
export function promptReadySequence(session: DeliverySession): string[] {
  const harness = resolveHarnessForSession(session);
  // A plain shell is a KNOWN target, not an unknown one: Ctrl+C both interrupts the
  // foreground job and makes readline discard the line. Resolving it into the unknown
  // bucket wrote a lone ESC, which bash ignores — turning Spec 0020's whole purpose for
  // this flag into a silent no-op that still reported success.
  const shell = harness === null && isPlainShellSession(session);
  const interrupt = shell
    ? INTERRUPT_BYTES[SHELL_TARGET.interruptSignal]
    : INTERRUPT_BYTES[interruptSignalForHarness(harness)];
  const clearKey = shell ? SHELL_TARGET.clearDraftKey : clearDraftKeyForHarness(harness);
  if (clearKey === 'none') return [interrupt];
  const clear = CLEAR_DRAFT_BYTES[clearKey];
  return clear === interrupt ? [interrupt] : [interrupt, clear];
}

/**
 * Classify a session's CURRENT screen for the gate (Spec 1313 render-gate round 2). Reads the
 * session's persistent {@link SessionScreen} mirror — a bounded headless Terminal fed the
 * session's output from birth — and runs the shared classifier on its viewport. This replaces
 * the old whole-ring re-render (`classifyScreen(ringBuffer.getAll()…)`), which #1205's 2 MiB
 * partial cap could hand a TORN frame → a permanent false-`busy` hold for the busiest agents.
 *
 * The delivery path only ever calls this with a live session resolved by
 * {@link resolveLiveSessionForAgent} — always a `PtySession`, which carries the mirror — so the
 * cast is sound. A session that has produced NO output yet has no mirror (`gateScreen` is null);
 * that is not a verified-empty prompt, so it classifies not-clean (`no-composer-marker`), exactly
 * as an empty replay always did. `SessionScreen.read()` flushes the parser, so the buffer the
 * shared {@link classifyBuffer} reads reflects every byte counted by the change token the
 * delivery path sampled — the property its gate→write TOCTOU relies on.
 */
export async function classifyAgentScreen(
  session: DeliverySession,
  profile: GateProfile,
  /** Optional sink for the geometry-mismatch diagnostic; omitted by callers without one. */
  log?: (message: string) => void,
): Promise<GateVerdict> {
  const screen = (session as PtySession).gateScreen;
  if (!screen) return { clean: false, reason: 'busy', detail: 'no-composer-marker' };
  const { term, cols, rows } = await screen.read();
  const verdict = classifyBuffer(term, cols, rows, profile);

  // A proven-live turn OUTRANKS the geometry compare below (Issue #197 review).
  //
  // `busy-indicator` is the one detail `heldRecoveryAction` deliberately refuses to act on:
  // it proves the agent is generating, so any recovery keystroke corrupts active work.
  //
  // NOTE the argument no longer runs through `geometry-mismatch`'s recovery action: #197
  // removed that mapping outright, so a geometry verdict now yields no keystroke at all.
  // What survives, and is the real reason for the ordering, is that the geometry answer is
  // read off a frame whose row boundaries are untrustworthy, while `busy-indicator` is a
  // POSITIVE proof of a live turn read off that same frame. The mismatch destroys the proof
  // rather than outranking it (a reflow can carry opencode's `esc interrupt` footer
  // off-screen, and the same live turn then classifies `geometry-mismatch`), so the check
  // that can still assert something true has to run first. The first version of this check
  // ran before `classifyBuffer` and lost that proof every time.
  //
  // Both verdicts hold, so nothing is lost by yielding here: the mismatch is still real, and
  // it will be reported the moment the turn ends and the busy indicator clears.
  if (verdict.detail === 'busy-indicator') return verdict;

  // Geometry check by FACT (Issue #197).
  //
  // The mirror and the agent's PTY are two grids that must agree, and when they don't every
  // row boundary the classifier reads is meaningless. `classifyBuffer` can only infer that
  // disagreement from the frame — the cols direction via `isWrapped`, the rows direction via
  // the profile's `finalRowAlwaysBlank` — and inference has a measured blind spot: when the
  // mirror is BOTH narrower and shorter, the frame re-wraps enough that no structural
  // signal survives and a clipped opencode composer still reads `no-composer-marker`. That
  // blind spot is not an edge case; 80x24 against a 110x32 agent is exactly the shape a
  // reborn session had in the field.
  //
  // Here the two geometries are simply KNOWN, so compare them. No heuristic, no per-app
  // assumption, and it covers BOTH axes at once. After attach-time adoption they normally
  // agree; they diverge when `PtySession.resize` moves the mirror and then DROPS the
  // app-side resize — the residual path adoption cannot close, and the one this catches.
  // `ShellperClient.resize` records the new size only on the success path, which is what
  // makes a dropped resize show up as a disagreement instead of being papered over.
  //
  // That divergence is only ever CREATED while the session is non-writable (every branch
  // that drops the resize also fails `writable`), but writability RETURNS without a
  // re-attach: `startRestartWait` (#1264) keeps the client and the WebSocket clients across
  // a child restart, a resize in that window moves the mirror alone, and the respawned
  // child's first byte clears `exitCode` — so the session is live again on a stale mirror
  // with no `attachShellper` to re-sync it. That is why this check is reachable at all, and
  // why it must not outrank the busy signal above.
  //
  // SCOPED to bottom-anchored profiles (opencode) on purpose, though the disagreement is
  // just as real for claude/codex/agy. Their composers sit at the cursor and stay in view,
  // so a short mirror has never taken them off the air — they survive it by luck, not by
  // design, and a mismatched mirror could in principle hand them a false CLEAN, which is the
  // dangerous direction. Widening this check to every harness is the right end state and is
  // recommended as a follow-up; it is deliberately NOT done here, because it would turn
  // deliveries that succeed today into holds for harnesses this issue is not about, and that
  // is a change to weigh on its own rather than smuggle in behind an opencode fix.
  if (profile.bottomAnchor) {
    const ptyGeometry = (session as PtySession).shellperPtyGeometry;
    if (ptyGeometry && (ptyGeometry.cols !== cols || ptyGeometry.rows !== rows)) {
      // Log BOTH geometries. The Issue #197 incident was diagnosed by curling Tower's live
      // session API to compare them by hand; the next one should be readable from the log.
      log?.(
        `[gate] geometry-mismatch ${(session as PtySession).label}: mirror ${cols}x${rows} ` +
        `vs pty ${ptyGeometry.cols}x${ptyGeometry.rows} — held. Self-clears only on a ` +
        `re-attach; a restart-path divergence (#1264) will NOT, and needs a client resize.`,
      );
      return { clean: false, reason: 'busy', detail: 'geometry-mismatch' };
    }
  }

  return verdict;
}

/** Convert a delivered-message frame to the WebSocket bus shape and broadcast it. */
function broadcastDelivered(frame: DeliveredBroadcast): void {
  broadcastMessage({
    type: 'message',
    from: { project: frame.from.project ?? 'unknown', agent: frame.from.agent ?? 'unknown' },
    to: frame.to,
    content: frame.content,
    metadata: { source: 'mailbox' },
    timestamp: new Date(frame.timestamp).toISOString(),
  });
}

/**
 * Deliver one message as a turn on a t3code thread, from Tower's process.
 *
 * WHY THIS IS MORE THAN `deliverThreadTurn` (issue #219)
 *
 * `ensureThreadBackendReady` runs in the `afx` CLI process, which exits. Tower is a
 * different, long-lived process and registers no engine of its own, so
 * `deliverThreadTurn` threw here for every thread-backed row — and the bare `catch`
 * that used to wrap it turned that into `return false`, which the delivery path holds
 * as `no-live-pty`. A workspace that configured threads therefore traded a working
 * Tower architect for one that could never receive mail, and nothing said so.
 *
 * So: register the engine in THIS process, adopt the thread (it was created in
 * another one), then start the turn.
 *
 * FOUR WAYS THIS FAILS, FOUR SENTENCES
 *
 * The port contract is a boolean, and the held-reason vocabulary is fixed at three
 * values by a CHECK constraint on the mailbox table, so all four still hold the row
 * the same way. What they no longer do is leave through the same silence: each logs
 * at ERROR naming which of the four happened, because "Tower has no engine" is a bug
 * in this repo and "the server refused the turn" is not, and an operator could not
 * tell them apart from an empty catch.
 */
async function deliverToThread(
  threadId: string,
  context: ThreadDeliveryContext | undefined,
  msg: string,
  noEnter: boolean,
  log: LogFn,
  rowId?: string,
): Promise<boolean> {
  const where = `thread ${threadId}`;
  // `--no-enter` means "put this in the composer and leave it for a human". A thread has
  // no composer: `thread.turn.start` IS the submit, and there is nothing in the protocol
  // that stages text without running it.
  //
  // This flag was received and DISCARDED here, so a gate notification sent with
  // `--no-enter` — the deliberate form, the one that exists so a human decides — executed
  // itself the moment it reached a thread-backed agent. A message that does not arrive is
  // the failure this project has spent two days on; a message that arrives and runs itself
  // is the worse half of it.
  //
  // Refused rather than approximated, and the DELIVERY PATH THEN ENDS THE ROW — it does
  // not hold it. A hold that can never clear is retried every tick and raises a starvation
  // notice with no remedy that applies, so `deliverAgentMail` dismisses such a row and this
  // is its backstop for anything that reaches `writeMessage` another way.
  //
  // Both of these sentences said "the row stays held" until round 5, while the caller
  // dismissed it. One rule in two places with one of them wrong is how the next reader is
  // misled — which is the whole reason it was worth correcting.
  if (!threadCanHonourNoEnter(noEnter)) {
    log('ERROR', `[mailbox] ${where}: refusing a --no-enter message. ${THREAD_HAS_NO_COMPOSER} `
      + `This is the backstop; the delivery path ends such a row terminally rather than holding `
      + `it. ${THREAD_NO_ENTER_REMEDY}`);
    return false;
  }
  if (!context) {
    log('ERROR', `[mailbox] ${where}: the session carries no thread context, so this process cannot `
      + `reach it. The row is thread-backed and delivery has nothing to attach to — a wiring fault here, `
      + `not a statement about the thread or the server.`);
    return false;
  }
  // NOTHING HERE AWAITS A CONNECT.
  //
  // Tower's drainer awaits agents sequentially, so an `await ensureThreadBackendReady(...)`
  // on this path stalled delivery for every agent in every workspace — including PTY-only
  // ones that never opted into threads — for as long as one workspace's connect took. The
  // bound that makes the connect safe is exactly what makes the stall long. So the connect
  // is started in the background and this returns; the row is held, and the next tick
  // (1.5 s later) finds the engine ready.
  const availability = requestThreadBackend(context.workspaceRoot);
  if (availability.kind !== 'ready') {
    // The TRANSITION, not the state. Tower ticks every 1.5 s, so a 60 s cooldown emitted
    // forty identical ERROR lines saying the same stable fact — which trains people to
    // stop reading the log, and the next line that matters is in there somewhere.
    if (lastNotReady.get(context.workspaceRoot) !== availability.kind) {
      lastNotReady.set(context.workspaceRoot, availability.kind);
      log(
        availability.kind === 'connecting' ? 'INFO' : 'ERROR',
        threadBackendNotReady(where, context, availability),
      );
    }
    return false;
  }
  // Ready again: forget the last complaint so the NEXT time it goes wrong is reported,
  // rather than suppressed as a repeat of something that has since resolved.
  lastNotReady.delete(context.workspaceRoot);
  try {
    // For THIS workspace. Tower serves every workspace in `global.db` from one process,
    // and an engine registered for another one holds another server and another project.
    await getThreadEngine(context.workspaceRoot).attach({
      threadId,
      worktreePath: context.worktreePath,
      branch: context.branch,
      builderId: context.agent,
      harnessName: context.harness,
      model: context.model,
    });
  } catch (err) {
    log('ERROR', `[mailbox] ${where}: could not adopt the thread in this process — `
      + `${err instanceof Error ? err.message : String(err)}. This is not evidence that the thread is `
      + `gone; it is evidence that this process cannot address it.`);
    return false;
  }
  try {
    const outcome = await deliverThreadTurn(threadId, msg, context.workspaceRoot, rowId);
    if (outcome === 'recovered') {
      // Not a new turn. A previous attempt's acknowledgement was lost, the intent was
      // still pending in the journal, and it has now been re-dispatched under its
      // ORIGINAL command id — so the server holds it exactly once. Reporting this as
      // anything other than delivered would send the next tick to submit it again, which
      // is the duplicate this whole path exists to prevent.
      log('WARN', `[mailbox] ${where}: a previous submission for ${context.agent} was never `
        + `acknowledged, so it was REPLAYED under its original command id rather than re-sent. `
        + `The server collapses it by that id, so the message ran once, not twice.`);
    }
    return true;
  } catch (err) {
    log('ERROR', `[mailbox] ${where}: the server refused the turn — `
      + `${err instanceof Error ? err.message : String(err)}. The thread was reached and the message `
      + `was not accepted.`);
    return false;
  }
}

/**
 * Why this delivery did not happen yet, in the caller's terms.
 *
 * Four states, four sentences, and only one of them is a bug in this repo. They were one
 * `return false` before, and an operator could not tell "connecting, try again in a
 * second" from "your server has been down for a minute" from "this row should not be
 * thread-backed at all".
 */
function threadBackendNotReady(
  where: string,
  context: ThreadDeliveryContext,
  availability: Exclude<ThreadBackendAvailability, { kind: 'ready' }>,
): string {
  const preamble = `[mailbox] ${where}: not delivered to ${context.agent}`;
  switch (availability.kind) {
    case 'connecting':
      return `${preamble} — the thread backend for ${context.workspaceRoot} is still connecting. `
        + `The row stays held and the next drain retries it; this is ordinary, not a fault.`;
    case 'cooling-down':
      return `${preamble} — the last connect to the t3code server for ${context.workspaceRoot} failed `
        + `${Math.round((Date.now() - availability.since) / 1000)}s ago and is not retried yet: `
        + `${availability.message}. Retrying every tick would re-exchange a bootstrap token that may `
        + `be one-time.`;
    case 'misconfigured':
      return `${preamble} — the "threads" config for ${context.workspaceRoot} is incomplete, so nothing `
        + `was attempted: ${availability.message}.`;
    case 'not-configured':
    default:
      return `${preamble} — the row is thread-backed, but ${context.workspaceRoot} names no t3code `
        + `server. A thread-backed row in a workspace with no server configured is a contradiction — `
        + `the row, or the config, is wrong.`;
  }
}

/**
 * Build the {@link DeliveryPorts} bound to the live Tower. Cheap (closures over
 * module singletons), so `handleSend` may construct one per request and the
 * drainer one at boot; the shared state that matters (the per-agent write
 * serializer) lives in `mailbox-delivery.ts`, not here.
 */
/**
 * The last not-ready state reported per workspace, so a stable one is logged once.
 *
 * Deleted when the workspace goes ready, so a later failure is reported rather than
 * suppressed as a repeat of a state that has since resolved.
 */
const lastNotReady = new Map<string, ThreadBackendAvailability['kind']>();

/** Forget every suppressed state. For a test's teardown, not for production. */
export function clearThreadBackendNotices(): void {
  lastNotReady.clear();
}

export function makeDeliveryPorts(log: LogFn): DeliveryPorts {
  return {
    getSessionForAgent: (ws, agent) => resolveLiveSessionForAgent(ws, agent, log),
    resolveProfile: (session) => resolveProfileForSession(session),
    classify: (session, profile) => classifyAgentScreen(session, profile, (m) => log('INFO', m)),
    writeMessage: async (session, msg, noEnter, rowId) => {
      if (isThreadDeliverySession(session) && session.threadId) {
        return await deliverToThread(session.threadId, session.threadContext, msg, noEnter, log, rowId);
      }
      return writeMessagePaced(session, msg, noEnter);
    },
    broadcast: (frame) => broadcastDelivered(frame),
    onHeldStateChange: () => broadcastHeldStateChange(),
    onEscalation: (info) => broadcastEscalation(info),
    onLiveness: (info) => surfaceLiveness(info, log),
    escalateHeldToOwner: (info) => escalateHeldToOwner(info, log),
    clearHeldOwnerNotice: (ws, agent) => clearHeldOwnerNotice(ws, agent),
    recoverHeld: (info) => recoverHeld(info, log),
    log: (m) => log('INFO', m),
    now: () => Date.now(),
  };
}

/** Pseudo-sender identity for owner starvation notices (Spec 1313 round 3, change 3). */
const NOTICE_SENDER = 'af-mailbox';

/** Supersede key for the single pending owner notice ABOUT a starving `toAgent`. */
function noticeSupersedeKey(toAgent: string): string {
  return `${NOTICE_SUPERSEDE_PREFIX}${toAgent}`;
}

/** Human-readable notice body (metadata only — never the starved messages' contents). */
function formatOwnerNoticeBody(info: HeldOwnerNoticeInfo): string {
  const mins = Math.max(1, Math.round(info.ageMs / 60_000));
  const plural = info.heldCount === 1 ? 'message' : 'messages';
  return (
    `Mailbox delivery is STUCK for builder '${info.toAgent}' @ ${path.basename(info.workspacePath)}. ` +
    `${info.heldCount} ${plural} held ~${mins}m (reason: ${info.reason ?? 'held'}) — its composer never classifies as a ready prompt, ` +
    `so nothing is being delivered (cron nudges included). ` +
    heldRemedy(info.toAgent, info.detail ?? null, canAutoClearFor(info.workspacePath, info.toAgent))
  );
}

/**
 * Whether Tower has a clearing keystroke recorded for this agent, i.e. whether the #92
 * auto-recovery can actually repair a `user-text` hold on it (Issue #196 / #190).
 *
 * Answers "will the automatic repair happen?" so {@link heldRemedy} can stop promising
 * one that will not. A session that cannot be resolved, or is gone, answers `false`:
 * on an unknown target `writeHeldRecovery` writes nothing and the hold is reported
 * unrecoverable, and telling an operator to wait for that is #190's exact shape.
 */
function canAutoClearFor(workspacePath: string, toAgent: string): boolean {
  const session = resolveLiveSessionForAgent(workspacePath, toAgent);
  if (!session || isThreadDeliverySession(session)) return false;
  return heldRecoveryKeystroke('cancel-draft', clearDraftKeyForSession(session)) !== null;
}

/**
 * The remedy that actually works, chosen by what the gate saw (#21).
 *
 * The old text named `afx interrupt`, which sends ESC. ESC does not clear typed
 * text in a composer, so running it changed nothing and the alert fired again
 * three minutes later. What works is `afx send <id> --interrupt`, which readies the
 * prompt with the keystrokes recorded as safe for that agent — Ctrl+C on claude/codex
 * and shells, ESC then Ctrl+U on opencode (#196) — and clears the line. It was
 * documented as a way to send a message, not as the remedy for this state, so nobody
 * found it. Hit five times on 2026-08-21, each needing manual intervention.
 *
 * `canAutoClear` (#190, again): the automatic recovery only fires when a clearing
 * keystroke is RECORDED for the target's agent. On an unidentified or custom one
 * nothing is written and the hold reports `unrecoverable`, so promising a repair that
 * will never arrive is the same defect this function was written to remove — a remedy
 * naming something that does not happen.
 *
 * It is deliberately REQUIRED, with no default. A default of `true` fails toward the
 * false claim: a future caller that omits it re-arms #190 in prose, silently, and the
 * promise is exactly the one this function exists to stop making. A default of `false`
 * would be safe but silent in the other direction. Requiring it makes an omission a
 * compile error in production source, so every call site has to answer out loud.
 *
 * That lever does NOT reach test files: this package's tsconfig excludes the
 * `__tests__` directories, so a call-arity error there is invisible to `tsc`. A test in
 * `bugfix-196-interrupt-signal.test.ts` asserts `heldRemedy.length === 3` for that
 * reason: re-adding a default drops the arity to 2, which is the only runtime-visible
 * trace it leaves.
 *
 * `user-text` gets the clearing command. `busy-indicator` is an agent mid-turn:
 * clearing there would corrupt a live turn, and the answer is to wait.
 * `geometry-mismatch` (Issue #197) is the third shape: nothing is wrong with the
 * composer, Tower's mirror is simply the wrong SIZE for it, so no keystroke helps
 * and Tower deliberately sends none — the remedy is a resize, which only a client
 * can produce. Anything else is a screen the gate could not read at all, which is
 * a different problem and says so rather than offering a remedy for the wrong one.
 *
 * Note the branches key on `heldRecoveryAction`, not on a second list of details.
 * That is why removing geometry-mismatch's recovery action degraded gracefully here
 * instead of promising an ESC that would never fire; do not replace it with a list.
 */
export function heldRemedy(toAgent: string, detail: string | null, canAutoClear: boolean): string {
  const inspect = `Inspect with 'afx inbox'.`;

  if (detail === 'user-text') {
    // #190's shape, and worth stating plainly because this function exists to avoid it:
    // only claim the automatic repair when one can actually be sent.
    const automatic = canAutoClear
      ? `Tower sends one automatic clearing keystroke after the starvation window. If it remains held, `
      : `Tower has NO clearing keystroke recorded for this agent, so no automatic repair will be attempted — `
        + `this hold needs a human. Clear it with: `;
    const lead = canAutoClear ? `clear it with: ` : ``;
    return (
      `${inspect} Its composer is holding TEXT the agent left behind and will not clear on its own. ` +
      automatic + lead +
      `afx send ${toAgent} --interrupt "<your message>"   ` +
      `(readies the prompt using the keystrokes recorded as safe for this agent — Ctrl+C on claude/codex, ` +
      `ESC then Ctrl+U on opencode, which quits on Ctrl+C — then delivers. By contrast ` +
      `'afx interrupt' sends ESC, which does not clear typed text on any harness.)`
    );
  }

  if (detail === 'busy-indicator') {
    return (
      `${inspect} The agent is MID-TURN, not stuck on a leftover prompt. Do not clear its composer — ` +
      `that corrupts a live turn. Delivery resumes on its own when the turn ends; ` +
      `'afx interrupt ${toAgent}' ends the turn if it is genuinely wedged.`
    );
  }

  if (detail === 'geometry-mismatch') {
    // The one detail whose remedy is neither "wait" nor "clear the composer" — and, until
    // Issue #197, the one an operator was told nothing specific about. Tower's gate mirror
    // is a different SIZE from the grid the agent paints at, so no keystroke helps: the
    // repair is a resize, and only a client can produce one.
    return (
      `${inspect} Tower's screen mirror is a different SIZE from the terminal the agent is ` +
      `drawing to, so the gate cannot read the composer and NO keystroke will fix it — ` +
      `Tower sends none for this state. Open ${toAgent}'s terminal tab: a connected client ` +
      `sends a resize, which realigns the mirror and delivery resumes. It also clears by ` +
      `itself the next time the session re-attaches (a Tower restart).`
    );
  }

  if (heldRecoveryAction(detail) === 'escape-screen') {
    return (
      `${inspect} Delivery is STUCK on a screen problem because the gate cannot read a ready prompt (${detail}); ` +
      `it will not resolve while that screen stays unchanged. Tower sends one automatic ESC after the starvation window. ` +
      `If it remains held, inspect the pane and run: afx interrupt ${toAgent} --no-enter.`
    );
  }

  return (
    `${inspect} The gate could not read a ready prompt${detail ? ` (${detail})` : ''}, ` +
    `which is a screen problem rather than a leftover draft. Look at the pane before acting.`
  );
}

/**
 * Raise a starvation notice to a starving agent's OWNER architect (Spec 1313 round 3, change
 * 3). Skips agents that are themselves architects — the alarm would land in the same starved
 * mailbox, and `afx status` covers that case. Resolves the recipient EXACTLY as `afx send
 * architect` does — the starving builder's spawning architect (affinity), else the workspace's
 * `main`, else the first-registered architect — via the shared registry resolver. Then enqueues
 * ONE coalesced (supersede-keyed), GATE-delivered mailbox row: visibility only, never a force
 * path. No-op when no architect can be resolved (nowhere to send).
 *
 * RETURNS `true` iff a notice row was enqueued; `false` on every no-op path (recipient is
 * itself an architect / no architect resolvable / would notify the agent about itself). The
 * drainer arms its once-per-episode guard only on `true`, so a no-op retries next tick rather
 * than silently suppressing the alarm for the episode.
 */
function escalateHeldToOwner(info: HeldOwnerNoticeInfo, log: LogFn): boolean {
  // An architect-addressed row gets no notice (it would starve in the same mailbox).
  if (getArchitectByName(info.workspacePath, info.toAgent)) return false;
  // Resolve the owner architect the same way `afx send architect` does (bare `architect` form
  // with the starving builder as sender → spawning affinity, else main, else first).
  const owner = resolveAgentInRegistry('architect', info.workspacePath, info.toAgent);
  if (isResolveError(owner)) {
    log('INFO', `[mailbox] starvation notice for ${info.toAgent} skipped: no architect to notify (${owner.message})`);
    return false;
  }
  if (owner.agent === info.toAgent) return false; // defensive: never notify an agent about itself
  const body = formatOwnerNoticeBody(info);
  supersedeMailbox(getGlobalDb(), info.workspacePath, noticeSupersedeKey(info.toAgent), {
    workspacePath: info.workspacePath,
    toAgent: owner.agent,
    body,
    formattedMessage: formatBuilderMessage(NOTICE_SENDER, body),
    fromAgent: NOTICE_SENDER,
    fromWorkspace: info.workspacePath,
  });
  broadcastHeldStateChange();
  // Deliver the notice promptly through the SAME gate (it holds if the architect is busy).
  void ensureDrainer().scheduleDrain(owner.workspacePath, owner.agent);
  log(
    'WARN',
    `[mailbox] STARVATION notice → ${owner.agent} about ${info.toAgent} @ ${path.basename(info.workspacePath)} ` +
      `(${info.heldCount} held ~${Math.round(info.ageMs / 1000)}s, reason ${info.reason ?? 'held'})`,
  );
  return true;
}

/**
 * Clear (dismiss) any still-held owner notice about `toAgent` once its starvation is over
 * (Spec 1313 round 3). A no-op on an already-delivered notice — the architect already saw it.
 */
function clearHeldOwnerNotice(workspacePath: string, toAgent: string): void {
  const dismissed = dismissHeldWithKey(getGlobalDb(), workspacePath, noticeSupersedeKey(toAgent));
  if (dismissed > 0) broadcastHeldStateChange();
}

/**
 * Fire the `overview-changed` SSE event so the held-count indicator refetches its
 * count (Spec 1313, Phase 7). Cheap and idempotent (it only triggers a refetch), so
 * the delivery path fires it freely on any held-set change. No-op until the broadcaster
 * is wired at boot.
 */
function broadcastHeldStateChange(): void {
  mailboxBroadcaster?.({
    type: 'overview-changed',
    title: 'Held mail changed',
    body: 'Mailbox held-set changed',
  });
}

/**
 * Fire the `mailbox-escalation` SSE event when a held row crosses the escalation age
 * (Spec 1313, Phase 7) — a VISIBILITY signal that moves the dashboard/VSCode indicator
 * into its attention state; it never triggers delivery. Carries metadata only (ids +
 * age + reason), never the message body, per the spec's redaction rule. No-op until the
 * broadcaster is wired at boot.
 */
function broadcastEscalation(info: EscalationInfo): void {
  const payload: MailboxEscalationPayload = {
    workspacePath: info.workspacePath,
    toAgent: info.toAgent,
    mailboxId: info.mailboxId,
    ageMs: info.ageMs,
    reason: info.reason,
  };
  mailboxBroadcaster?.({
    type: 'mailbox-escalation',
    title: 'Message held past escalation age',
    body: JSON.stringify(payload),
    workspace: info.workspacePath,
  });
}

/**
 * Surface the liveness diagnostic (Spec 1313, Phase 7 — spec line 91). Applies the spec's
 * "with recent output" gate: only when the agent's live session emitted output within
 * {@link LIVENESS_RECENT_OUTPUT_MS} — proving a genuinely broken/unknown classifier on a
 * PRODUCING app, not a dormant unknown session — does it raise the loud log AND a broadcast.
 * The broadcast rides the existing generic `notification` SSE channel (human title/body, no
 * body-of-message), so it is immediately visible in the dashboard's notification surface
 * without any new event type or client wiring. An idle unknown session raises nothing here —
 * its held row is still discoverable in `afx inbox`, per the metadata-only visibility model.
 */
function surfaceLiveness(info: LivenessInfo, log: LogFn): void {
  const session = resolveLiveSessionForAgent(info.workspacePath, info.toAgent);
  if (!session || isThreadDeliverySession(session)) return;
  const hasRecentOutput = Date.now() - (session as PtySession).lastDataAt <= LIVENESS_RECENT_OUTPUT_MS;
  if (!hasRecentOutput) return; // dormant unknown session → no loud alarm (still in `afx inbox`)
  const where = `${info.toAgent} @ ${path.basename(info.workspacePath)}`;
  log(
    'WARN',
    `[mailbox] LIVENESS: ${where} held no-profile for ${info.streak} consecutive checks with recent output — ` +
      `unrecognized app; its mail will not deliver until a classifier profile matches (check for a TUI update)`
  );
  mailboxBroadcaster?.({
    type: 'notification',
    title: 'Mailbox: delivery blocked (unrecognized app)',
    body: `${where} — its screen never classifies as a ready prompt, so held messages will not deliver. A classifier profile may need updating.`,
    workspace: info.workspacePath,
  });
}

/**
 * Write ONE bounded recovery keystroke to `session` and return the byte written, or
 * `null` when the write was rejected (Issue #196).
 *
 * The whole point of this function is that it is the ONLY place the #92 auto-recovery
 * puts a control byte on a PTY, and it derives that byte from the session's own harness.
 * That path fires with NO operator in the loop, so an unconditional `\x03` here let Tower
 * quit an opencode builder by itself — strictly worse than the manual `--interrupt` case,
 * because nobody is watching to learn from it. Exported so the regression test can assert
 * on the bytes this production code writes rather than on a policy return value.
 */
export function writeHeldRecovery(
  session: DeliverySession,
  action: HeldRecoveryAction,
): string | null {
  const control = heldRecoveryKeystroke(action, clearDraftKeyForSession(session));
  if (control === null) return null; // no safe byte for this agent — write nothing
  return session.write(control) ? control : null;
}

/**
 * Repair one terminal screen after the drainer proved the SAME deadlocking verdict
 * stable for the starvation window (#92). This sends only a control byte; the held
 * message remains in SQLite and still requires a later render-gate CLEAN verdict.
 */
function recoverHeld(info: HeldRecoveryInfo, log: LogFn): HeldRecoveryResult {
  const session = resolveLiveSessionForAgent(info.workspacePath, info.toAgent);
  if (!session || isThreadDeliverySession(session)) return { outcome: 'failed' };
  const where = `${info.toAgent} @ ${path.basename(info.workspacePath)}`;

  // Issue #196: no byte is recorded as safe for this agent, so there is nothing to try.
  // Say so ONCE and latch (`true`) so the drainer stops re-attempting: a recovery that
  // CANNOT succeed must not be spelled the same as one that has not succeeded yet, and
  // it must not spin silently. The row stays in `afx inbox` and needs a human at the pane.
  if (heldRecoveryKeystroke(info.action, clearDraftKeyForSession(session)) === null) {
    const agent = resolveHarnessForSession(session) ?? 'an unidentified agent';
    log(
      'WARN',
      `[mailbox] UNRECOVERABLE HOLD: ${where} stuck (${info.detail}) for ${Math.round(info.stableMs / 1000)}s and cannot be auto-repaired — ` +
        `no keystroke is recorded as safe for ${agent}. Its mail will not deliver until someone clears the pane.`,
    );
    mailboxBroadcaster?.({
      type: 'notification',
      title: 'Mailbox: hold cannot be auto-recovered',
      body: `${where} — delivery is STUCK (${info.detail}) and Tower has no safe keystroke for ${agent}, so it will not guess one. Clear the composer by hand; the message is still held.`,
      workspace: info.workspacePath,
    });
    return { outcome: 'unrecoverable' };
  }

  // A rejected write is TRANSIENT (a torn-down PTY), not unrecoverable: report `failed` so
  // the drainer re-attempts on a later pass rather than latching.
  const written = writeHeldRecovery(session, info.action);
  if (written === null) return { outcome: 'failed' };

  // The keystroke's human label travels back with the outcome so the drainer's
  // `written-inert` log line can name the byte that was tried (Issue #196, residual 1)
  // without re-deriving per-harness facts on that side.
  const keystroke = info.action !== 'cancel-draft'
    ? 'ESC'
    : written === CLEAR_DRAFT_BYTES['ctrl-c'] ? 'Ctrl+C' : 'Ctrl+U';
  const recovery = info.action !== 'cancel-draft'
    ? 'ESC to repaint/end the unreadable screen'
    : written === CLEAR_DRAFT_BYTES['ctrl-c']
      ? 'Ctrl+C to clear abandoned text'
      : 'Ctrl+U to clear the composer line (this agent quits on Ctrl+C)';
  log(
    'WARN',
    `[mailbox] AUTO-RECOVERY: ${where} remained STUCK (${info.detail}) for ${Math.round(info.stableMs / 1000)}s; sent ${recovery}`,
  );
  mailboxBroadcaster?.({
    type: 'notification',
    title: 'Mailbox: automatic stuck-screen recovery',
    body: `${where} — delivery was STUCK (${info.detail}); Tower sent ${recovery}. The message will deliver only after the gate verifies a clean prompt.`,
    workspace: info.workspacePath,
  });
  return { outcome: 'written', keystroke };
}

// The single backstop drainer instance (replaces the retired SendBuffer). Created
// lazily so it picks up the configured retention window (below) at first use.
let drainer: MailboxDrainer | undefined;

/**
 * The terminal-row retention window (days) for the prune. This is a Tower-GLOBAL
 * policy — the drainer prunes rows across every workspace in the user-global
 * `global.db` — so it is read from the user-global `~/.codev/config.json` layer via
 * `loadConfig` (rooted at home), not any single workspace's config. Spec default 30
 * (already `DEFAULT_CONFIG.mailbox.retentionDays`). A malformed config never stops
 * the drainer from booting — it falls back to the default.
 */
function configuredRetentionDays(): number {
  try {
    return loadConfig(homedir()).mailbox?.retentionDays ?? 30;
  } catch {
    return 30;
  }
}

/**
 * The held-row escalation age in ms (Spec 1313, Phase 7). Like the retention window
 * this is a Tower-GLOBAL policy read from the user-global config layer, default 60s
 * (matching today's max-age; `DEFAULT_CONFIG.mailbox.escalationSeconds`). A malformed
 * config never stops the drainer from booting — it falls back to the default.
 */
function configuredEscalationMs(): number {
  try {
    return (loadConfig(homedir()).mailbox?.escalationSeconds ?? 60) * 1000;
  } catch {
    return 60_000;
  }
}

function ensureDrainer(): MailboxDrainer {
  if (!drainer) {
    drainer = new MailboxDrainer({
      pruneRetentionDays: configuredRetentionDays(),
      escalationMs: configuredEscalationMs(),
    });
  }
  return drainer;
}

// Phase 5 fast-trigger bus handler. Held at module scope so `stopMailboxDrainer` can
// detach it: re-subscribing on every start would accumulate duplicate listeners across
// Tower restarts within one process (and the tests do start/stop/start).
let deliverySignalHandler: ((sessionId: string) => void) | undefined;

/**
 * Subscribe the fast submit/quiescence triggers (Spec 1313 Phase 5) to the drainer.
 * Each signal names only the emitting session; we reverse-map it to its agent and
 * schedule a coalesced, gated drain. Idempotent — a second call while already
 * subscribed is a no-op, so the single-listener invariant (which arms the
 * per-session quiescence timers) holds.
 */
function subscribeDeliverySignals(): void {
  if (deliverySignalHandler) return;
  const handler = (sessionId: string): void => {
    const target = resolveAgentForSession(sessionId);
    if (target) void ensureDrainer().scheduleDrain(target.workspacePath, target.toAgent);
  };
  deliverySignalHandler = handler;
  terminalDeliverySignals.on('submit', handler);
  terminalDeliverySignals.on('quiescence', handler);
}

/** Detach the Phase 5 trigger handler so a subsequent start re-subscribes cleanly. */
function unsubscribeDeliverySignals(): void {
  if (!deliverySignalHandler) return;
  terminalDeliverySignals.off('submit', deliverySignalHandler);
  terminalDeliverySignals.off('quiescence', deliverySignalHandler);
  deliverySignalHandler = undefined;
}

/**
 * Start the mailbox drainer (replaces `startSendBuffer`). Called once on Tower boot:
 * prunes terminal rows, begins the periodic held-row backstop that redelivers on the
 * first clean gate after a line clears, and subscribes the Phase 5 fast triggers so a
 * held message drains within a microtask of a user submit or output quiescence rather
 * than waiting for the next backstop tick.
 */
export function startMailboxDrainer(log: LogFn): void {
  ensureDrainer().start(makeDeliveryPorts(log), getGlobalDb());
  subscribeDeliverySignals();
  log('INFO', '[mailbox] backstop drainer started');
}

/**
 * Stop the mailbox drainer (replaces `stopSendBuffer`). Detaches the fast triggers and
 * stops the backstop timer — there is NO shutdown force-flush, because every held row
 * is already persisted in SQLite and will be redelivered after restart on a clean gate.
 */
export function stopMailboxDrainer(): void {
  unsubscribeDeliverySignals();
  drainer?.stop();
}

/** The live drainer (liveness-telemetry streaks; Phase 7 surfaces them). */
export function getMailboxDrainer(): MailboxDrainer {
  return ensureDrainer();
}
