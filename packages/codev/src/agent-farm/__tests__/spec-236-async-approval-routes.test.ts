/**
 * Asynchronous gate approval, end to end over HTTP (Spec 236, phase 5).
 *
 * ## The case the synchronous route could not serve
 *
 * `gate-approve` sets `refuseIfChecksWouldRun: true`, so an ordinary project —
 * one whose phase declares checks, which is most of them — is refused and the
 * operator is sent to the CLI. **That refusal stays**, and the first test here
 * asserts it still fires, because criterion 11 says it must and because a
 * request timeout was never the alternative: a client that gives up does not stop
 * porch, so it would abandon a call that goes on to approve the gate anyway.
 *
 * What is new is submit → poll → report, against a project **with its checks
 * left in**. Every other approval test in this suite skips them, which is not
 * what a real project has.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { ApprovalOperationStore } from '../lib/approval-operations.js';
import { MachineCredentialStore } from '../lib/machine-credentials.js';
import { APPROVAL_RECEIPT_HEADER } from '../servers/agent-auth.js';
import { PairingStore } from '../lib/pairing.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MACHINE_MINT = { purpose: 'machine-credential' as const, authority: 'test harness' };
const SESSION_MINT = { purpose: 'client-session' as const, authority: 'test harness' };

const cleanup: Array<() => void> = [];
afterEach(() => {
  shutdownAgentRoutes();
  for (const undo of cleanup.splice(0)) undo();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-236-async-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A workspace with a real project on a requested gate.
 *
 * `skipChecks` is the axis this whole phase turns on. `false` leaves the phase's
 * real checks in — which is what a real project has and what the synchronous
 * route refuses — and the checks it leaves in are ones a throwaway directory
 * cannot pass, which is exactly the point: the run has to reach them and report
 * what they did.
 */
function workspaceWithRequestedGate(
  projectId: string,
  options: { checks: 'skipped' | 'passing' | 'real' | 'slow' },
): string {
  const root = tmp();
  mkdirSync(join(root, '.codev'), { recursive: true });
  /*
   * THREE SETTINGS, AND THE MIDDLE ONE IS THE POINT OF THIS PHASE.
   *
   * `skipped` removes the checks entirely — `getPhaseChecks` returns `{}`, so
   * `refuseIfChecksWouldRun` never fires and the SYNCHRONOUS route would have
   * served it. A success proven that way proves nothing about this phase.
   *
   * `passing` keeps the checks DECLARED and overrides their commands with `true`.
   * The phase still declares checks, so the synchronous route still refuses — and
   * the asynchronous path runs them, they pass, and the gate is approved. That is
   * criterion 7, driven rather than assumed.
   *
   * `real` leaves the repository's own commands in, which a throwaway directory
   * cannot pass, and is how the refusal path is exercised.
   */
  if (options.checks === 'skipped') {
    writeFileSync(join(root, '.codev', 'config.json'), JSON.stringify({
      porch: { checks: { build: { skip: true }, tests: { skip: true } } },
    }));
  } else if (options.checks === 'passing') {
    writeFileSync(join(root, '.codev', 'config.json'), JSON.stringify({
      porch: { checks: { build: { command: 'true' }, tests: { command: 'true' } } },
    }));
  } else if (options.checks === 'slow') {
    /*
     * `slow` KEEPS THE OPERATION IN FLIGHT LONG ENOUGH TO BE FOUND.
     *
     * The in-flight cases need a run that is still going when the second request
     * arrives. With instant checks the first operation has already settled, so a
     * retry legitimately starts a new one and the test measures nothing —
     * exactly how the e2e "shows what it is running" case failed earlier in this
     * project. Two seconds is longer than the requests around it and short
     * enough not to slow the suite.
     */
    writeFileSync(join(root, '.codev', 'config.json'), JSON.stringify({
      porch: { checks: { build: { command: 'sleep 2' }, tests: { command: 'true' } } },
    }));
  }
  const projectDir = join(root, 'codev', 'projects', `${projectId}-async-approval`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'status.yaml'), yaml.dump({
    id: projectId,
    title: 'spec 236 async approval',
    protocol: 'air',
    phase: 'implement',
    plan_phases: [],
    current_plan_phase: null,
    gates: { pr: { status: 'pending', requested_at: '2026-08-30T00:00:00.000Z' } },
    iteration: 1,
    build_complete: false,
    history: [],
  }));
  // The real protocol definitions, so `approve` runs the real phase checks
  // rather than a shape invented here.
  cpSync(join(REPO_ROOT, 'codev-skeleton', 'protocols'), join(root, 'codev', 'protocols'), { recursive: true });
  return root;
}

interface Host {
  readonly origin: string;
  readonly pairings: PairingStore;
  readonly operations: ApprovalOperationStore;
  readonly workspacePath: string;
  readonly encodedWorkspace: string;
}

async function startHost(
  workspacePath: string,
  options: { withOperations?: boolean; alsoServing?: string } = {},
): Promise<Host> {
  const stateRoot = tmp();
  const pairings = new PairingStore({ root: join(stateRoot, 'pairing') });
  const operations = new ApprovalOperationStore({ root: join(stateRoot, 'approval') });
  const database = new Database(':memory:');
  database.exec(GLOBAL_SCHEMA);
  const workspace = normalizeWorkspacePath(workspacePath);
  // A host ordinarily serves SEVERAL workspaces; one is the degenerate case, and
  // the degenerate case cannot see a cross-workspace read.
  const served = new Set([workspace,
    ...(options.alsoServing ? [normalizeWorkspacePath(options.alsoServing)] : [])]);

  initAgentRoutes({
    db: () => database,
    log: () => {},
    isKnownWorkspace: (candidate) => served.has(normalizeWorkspacePath(candidate)),
    humanSessions: new HumanPairedSessionRegistry(),
    approvalCapabilities: new ApprovalCapabilityStore({
      root: join(stateRoot, 'approval'), machine: 'test-machine',
    }),
    approvalNonces: new ApprovalNonceStore({ root: join(stateRoot, 'approval') }),
    machineCredentials: new MachineCredentialStore({ root: join(stateRoot, 'machines') }),
    pairings,
    ...(options.withOperations === false ? {} : { approvalOperations: operations }),
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
    operations,
    workspacePath: workspace,
    encodedWorkspace: Buffer.from(workspace, 'utf8').toString('base64url'),
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

async function get(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

/** Pair, open a session, issue a capability and mint a nonce. The client's whole walk. */
async function credentialed(host: Host, projectId: string) {
  const credential: string = (await post(`${host.origin}/api/agent/v1/pairing/redeem`,
    { [PAIRING_TOKEN_HEADER]: host.pairings.issue(MACHINE_MINT).token }, { machine: 'laptop' })).body.credential;
  const session = (await post(`${host.origin}/api/agent/v1/human-sessions`, {
    [MACHINE_CREDENTIAL_HEADER]: credential,
    [PAIRING_TOKEN_HEADER]: host.pairings.issue(SESSION_MINT).token,
  }, {})).body;
  const authed = {
    [MACHINE_CREDENTIAL_HEADER]: credential,
    [HUMAN_SESSION_HEADER]: session.presentation as string,
  };
  const capability = (await post(`${host.origin}/api/agent/v1/approval-capabilities`, authed,
    { principalKind: 'human-client' })).body;
  const nonce = (await post(`${host.origin}/api/agent/v1/approval-nonces`, authed,
    { projectId, gateName: 'pr', capabilityId: capability.capabilityId })).body;
  return { authed, session, capability, nonce, credential };
}

/** Poll until the operation settles, or give up with what it last said. */
async function settled(host: Host, authed: Record<string, string>, operationId: string) {
  const url = `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/${operationId}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const seen = await get(url, authed);
    if (['succeeded', 'refused', 'failed', 'interrupted'].includes(seen.body.state)) return seen;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error(`operation ${operationId} never settled`);
}

function gateOf(workspace: string, projectId: string) {
  const state = yaml.load(readFileSync(
    join(workspace, 'codev', 'projects', `${projectId}-async-approval`, 'status.yaml'), 'utf8',
  )) as any;
  return state.gates.pr;
}

describe('the synchronous route still refuses, which is criterion 11', () => {
  /*
   * ASSERTED, NOT ASSUMED. This phase adds a path around the refusal; it must
   * not remove it. A caller that has not opted into the asynchronous route gets
   * exactly what it got before, because an HTTP request that runs a repository's
   * test suite is what the refusal exists to prevent.
   */
  it('refuses a checks-enabled project with PHASE_CHECKS_REQUIRED', async () => {
    const workspace = workspaceWithRequestedGate('900', { checks: 'real' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '900');

    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      authed,
      { projectId: '900', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.signal).toBe('PHASE_CHECKS_REQUIRED');
    expect(gateOf(workspace, '900').status).toBe('pending');
  });
});

describe('submit, poll, report', () => {
  /*
   * CRITERION 7, AND THE ONLY TEST HERE THAT PROVES IT.
   *
   * The phase declares checks — so the synchronous route refuses, which the test
   * below asserts against the very same workspace — and this path runs them,
   * they pass, and the gate is approved. A success proven with the checks
   * SKIPPED would be the path the synchronous route already served.
   */
  it('succeeds on a project whose phase declares checks, which the sync route refuses', async () => {
    const workspace = workspaceWithRequestedGate('900b', { checks: 'passing' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '900b');

    // The same workspace, the same gate: the synchronous route refuses it.
    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approve`,
      authed,
      { projectId: '900b', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.signal).toBe('PHASE_CHECKS_REQUIRED');
    expect(gateOf(workspace, '900b').status).toBe('pending');

    // A fresh nonce: the refusal above did not spend one, but a second approval
    // needs its own regardless, and reusing it would test replay rather than this.
    const second = await credentialed(host, '900b');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      second.authed,
      {
        projectId: '900b',
        gateName: 'pr',
        capability: second.capability.presentation,
        nonce: second.nonce.nonce,
      },
    );
    expect(submitted.status).toBe(202);

    const done = await settled(host, second.authed, submitted.body.operationId);
    expect(done.body.state).toBe('succeeded');
    expect(gateOf(workspace, '900b').status).toBe('approved');
  });

  it('accepts without approving, then reports what porch persisted', async () => {
    const workspace = workspaceWithRequestedGate('901', { checks: 'skipped' });
    const host = await startHost(workspace);
    const { authed, session, capability, nonce } = await credentialed(host, '901');

    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '901', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    // 202 ACCEPTED, not 200. The gate is NOT approved at this moment, and a
    // client reading 200 as done would report an outcome that has not happened.
    expect(submitted.status).toBe(202);
    expect(submitted.body.state).toBe('submitted');
    expect(typeof submitted.body.operationId).toBe('string');

    const done = await settled(host, authed, submitted.body.operationId);
    expect(done.body.state).toBe('succeeded');
    // EVERY FIELD FROM WHAT PORCH PERSISTED, checked against the file itself.
    const gate = gateOf(workspace, '901');
    expect(gate.status).toBe('approved');
    expect(done.body.record.machine).toBe(gate.approval.machine);
    expect(done.body.record.sessionId).toBe(gate.approval.session_id);
    expect(done.body.record.sessionId).toBe(session.sessionId);
    expect(done.body.record.approvedAt).toBe(gate.approved_at);

    /*
     * OWNED BY THE DEVICE THAT SUBMITTED IT, NOT BY THIS HOST.
     *
     * Two names are in play and they are not the same namespace: this harness's
     * capability store is 'test-machine' and the paired client is 'laptop'. The
     * operation's `machine` decides who may present a receipt after a restart, so
     * persisting the host's name there would hand every paired device the same
     * ownership and give the submitting one no way to prove it was the submitter.
     *
     * Note this is a DIFFERENT field from `record.machine` above, which is what
     * porch wrote into status.yaml.
     */
    const owned = host.operations.describe(submitted.body.operationId);
    expect(owned?.machine).toBe('laptop');
    expect(owned?.machine).not.toBe('test-machine');
  });

  /*
   * A REFUSAL IS PORCH WORKING. The checks are left in and cannot pass in a
   * throwaway directory, so this drives the whole path to a refusal — and the
   * gate must be untouched at the end of it.
   */
  it('records a refusal with porch\'s own code, and approves nothing', async () => {
    const workspace = workspaceWithRequestedGate('902', { checks: 'real' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '902');

    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '902', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(submitted.status).toBe(202);

    const done = await settled(host, authed, submitted.body.operationId);
    expect(done.body.state).toBe('refused');
    expect(done.body.code).toBe('PHASE_CHECKS_FAILED');
    expect(gateOf(workspace, '902').status).toBe('pending');
  });

  it('reports the phase and the checks while it runs, or has already finished', async () => {
    const workspace = workspaceWithRequestedGate('903', { checks: 'real' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '903');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '903', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );

    // A poll immediately after the submit sees `submitted` or `running` — or,
    // on a fast machine, a settled state. Asserting a specific transient here
    // would be a test of scheduling rather than of behaviour, so what is
    // asserted is that every state it CAN report is one of the six.
    const seen = await get(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/${submitted.body.operationId}`,
      authed,
    );
    expect(['submitted', 'running', 'succeeded', 'refused', 'failed', 'interrupted'])
      .toContain(seen.body.state);
    expect(seen.body.operationId).toBe(submitted.body.operationId);
    expect(seen.body.gateName).toBe('pr');
    await settled(host, authed, submitted.body.operationId);
  });
});

describe('what a running operation tells an operator', () => {
  /*
   * "Running" with nothing beside it is a spinner. `markRunning` accepted a phase
   * and a check set from the first commit and the production call passed neither,
   * so those fields could never reach a poll response — the store took them, the
   * response spread them, and nothing filled them.
   */
  it('records the phase and the checks that will run', async () => {
    const workspace = workspaceWithRequestedGate('911', { checks: 'passing' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '911');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '911', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    await settled(host, authed, submitted.body.operationId);

    // Read from the STORE rather than from a poll, because a poll may land after
    // the run settles and this is about what the running record carried. The
    // names are porch's own resolved check set, not a list typed here.
    const operation = host.operations.describe(submitted.body.operationId)!;
    // The phase the fixture actually declares, read from the file rather than
    // named here — asserting a phase the fixture does not have would test the
    // test's memory of itself.
    expect(operation.phase).toBe('implement');
    expect(operation.checks).toContain('build');
    expect(operation.checks).toContain('tests');
  });

  /*
   * `verify-approval` IS THE ONE GATE THIS DISPLAY COULD BE CONFIDENTLY WRONG
   * ABOUT. `approve()` enters `verify` BEFORE computing the checks — so that the
   * checks it runs are verify's, which are none — and reading the phase off
   * `status.yaml` names the phase the project is leaving. That would report the
   * review phase's build and tests for a run that executes neither.
   */
  it('names the phase verify-approval will actually run in, not the one it leaves', async () => {
    const workspace = workspaceWithRequestedGate('913', { checks: 'passing' });
    const host = await startHost(workspace);
    const { authed, capability } = await credentialed(host, '913');
    const nonce = (await post(`${host.origin}/api/agent/v1/approval-nonces`, authed,
      { projectId: '913', gateName: 'verify-approval', capabilityId: capability.capabilityId })).body;

    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      {
        projectId: '913',
        gateName: 'verify-approval',
        capability: capability.presentation,
        nonce: nonce.nonce,
      },
    );
    expect(submitted.status).toBe(202);
    await settled(host, authed, submitted.body.operationId);

    const operation = host.operations.describe(submitted.body.operationId)!;
    // NOT `implement`, which is what the file says, and not the review phase's
    // check set — verify declares none.
    expect(operation.phase).toBe('verify');
    expect(operation.checks).toEqual([]);
  });
});

describe('what a settled operation reports', () => {
  /*
   * A LABEL THAT CONTRADICTS THE FIELD BESIDE IT IS THE ONE THAT GETS READ. The
   * poll answered `APPROVAL_OPERATION_SUBMITTED` for every state but
   * `interrupted`, so a succeeded operation carried a signal saying it had just
   * been submitted.
   */
  it('signals settled rather than submitted once it has finished', async () => {
    const workspace = workspaceWithRequestedGate('914', { checks: 'skipped' });
    const host = await startHost(workspace);
    const { authed, capability, nonce } = await credentialed(host, '914');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '914', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(submitted.body.signal).toBe('APPROVAL_OPERATION_SUBMITTED');

    const done = await settled(host, authed, submitted.body.operationId);
    expect(done.body.state).toBe('succeeded');
    expect(done.body.signal).toBe('APPROVAL_OPERATION_SETTLED');
  });

  /*
   * `delivery` IS A CAVEAT ON A REAL APPROVAL, and the asynchronous path dropped
   * it while the synchronous route forwarded it. A `committed-not-pushed`
   * approval reported plain success on the path ordinary projects must use.
   *
   * Driven at the store, because making a real push fail is not reachable from
   * this harness — `writeStateAndCommit` skips git entirely under VITEST. What is
   * asserted here is that the record CARRIES the field and the route reports it.
   */
  it('carries porch\'s delivery caveat through to the poll response', async () => {
    const workspace = workspaceWithRequestedGate('915', { checks: 'skipped' });
    const host = await startHost(workspace);
    const { authed, session, capability, nonce } = await credentialed(host, '915');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '915', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    await settled(host, authed, submitted.body.operationId);

    // A SECOND operation, settled directly with the caveat porch would attach,
    // then POLLED THROUGH THE ROUTE. Asserting the shape of a record built in
    // the test would be a tautology; what has to be true is that the route
    // reports the field, which is exactly what was missing.
    const seeded = host.operations.submit({
      workspacePath: host.workspacePath,
      projectId: '915-delivery',
      gateName: 'pr',
      sessionId: session.sessionId,
    });
    expect(seeded.accepted).toBe(true);
    if (!seeded.accepted) return;
    host.operations.settle(seeded.operation.operationId, {
      state: 'succeeded',
      record: {
        machine: 'test-machine',
        sessionId: session.sessionId,
        approvedAt: '2026-08-30T10:00:00Z',
        outcome: 'approved',
        delivery: 'committed-not-pushed',
        deliveryMessage: 'the commit was made and the push was refused',
      },
    });

    const polled = await get(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/${seeded.operation.operationId}`,
      authed,
    );
    expect(polled.status).toBe(200);
    expect(polled.body.state).toBe('succeeded');
    // The caveat reaches the client. Without it, an approval that was committed
    // and not pushed reads as plain success, and the operator never pushes.
    expect(polled.body.record.delivery).toBe('committed-not-pushed');
    expect(polled.body.record.deliveryMessage).toContain('push was refused');
  });
});

describe('an already-approved gate reports the approval that exists', () => {
  /*
   * CRITERION 9, and the defect this reporting layer was built to stop. `approve`
   * returns NORMALLY when the gate was already approved, so a second submit that
   * answered with its own session and a fresh timestamp would claim it approved a
   * gate somebody else had.
   */
  it('reports the first session\'s machine, session and timestamp to the second', async () => {
    const workspace = workspaceWithRequestedGate('912', { checks: 'skipped' });
    const host = await startHost(workspace);

    const first = await credentialed(host, '912');
    const firstSubmit = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      first.authed,
      { projectId: '912', gateName: 'pr', capability: first.capability.presentation, nonce: first.nonce.nonce },
    );
    const firstDone = await settled(host, first.authed, firstSubmit.body.operationId);
    expect(firstDone.body.state).toBe('succeeded');
    expect(firstDone.body.record.outcome).toBe('approved');

    // A SECOND, DIFFERENT session approves the same, already-approved gate.
    const second = await credentialed(host, '912');
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    const secondSubmit = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      second.authed,
      { projectId: '912', gateName: 'pr', capability: second.capability.presentation, nonce: second.nonce.nonce },
    );
    const secondDone = await settled(host, second.authed, secondSubmit.body.operationId);

    expect(secondDone.body.state).toBe('succeeded');
    // ALREADY-APPROVED, and it says so rather than claiming this session did it.
    expect(secondDone.body.record.outcome).toBe('already-approved');
    // The session reported is the FIRST one's, which is what status.yaml holds.
    const gate = gateOf(workspace, '912');
    expect(secondDone.body.record.sessionId).toBe(first.session.sessionId);
    expect(secondDone.body.record.sessionId).toBe(gate.approval.session_id);
    expect(secondDone.body.record.sessionId).not.toBe(second.session.sessionId);
    expect(secondDone.body.record.approvedAt).toBe(gate.approved_at);
    expect(secondDone.body.record.machine).toBe(gate.approval.machine);
  });
});

/*
 * ONE OPERATION BELONGS TO ONE WORKSPACE.
 *
 * The dispatcher checks that the URL names a workspace this host serves, and the
 * handler used to look the operation up by id alone — so the same record was
 * readable through EVERY workspace URL the host answered for. The leak is not
 * abstract: the response carries the gate, the project, the approving session and
 * the authority the approval was made under, to a client scoped to a different
 * workspace.
 *
 * FOUND INDEPENDENTLY BY TWO REVIEW LANES at the same seam, which is why this
 * test exists rather than a note.
 */
/*
 * THE LOST 202 — the case ALREADY_IN_FLIGHT actually arises from.
 *
 * A submit is accepted and its response never reaches the client: a dropped
 * connection, a closed lid, a proxy that gave up. The human clicks again, because
 * from where they sit nothing happened.
 *
 * Answering that with a refusal tells them their approval was REFUSED about one
 * that may be succeeding — the last place in this client where "I could not tell"
 * was still spelled the same as "no", on the one action it exists to perform.
 *
 * What makes this a recovery rather than a claim of one is the last assertion:
 * the outcome observed is the ORIGINAL operation's, and no second run of the
 * checks was started.
 */
describe('a submitter that lost its response', () => {
  it('is handed back the operation it already started, and sees that one settle', async () => {
    const workspace = workspaceWithRequestedGate('917', { checks: 'slow' });
    const host = await startHost(workspace);
    const { authed, capability, nonce, session } = await credentialed(host, '917');
    const submitUrl = `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`;

    // THE FIRST SUBMIT LANDS. Its 202 is what the client never sees; the
    // operation exists regardless, which is the whole reason this case is a
    // recovery and not a retry.
    const first = await post(submitUrl, authed, {
      projectId: '917', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce,
    });
    expect(first.status).toBe(202);
    const original = first.body.operationId as string;

    // THE HUMAN CLICKS AGAIN. Same session, same machine, a fresh nonce because
    // the first one is spent — this is a new request in every respect except
    // that the work it asks for is already running.
    const retryNonce = (await post(`${host.origin}/api/agent/v1/approval-nonces`, authed,
      { projectId: '917', gateName: 'pr', capabilityId: capability.capabilityId })).body;
    const retry = await post(submitUrl, authed, {
      projectId: '917', gateName: 'pr', capability: capability.presentation, nonce: retryNonce.nonce,
    });

    // 202 AND RESUMED, not 409 and refused.
    expect(retry.status, `the retry was refused: ${JSON.stringify(retry.body)}`).toBe(202);
    expect(retry.body.signal).toBe('APPROVAL_OPERATION_RESUMED');
    expect(retry.body.operationId, 'a second operation was created').toBe(original);
    expect(typeof retry.body.receipt).toBe('string');
    // The state is the RECORD's, not a fixed 'submitted': between the lost
    // response and this retry the run may have started or even finished.
    expect(['submitted', 'running', 'succeeded']).toContain(retry.body.state);

    // AND THE CLIENT SEES THE ORIGINAL SETTLE. This is the assertion that
    // distinguishes a recovery from a claim of one.
    const done = await settled(host, authed, retry.body.operationId);
    expect(done.body.state).toBe('succeeded');
    expect(done.body.record.sessionId).toBe(session.sessionId);

    // ONE operation for the whole episode: the checks did not run twice.
    const all = host.operations.records()
      .filter((operation) => operation.projectId === '917');
    expect(all).toHaveLength(1);
    expect(all[0].operationId).toBe(original);

    const gate = gateOf(workspace, '917');
    expect(gate.status).toBe('approved');
  });

  /*
   * ANOTHER SESSION STILL GETS THE CONFLICT, AND NOW GETS THE ID WITH IT.
   *
   * It did not start that run, so it must not be handed the receipt — the
   * receipt is what proves submission across a restart. But the id is not a
   * secret and the server's own message already named it in prose, so a client
   * had to parse English to recover what a field should have carried.
   */
  it('refuses another session, names the operation, and hands over no receipt', async () => {
    const workspace = workspaceWithRequestedGate('918', { checks: 'slow' });
    const host = await startHost(workspace);
    const mine = await credentialed(host, '918');
    const submitUrl = `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`;

    const first = await post(submitUrl, mine.authed, {
      projectId: '918',
      gateName: 'pr',
      capability: mine.capability.presentation,
      nonce: mine.nonce.nonce,
    });
    expect(first.status).toBe(202);

    // A SECOND, GENUINELY DIFFERENT CLIENT: its own credential, its own session,
    // its own capability and nonce.
    const theirs = await credentialed(host, '918');
    const conflict = await post(submitUrl, theirs.authed, {
      projectId: '918',
      gateName: 'pr',
      capability: theirs.capability.presentation,
      nonce: theirs.nonce.nonce,
    });

    // It may be refused as a conflict OR as a stale in-flight check; what must
    // never happen is it being handed the other session's receipt.
    expect(conflict.status).toBe(409);
    expect(conflict.body.signal).toBe('APPROVAL_ALREADY_IN_FLIGHT');
    expect(conflict.body.operationId, 'the id is still only in the prose').toBe(first.body.operationId);
    expect(conflict.body.receipt, 'another session was handed the receipt').toBeUndefined();
  });
});

describe('the workspace in the URL', () => {
  it('does not hand an operation to a client polling a different workspace', async () => {
    const workspace = workspaceWithRequestedGate('916', { checks: 'skipped' });
    const other = workspaceWithRequestedGate('916-other', { checks: 'skipped' });
    const host = await startHost(workspace, { alsoServing: other });
    const { authed, capability, nonce } = await credentialed(host, '916');

    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '916', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(submitted.status).toBe(202);

    // THE SAME CLIENT, THE SAME OPERATION ID, A DIFFERENT WORKSPACE. Authorisation
    // would pass — it is the submitting session — so nothing but the scope check
    // stands between this request and the record.
    const encodedOther = Buffer.from(normalizeWorkspacePath(other), 'utf8').toString('base64url');
    const crossed = await get(
      `${host.origin}/api/agent/v1/workspaces/${encodedOther}/gates/approvals/${submitted.body.operationId}`,
      authed,
    );

    // 404, NOT 403: through this workspace the operation does not exist. A 403
    // would confirm that it exists somewhere else, which is half the answer the
    // request was refused for asking.
    expect(crossed.status).toBe(404);
    expect(crossed.body.signal).toBe('APPROVAL_OPERATION_UNKNOWN');
    expect(JSON.stringify(crossed.body)).not.toContain('916');

    // And it is still readable through its own workspace, so the check narrowed
    // the leak rather than the feature.
    const own = await get(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/${submitted.body.operationId}`,
      authed,
    );
    expect(own.status).toBe(200);
  });
});

describe('what is checked before an operation exists', () => {
  /*
   * An operation is a durable artifact an operator can see. Creating one and
   * then refusing it would put a failed approval in their history for a request
   * that never had the right to make one.
   */
  it('refuses a capability from another session and records nothing', async () => {
    const host = await startHost(workspaceWithRequestedGate('904', { checks: 'skipped' }));
    const first = await credentialed(host, '904');
    const second = await credentialed(host, '904');

    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      second.authed,
      {
        projectId: '904',
        gateName: 'pr',
        // The FIRST session's capability, presented by the SECOND session.
        capability: first.capability.presentation,
        nonce: second.nonce.nonce,
      },
    );
    expect(refused.status).toBe(403);
    expect(host.operations.records()).toHaveLength(0);
  });

  it('refuses a request missing any of its four fields', async () => {
    const host = await startHost(workspaceWithRequestedGate('905', { checks: 'skipped' }));
    const { authed, capability } = await credentialed(host, '905');
    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '905', capability: capability.presentation },
    );
    expect(refused.status).toBe(400);
    expect(host.operations.records()).toHaveLength(0);
  });

  it('refuses an unknown workspace before touching the store', async () => {
    const host = await startHost(workspaceWithRequestedGate('906', { checks: 'skipped' }));
    const { authed, capability, nonce } = await credentialed(host, '906');
    const elsewhere = Buffer.from('/not/this/workspace', 'utf8').toString('base64url');
    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${elsewhere}/gates/approvals`,
      authed,
      { projectId: '906', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(refused.status).toBe(404);
    expect(host.operations.records()).toHaveLength(0);
  });

  /*
   * 409, NOT 400. The request is well formed and would be valid at another
   * moment. A client told "bad request" retries with different input; one told
   * "conflict" polls the operation whose id it was just handed.
   */
  it('refuses a second approval for one project with the live operation\'s id', async () => {
    const host = await startHost(workspaceWithRequestedGate('907', { checks: 'real' }));
    const first = await credentialed(host, '907');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      first.authed,
      { projectId: '907', gateName: 'pr', capability: first.capability.presentation, nonce: first.nonce.nonce },
    );
    expect(submitted.status).toBe(202);

    const second = await credentialed(host, '907');
    const conflicted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      second.authed,
      { projectId: '907', gateName: 'pr', capability: second.capability.presentation, nonce: second.nonce.nonce },
    );
    if (conflicted.status === 409) {
      expect(conflicted.body.signal).toBe('APPROVAL_ALREADY_IN_FLIGHT');
      expect(conflicted.body.message).toContain(submitted.body.operationId);
    } else {
      // The first settled before the second arrived, which is legitimate and not
      // what this test is about. Recorded rather than asserted away.
      expect(conflicted.status).toBe(202);
    }
    // NOT waited out. The first operation runs the project's real checks, which
    // take longer than this test's budget and prove nothing it is asking about —
    // and waiting for them made the test fail for being slow, which says nothing
    // about the code. The background run settles into the store or is torn down
    // with the temp directory; either way it writes to no response and cannot
    // fail this test, because every path through it is caught.
  });
});

describe('polling one operation', () => {
  it('answers 404 for an id this host has never held', async () => {
    const host = await startHost(workspaceWithRequestedGate('908', { checks: 'skipped' }));
    const { authed } = await credentialed(host, '908');
    const missing = await get(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/no-such-operation`,
      authed,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.signal).toBe('APPROVAL_OPERATION_UNKNOWN');
  });

  it('refuses to show one session another session\'s approval', async () => {
    const host = await startHost(workspaceWithRequestedGate('909', { checks: 'skipped' }));
    const first = await credentialed(host, '909');
    const submitted = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      first.authed,
      { projectId: '909', gateName: 'pr', capability: first.capability.presentation, nonce: first.nonce.nonce },
    );
    const second = await credentialed(host, '909');
    const refused = await get(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals/${submitted.body.operationId}`,
      second.authed,
    );
    expect(refused.status).toBe(403);
    // Same reasoning as above: the assertion is complete, and waiting for the
    // background run to finish only adds a way for this test to fail slowly.
  });
});

describe('a host with nowhere to record an approval says so', () => {
  /*
   * `tools/codev-agent-host` wires no operation store. Accepting work it cannot
   * record — and then losing it — would be the worst available answer; 501 says
   * which route to use instead.
   */
  it('answers 501 rather than accepting work it would lose', async () => {
    const host = await startHost(
      workspaceWithRequestedGate('910', { checks: 'skipped' }),
      { withOperations: false },
    );
    const { authed, capability, nonce } = await credentialed(host, '910');
    const refused = await post(
      `${host.origin}/api/agent/v1/workspaces/${host.encodedWorkspace}/gates/approvals`,
      authed,
      { projectId: '910', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce },
    );
    expect(refused.status).toBe(501);
    expect(refused.body.signal).toBe('APPROVAL_OPERATIONS_NOT_AVAILABLE');
  });
});

/**
 * A REAL RESTART, DRIVEN THROUGH THE ROUTES THE CLIENT ACTUALLY USES.
 *
 * ## Why this test exists, and why it is written before the fix
 *
 * Criterion 10 promises that an approval interrupted by a host restart reports
 * what happened. Two review rounds each found a different rejection standing in
 * front of that promise — first a 403 on session identity, then a 401 at
 * authentication before the receipt could even be read — and each round I fixed
 * the rejection I had been shown rather than the path.
 *
 * So this drives the whole path with only what a client genuinely holds across a
 * restart: **its machine credential** (file-backed, survives), the operation id,
 * and the receipt it was handed at submit. It holds no human session, because the
 * restart that produced the interrupted record destroyed every one of them —
 * that is not a limitation of the test, it is the condition the criterion is
 * about.
 *
 * If this passes, the path works. If it fails, it names where.
 */
describe('an approval interrupted by a restart is readable by the client that submitted it', () => {
  it('reports the interrupted outcome to a machine holding only its credential and the receipt', async () => {
    const workspace = workspaceWithRequestedGate('920', { checks: 'passing' });
    const stateRoot = tmp();
    const database = new Database(':memory:');
    database.exec(GLOBAL_SCHEMA);
    const normalized = normalizeWorkspacePath(workspace);
    const encoded = Buffer.from(normalized, 'utf8').toString('base64url');

    const pairings = new PairingStore({ root: join(stateRoot, 'pairing') });
    const machines = new MachineCredentialStore({ root: join(stateRoot, 'machines') });
    const capabilities = new ApprovalCapabilityStore({
      root: join(stateRoot, 'approval'), machine: 'tower-host',
    });
    const nonces = new ApprovalNonceStore({ root: join(stateRoot, 'approval') });

    /** The Tower that dies: its operations are owned by a pid that will be gone. */
    const before = new ApprovalOperationStore({
      root: join(stateRoot, 'approval'),
      owner: { host: 'tower-a', pid: 4242, runId: 'run-before-the-crash' },
    });

    const wire = (operations: ApprovalOperationStore, humanSessions: HumanPairedSessionRegistry) => {
      initAgentRoutes({
        db: () => database,
        log: () => {},
        isKnownWorkspace: (candidate) => normalizeWorkspacePath(candidate) === normalized,
        humanSessions,
        approvalCapabilities: capabilities,
        approvalNonces: nonces,
        machineCredentials: machines,
        pairings,
        approvalOperations: operations,
      });
    };

    wire(before, new HumanPairedSessionRegistry());
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (handleAgentRoute(req, res, url)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    cleanup.push(() => { server.close(); database.close(); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // THE DEVICE. Its credential is file-backed and survives the restart, which
    // is the only thing about this client that does.
    const credential: string = (await post(`${origin}/api/agent/v1/pairing/redeem`,
      { [PAIRING_TOKEN_HEADER]: pairings.issue(MACHINE_MINT).token },
      { machine: 'laptop' })).body.credential;
    const session = (await post(`${origin}/api/agent/v1/human-sessions`, {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [PAIRING_TOKEN_HEADER]: pairings.issue(SESSION_MINT).token,
    }, {})).body;
    const authed = {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: session.presentation as string,
    };
    const capability = (await post(`${origin}/api/agent/v1/approval-capabilities`, authed,
      { principalKind: 'human-client' })).body;
    const nonce = (await post(`${origin}/api/agent/v1/approval-nonces`, authed,
      { projectId: '920', gateName: 'pr', capabilityId: capability.capabilityId })).body;

    const submitted = await post(`${origin}/api/agent/v1/workspaces/${encoded}/gates/approvals`, authed, {
      projectId: '920', gateName: 'pr', capability: capability.presentation, nonce: nonce.nonce,
    });
    expect(submitted.status).toBe(202);
    const { operationId, receipt } = submitted.body;
    expect(typeof receipt, 'the submit must hand back a receipt to survive the restart').toBe('string');

    // THE RESTART. Same files, new process identity, and — the part that matters —
    // a FRESH session registry, because sessions live in memory and do not survive.
    shutdownAgentRoutes();
    const after = new ApprovalOperationStore({
      root: join(stateRoot, 'approval'),
      owner: { host: 'tower-a', pid: 5150, runId: 'run-after-the-restart' },
      isAlive: () => false,
    });
    wire(after, new HumanPairedSessionRegistry());
    expect(after.describe(operationId)?.state, 'startup must resolve the abandoned record')
      .toBe('interrupted');

    // THE CLIENT COMES BACK holding exactly what survived: its machine credential,
    // the operation id and the receipt. No session — there cannot be one.
    //
    // The receipt is in a HEADER. It was a query parameter here first, which put
    // a bearer secret in every URL Tower logs on an authentication failure — the
    // exact request this test makes. `spec-236-receipt-not-in-url.test.ts` holds
    // that line; this one only has to keep presenting it the way a client does.
    const polled = await get(
      `${origin}/api/agent/v1/workspaces/${encoded}/gates/approvals/${operationId}`,
      { [MACHINE_CREDENTIAL_HEADER]: credential, [APPROVAL_RECEIPT_HEADER]: receipt },
    );
    expect(polled.status, `the client could not read its own interrupted approval: ${JSON.stringify(polled.body)}`)
      .toBe(200);
    expect(polled.body.state).toBe('interrupted');
    expect(polled.body.gateAfterInterruption).toBeDefined();
  });
});
