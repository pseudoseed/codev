/**
 * Spec 146 Phase 7: the pairing flow against a LIVE server, then teardown.
 *
 * The unit tests in `agent-auth.test.ts` drive the dispatcher in-process. This
 * one spawns a real Tower and goes over the wire, because the deliverable is a
 * property of the running service and the unit tests cannot see the wiring
 * between Tower's own request-authentication choke point and codev-agent's.
 *
 * It follows the runbook's own sequence — issue a token on the host, redeem it
 * from the device, use the credential, revoke the device — so the runbook is
 * tested rather than merely authored.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import {
  startTower,
  cleanupTestDb,
  createTestWorkspace,
  cleanupTestWorkspace,
  encodeWorkspacePath,
  activateWorkspace,
} from './helpers/tower-test-utils.js';
import { PairingStore } from '../lib/pairing.js';
import { MachineCredentialStore, MACHINE_SIGNAL } from '../lib/machine-credentials.js';
import { AGENT_ROUTE_PREFIX } from '../servers/agent-auth.js';

const PORT = 14910;

let tower: Awaited<ReturnType<typeof startTower>> | null = null;
let workspacePath: string | null = null;

/** Tower's shared local key. A different boundary from the machine credential. */
function towerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'codev-tower-key': ensureLocalKey(), ...extra };
}

/**
 * Headers for a request that carries NO host key — which is EVERY request a
 * remote device makes.
 *
 * This is the shape of the deliverable, not an edge case. A paired iPad holds its
 * machine credential and nothing else: `~/.agent-farm/local-key` is host-local,
 * and there is no step in the runbook that puts it on the device, because sending
 * every client the one all-or-nothing secret is what pairing exists to replace.
 * So a test that reaches this surface WITH the key is not testing the remote path.
 *
 * `vitest-e2e-setup.ts` wraps global `fetch` and injects `codev-tower-key` on
 * every loopback call, so simply omitting the header does not omit it — an earlier
 * version of the bootstrap test below "proved" a keyless flow while the harness
 * was quietly supplying the key. An explicitly-set empty value is that setup's own
 * documented opt-out: it satisfies `headers.has()`, so nothing is injected, and
 * the server reads an empty header as no key at all.
 */
function keylessHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'codev-tower-key': '', ...extra };
}

describe('Phase 7 pairing flow, live server', () => {
  beforeAll(async () => {
    tower = await startTower(PORT, {});
    workspacePath = createTestWorkspace();
    await activateWorkspace(PORT, workspacePath);
  }, 60000);

  afterAll(async () => {
    if (tower) await tower.stop();
    if (workspacePath) cleanupTestWorkspace(workspacePath);
    cleanupTestDb(PORT);
  });

  it('pairs a device, reads protocol state with it, and fails it closed on revocation', async () => {
    const farmDir = tower!.agentFarmDir;
    const statePath =
      `${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/state`;
    const base = `http://127.0.0.1:${PORT}`;

    // 1. Before pairing, the protocol state is not readable. Asserted twice, and
    //    the pair is the point: holding Tower's own key does not help, and not
    //    holding it does not change the answer. The machine credential is the
    //    control on this surface — the shared key is neither sufficient nor
    //    required here, which is why the key layer delegates the whole prefix.
    const unpaired = await fetch(`${base}${statePath}`, { headers: towerHeaders() });
    expect(unpaired.status).toBe(401);
    expect((await unpaired.json() as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED);

    const unpairedKeyless = await fetch(`${base}${statePath}`, { headers: keylessHeaders() });
    expect(unpairedKeyless.status).toBe(401);
    // The signal, not just the status: a keyless request that died at Tower's own
    // key check would answer a bare `Unauthorized` with no signal, which is how
    // this surface used to be unreachable rather than unauthorized.
    expect((await unpairedKeyless.json() as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED);

    // 2. Issue a pairing token on the HOST, as the runbook says to.
    const pairings = new PairingStore({ root: join(farmDir, 'pairing') });
    const token = pairings.issue();

    // 3. Redeem it from the DEVICE — carrying ONLY the pairing token.
    //
    // No `codev-tower-key`. A machine being paired for the first time does not
    // have the host-local key and there is no secure way to give it one, so a
    // bootstrap that needed it would be a documented flow that cannot work. This
    // request is the runbook's request, byte for byte in what it carries.
    const redeemed = await fetch(`${base}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': token.token,
      }),
      body: JSON.stringify({ machine: 'ipad' }),
    });
    expect(redeemed.status).toBe(201);
    const credential = (await redeemed.json() as { credential: string }).credential;
    expect(credential).toBeTruthy();

    // 4. The same token a second time is refused as already redeemed.
    const replay = await fetch(`${base}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': token.token,
      }),
      body: JSON.stringify({ machine: 'ipad' }),
    });
    expect(replay.status).toBe(401);
    expect((await replay.json() as { signal: string }).signal).toBe('PAIRING_TOKEN_REDEEMED');

    // 5. The credential ALONE reads protocol state — no host key, because the
    //    device has none. This is the assertion the phase exists for: everything
    //    above it only proves the device can be issued a credential, and a
    //    credential it cannot then use is not remote access. A 200 with real
    //    content, not just the absence of a refusal.
    const paired = await fetch(`${base}${statePath}`, {
      headers: keylessHeaders({ 'x-codev-machine-credential': credential }),
    });
    expect(paired.status).toBe(200);
    const snapshot = await paired.json() as { schemaVersion: number; workspacePath: string };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.workspacePath).toBeTruthy();

    // 6. Revoke that machine at the host, as the runbook's teardown says.
    const machines = new MachineCredentialStore({ root: join(farmDir, 'machines') });
    expect(machines.revoke('ipad')).toBe(true);

    // 7. It now fails CLOSED, with the revocation's own code — not "unknown",
    //    which would read as "never paired".
    const revoked = await fetch(`${base}${statePath}`, {
      headers: keylessHeaders({ 'x-codev-machine-credential': credential }),
    });
    expect(revoked.status).toBe(403);
    const body = await revoked.json() as { signal: string };
    expect(body.signal).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED);
    expect(body.signal).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN);

    // 8. A second machine paired after the revocation still works, so the
    //    revocation was per machine and not a service-wide lockout.
    const second = pairings.issue();
    const laptop = await fetch(`${base}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': second.token,
      }),
      body: JSON.stringify({ machine: 'laptop' }),
    });
    const laptopCredential = (await laptop.json() as { credential: string }).credential;
    const laptopRead = await fetch(`${base}${statePath}`, {
      headers: keylessHeaders({ 'x-codev-machine-credential': laptopCredential }),
    });
    expect(laptopRead.status).toBe(200);
  }, 30000);

  // The state STREAM, credential-only. A client does not poll `/state`; it lives
  // on this route, so "remote access works" is false if only the one-shot read
  // does. It is SSE over HTTP rather than a WebSocket, which is why it passes
  // through the same delegation — the WS upgrade path still requires the host key
  // and would not have carried a paired device.
  it('streams protocol state to a paired device with no host key', async () => {
    const pairings = new PairingStore({ root: join(tower!.agentFarmDir, 'pairing') });
    const redeemed = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': pairings.issue().token,
      }),
      body: JSON.stringify({ machine: 'streamer' }),
    });
    const credential = (await redeemed.json() as { credential: string }).credential;

    // SSE holds the connection open, so abort once the headers are in rather than
    // waiting on a body that is designed never to end.
    const abort = new AbortController();
    const streamPath =
      `${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/stream`;
    try {
      const response = await fetch(`${base()}${streamPath}`, {
        headers: keylessHeaders({ 'x-codev-machine-credential': credential }),
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      abort.abort();
    }
  }, 20000);

  // The runbook's own revocation request, byte for byte in what it carries: a
  // machine credential and a human session, and NO host key. We cannot mint a
  // human session against a separate Tower process from here — the registry is
  // in-memory and Phase 6 pairs a browser out of band — so this asserts the one
  // half that is reachable, which is also the half that was broken: the request
  // REACHES codev-agent and is refused for the reason the runbook names. Before
  // the key layer delegated this prefix it died at Tower's bare `Unauthorized`,
  // so a documented request that names the wrong missing credential would have
  // sent an operator looking for the wrong thing.
  it('the documented revoke request reaches codev-agent and asks for the human session', async () => {
    const response = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/machines/ipad`, {
      method: 'DELETE',
      headers: keylessHeaders({ 'x-codev-machine-credential': 'unknown.credential' }),
    });
    const body = await response.text();
    expect(body, 'the documented revoke died at the shared-key layer').not.toContain('Unauthorized');
    const signal = (JSON.parse(body) as { signal: string }).signal;
    // Its own machine credential is checked first, so a bogus one answers for the
    // machine rather than the session — either way it is codev-agent answering,
    // with a named signal, which is what the runbook's reader needs.
    expect([
      MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN,
      MACHINE_SIGNAL.MACHINE_CREDENTIAL_INVALID,
    ]).toContain(signal);
  }, 20000);

  // THE SHARED KEY IS NOT WHAT GUARDS THIS SURFACE — the machine credential is,
  // and this walks the whole table keyless to prove the delegation did not become
  // an exemption. Every route must still refuse, and must refuse with its OWN
  // named signal: a bare `Unauthorized` would mean it never reached codev-agent,
  // and pairing redemption would be the only route a device could ever call.
  //
  // The distinction the assertion turns on: unreachable and unauthorized are not
  // the same answer, and only one of them is a boundary.
  it('no agent route is reachable without a machine credential', async () => {
    for (const [method, path] of [
      ['GET', `${AGENT_ROUTE_PREFIX}/session`],
      ['GET', `${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/state`],
      ['POST', `${AGENT_ROUTE_PREFIX}/approval-capabilities`],
      ['POST', `${AGENT_ROUTE_PREFIX}/approval-nonces`],
      ['DELETE', `${AGENT_ROUTE_PREFIX}/machines/ipad`],
    ] as const) {
      const response = await fetch(`${base()}${path}`, { method, headers: keylessHeaders() });
      const body = await response.text();
      expect(response.status, `${method} ${path} was reachable with no credential`).toBe(401);
      expect(body, `${method} ${path} did not reach codev-agent`).not.toContain('Unauthorized');
      expect((JSON.parse(body) as { signal: string }).signal, `${method} ${path} refused namelessly`)
        .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED);
    }
  }, 20000);

  // A near-miss on the one route that takes a pairing token instead of a
  // credential: same path, different method. It must not inherit the exemption.
  it('the pairing path is keyless only for the method the bootstrap uses', async () => {
    const response = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'GET',
      headers: keylessHeaders(),
    });
    // 404 from the route table, not 200 and not a bare Unauthorized: the table
    // names POST on this path and nothing else, so GET is a path that does not
    // exist rather than a route that skipped its check.
    expect(response.status).toBe(404);
    expect((await response.json() as { signal: string }).signal).toBe('AGENT_ROUTE_NOT_FOUND');
  }, 20000);

  // The shared key still guards everything OUTSIDE the agent surface. The
  // delegation is scoped to a prefix, and a prefix check is exactly the kind of
  // thing that silently widens, so this pins the boundary from the other side.
  it('leaves the rest of Tower behind the shared key', async () => {
    for (const path of ['/api/terminals', '/api/overview']) {
      const response = await fetch(`${base()}${path}`, { headers: keylessHeaders() });
      expect(response.status, `${path} was reachable without the host key`).toBe(401);
      expect(await response.text()).toContain('Unauthorized');
    }
  }, 20000);

  it('preflight advertises the machine-credential and pairing-token headers', async () => {
    const response = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.status).toBe(200);
    const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    // Without these, a browser on an allowed remote origin fails at the preflight
    // and never reaches any of Phase 7's own checks.
    expect(allowed).toContain('x-codev-machine-credential');
    expect(allowed).toContain('x-codev-pairing-token');
    expect(allowed).toContain('x-codev-human-session');
  });

  it('refuses an agent request from a disallowed Origin, over the wire', async () => {
    const response = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/session`, {
      headers: towerHeaders({ origin: 'https://evil.example' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { signal: string }).signal).toBe('ORIGIN_NOT_ALLOWED');
  });
});

function base(): string {
  return `http://127.0.0.1:${PORT}`;
}
