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
 *
 * A TIMEOUT THAT DOES NOT BOUND THE CALL IS NOT A TIMEOUT
 *
 * The first version of this file signalled the shell's own PID and resolved on
 * `close`. Both are wrong for every check porch will actually run, and the one
 * test it had used the single shape that hides it:
 *
 *  - `bash -lc 'sleep 30'` EXECS the sleep, so the shell's PID *is* the sleep's,
 *    and killing it works. `bash -lc 'sleep 20; true'` forks instead, so the
 *    signal reached a shell that was merely waiting, and the call returned after
 *    20 seconds against a 1-second budget. Every real check — `npm test`,
 *    `pnpm build` — is the compound shape. Measured by a review lane at 20,019 ms
 *    against `timeoutMs: 1000`.
 *  - `close` fires when the last holder of the stdout pipe goes away, so a
 *    backgrounded grandchild kept the promise pending long after the shell died.
 *
 *    Resolving on `exit` INSTEAD would bound it and lose output: `exit` can fire
 *    before the pipes drain, so a check that prints a lot and exits promptly would
 *    have its tail cut — and a truncated log presented as a whole one is the
 *    failure this project is about. So `close` still wins the race when it comes,
 *    and `exit` starts a short grace timer that resolves without it. The normal
 *    check keeps every byte; the pathological one is bounded.
 *
 *    The grace is not mutation-checkable here: at the output sizes a test can
 *    produce, the pipes are already empty when `exit` fires, so resolving at once
 *    passes too. It stays because the guarantee is about the case that does not
 *    reproduce on demand, and `146-phase3-mutation-check.py` records that rather
 *    than carrying a mutation that reports a meaningless green.
 *
 * So the child is `detached`, the signal goes to the process GROUP, and the
 * result resolves on `exit`.
 *
 * Those two are partly redundant, and the redundancy is deliberate rather than
 * unnoticed. Measured on this platform: `close` + attached is 20,018 ms against a
 * 700 ms budget; `exit` + attached is 705 ms; `close` + detached is 706 ms. Either
 * fix alone bounds the compound case, so no test can go red for reverting just
 * one, and `146-phase3-mutation-check.py` says so instead of carrying a mutation
 * that reports a meaningless green. They cover different escapes: the group kill
 * stops descendants, and `exit` stops a pipe-holder that escaped the group.
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
  /**
   * How long to keep draining output after the process exits. Default 500ms.
   *
   * `exit` can arrive before the pipes are empty. Waiting for `close` alone is
   * unbounded — an orphan can hold the pipe — so this is the compromise: the
   * drain wins if it finishes, and the grace ends it if it does not.
   */
  readonly drainGraceMs?: number;
  /**
   * Bytes retained per output stream. Default 4 MiB.
   *
   * A 30-minute default budget on a chatty check is otherwise an unbounded string
   * in the same process that holds the thread's capped event log. Past the cap the
   * TAIL is kept — a failing check's last lines are the ones that say why — and
   * the result says so rather than presenting a trimmed log as the whole one.
   */
  readonly maxOutputBytes?: number;
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
  /** Output was longer than the cap and the head was discarded. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Signal a whole process group, falling back to the child alone.
 *
 * `-pid` is the group, which is why the child is spawned `detached`. The fallback
 * matters: a child that has already exited makes `process.kill` throw ESRCH, and
 * a platform without process groups would otherwise turn a timeout into a crash.
 */
function signalGroup(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* no group, or it is already gone */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** Append to a capped buffer, keeping the tail. */
function appendCapped(buffer: string, chunk: string, cap: number): { text: string; truncated: boolean } {
  const combined = buffer + chunk;
  if (combined.length <= cap) return { text: combined, truncated: false };
  return { text: combined.slice(combined.length - cap), truncated: true };
}

/**
 * Run one check to completion and report what happened.
 *
 * Never throws for a failing check — a non-zero exit is a result, not an
 * exception. It throws only when the process could not be started at all.
 *
 * **`detached: true` has a consequence the caller owns.** The child is in its own
 * process group, so a Ctrl-C in porch's terminal no longer reaches it. Porch is a
 * long-lived driver that owns its checks explicitly rather than a foreground
 * command relying on terminal signal delivery, and the alternative — a timeout
 * that cannot stop the thing it is timing — is worse. A caller that shuts down
 * while a check runs must signal the group itself.
 */
export async function runPhaseCheck(options: PhaseCheckOptions): Promise<PhaseCheckResult> {
  const shell = options.shell ?? 'bash';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  return await new Promise<PhaseCheckResult>((resolve, reject) => {
    const child = spawn(shell, ['-lc', options.command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so the timeout can signal every descendant rather
      // than a shell that is merely waiting on one.
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendCapped(stdout, chunk.toString(), cap);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendCapped(stderr, chunk.toString(), cap);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, options.killSignal ?? 'SIGTERM');
      // A check that ignores SIGTERM must not hold the phase open. This is the
      // group, not the shell, so it applies to what the check spawned too.
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), options.killGraceMs ?? 5_000);
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (settled) return;
      settled = true;
      reject(error);
    });

    const finish = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (settled) return;
      settled = true;
      resolve({
        command: options.command,
        cwd: options.cwd,
        shell,
        exitCode: exitCode,
        signal: exitSignal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        passed: exitCode === 0 && !timedOut,
      });
    };

    // `close` means the pipes drained; it is the right moment when it comes.
    child.once('close', finish);

    // `exit` means the process is gone. It starts a bounded drain rather than
    // resolving at once, because the pipes may still hold this check's output —
    // and rather than waiting forever, because something that is not this check
    // may be holding them open.
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal as NodeJS.Signals | null;
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, options.drainGraceMs ?? 500);
    });
  });
}
