/**
 * Spec 146 Phase 11: THE APPROVAL PATH IS REACHABLE FROM A CLIENT.
 *
 * ## Why this file exists, and why it is not another unit test
 *
 * Phase 6 built the approval capability. Phase 7 built the route table. Both
 * shipped green, and between them there was no way for a browser to obtain the
 * human-paired session that gates issuance — `completePairing` had no caller
 * outside its own file — and no way to spend a capability, because porch reads
 * it from an environment only a server-side caller can set. Two phases marked
 * done, one criterion unreachable, and every test passing, because each test
 * drove its unit directly and none asked whether anything in production called
 * it.
 *
 * That is the third instance of the same pattern in this initiative. So this
 * test drives ONE JOURNEY over a REAL HTTP SERVER with the REAL `fetch`, from a
 * client holding nothing to a gate approved in a real `status.yaml`. Every step
 * is a request. Nothing is called directly. A route that does not exist fails it,
 * and so does a route that exists but that no request can reach.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  HUMAN_SESSION_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PAIRING_TOKEN_HEADER,
} from '../servers/agent-auth.js';
import {
  HumanPairedSessionRegistry,
  handleAgentRoute,
  initAgentRoutes,
  shutdownAgentRoutes,
} from '../servers/agent-routes.js';
import { ApprovalCapabilityStore, ApprovalNonceStore } from '../lib/approval-capability.js';
import { MachineCredentialStore } from '../lib/machine-credentials.js';
import { PairingStore } from '../lib/pairing.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const cleanup: Array<() => void> = [];
afterEach(() => {
  shutdownAgentRoutes();
  for (const undo of cleanup.splice(0)) undo();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-phase11-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A workspace with one real AIR project sitting on a requested `pr` gate. */
function workspaceWithRequestedGate(
  projectId: string,
  gateName: string,
  options: { readonly checksPass?: boolean } = {},
): string {
  const root = tmp();
  // The phase's own checks, skipped through the mechanism porch supports for it.
  // This test is about whether a client can reach an approval, not about whether
  // a throwaway directory can run a build. `checksPass: false` leaves them in,
  // which is how the refusal path below is exercised.
  if (options.checksPass !== false) {
    mkdirSync(join(root, '.codev'), { recursive: true });
    writeFileSync(join(root, '.codev', 'config.json'), JSON.stringify({
      porch: { checks: { build: { skip: true }, tests: { skip: true } } },
    }));
  }
  const projectDir = join(root, 'codev', 'projects', projectId);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'status.yaml'), yaml.dump({
    id: projectId,
    title: 'phase 11 approval path',
    protocol: 'air',
    phase: 'implement',
    plan_phases: [],
    current_plan_phase: null,
    gates: { [gateName]: { status: 'pending', requested_at: '2026-08-30T00:00:00.000Z' } },
    iteration: 1,
    build_complete: false,
    history: [],
  }));
  // The real protocol definition, so `approve` runs the real phase checks rather
  // than a shape invented here.
  cpSync(join(REPO_ROOT, 'codev-skeleton', 'protocols'), join(root, 'codev', 'protocols'), { recursive: true });
  return root;
}

interface Host {
  readonly origin: string;
  readonly pairings: PairingStore;
  readonly machines: MachineCredentialStore;
  readonly capabilities: ApprovalCapabilityStore;
  readonly workspacePath: string;
  readonly encodedWorkspace: string;
}

async function startHost(workspacePath: string): Promise<Host> {
  const stateRoot = tmp();
  const pairings = new PairingStore({ root: join(stateRoot, 'pairing') });
  const machines = new MachineCredentialStore({ root: join(stateRoot, 'machines') });
  const capabilities = new ApprovalCapabilityStore({ root: join(stateRoot, 'approval'), machine: 'test-machine' });
  const database = new Database(':memory:');
  database.exec(GLOBAL_SCHEMA);
  const workspace = normalizeWorkspacePath(workspacePath);

  initAgentRoutes({
    db: () => database,
    log: (level, message) => { if (level === 'ERROR') console.error(message); },
    isKnownWorkspace: (candidate) => normalizeWorkspacePath(candidate) === workspace,
    humanSessions: new HumanPairedSessionRegistry(),
    approvalCapabilities: capabilities,
    approvalNonces: new ApprovalNonceStore({ root: join(stateRoot, 'approval') }),
    machineCredentials: machines,
    pairings,
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (handleAgentRoute(req, res, url)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanup.push(() => { server.close(); database.close(); });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    pairings,
    machines,
    capabilities,
    workspacePath: workspace,
    encodedWorkspace: Buffer.from(workspace, 'utf8').toString('base64url'),
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

describe('a client can get from nothing to an approved gate', () => {
  it('walks the whole path over HTTP, and status.yaml records who approved', async () => {
    const workspace = workspaceWithRequestedGate('980', 'pr');
    const host = await startHost(workspace);

    // 1. PAIR THE MACHINE. The one route reachable with no credential at all.
    const machineToken = host.pairings.issue().token;
    const paired = await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: machineToken }, { machine: 'laptop' });
    expect(paired.status).toBe(201);
    const credential: string = paired.body.credential;
    expect(typeof credential).toBe('string');

    // 2. A MACHINE CREDENTIAL IS NOT A HUMAN. The probe says so before the
    //    session exists, which is the check a client makes before it tries.
    const probeBefore = await fetch(`${host.origin}/api/agent/v1/session`, {
      headers: { [MACHINE_CREDENTIAL_HEADER]: credential },
    });
    expect(probeBefore.status).toBe(401);

    // 3. BECOME A HUMAN SESSION. Costs a second, fresh pairing token — a builder
    //    that read the machine credential off disk still cannot mint one.
    const humanToken = host.pairings.issue().token;
    const session = await post(`${host.origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: humanToken,
    }, {});
    expect(session.status).toBe(201);
    const humanSession: string = session.body.presentation;
    expect(typeof humanSession).toBe('string');

    const probeAfter = await fetch(`${host.origin}/api/agent/v1/session`, {
      headers: { [MACHINE_CREDENTIAL_HEADER]: credential, [HUMAN_SESSION_HEADER]: humanSession },
    });
    expect(probeAfter.status).toBe(200);

    const authed = {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: humanSession,
    };

    // 4. ISSUE THE CAPABILITY.
    const capability = await post(`${host.origin}/api/agent/v1/approval-capabilities`, authed,
      { principalKind: 'human-client' });
    expect(capability.status).toBe(201);
    // Issued for the HOST that will verify it, never for the client's device.
    expect(capability.body.machine).toBe('test-machine');

    // 5. MINT A NONCE FOR THIS GATE.
    const nonce = await post(`${host.origin}/api/agent/v1/approval-nonces`, authed,
      { projectId: '980', gateName: 'pr', capabilityId: capability.body.capabilityId });
    expect(nonce.status).toBe(201);

    // 6. APPROVE. porch is the only writer; this route only asks it.
    const approved = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      authed,
      {
        projectId: '980',
        gateName: 'pr',
        capability: capability.body.presentation,
        nonce: nonce.body.nonce,
      },
    );
    expect(approved.body).toMatchObject({ signal: 'GATE_APPROVED' });
    expect(approved.status).toBe(200);
    expect(approved.body.signal).toBe('GATE_APPROVED');

    // 7. CRITERION 9b: session id, machine and timestamp, in status.yaml.
    const state = yaml.load(
      readFileSync(join(workspace, 'codev', 'projects', '980', 'status.yaml'), 'utf8'),
    ) as any;
    expect(state.gates.pr.status).toBe('approved');
    expect(state.gates.pr.approval.authorization).toBe('capability');
    expect(state.gates.pr.approval.session_id).toBe(session.body.sessionId);
    expect(state.gates.pr.approval.machine).toBe('test-machine');
    expect(typeof state.gates.pr.approved_at).toBe('string');
    expect(Number.isNaN(Date.parse(state.gates.pr.approval.approved_at))).toBe(false);
  });

  /*
   * A capability names the host that will verify it. Accepting a client's own
   * device name issued something that could never verify anywhere, and the
   * caller only found out at the moment of approval — where the refusal reads
   * as a revocation rather than as a bad request.
   */
  it('refuses at issuance to mint a capability for another machine', async () => {
    const host = await startHost(workspaceWithRequestedGate('985', 'pr'));
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;
    const session = (await post(`${host.origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: host.pairings.issue().token,
    }, {})).body;

    const refused = await post(`${host.origin}/api/agent/v1/approval-capabilities`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: session.presentation,
    }, { principalKind: 'human-client', machine: 'some-other-host' });
    expect(refused.status).toBe(400);
    expect(refused.body.signal).toBe('APPROVAL_CAPABILITY_FOREIGN_MACHINE');
  });

  /*
   * THE PATH A REAL PROJECT TAKES.
   *
   * Every other test here uses a workspace whose phase checks are skipped, which
   * no real project is. With the checks left in, approving would run the
   * repository's build and test suite inside Tower on an open HTTP request,
   * unbounded — and a client that gave up would not stop porch, so a timeout
   * would abandon a call that goes on to approve the gate anyway. The route
   * refuses before starting and names what it will not run.
   *
   * It also proves the process survives: porch's CLI answers this class with
   * `process.exit(1)`, which inside Tower would end it and answer the request
   * with nothing at all — the worst available spelling of "refused".
   */
  it('refuses when the phase has checks, instead of running them or ending the process', async () => {
    const workspace = workspaceWithRequestedGate('986', 'pr', { checksPass: false });
    const host = await startHost(workspace);
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;
    const session = (await post(`${host.origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: host.pairings.issue().token,
    }, {})).body;
    const authed = {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: session.presentation,
    };
    const capability = (await post(`${host.origin}/api/agent/v1/approval-capabilities`, authed,
      { principalKind: 'human-client' })).body;
    const nonce = (await post(`${host.origin}/api/agent/v1/approval-nonces`, authed,
      { projectId: '986', gateName: 'pr', capabilityId: capability.capabilityId })).body;

    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      authed,
      { projectId: '986', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.signal).toBe('PHASE_CHECKS_REQUIRED');
    // Names them, so the human knows what to run rather than only that something
    // was refused.
    expect(refused.body.message).toContain('build');

    // The process is still here, and so is the unapproved gate.
    const state = yaml.load(
      readFileSync(join(workspace, 'codev', 'projects', '986', 'status.yaml'), 'utf8'),
    ) as any;
    expect(state.gates.pr.status).toBe('pending');
  });

  it('refuses the approval route to a machine that has no human session', async () => {
    const workspace = workspaceWithRequestedGate('981', 'pr');
    const host = await startHost(workspace);
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;

    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      { [MACHINE_CREDENTIAL_HEADER]: credential },
      { projectId: '981', gateName: 'pr', capability: 'a.b', nonce: 'n' },
    );
    expect(refused.status).toBe(401);

    const state = yaml.load(
      readFileSync(join(workspace, 'codev', 'projects', '981', 'status.yaml'), 'utf8'),
    ) as any;
    expect(state.gates.pr.status).toBe('pending');
  });

  it('will not mint a human session for a machine credential alone', async () => {
    const host = await startHost(workspaceWithRequestedGate('982', 'pr'));
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;

    const refused = await post(`${host.origin}/api/agent/v1/human-sessions`,
      { [MACHINE_CREDENTIAL_HEADER]: credential }, {});
    expect(refused.status).toBe(401);
    expect(refused.body.signal).toBe('PAIRING_TOKEN_REQUIRED');
  });

  it('spends the pairing token, so a session cannot be minted twice from one', async () => {
    const host = await startHost(workspaceWithRequestedGate('983', 'pr'));
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;
    const token = host.pairings.issue().token;
    const headers = { [MACHINE_CREDENTIAL_HEADER]: credential, [PAIRING_TOKEN_HEADER]: token };

    expect((await post(`${host.origin}/api/agent/v1/human-sessions`, headers, {})).status).toBe(201);
    const second = await post(`${host.origin}/api/agent/v1/human-sessions`, headers, {});
    expect(second.status).toBe(401);
  });

  it('refuses a capability that belongs to a different human session', async () => {
    const workspace = workspaceWithRequestedGate('984', 'pr');
    const host = await startHost(workspace);
    const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: host.pairings.issue().token }, { machine: 'laptop' })).body.credential;

    const sessionA = (await post(`${host.origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: host.pairings.issue().token,
    }, {})).body;
    const sessionB = (await post(`${host.origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: host.pairings.issue().token,
    }, {})).body;

    const capability = (await post(`${host.origin}/api/agent/v1/approval-capabilities`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: sessionA.presentation,
    }, { principalKind: 'human-client' })).body;

    const stolen = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      { [MACHINE_CREDENTIAL_HEADER]: credential, [HUMAN_SESSION_HEADER]: sessionB.presentation },
      { projectId: '984', gateName: 'pr', capability: capability.presentation, nonce: 'whatever' },
    );
    expect(stolen.status).toBe(403);

    const state = yaml.load(
      readFileSync(join(workspace, 'codev', 'projects', '984', 'status.yaml'), 'utf8'),
    ) as any;
    expect(state.gates.pr.status).toBe('pending');
  });
});
