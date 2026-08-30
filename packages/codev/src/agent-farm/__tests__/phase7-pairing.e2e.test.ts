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

/**
 * Every mint names the ceremony it is for and what authorized it.
 *
 * These tests walk the operator runbook, so they mint as the runbook does: an
 * operator at the host, pairing a device. The store cannot verify that — a
 * same-uid process can mint its own token — so `authority` records the claim
 * rather than asserting it.
 */
const RUNBOOK_MINT = {
  purpose: 'machine-credential' as const,
  authority: 'operator at the host, following the pairing runbook',
};

const PORT = 14910;

let tower: Awaited<ReturnType<typeof startTower>> | null = null;
let workspacePath: string | null = null;

/** Tower's shared local key. A different boundary from the machine credential. */
function towerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'codev-tower-key': ensureLocalKey(), ...extra };
}

/**
 * Headers for a request that carries NO host key.
 *
 * `vitest-e2e-setup.ts` wraps global `fetch` and injects `codev-tower-key` on
 * every loopback call, so simply omitting the header does not omit it — the first
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

    // 1. Before pairing, the protocol state is not readable — even holding
    //    Tower's own key, which is the point of adding a second credential.
    const unpaired = await fetch(`${base}${statePath}`, { headers: towerHeaders() });
    expect(unpaired.status).toBe(401);
    expect((await unpaired.json() as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED);

    // 2. Issue a pairing token on the HOST, as the runbook says to.
    const pairings = new PairingStore({ root: join(farmDir, 'pairing') });
    const token = pairings.issue(RUNBOOK_MINT);

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

    // 5. The credential reads protocol state. A 200 with real content, not just
    //    the absence of a refusal.
    const paired = await fetch(`${base}${statePath}`, {
      headers: towerHeaders({ 'x-codev-machine-credential': credential }),
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
      headers: towerHeaders({ 'x-codev-machine-credential': credential }),
    });
    expect(revoked.status).toBe(403);
    const body = await revoked.json() as { signal: string };
    expect(body.signal).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED);
    expect(body.signal).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN);

    // 8. A second machine paired after the revocation still works, so the
    //    revocation was per machine and not a service-wide lockout.
    const second = pairings.issue(RUNBOOK_MINT);
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
      headers: towerHeaders({ 'x-codev-machine-credential': laptopCredential }),
    });
    expect(laptopRead.status).toBe(200);
  }, 30000);

  // THE PREMISE OF THIS TEST INVERTED, and saying so is the point.
  //
  // It used to assert that every agent route except pairing needed the host key.
  // That was true and it was the defect: a paired remote device holds a machine
  // credential and nothing else, so the surface it had just been admitted to was
  // unreachable. The whole prefix now delegates to `agent-auth.ts`.
  //
  // So what is asserted here is the other half — that the delegation is SCOPED.
  // Tower's own routes must still demand the key, or the exemption widened past
  // the surface it was written for.
  it('agent routes are reachable without the host key, and Tower routes are not', async () => {
    // Agent surface: reached, and refused by ITS OWN layer with its own signal.
    for (const [method, path] of [
      ['GET', `${AGENT_ROUTE_PREFIX}/session`],
      ['GET', `${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/state`],
      ['POST', `${AGENT_ROUTE_PREFIX}/approval-capabilities`],
      ['DELETE', `${AGENT_ROUTE_PREFIX}/machines/ipad`],
    ] as const) {
      const response = await fetch(`${base()}${path}`, { method, headers: keylessHeaders() });
      const body = await response.text();
      expect(response.status, `${method} ${path}`).toBe(401);
      // agent-auth's refusal, not Tower's bare "Unauthorized". If this said
      // Unauthorized, the key would still be gating the surface.
      expect(body, `${method} ${path} was refused by Tower, not by agent-auth`)
        .toContain('MACHINE_CREDENTIAL_REQUIRED');
    }

    // A path under the prefix that the table does not name is a 404 from
    // agent-auth's dispatcher — reached, and serving nothing.
    const unknown = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/not-a-route`, {
      headers: keylessHeaders(),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('AGENT_ROUTE_NOT_FOUND');

    // TOWER'S OWN ROUTES ARE UNCHANGED. This is the assertion that fails if the
    // exemption ever widens beyond the agent prefix.
    for (const path of ['/api/status', '/api/instances', '/api/agent/v2/session']) {
      const response = await fetch(`${base()}${path}`, { headers: keylessHeaders() });
      expect(response.status, `${path} became keyless with the agent surface`).toBe(401);
      expect(await response.text(), `${path} was not refused by Tower`).toContain('Unauthorized');
    }
  }, 20000);

  // The flow the runbook actually describes, end to end, with the credential a
  // paired device really holds and nothing else.
  it('a paired device drives the surface with its machine credential alone', async () => {
    const pairings = new PairingStore({ root: join(tower!.agentFarmDir, 'pairing') });
    const token = pairings.issue(RUNBOOK_MINT);
    const redeemed = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': token.token,
      }),
      body: JSON.stringify({ machine: 'remote-ipad' }),
    });
    expect(redeemed.status).toBe(201);
    const credential = (await redeemed.json() as { credential: string }).credential;

    const statePath =
      `${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/state`;
    const read = await fetch(`${base()}${statePath}`, {
      headers: keylessHeaders({ 'x-codev-machine-credential': credential }),
    });
    expect(read.status).toBe(200);
    expect((await read.json() as { schemaVersion: number }).schemaVersion).toBe(1);

    // And the elevation boundary still holds for a device that has only paired:
    // approving a gate needs a human session, which pairing does not grant.
    const approve = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/approval-capabilities`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-machine-credential': credential,
      }),
      body: '{}',
    });
    expect(approve.status).toBe(401);
    expect((await approve.json() as { signal: string }).signal).toBe('HUMAN_SESSION_REQUIRED');
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

  // CODEX'S ITERATION-3 FINDING, against a live server.
  //
  // The revocation test above revokes and then makes a NEW request, which is the
  // path that already worked. This opens the stream FIRST and revokes underneath
  // it — the path that did not, and the one success criterion 15 actually
  // describes, because an already-open stream is the subtree that must fail
  // closed.
  it('revocation closes a stream that was already open, and says why', async () => {
    const pairings = new PairingStore({ root: join(tower!.agentFarmDir, 'pairing') });
    const machines = new MachineCredentialStore({ root: join(tower!.agentFarmDir, 'machines') });
    const token = pairings.issue(RUNBOOK_MINT);
    const redeemed = await fetch(`${base()}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: keylessHeaders({
        'content-type': 'application/json',
        'x-codev-pairing-token': token.token,
      }),
      body: JSON.stringify({ machine: 'streaming-ipad' }),
    });
    const credential = (await redeemed.json() as { credential: string }).credential;

    const controller = new AbortController();
    const stream = await fetch(
      `${base()}${AGENT_ROUTE_PREFIX}/workspaces/${encodeWorkspacePath(workspacePath!)}/stream`,
      {
        headers: keylessHeaders({ 'x-codev-machine-credential': credential }),
        signal: controller.signal,
      },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';

    // The opening snapshot arrives while the credential is good, so the test can
    // tell "the stream was live and then stopped" from "it never worked".
    const first = await reader.read();
    received += decoder.decode(first.value ?? new Uint8Array());
    expect(received).toContain('protocol-state');

    // Revoke underneath the open connection.
    expect(machines.revoke('streaming-ipad')).toBe(true);

    // The stream must announce and end within the re-authorize interval.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !received.includes('STREAM_AUTHORIZATION_LOST')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value ?? new Uint8Array());
    }
    controller.abort();

    expect(received).toContain('STREAM_AUTHORIZATION_LOST');
    // Withdrawn, not dropped. A stream that simply went silent would be
    // indistinguishable from a network failure.
    expect(received).toContain('MACHINE_CREDENTIAL_REVOKED');
  }, 30000);

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
