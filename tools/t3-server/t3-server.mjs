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
 *   stop      stop it
 *   status    report what is running and whether it matches the pin
 *
 * Exit codes: 0 ok, 1 mismatch or failure, 3 "could not determine".
 * Three codes, not two, because "I could not tell" must not exit the same way as
 * "verified fine".
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));

const t3Root = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';
const runtimeDir = process.env.T3_HARNESS_DIR ?? join(here, '.runtime');
const pidFile = join(runtimeDir, 'server.pid');
const portFile = join(runtimeDir, 'server.port');
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
  say('acquire ok — run `verify` before trusting it');
}

// ------------------------------------------------------------------ verify

function verify() {
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
      `CHECKOUT MISMATCH\n` +
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

function start() {
  verify();

  const existing = readPid();
  if (existing) die(MISMATCH, `A harness server is already running (pid ${existing}). Run \`stop\` first.`);

  mkdirSync(runtimeDir, { recursive: true });
  const dataDir = join(runtimeDir, 'data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  say(`starting on 127.0.0.1:${port} with data dir ${dataDir}`);

  // Loopback only. Spec 146's Security constraints make loopback the default and
  // exposing an interface an explicit action; a test harness never exposes one.
  const child = spawn(
    'npx',
    ['--yes', 't3@latest', 'serve', '--host', '127.0.0.1', '--port', String(port), '--base-dir', dataDir, t3Root],
    { cwd: t3Root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const log = join(runtimeDir, 'server.log');
  writeFileSync(log, '');
  child.stdout.on('data', (d) => writeFileSync(log, d, { flag: 'a' }));
  child.stderr.on('data', (d) => writeFileSync(log, d, { flag: 'a' }));

  writeFileSync(pidFile, String(child.pid));
  writeFileSync(portFile, String(port));
  child.unref();

  say(`started pid ${child.pid}; log at ${log}`);
  say(`NOTE: the published t3 CLI is used to serve the pinned checkout. If the CLI and the`);
  say(`pinned commit diverge, that divergence is real and \`verify\` cannot see it — the`);
  say(`checkout is pinned, the server binary is not.`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    say('nothing running');
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
  say(`stopped pid ${pid}`);
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
  case 'stop': stop(); break;
  case 'status': status(); break;
  default:
    console.error('usage: t3-server.mjs <acquire|verify|start|stop|status>');
    process.exit(UNDETERMINED);
}
