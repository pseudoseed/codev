/**
 * Porch terminal notifications — sends `afx send` to deliver messages into a
 * target terminal as PTY input.
 *
 * Two callers:
 *   - gate approval: wake the builder so an idle session runs `porch next`
 *   - protocol complete: tell the spawning architect cleanup is due (#109)
 *
 * Architect-bound *gate* notifications stay gone: PIR/SPIR gates are
 * human-decision points, and the architect cannot approve them. Protocol
 * complete is different — it is the cleanup trigger, and without it
 * finished builders sit until a human happens to look.
 *
 * ADDRESSING IS THE SAFETY PROPERTY HERE (issue #264).
 *
 * A gate is where a human's authority enters the system. A message saying a
 * gate was approved, delivered to a project that approved nothing, is a channel
 * around that authority — and it happened: `porch approve` addressed the
 * recipient by bare project id and let the SENDING PROCESS's session decide the
 * workspace, so an approval for a throwaway project in a temp workspace woke a
 * live builder in another workspace whose id merely ended in the same digits.
 *
 * Every send from this module therefore names the project's OWN worktree
 * (`--worktree`), which fixes both the workspace and the recipient to the
 * project's location on disk, and demands an exact match (`--exact`), so a miss
 * is a logged error rather than a delivery to a plausible neighbour.
 */

import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnderTestRunner } from '../../lib/test-env.js';

function resolveAfxBinary(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '../../../bin/afx.js');
}

export interface NotifyTerminalOptions {
  /** Target agent — a builder ID, or 'architect'. Omit to address the worktree's own builder. */
  target?: string;
  /** Message text to deliver. */
  message: string;
  /** Working directory — used by afx to resolve the workspace. */
  worktreeDir: string;
  /**
   * The worktree that owns the project this notification is about. Pins BOTH
   * the workspace and (when `target` is omitted) the recipient, so neither is
   * inherited from whatever process happens to be running porch.
   */
  projectWorktree?: string;
  /** Refuse the builder tail match — a miss must not become a delivery. */
  exact?: boolean;
}

/**
 * Builder-bound wake-up after a gate is approved.
 *
 * The text is written to be CHECKABLE. The old wording — "Gate pr approved —
 * please run `porch next` to advance" — was an instruction carrying no project
 * id, no workspace, and nothing a recipient could test it against, so a
 * misdelivered copy read exactly like a real one. This names what was approved
 * and where, and says plainly that the message is not the authority.
 */
export function gateApprovedMessage(
  gateName: string,
  projectId: string,
  workspacePath: string,
): string {
  return (
    `Notification, not an approval: porch recorded gate ${gateName} approved for ` +
    `project ${projectId} in ${workspacePath}. This message carries no authority. ` +
    `Confirm with \`porch next ${projectId}\` before advancing — if that shows the ` +
    `gate still pending, or names a project that is not yours, this was not meant ` +
    `for you: ignore it and report it.`
  );
}

/** Architect-bound cleanup trigger when a protocol reaches verified. */
export function protocolCompleteMessage(projectId: string, workspacePath: string): string {
  return `Project ${projectId} in ${workspacePath} reports protocol complete. Ready for cleanup.`;
}

export function notifyProtocolComplete(artifactRoot: string, projectId: string): void {
  notifyTerminal({
    target: 'architect',
    message: protocolCompleteMessage(projectId, artifactRoot),
    worktreeDir: artifactRoot,
    // Pinned to the project's worktree for the same reason the gate wake-up is:
    // `afx cleanup` is destructive, and this message is what prompts it.
    projectWorktree: artifactRoot,
  });
}

/** Builder-bound wake-up, addressed to the builder that owns the project. */
export function notifyGateApproved(
  artifactRoot: string,
  projectId: string,
  gateName: string,
): void {
  notifyTerminal({
    message: gateApprovedMessage(gateName, projectId, artifactRoot),
    worktreeDir: artifactRoot,
    projectWorktree: artifactRoot,
    exact: true,
  });
}

/**
 * Fire-and-forget notification to a terminal.
 * Uses `afx send` via execFile (no shell, no injection risk).
 * Errors are logged but never thrown — notification is best-effort.
 */
export function notifyTerminal(opts: NotifyTerminalOptions): void {
  // Fire-and-forget execFile's error callback console.errors after the
  // suite has finished when afx.js cannot load (CI: ERR_MODULE_NOT_FOUND
  // on dist/agent-farm/cli.js). That is an EnvironmentTeardownError, not
  // a failed assertion. Same class as #1515: no-op under a test runner.
  if (isUnderTestRunner()) return;

  const afBinary = resolveAfxBinary();

  execFile(
    process.execPath,
    [afBinary, ...buildSendArgs(opts)],
    { cwd: opts.worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(
          `[porch] notifyTerminal(${opts.target ?? opts.projectWorktree ?? '?'}) failed: ${error.message}`,
        );
      }
    }
  );
}

/**
 * The `afx send` argv for a notification.
 *
 * Exported so a test can assert the addressing WITHOUT spawning a process: the
 * regression this pins is which agent gets addressed and in which workspace, and
 * that is decided entirely here.
 */
export function buildSendArgs(opts: NotifyTerminalOptions): string[] {
  const args = ['send'];
  if (opts.projectWorktree) args.push('--worktree', opts.projectWorktree);
  if (opts.exact) args.push('--exact');
  if (opts.target) args.push(opts.target);
  args.push(opts.message, '--raw');
  return args;
}
