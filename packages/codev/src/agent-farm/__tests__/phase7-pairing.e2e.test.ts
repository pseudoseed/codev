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
    const token = pairings.issue();

    // 3. Redeem it from the DEVICE.
    const redeemed = await fetch(`${base}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: towerHeaders({
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
      headers: towerHeaders({
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
    const second = pairings.issue();
    const laptop = await fetch(`${base}${AGENT_ROUTE_PREFIX}/pairing/redeem`, {
      method: 'POST',
      headers: towerHeaders({
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
