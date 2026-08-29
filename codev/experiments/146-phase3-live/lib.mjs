/**
 * Spec 146, Phase 3 — shared plumbing for the live harness.
 *
 * Everything here talks to a real t3code server over the real client. Nothing is
 * faked: the point of this directory is that the unit tests stand inside the two
 * crash windows with hooks, and these scenarios stand inside them with a real
 * process being killed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exchangeBootstrapToken, issueWebSocketTicket, webSocketUrl, missingScopes } from '../../../packages/t3-client/dist/auth.js';
import { T3Client } from '../../../packages/t3-client/dist/client.js';

export const PINNED_T3_VERSION = process.env.T3_LIVE_VERSION ?? 't3@0.0.35';

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const timeoutAfter = (label, ms) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label} (${ms}ms)`)), ms));

export const withTimeout = (promise, label, ms) => Promise.race([promise, timeoutAfter(label, ms)]);

/** Run a command in `cwd`, throwing on failure. Bash, because porch uses bash. */
export function shell(command, cwd) {
  const result = spawnSync('bash', ['-lc', command], { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    throw new Error(`Shell failed (${result.status}): ${command}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Start a pinned t3code server on a scratch data dir with a seed repository.
 *
 * Resolves once the bootstrap token has been printed. The token is returned in
 * memory and never written anywhere — the spec forbids it reaching a repository,
 * a log, or a shell history file.
 */
export async function startServer({ port, log = () => {} }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'spec146-phase3-'));
  const seedRepo = join(dataDir, 'seed-repo');
  await mkdir(seedRepo);
  await writeFile(join(seedRepo, 'README.md'), 'spec 146 phase 3 live harness\n');
  shell(
    "git init -q && git config user.email live@example.invalid && git config user.name 'Phase 3 Live' && " +
      'git add README.md && git commit -qm seed',
    seedRepo,
  );

  const ready = deferred();
  let serverLog = '';
  const child = spawn(
    'npx',
    ['--yes', PINNED_T3_VERSION, 'serve', '--host', '127.0.0.1', '--port', String(port), '--base-dir', dataDir, seedRepo],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const consume = (chunk) => {
    const text = chunk.toString();
    serverLog += text;
    const match = serverLog.match(/^Token: (.+)$/m);
    if (match) ready.resolve(match[1].trim());
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('exit', (code, signal) => {
    if (!serverLog.match(/^Token: (.+)$/m)) {
      ready.reject(new Error(`t3 exited before it was ready: ${code}/${signal}\n${serverLog.slice(-2000)}`));
    }
  });

  const bootstrapToken = await withTimeout(ready.promise, 't3 server ready', 120_000);
  log(`server up on 127.0.0.1:${port}`);

  return {
    dataDir,
    seedRepo,
    bootstrapToken,
    pid: child.pid,
    get log() {
      return serverLog;
    },
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(10_000)]);
    },
  };
}

/** Exchange the bootstrap token for an access token, refusing a narrowed grant silently. */
export async function authenticate(baseUrl, bootstrapToken) {
  const token = await exchangeBootstrapToken(baseUrl, bootstrapToken, { clientLabel: 'spec146-phase3-live' });
  const missing = missingScopes(token.scope);
  return { accessToken: token.access_token, scope: token.scope, missingScopes: missing };
}

/**
 * Open one authenticated connection.
 *
 * A ticket is single-use, so every connection issues its own — reusing one is
 * how a reconnect fails in a way that looks like the server refusing us.
 */
export async function connect(baseUrl, accessToken, options = {}) {
  const ticket = await issueWebSocketTicket(baseUrl, accessToken);
  const socket = new WebSocket(webSocketUrl(baseUrl, ticket.ticket));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', (event) => reject(new Error(`socket error: ${String(event?.message ?? event)}`)), {
      once: true,
    });
  });
  const client = new T3Client(socket, options);
  return {
    socket,
    client,
    dispatcher: { call: (method, payload) => client.call(method, payload) },
    close: () => socket.close(),
  };
}

/** A scenario result carrying the three states the evidence file distinguishes. */
export const demonstrated = (scenario, fields) => ({
  scenario,
  state: 'demonstrated',
  stateMeaning: 'Ran against a live pinned server and passed.',
  ...fields,
});

export const notDemonstrated = (scenario, fields) => ({
  scenario,
  state: 'not-demonstrated',
  stateMeaning:
    'The scenario did not run to a verdict — preconditions absent, or nothing to observe. ' +
    'This says NOTHING about whether the code works, and is not a failure.',
  ...fields,
});

export const failed = (scenario, fields) => ({
  scenario,
  state: 'failed',
  stateMeaning: 'Ran against a live pinned server and the assertion did not hold.',
  ...fields,
});
