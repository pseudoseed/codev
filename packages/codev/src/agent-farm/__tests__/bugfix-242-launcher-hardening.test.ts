/**
 * Issue #242 — `tools/t3-server/full-protocol-run.sh` built deletion paths from an
 * unvalidated label, and stopped its server only on the path that reached the end.
 *
 * Both were reproduced before the fix, and both are pinned here against the real
 * launcher rather than a paraphrase of it.
 *
 *   1. `rm -rf "${RUNS:?}/work-$LABEL"`. The `:?` guards an EMPTY `RUNS`; it says
 *      nothing about what `$LABEL` appends. With `LABEL='x/../../../../../victim'`
 *      the `rm -rf` resolved five levels above `.runtime-runs` and deleted a
 *      directory there whole.
 *   2. The only `stop` was the last line. A SIGTERM during the run — an hour for
 *      the 1h runs, a day for the gate — left the server holding its port, and once
 *      `.runtime-<label>` is gone it is orphaned beyond any `stop` and can only be
 *      killed by pid. It happened twice during #238.
 *
 * THE SANDBOX, AND WHY IT IS THE REAL SCRIPT.
 *
 * The lifetime tests copy the launcher's own bytes into a temp tree and put a stub
 * `node` ahead of it on PATH. The script under test is therefore the shipped one,
 * executed by a real bash, taking a real signal — only its two collaborators (the
 * t3 harness and the protocol runner) are stood in for, because the genuine ones
 * need a pinned t3code checkout and an hour. Asserting the presence of a `trap`
 * line in the file would test the text; this tests whether the teardown fires.
 */

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const launcherPath = join(repoRoot, 'tools', 't3-server', 'full-protocol-run.sh');

/**
 * A stub `node` covering exactly the four calls the launcher makes: the three
 * `t3-server.mjs` subcommands, the one-liner that maps a harness to a driver kind,
 * and the protocol runner. Every `stop` is appended to `$STOP_LOG`, which is how a
 * teardown that happened is told apart from one that did not.
 */
const STUB_NODE = `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then case "\${!#}" in claude) printf claudeAgent;; *) printf '%s' "\${!#}";; esac; exit 0; fi
case "$*" in
  *t3-server.mjs\\ start*) mkdir -p "$T3_HARNESS_DIR/data"; echo "START" >> "$STOP_LOG"; exit 0;;
  *t3-server.mjs\\ restart*) exit 0;;
  *t3-server.mjs\\ ready*) echo '{"port": 1, "token": "tok"}'; exit 0;;
  *t3-server.mjs\\ stop*) echo "STOP" >> "$STOP_LOG"; exit 0;;
  *air-235-full-protocol.mjs*)
    echo "RUNNER" >> "$STOP_LOG"
    # The stub sleeps in the BACKGROUND and traps, so the signal that ends the
    # launcher ends this too. A foreground \`sleep\` is a grandchild the launcher
    # never names, and it outlived every run of this file by five minutes — a
    # test that leaks a process is a test that costs someone an afternoon.
    trap 'kill "$SLEEP_PID" 2>/dev/null; exit 143' TERM INT HUP
    sleep "\${FAKE_RUN_SECONDS:-30}" & SLEEP_PID=$!
    wait "$SLEEP_PID"
    exit 7;;
esac
exit 0
`;

/** A temp tree holding the launcher's real bytes, a stub `node`, and a stop log. */
function sandbox(): { dir: string; script: string; stopLog: string; binDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bugfix-242-'));
  const toolDir = join(dir, 'tools', 't3-server');
  const binDir = join(dir, 'bin');
  mkdirSync(toolDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const script = join(toolDir, 'full-protocol-run.sh');
  writeFileSync(script, readFileSync(launcherPath));
  const stub = join(binDir, 'node');
  writeFileSync(stub, STUB_NODE);
  chmodSync(stub, 0o755);
  return { dir, script, stopLog: join(dir, 'stop.log'), binDir };
}

/** A port nothing is listening on, so the launcher's PORT_IN_USE guard stays quiet. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const stopsAfterRunner = (log: string): number => {
  const lines = log.split('\n');
  const started = lines.indexOf('RUNNER');
  return started === -1 ? 0 : lines.slice(started).filter((l) => l === 'STOP').length;
};

describe('Issue #242 — the launcher validates its arguments', () => {
  /*
   * Against the REAL script at its real path, because the refusal has to come
   * before anything is built from the argument — including before the `T3_NODE`
   * check, which is what the unfixed script answered with instead (exit 3,
   * NO_INTERPRETER) while the label sat unexamined.
   */
  const run = (args: string[]) =>
    spawnSync('bash', [launcherPath, ...args], { encoding: 'utf8', env: { ...process.env, T3_NODE: '' } });

  it('refuses a label that would take `rm -rf` out of .runtime-runs', () => {
    const result = run(['3999', 'claude', 'claude-haiku-4-5', '60', 'x/../../../../../victim']);
    expect(result.status, `stderr: ${result.stderr}`).toBe(2);
    expect(result.stderr).toContain('BAD_LABEL');
    /*
     * A separator is the escape, and a bare `..` is NOT — the `.runtime-`/`work-`
     * prefixes absorb it into a literal `.runtime-..`. That near-miss is what makes
     * a `..` blocklist look sufficient, so the check is a whitelist and this case
     * pins the whitelist rather than the blocklist that would have passed it.
     */
    const spaced = run(['3999', 'claude', 'm', '60', 'two words']);
    expect(spaced.status).toBe(2);
    expect(spaced.stderr).toContain('BAD_LABEL');
    const empty = run(['3999', 'claude', 'm', '60', '']);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('BAD_LABEL');
  });

  it('accepts the labels the recorded runs actually used', () => {
    // These reach the T3_NODE check and stop there, which is the pre-existing
    // refusal — proof the whitelist did not narrow the documented interface.
    for (const label of ['claude-1h', 'opencode-1h', 'gate-24h', 'a.b_c-1']) {
      const result = run(['3803', 'claude', 'claude-haiku-4-5', '3600', label]);
      expect(result.stderr, `label ${label} was rejected`).not.toContain('BAD_LABEL');
      expect(result.stderr, `label ${label} did not reach the T3_NODE check`).toContain('NO_INTERPRETER');
    }
    /*
     * The MODEL is not whitelisted and must not be. `xai/grok-4.6` — one of the
     * three recorded invocations — carries a slash, and nothing builds a path from
     * it. Pinned because "harden the other arguments too" is the obvious next edit
     * and it would refuse a documented run.
     */
    const slashModel = run(['3804', 'opencode', 'xai/grok-4.6', '3600', 'opencode-1h']);
    expect(slashModel.stderr).toContain('NO_INTERPRETER');
    expect(slashModel.stderr).not.toMatch(/BAD_(LABEL|PORT|GATE)/);
  });

  it('refuses a port outside 1..65535 and a non-numeric gate', () => {
    expect(run(['99999', 'claude', 'm', '60', 'ok']).status).toBe(2);
    expect(run(['99999', 'claude', 'm', '60', 'ok']).stderr).toContain('BAD_PORT');
    expect(run(['0', 'claude', 'm', '60', 'ok']).stderr).toContain('BAD_PORT');
    expect(run(['38 03', 'claude', 'm', '60', 'ok']).stderr).toContain('BAD_PORT');
    expect(run(['3803', 'claude', 'm', 'abc', 'ok']).status).toBe(2);
    expect(run(['3803', 'claude', 'm', 'abc', 'ok']).stderr).toContain('BAD_GATE');
    // The boundary itself, both sides.
    expect(run(['65536', 'claude', 'm', '60', 'ok']).stderr).toContain('BAD_PORT');
    expect(run(['65535', 'claude', 'm', '60', 'ok']).stderr).toContain('NO_INTERPRETER');
  });

  it('refuses a port too long for `[` to compare, rather than falling through it', () => {
    /*
     * `[ "$PORT" -lt 1 ]` on a 30-digit port prints "integer expression expected"
     * and returns 2, which an `if` reads as false — so the FIRST version of this
     * guard let such a port through and the run continued to a refusal about
     * something else. A guard whose failure mode is falling through reads as a
     * guard while being none, which is why the shape is now matched before the
     * value is compared. Found by the codex review lane on PR #282.
     */
    const huge = run(['999999999999999999999999999999', 'claude', 'm', '60', 'ok']);
    expect(huge.status, `stderr: ${huge.stderr}`).toBe(2);
    expect(huge.stderr).toContain('BAD_PORT');
    expect(huge.stderr, 'the guard fell through to a later, unrelated refusal')
      .not.toContain('NO_INTERPRETER');
    expect(huge.stderr, '`[` was reached with a value it cannot compare')
      .not.toContain('integer expression expected');
    // A leading zero is refused for the same reason: `[ 08 -gt … ]` reads it as octal.
    expect(run(['03803', 'claude', 'm', '60', 'ok']).stderr).toContain('BAD_PORT');
    // And the gate is length-bounded even though nothing here compares it.
    const longGate = run(['3803', 'claude', 'm', '9999999999', 'ok']);
    expect(longGate.status).toBe(2);
    expect(longGate.stderr).toContain('BAD_GATE');
    expect(run(['3803', 'claude', 'm', '999999999', 'ok']).stderr).toContain('NO_INTERPRETER');
  });
});

describe('Issue #242 — the launcher stops the server it started, on every exit', () => {
  it('tears the server down when the run is signalled mid-flight', async () => {
    const box = sandbox();
    const port = await freePort();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn('bash', [box.script, String(port), 'claude', 'model', '60', 'trap-check'], {
        env: {
          ...process.env,
          PATH: `${box.binDir}:${process.env.PATH ?? ''}`,
          T3_NODE: '/usr/bin/true',
          STOP_LOG: box.stopLog,
          FAKE_RUN_SECONDS: '30',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child!.on('exit', (code) => resolve(code)));

      const reached = await waitFor(() =>
        existsSync(box.stopLog) && readFileSync(box.stopLog, 'utf8').includes('RUNNER'));
      expect(reached, `the launcher never reached the runner. stderr: ${stderr}`).toBe(true);

      child.kill('SIGTERM');
      const code = await exited;

      const log = readFileSync(box.stopLog, 'utf8');
      expect(
        stopsAfterRunner(log),
        `the interrupted run left its server up. stop log:\n${log}\nstderr: ${stderr}`,
      ).toBe(1);
      expect(code, 'a SIGTERM-ed run must not report the runner\'s status').toBe(143);
      expect(stderr).toContain('INTERRUPTED trap-check');
    } finally {
      child?.kill('SIGKILL');
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('tears the server down on SIGHUP, which the 24-hour gate outlives a terminal to meet', async () => {
    /*
     * The gate runs for a day. The terminal that started it does not, and a
     * closed one delivers HUP — which the first version of this fix did not
     * trap, so it leaked the server exactly the way a Ctrl-C used to. Raised by
     * the claude review lane on PR #282.
     */
    const box = sandbox();
    const port = await freePort();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn('bash', [box.script, String(port), 'claude', 'model', '60', 'hup-check'], {
        env: {
          ...process.env,
          PATH: `${box.binDir}:${process.env.PATH ?? ''}`,
          T3_NODE: '/usr/bin/true',
          STOP_LOG: box.stopLog,
          FAKE_RUN_SECONDS: '30',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child!.on('exit', (code) => resolve(code)));
      const reached = await waitFor(() =>
        existsSync(box.stopLog) && readFileSync(box.stopLog, 'utf8').includes('RUNNER'));
      expect(reached, `the launcher never reached the runner. stderr: ${stderr}`).toBe(true);

      child.kill('SIGHUP');
      const code = await exited;

      const log = readFileSync(box.stopLog, 'utf8');
      expect(stopsAfterRunner(log), `a hung-up run left its server up. stop log:\n${log}`).toBe(1);
      expect(code).toBe(129);
      expect(stderr).toContain('INTERRUPTED hup-check on SIGHUP');
    } finally {
      child?.kill('SIGKILL');
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('still reports the runner\'s exit status, and stops the server exactly once', async () => {
    /*
     * The documented contract: "The exit status is the RUNNER's, not the server's."
     * Backgrounding the runner so a trap can fire during it must not cost that, and
     * the EXIT trap must not re-run the teardown the last line already did.
     */
    const box = sandbox();
    const port = await freePort();
    try {
      const result = spawnSync('bash', [box.script, String(port), 'claude', 'model', '60', 'happy'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${box.binDir}:${process.env.PATH ?? ''}`,
          T3_NODE: '/usr/bin/true',
          STOP_LOG: box.stopLog,
          FAKE_RUN_SECONDS: '0',
        },
        timeout: 30_000,
      });
      expect(result.status, `stderr: ${result.stderr}`).toBe(7);
      expect(result.stdout).toContain('DONE happy status=7');
      const log = readFileSync(box.stopLog, 'utf8');
      expect(stopsAfterRunner(log), `stop log:\n${log}`).toBe(1);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 40_000);
});
