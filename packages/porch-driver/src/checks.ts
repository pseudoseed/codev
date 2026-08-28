/**
 * Spec 146, Phase 3 — running a phase check.
 *
 * RULED BY THE ARCHITECT: NOT THROUGH A t3code TERMINAL.
 *
 * porch spawns the check itself, with `child_process`, in the thread's own
 * `worktreePath`. No `terminal.open`, no `terminal.write`, no RPC anywhere in the
 * path that runs a check. A check is a process porch owns end to end; routing it
 * through the server's terminal layer would turn its exit code into a parsing
 * problem and its lifetime into the server's business. The corollary, also ruled:
 * `pin.json` is NOT extended with `terminal.ts` for this. Phases 14 and 15 delete
 * the terminal layer, and a check that depended on it would have to be rewritten
 * then.
 *
 * THE SHELL IS PART OF THE CHECK
 *
 * Phase 2 had a teardown race that failed under bash and passed under zsh. Running
 * "the same command" as porch and getting exit 0 proved nothing until the
 * interpreter matched. So the shell is explicit here, defaults to the one porch
 * uses, and is reported back in the result rather than left to be inferred.
 *
 * A TIMEOUT IS NOT A FAILING CHECK
 *
 * A check that ran and exited 1 and a check that never finished are different
 * facts. `timedOut` carries the second, and `exitCode` is null there rather than
 * a number a caller could mistake for a verdict.
 */

import { spawn } from 'node:child_process';

export interface PhaseCheckOptions {
  /** The command line, run by `shell -lc`. */
  readonly command: string;
  /** The thread's `worktreePath`. The check runs here and nowhere else. */
  readonly cwd: string;
  /** Interpreter. Defaults to bash — porch's own shell in `.codev/config.json`. */
  readonly shell?: string;
  /** Extra environment on top of the driver's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the process is killed. Default 30 minutes. */
  readonly timeoutMs?: number;
  /** Signal used on timeout. Default SIGTERM, then SIGKILL after `killGraceMs`. */
  readonly killSignal?: NodeJS.Signals;
  /** Milliseconds between the timeout signal and SIGKILL. Default 5s. */
  readonly killGraceMs?: number;
}

export interface PhaseCheckResult {
  readonly command: string;
  readonly cwd: string;
  readonly shell: string;
  /** null when the process was killed rather than exiting on its own. */
  readonly exitCode: number | null;
  /** The signal that killed it, when one did. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Exit 0, and it actually exited. */
  readonly passed: boolean;
}

/** The thread still had a turn running when a check was requested. */
export class TurnActiveError extends Error {
  constructor(readonly threadId: string) {
    super(
      `Refusing to run a phase check on thread ${threadId}: a turn is active.\n` +
        `  Checks run BETWEEN turns. Running one against a worktree an agent is ` +
        `still writing measures a tree that is mid-edit, and the result would be ` +
        `reported as the phase's verdict.`,
    );
    this.name = 'TurnActiveError';
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run one check to completion and report what happened.
 *
 * Never throws for a failing check — a non-zero exit is a result, not an
 * exception. It throws only when the process could not be started at all.
 */
export async function runPhaseCheck(options: PhaseCheckOptions): Promise<PhaseCheckResult> {
  const shell = options.shell ?? 'bash';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return await new Promise<PhaseCheckResult>((resolve, reject) => {
    const child = spawn(shell, ['-lc', options.command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(options.killSignal ?? 'SIGTERM');
      // A check that ignores SIGTERM must not hold the phase open forever.
      killTimer = setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 5_000);
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command: options.command,
        cwd: options.cwd,
        shell,
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        passed: code === 0 && !timedOut,
      });
    });
  });
}
