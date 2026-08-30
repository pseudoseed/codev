#!/usr/bin/env node
/**
 * Spec 146 — the pinned t3code server harness.
 *
 * Phases 1 through 4 all say "against a live server on the pinned commit", and
 * before this existed nothing provided one. Worse, nothing checked: a phase could
 * pass against whatever server happened to be listening, which makes the pin a
 * comment rather than a control.
 *
 * So `verify` is the load-bearing verb here, not `start`. The architect's
 * instruction is explicit — do not let a later phase quietly test against the
 * wrong server, and make that failure loud.
 *
 * Commands:
 *   acquire   clone/fetch the pinned commit into a checkout
 *   verify    assert the checkout, and any running server, match pin.json
 *   start     start a server from the pinned checkout on a private data dir
 *   restart   stop and start again, KEEPING the data dir
 *   stop      stop it
 *   status    report what is running and whether it matches the pin
 *
 * Exit codes: 0 ok, 1 mismatch or failure, 3 "could not determine".
 * Three codes, not two, because "I could not tell" must not exit the same way as
 * "verified fine".
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));

const t3Root = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';
const runtimeDir = process.env.T3_HARNESS_DIR ?? join(here, '.runtime');
const pidFile = join(runtimeDir, 'server.pid');
const portFile = join(runtimeDir, 'server.port');
const runtimeFile = join(runtimeDir, 'server-runtime.json');
const port = Number(process.env.T3_HARNESS_PORT ?? 3799);

const OK = 0;
const MISMATCH = 1;
const UNDETERMINED = 3;

function say(message) {
  console.error(`[t3-server] ${message}`);
}

function die(code, message) {
  say(message);
  process.exit(code);
}

function gitIn(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// ------------------------------------------------------------------ acquire

function acquire() {
  if (!existsSync(t3Root)) {
    die(
      UNDETERMINED,
      `No checkout at ${t3Root}. Clone it first:\n` +
        `  git clone ${pin.repo} ${t3Root}\n` +
        `Then re-run. This harness never clones into a path it did not create.`,
    );
  }
  try {
    gitIn(t3Root, 'cat-file', '-e', `${pin.commit}^{commit}`);
    say(`pinned commit ${pin.commit.slice(0, 12)} already present`);
  } catch {
    say(`fetching ${pin.commit.slice(0, 12)}...`);
    gitIn(t3Root, 'fetch', 'origin');
  }

  // Actually check it out. An earlier version fetched and then said "acquire ok",
  // leaving the tree wherever it already was — so `acquire` reported success
  // without acquiring anything, and only `verify` would have noticed.
  const head = gitIn(t3Root, 'rev-parse', 'HEAD');
  if (head !== pin.commit) {
    const dirty = gitIn(t3Root, 'status', '--porcelain');
    if (dirty) {
      die(
        MISMATCH,
        `Checkout has uncommitted changes; refusing to check out ${pin.commit.slice(0, 12)} over them.\n${dirty}`,
      );
    }
    say(`checking out ${pin.commit.slice(0, 12)} (was ${head.slice(0, 12)})`);
    gitIn(t3Root, 'checkout', '--detach', pin.commit);
  }

  verify();
}

// ------------------------------------------------------------------ verify

function verify(mismatchSignal = 'CHECKOUT_MISMATCH') {
  if (!existsSync(t3Root)) {
    die(UNDETERMINED, `No checkout at ${t3Root}; cannot verify. This is "unknown", not "fine".`);
  }

  let head;
  try {
    head = gitIn(t3Root, 'rev-parse', 'HEAD');
  } catch (error) {
    die(UNDETERMINED, `Could not read HEAD of ${t3Root}: ${error.message}`);
  }

  if (head !== pin.commit) {
    die(
      MISMATCH,
      `${mismatchSignal}\n` +
        `  pin.json: ${pin.commit}\n` +
        `  checkout: ${head}\n` +
        `Any phase that tested against this was not testing the pinned contract.`,
    );
  }

  let dirty = '';
  try {
    dirty = gitIn(t3Root, 'status', '--porcelain');
  } catch {
    /* reported below as undetermined */
  }
  if (dirty) {
    die(
      MISMATCH,
      `Checkout is at the pinned commit but has uncommitted changes:\n${dirty}\n` +
        `The clone is meant to be read-only. Results from it are not reproducible.`,
    );
  }

  say(`verified: ${t3Root} is clean at ${pin.commit.slice(0, 12)} (${pin.commitDate})`);
  return head;
}

// ------------------------------------------------------------------ start / stop

function parsedVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

/** The checkout currently declares a caret range. Unknown syntax stays advisory/unknown. */
function engineMatch(version, range) {
  const actual = parsedVersion(version);
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)?.slice(1).map(Number);
  if (!actual || !wanted) return null;
  const [major, minor, patch] = actual;
  const [wantMajor, wantMinor, wantPatch] = wanted;
  const atLeast = major > wantMajor ||
    (major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch)));
  const belowUpper = wantMajor > 0 ? major < wantMajor + 1
    : wantMinor > 0 ? major === 0 && minor < wantMinor + 1
      : major === 0 && minor === 0 && patch < wantPatch + 1;
  return atLeast && belowUpper;
}

/** Resolve the server interpreter once, then invoke it by absolute path. */
function serverRuntime() {
  const requested = process.env.T3_NODE?.trim();
  if (!requested) {
    die(
      UNDETERMINED,
      'NO_INTERPRETER: could not check: T3_NODE is not set. The harness never inherits its server Node from PATH.',
    );
  }

  let node;
  try {
    if (!isAbsolute(requested)) throw new Error('not absolute');
    node = realpathSync(requested);
  } catch {
    die(
      UNDETERMINED,
      `NO_INTERPRETER: could not check: T3_NODE=${requested} is not an absolute path to an executable.`,
    );
  }

  let version;
  try {
    version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch {
    die(UNDETERMINED, `NO_INTERPRETER: could not check: ${node} could not execute \`--version\`.`);
  }

  let packageJson;
  const packagePath = join(t3Root, 'package.json');
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    die(
      UNDETERMINED,
      `CHECKOUT_UNAVAILABLE: could not check: cannot read t3code package metadata at ${packagePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declaredEngine = packageJson.engines?.node ?? 'not declared';
  const matchesDeclaredEngine = engineMatch(version, declaredEngine);
  const npx = join(dirname(node), 'npx');
  let npxCli;
  try {
    npxCli = realpathSync(npx);
  } catch {
    die(UNDETERMINED, `NO_INTERPRETER: could not check: ${node} has no sibling npx executable.`);
  }

  const info = { node, version, declaredEngine, matchesDeclaredEngine, npxCli };
  if (matchesDeclaredEngine === false) {
    say(
      `ADVISORY: Node ${version} is outside t3code engines.node ${declaredEngine}; ` +
        'continuing because server readiness, not the advisory range, is the gate.',
    );
  }
  return info;
}

/**
 * Is this PID one of ours?
 *
 * `stop` used to SIGTERM every process listening on the configured port, on the
 * reasoning that the real server is a grandchild of the pid we recorded. That is
 * true and it was still wrong: on a machine where something unrelated happens to
 * hold 3799, it would have killed a service this project does not own. Review
 * caught it.
 *
 * Ownership is proven from the command line: it must be a t3 serve for OUR data
 * directory. Anything we cannot prove is ours is reported and left alone.
 */
function ownsProcess(pid) {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return cmd.includes(runtimeDir) || cmd.includes(join(runtimeDir, 'data'));
  } catch {
    return false; // cannot read it, cannot claim it
  }
}

/** PIDs listening on our port that we can prove belong to this harness. */
function ownedPortHolders() {
  let holders = [];
  try {
    holders = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return { ours: [], foreign: [] };
  }
  const ours = holders.filter(ownsProcess);
  const foreign = holders.filter((p) => !ours.includes(p));
  return { ours, foreign };
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Confirm the spawned server is still alive a moment after `spawn` returned.
 *
 * `spawn` succeeding means a process was created, not that it stayed. Reporting
 * "started pid N" for a process that has already exited is a check announcing a
 * result it never measured, which is the failure mode this whole harness exists
 * to avoid making.
 */
function assertChildSurvived(pid, runtime) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      // Redact first: the log is read below and may hold a pairing token.
      pairingToken();
      const log = join(runtimeDir, 'server.log');
      const tail = existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter((line) => /error|fatal|cannot/i.test(line)).slice(-3).join('\n')
        : '';
      die(
        MISMATCH,
        `SERVER_START_FAILED: t3@${pin.cliVersion} under Node ${runtime.version} ` +
          `exited immediately after starting (pid ${pid}).\n` +
          (tail ? `  From its log:\n    ${tail.replace(/\n/g, '\n    ')}` : '  Its log records nothing.'),
      );
    }
    execFileSync('sleep', ['0.25']);
  }
}

/**
 * Start the pinned server.
 *
 * `keepData` is the whole difference between a cold start and a restart, and it
 * defaults to false because every existing caller wants a cold one: the phase-1
 * cold-start evidence is only evidence if the database is empty each time.
 *
 * A restart passes `true`, because a server that comes back with an erased
 * database is not the same server. Testing "does a thread survive a restart"
 * against a wiped data dir measures the wipe, and reports it as the thread's
 * fate.
 */
function start({ keepData = false } = {}) {
  verify();
  const runtime = serverRuntime();

  const existing = readPid();
  if (existing) die(MISMATCH, `A harness server is already running (pid ${existing}). Run \`stop\` first.`);

  mkdirSync(runtimeDir, { recursive: true });
  const dataDir = join(runtimeDir, 'data');
  if (keepData) {
    // Refuse rather than quietly cold-start. "There was nothing to preserve" and
    // "the state was preserved" must not exit the same way — a restart that
    // silently began from an empty database is exactly the false negative this
    // flag exists to prevent.
    if (!existsSync(dataDir)) {
      die(UNDETERMINED, `NO_DATA_TO_KEEP: could not check: ${dataDir} does not exist, so there is no server state to preserve. This would have been a cold start wearing a restart's name.`);
    }
  } else {
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });

  say(`starting on 127.0.0.1:${port} with data dir ${dataDir}${keepData ? ' (preserved)' : ''}`);

  const log = join(runtimeDir, 'server.log');
  // 0600: the server prints a pairing token on stdout and this file receives it
  // until `ready` redacts it. Narrow the window AND the audience.
  writeFileSync(log, '', { mode: 0o600 });

  // The child's stdio goes STRAIGHT to a file descriptor, never through a pipe
  // this process holds. An earlier version attached `child.stdout.on('data')`
  // handlers here: the server came up fine and then died the moment its parent
  // did, because writing to a broken pipe kills it. A harness whose server only
  // survives while the shell that started it survives is not a harness.
  const logFd = openSync(log, 'a');

  // Loopback only. Spec 146's Security constraints make loopback the default and
  // exposing an interface an explicit action; a test harness never exposes one.
  const child = spawn(
    runtime.node,
    [runtime.npxCli, '--yes', `t3@${pin.cliVersion}`, 'serve', '--host', '127.0.0.1', '--port', String(port), '--base-dir', dataDir, t3Root],
    {
      cwd: t3Root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // npm launches package bins through `#!/usr/bin/env node`. Put the chosen
      // interpreter first so that final hop cannot fall back to the harness's Node.
      env: { ...process.env, PATH: `${dirname(runtime.node)}:${process.env.PATH ?? ''}` },
    },
  );

  closeSync(logFd);
  writeFileSync(pidFile, String(child.pid));
  writeFileSync(portFile, String(port));
  writeFileSync(runtimeFile, `${JSON.stringify({ ...runtime, cliVersion: pin.cliVersion }, null, 2)}\n`);
  child.unref();

  assertChildSurvived(child.pid, runtime);

  say(`started pid ${child.pid}; log at ${log}`);
  say(`runtime: Node ${runtime.version}; pinned CLI: t3@${pin.cliVersion}`);
}

/**
 * Wait until the server answers, with a bound. Returns true when it is up.
 *
 * `start` returning is NOT evidence the server is up — `npx` may still be
 * downloading. A phase that dispatches immediately after `start` would fail for
 * a reason that has nothing to do with what it was testing.
 */
async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (response.status > 0) return true;
    } catch {
      /* not up yet */
    }
    if (!readPid()) {
      pairingToken();
      const log = join(runtimeDir, 'server.log');
      const tail = existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter((line) => /error|fatal|cannot/i.test(line)).slice(-3).join('\n')
        : '';
      die(
        MISMATCH,
        `SERVER_START_FAILED: server process exited before answering.\n` +
          (tail ? `  From its log:\n    ${tail.replace(/\n/g, '\n    ')}` : '  Its log records nothing.'),
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Read the pairing token, then REDACT it from the log.
 *
 * The spec's Security constraint is explicit: pairing tokens are "never written
 * to a repository, a log, or a shell history file". t3 prints the token on
 * stdout and this harness sends stdout to a file, so it lands in a log — a
 * direct violation, and review caught it.
 *
 * We cannot stop t3 printing it. What we can do is make the log stop holding it:
 * read once, overwrite that line in place, and return the value in memory only.
 * The file is also mode 0600 and gitignored.
 *
 * The residual window is stated rather than hidden: the token is on disk from
 * the moment the server prints it until `ready` runs, typically a few seconds.
 * Closing that completely would mean not persisting the server's stdout at all,
 * which costs the diagnostics that made three separate harness bugs findable.
 */
function pairingToken() {
  const log = join(runtimeDir, 'server.log');
  if (!existsSync(log)) return null;
  const contents = readFileSync(log, 'utf8');
  const token = /Token:\s*([A-Z0-9]+)/.exec(contents)?.[1] ?? null;
  if (token) {
    const redacted = contents
      .split(token).join('<redacted-pairing-token>')
      .replace(/(Pairing URL: \S*?#token=)\S+/g, '$1<redacted>');
    writeFileSync(log, redacted, { mode: 0o600 });
  }
  return token;
}

async function ready() {
  const up = await waitReady();
  if (!up) die(MISMATCH, `SERVER_START_FAILED: server did not answer on 127.0.0.1:${port} within the timeout.`);
  verify('CHECKOUT_MOVED_DURING_RUN');
  const token = pairingToken();
  if (!token) die(UNDETERMINED, 'Server is answering but printed no pairing token; cannot authenticate.');
  say(`ready on 127.0.0.1:${port}; pairing token present`);
  console.log(JSON.stringify({ port, token, pairingUrl: `http://127.0.0.1:${port}/pair#token=${token}` }, null, 2));
}

function stop() {
  rmSync(runtimeFile, { force: true });
  const pid = readPid();
  if (!pid) {
    // Still sweep the port: a previous run may have left a listener with no
    // matching pid file, and reporting "nothing running" while a server holds
    // the port is the same lie as a check that passes without looking.
    const { ours, foreign } = ownedPortHolders();
    for (const holder of ours) {
      try { process.kill(holder, 'SIGTERM'); } catch { /* gone */ }
    }
    if (foreign.length > 0) {
      say(
        `REFUSING to kill pid(s) ${foreign.join(', ')} on port ${port}: not ours.\n` +
          `  Something outside this harness is listening there. Stop it yourself, or set\n` +
          `  T3_HARNESS_PORT to a free port. This harness does not kill what it cannot prove it owns.`,
      );
    }
    say(ours.length > 0 ? `no pid file, but released port ${port} (pids ${ours.join(', ')})` : 'nothing running');
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
  rmSync(pidFile, { force: true });

  // The recorded pid is the `npx` wrapper; the server is its grandchild and can
  // outlive a group signal. Without this the port stays bound, and a later
  // "cold" start would silently reuse the previous server — making a
  // start-twice proof a proof of nothing.
  const { ours, foreign } = ownedPortHolders();
  for (const holder of ours) {
    try { process.kill(holder, 'SIGTERM'); } catch { /* gone */ }
  }
  if (ours.length > 0) say(`released port ${port} (pids ${ours.join(', ')})`);
  if (foreign.length > 0) say(`left pid(s) ${foreign.join(', ')} on port ${port} alone: not ours`);

  say(`stopped pid ${pid}`);
}

/**
 * Restart the running server without erasing its state.
 *
 * `stop` then `start` is not this: `start` wipes the data dir, so the pair is a
 * cold start with a restart's shape. Spec 146 phase 9's item 4 — "an architect
 * thread survives a server restart" — cannot be evaluated against that at all,
 * because the thread is deleted by the harness rather than by anything the
 * criterion is about.
 */
function restart() {
  // A running server, first. `stop` leaves the data dir in place, so a data dir is
  // NOT evidence that anything is running — `stop` then `restart` would have
  // succeeded with no server having been replaced, and reported a restart that did
  // not happen. What item 4 asks about is a process being replaced, and that has to
  // be true before this exits 0.
  const pid = readPid();
  const holders = ownedPortHolders();
  if (!pid && holders.ours.length === 0) {
    die(
      UNDETERMINED,
      `NOT_RUNNING: could not check: no harness server is running on port ${port}` +
        (holders.foreign.length > 0
          ? `; pid(s) ${holders.foreign.join(', ')} hold it and are not ours.`
          : '.') +
        `\n  A restart of nothing is not a restart. Use \`start\` for a cold one.`,
    );
  }

  const dataDir = join(runtimeDir, 'data');
  if (!existsSync(dataDir)) {
    die(UNDETERMINED, `NO_DATA_TO_KEEP: could not check: ${dataDir} does not exist, so there is no server state to preserve.`);
  }

  stop();

  // `stop` signals; it does not wait. Starting before the old listener lets go
  // gives `start` a port already bound, and that failure has nothing to do with
  // the restart.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { ours } = ownedPortHolders();
    if (ours.length === 0) break;
    execFileSync('sleep', ['0.25']);
  }
  const stillHeld = ownedPortHolders().ours;
  if (stillHeld.length > 0) {
    die(
      UNDETERMINED,
      `PORT_NOT_RELEASED: could not check: pid(s) ${stillHeld.join(', ')} still hold port ${port} ` +
        `30s after stop. The old server was not replaced, and starting on top of it would test the ` +
        `wrong process.`,
    );
  }

  start({ keepData: true });
}

function status() {
  const pid = readPid();
  if (!existsSync(t3Root)) {
    console.log(JSON.stringify({ checkout: null, matchesPin: 'unknown', server: null }, null, 2));
    process.exit(UNDETERMINED);
  }
  const head = gitIn(t3Root, 'rev-parse', 'HEAD');
  const matches = head === pin.commit;
  console.log(
    JSON.stringify(
      {
        pin: pin.commit,
        checkout: head,
        matchesPin: matches,
        server: pid ? { pid, port: Number(readFileSync(portFile, 'utf8').trim()) } : null,
        runtime: existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, 'utf8')) : null,
      },
      null,
      2,
    ),
  );
  process.exit(matches ? OK : MISMATCH);
}

const command = process.argv[2];
switch (command) {
  case 'acquire': acquire(); break;
  case 'verify': verify(); break;
  case 'start': start(); break;
  case 'restart': restart(); break;
  case 'ready': await ready(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'runtime': console.log(JSON.stringify(serverRuntime(), null, 2)); break;
  default:
    console.error('usage: t3-server.mjs <acquire|verify|start|restart|ready|stop|status|runtime>');
    process.exit(UNDETERMINED);
}
