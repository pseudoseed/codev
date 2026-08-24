/**
 * Porch terminal notifications — sends `afx send <target>` to deliver
 * messages into a target terminal as PTY input.
 *
 * Two callers:
 *   - gate approval: wake the builder so an idle session runs `porch next`
 *   - protocol complete: tell the spawning architect cleanup is due (#109)
 *
 * Architect-bound *gate* notifications stay gone: PIR/SPIR gates are
 * human-decision points, and the architect cannot approve them. Protocol
 * complete is different — it is the cleanup trigger, and without it
 * finished builders sit until a human happens to look.
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
  /** Target terminal — currently always a builder ID (e.g., 'pir-1298'). */
  target: string;
  /** Message text to deliver. */
  message: string;
  /** Working directory — used by afx to resolve the workspace. */
  worktreeDir: string;
}

/** Builder-bound wake-up after a gate is approved. */
export function gateApprovedMessage(gateName: string): string {
  return `Gate ${gateName} approved — please run \`porch next\` to advance.`;
}

/** Architect-bound cleanup trigger when a protocol reaches verified. */
export function protocolCompleteMessage(projectId: string): string {
  return `Project ${projectId} protocol complete. Ready for cleanup.`;
}

export function notifyProtocolComplete(workspaceRoot: string, projectId: string): void {
  notifyTerminal({
    target: 'architect',
    message: protocolCompleteMessage(projectId),
    worktreeDir: workspaceRoot,
  });
}

/**
 * Fire-and-forget notification to a terminal.
 * Uses `afx send <target>` via execFile (no shell, no injection risk).
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
    [afBinary, 'send', opts.target, opts.message, '--raw'],
    { cwd: opts.worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(`[porch] notifyTerminal(${opts.target}) failed: ${error.message}`);
      }
    }
  );
}
