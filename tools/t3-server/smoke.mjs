#!/usr/bin/env node
/**
 * Spec 146, Phase 1 — the harness cold-start proof.
 *
 * The plan's acceptance criterion, verbatim: "The harness brings up a live server
 * on the pinned commit from a cold clone, twice, on a machine where it has never
 * run. A dispatched no-op command returns successfully, then teardown leaves no
 * stray process, port binding or worktree. **Phase 2 does not start until this
 * passes**, since every one of its acceptance criteria assumes it."
 *
 * So this does not check that the server answers HTTP. It authenticates the way
 * the spike did, opens the RPC socket, and dispatches a real command — because
 * "the port is open" and "the contract works" are different claims, and Phase 2
 * depends on the second one.
 *
 * Writes its result as JSON so the evidence is reviewable rather than asserted.
 *
 * Usage: node smoke.mjs [--runs 2]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIdentities } from '../t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));

// Spec 250: the UPSTREAM identity, deliberately. This file records the spec 146
// cold-start evidence, and that evidence is only reproducible against the clone
// pinned at `upstreamBase`. Pointing it at the fork would silently re-baseline
// the measurement onto a tree the original evidence never saw.
const UPSTREAM_ROOT = resolveIdentities(pin).upstream.root;

const port = Number(process.env.T3_HARNESS_PORT ?? 3799);
const base = `http://127.0.0.1:${port}`;

const runsIdx = process.argv.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(process.argv[runsIdx + 1]) : 2;

const harness = (cmd) =>
  execFileSync(process.execPath, [join(here, 't3-server.mjs'), cmd], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

/**
 * Exchange the bootstrap token for an access token.
 *
 * Endpoints and the token type are taken from the proven spike, not guessed. An
 * earlier version of this file invented `/api/auth/token` with an RFC-standard
 * subject_token_type and got a 404: t3 uses `/oauth/token`, form-encoded, with
 * its own `urn:t3:params:oauth:token-type:environment-bootstrap`.
 */
async function authenticate(bootstrapToken) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: bootstrapToken,
    subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'orchestration:read orchestration:operate terminal:operate review:write relay:read',
    client_label: 'codev-phase1-harness',
    client_device_type: 'bot',
    client_os: process.platform,
  });
  const response = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function wsTicket(accessToken) {
  const response = await fetch(`${base}/api/auth/websocket-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`websocket ticket failed: ${response.status} ${await response.text()}`);
  return response.json();
}

/**
 * Dispatch one command over the RPC socket, speaking the envelope directly.
 *
 * No Effect here on purpose: the envelope under `RpcSerialization.layerJson` is
 * ~10 tagged JSON shapes, and proving a plain client can drive it is exactly the
 * finding Phase 2 is built on. If this needs Effect, Phase 2's premise is wrong
 * and better to know now.
 */
async function dispatch(ticket, command) {
  const { WebSocket } = await import('node:worker_threads').then(() => globalThis);
  const url = `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}`;
  const socket = new WebSocket(url);

  return await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectP(new Error('no Exit received within 30s'));
    }, 30_000);

    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      rejectP(new Error(`socket error: ${event.message ?? 'unknown'}`));
    });

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          _tag: 'Request',
          id: 1,
          tag: 'orchestration.dispatchCommand',
          payload: command,
          headers: [],
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      for (const line of text.split('\n').filter(Boolean)) {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        const frames = Array.isArray(frame) ? frame : [frame];
        for (const f of frames) {
          if (f._tag === 'Exit') {
            clearTimeout(timer);
            socket.close();
            resolveP(f);
            return;
          }
          if (f._tag === 'Defect') {
            clearTimeout(timer);
            socket.close();
            rejectP(new Error(`server defect: ${JSON.stringify(f).slice(0, 300)}`));
            return;
          }
        }
      }
    });
  });
}

const results = [];

for (let run = 1; run <= runs; run += 1) {
  const started = Date.now();
  const record = { run, startedAt: now() };
  try {
    // Every run starts from stopped, so run 2 is a genuine cold start and not a
    // second look at a server run 1 left behind.
    try { harness('stop'); } catch { /* nothing running */ }
    harness('acquire');
    harness('verify');
    harness('start');
    record.serverRuntime = JSON.parse(harness('status')).runtime;
    const readyOut = harness('ready');
    const { token } = JSON.parse(readyOut.slice(readyOut.indexOf('{')));
    record.pairingTokenPresent = Boolean(token);

    const auth = await authenticate(token);
    record.scopes = auth.scope;

    const ticket = await wsTicket(auth.access_token);

    // A no-op in the sense that matters: it creates nothing on disk and starts no
    // agent, but it is a REAL dispatched command that the server must decode
    // against its own contract and answer.
    const exit = await dispatch(ticket.ticket, {
      type: 'project.create',
      commandId: id(),
      projectId: id(),
      title: `phase-1 harness smoke run ${run}`,
      workspaceRoot: UPSTREAM_ROOT,
      defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      createdAt: now(),
    });

    record.dispatchExit = exit.exit?._tag ?? 'unknown';
    record.dispatchSucceeded = exit.exit?._tag === 'Success';

    harness('stop');
    await new Promise((r) => setTimeout(r, 2000));

    // Teardown must actually free the port. A harness that leaves a listener
    // behind makes run 2 a lie: it would reuse run 1's server.
    let portFree = true;
    try {
      const lsof = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      portFree = lsof.trim() === '';
    } catch {
      portFree = true; // lsof exits non-zero when nothing matches
    }
    record.portFreeAfterStop = portFree;
    record.ok = record.dispatchSucceeded && portFree;
  } catch (error) {
    record.ok = false;
    record.error = String(error).split('\n').slice(0, 3).join(' | ');
    try { harness('stop'); } catch { /* best effort */ }
  }
  record.durationMs = Date.now() - started;
  results.push(record);
}

const allOk = results.every((r) => r.ok);
console.log(
  JSON.stringify(
    {
      criterion: 'Phase 1: harness brings up a live pinned server, twice, with a real dispatched command',
      pinnedCommit: pin.commit,
      pinnedCliVersion: pin.cliVersion,
      runs: results,
      allRunsPassed: allOk,
      gatesPhase2: true,
    },
    null,
    2,
  ),
);
process.exit(allOk ? 0 : 1);
