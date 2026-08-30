/**
 * Spec 236 — the approval receipt is a bearer secret and must not travel in a URL.
 *
 * ## What was wrong
 *
 * The poll carried the receipt as `?receipt=...`. Tower logs `req.url` in two
 * places: `tower-server.ts` on a boot-window 503, and `tower-routes.ts` on EVERY
 * authentication failure — which is exactly when a client polling across a
 * restart arrives, because that is the scenario the receipt was invented for. And
 * the exposure was never bounded by our own logging: reverse proxies log query
 * strings as a matter of course.
 *
 * `agent-auth.ts` had already written this rule down, three lines above where the
 * receipt constant now sits: credentials are headers, "a URL lands in access logs
 * and a command line lands in `ps` output". This was not an obscure hazard; it
 * crossed a documented line in the file next door. Both review lanes found it
 * independently.
 *
 * ## What is asserted, and why the absence is the assertion
 *
 * A test that only proves the header WORKS would pass with the query parameter
 * still accepted beside it — and the query string is the convenient place to put
 * a value, which is how it got there the first time. So the query channel is
 * asserted CLOSED, the source is asserted to build no such URL, and the header is
 * asserted to be the only way in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  APPROVAL_RECEIPT_HEADER,
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
import { ApprovalOperationStore, mayRead } from '../lib/approval-operations.js';
import { MachineCredentialStore } from '../lib/machine-credentials.js';
import { PairingStore } from '../lib/pairing.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); shutdownAgentRoutes(); });

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'codev-236-receipt-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A workspace with one gate awaiting approval, enough for a submit to be accepted. */
function workspaceWithGate(projectId: string): string {
  const root = tmp();
  const project = join(root, 'codev', 'projects', projectId);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'status.yaml'), [
    `project_id: "${projectId}"`,
    'protocol: aspir',
    'phase: pr',
    'gates:',
    '  pr:',
    '    status: requested',
    '    checks: skipped',
    '',
  ].join('\n'));
  return root;
}

/** A running host with real stores, so credentials are compared as production does. */
async function liveHost(projectId = '916-receipt') {
  const workspace = normalizeWorkspacePath(workspaceWithGate(projectId));
  const stateRoot = tmp();
  const pairings = new PairingStore({ root: join(stateRoot, 'pairing') });
  const operations = new ApprovalOperationStore({ root: join(stateRoot, 'approval') });
  const machines = new MachineCredentialStore({ root: join(stateRoot, 'machines') });
  const database = new Database(':memory:');
  database.exec(GLOBAL_SCHEMA);
  cleanup.push(() => database.close());

  initAgentRoutes({
    db: () => database,
    log: () => {},
    isKnownWorkspace: (candidate) => normalizeWorkspacePath(candidate) === workspace,
    humanSessions: new HumanPairedSessionRegistry(),
    // 'tower-host' is the VERIFYING HOST and is deliberately not any device's
    // name: a fixture that reuses one value cannot tell binding from its absence.
    approvalCapabilities: new ApprovalCapabilityStore({
      root: join(stateRoot, 'approval'), machine: 'tower-host',
    }),
    approvalNonces: new ApprovalNonceStore({ root: join(stateRoot, 'approval') }),
    machineCredentials: machines,
    pairings,
    approvalOperations: operations,
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (handleAgentRoute(req, res, url)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanup.push(() => server.close());
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    workspace,
    encoded: Buffer.from(workspace, 'utf8').toString('base64url'),
    pairings,
    operations,
    machines,
  };
}

/**
 * A human session belongs to ONE device (spec 236, round 6).
 *
 * ## What was wrong
 *
 * The registry stored no machine, and the machine credential and the human
 * session were verified INDEPENDENTLY of each other. Two valid credentials, never
 * compared — so a session opened on one machine could be replayed alongside
 * another machine's credential to issue capabilities, submit approvals or poll
 * operations. That is the per-device ownership and revocation model of this whole
 * spec, defeated without breaking either credential.
 *
 * It is the same conflation round 2 removed one layer down, where `machine` (the
 * verifying host) and `pairedMachine` (the device) had been treated as one name.
 *
 * ## Two genuinely different identities, and that is the point
 *
 * Every assertion below uses DISTINCT machines with DISTINCT credentials and
 * DISTINCT sessions. A fixture that reuses one value cannot tell binding from its
 * absence — which is the mistake this project has now made five times, and the
 * reason it is called out here rather than left to the reader.
 */
describe('a session is bound to the machine it was opened from', () => {
  it('refuses a session presented with another machine\'s credential', async () => {
    const host = await liveHost();

    // TWO DEVICES. Two credentials, and a session opened on the first.
    const laptop = host.machines.issue({ machine: 'laptop' }).presentation;
    const ipad = host.machines.issue({ machine: 'ipad' }).presentation;
    const session = await (await fetch(`${host.origin}/api/agent/v1/human-sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [MACHINE_CREDENTIAL_HEADER]: laptop,
        [PAIRING_TOKEN_HEADER]: host.pairings.issue({ purpose: 'client-session', authority: 't' }).token,
      },
      body: '{}',
    })).json() as { presentation: string; sessionId: string };

    // THE LAPTOP'S SESSION, THE IPAD'S CREDENTIAL. Both are valid; neither was
    // ever checked against the other.
    const replayed = await fetch(`${host.origin}/api/agent/v1/approval-capabilities`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [MACHINE_CREDENTIAL_HEADER]: ipad,
        [HUMAN_SESSION_HEADER]: session.presentation,
      },
      body: JSON.stringify({ principalKind: 'human-client' }),
    });

    // 403, NOT 401. The session is real and the holder may use it legitimately on
    // the laptop; what is refused is using it from HERE. Answering "authenticate"
    // would send a client into a re-pair loop that cannot fix what is wrong.
    expect(replayed.status, 'a session was accepted from another machine').toBe(403);
    const body = await replayed.json() as { signal?: string };
    expect(body.signal).toBe('HUMAN_SESSION_FOREIGN_MACHINE');

    // AND IT STILL WORKS FROM ITS OWN MACHINE, so the binding narrowed the hole
    // rather than the feature.
    const proper = await fetch(`${host.origin}/api/agent/v1/approval-capabilities`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [MACHINE_CREDENTIAL_HEADER]: laptop,
        [HUMAN_SESSION_HEADER]: session.presentation,
      },
      body: JSON.stringify({ principalKind: 'human-client' }),
    });
    expect(proper.status).toBe(201);
  });

  /*
   * AND THE POLL DOES NOT HAVE ITS OWN WEAKER RULE.
   *
   * `mayRead`'s receipt branch always required the machine to match; its SESSION
   * branch returned true on a session id alone — so the path with the weaker
   * credential carried the stronger check, and the operation's own `machine`
   * field was bypassed by the branch most callers take.
   */
  it('will not read an operation for a session id alone from another machine', () => {
    const operation = {
      operationId: 'op-1',
      workspacePath: '/w',
      projectId: '236',
      gateName: 'pr',
      sessionId: 'session-1',
      machine: 'laptop',
      receipt: 'r-1',
      owner: { host: 'h', pid: 1 },
      submittedAt: '2026-08-30T00:00:00Z',
      state: 'running',
    } as unknown as Parameters<typeof mayRead>[0];

    expect(mayRead(operation, { sessionId: 'session-1', machine: 'laptop' })).toBe(true);
    expect(
      mayRead(operation, { sessionId: 'session-1', machine: 'ipad' }),
      'a session id alone read an approval owned by another machine',
    ).toBe(false);
  });
});

describe('the receipt never travels in a URL', () => {
  /*
   * THE SOURCE BUILDS NO SUCH URL. Read as text because the defect is a string
   * that a future convenience re-adds in one edit, in a file no route test opens.
   * Any of `?receipt=`, `&receipt=` or a `searchParams` read of it is the bug
   * coming back, whichever half of the wire adds it.
   */
  it('is not interpolated into a URL anywhere in the client or the server', () => {
    const sources = [
      join(repoRoot, 'apps', 'client', 'src', 'gate', 'approval.ts'),
      join(here, '..', 'servers', 'agent-routes.ts'),
    ];
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      // Comments explain WHY it is not there and legitimately contain the word.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${path} builds a receipt into a query string`)
        .not.toMatch(/[?&]receipt=/);
      expect(code, `${path} reads a receipt out of a query string`)
        .not.toMatch(/searchParams\s*\.\s*get\(\s*['"]receipt['"]/);
    }
  });

  /*
   * THE QUERY CHANNEL IS CLOSED AT THE SERVER, not merely unused by our client.
   * A client is one of the two halves; a host that still accepts the parameter
   * leaves the leak available to anything else that talks to it, and would let
   * the client half be re-added without a single test going red.
   */
  it('refuses a receipt presented in the query string, and accepts the header', async () => {
    const { origin, workspace, encoded, pairings, operations, machines } = await liveHost();
    const credential = machines.issue({ machine: 'laptop' }).presentation;
    const session = await (await fetch(`${origin}/api/agent/v1/human-sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [MACHINE_CREDENTIAL_HEADER]: credential,
        [PAIRING_TOKEN_HEADER]: pairings.issue({ purpose: 'client-session', authority: 't' }).token,
      },
      body: '{}',
    })).json() as { presentation: string; sessionId: string };

    // Submitted directly at the store: this test is about how the receipt is
    // PRESENTED, and driving a real approval would only add ways to fail.
    const seeded = operations.submit({
      workspacePath: workspace,
      projectId: '916-receipt',
      gateName: 'pr',
      sessionId: session.sessionId,
      machine: 'laptop',
    });
    expect(seeded.accepted).toBe(true);
    if (!seeded.accepted) return;
    const { operationId, receipt } = seeded.operation;
    const path = `${origin}/api/agent/v1/workspaces/${encoded}/gates/approvals/${operationId}`;

    /*
     * THE SAME CREDENTIAL, AND NO SESSION. The receipt is the ONLY thing that
     * could authorise this request, so the status reports the channel and nothing
     * else.
     *
     * The first version of this used a different machine — and passed with the
     * query parameter still accepted, because `mayRead` refused it on the machine
     * mismatch instead. It measured the wrong refusal, which is the exact defect
     * this project keeps finding in its own fixtures.
     */
    const viaQuery = await fetch(`${path}?receipt=${encodeURIComponent(receipt)}`, {
      headers: { [MACHINE_CREDENTIAL_HEADER]: credential },
    });
    expect(viaQuery.status, 'the query string is still an accepted channel').toBe(403);

    const viaHeader = await fetch(path, {
      headers: { [MACHINE_CREDENTIAL_HEADER]: credential, [APPROVAL_RECEIPT_HEADER]: receipt },
    });
    expect(viaHeader.status, 'the header is not accepted').toBe(200);

    // And the session route still works without any receipt at all, so closing
    // the query channel did not make the receipt mandatory.
    const viaSession = await fetch(path, {
      headers: {
        [MACHINE_CREDENTIAL_HEADER]: credential,
        [HUMAN_SESSION_HEADER]: session.presentation,
      },
    });
    expect(viaSession.status).toBe(200);
  });

  /*
   * WHAT THE LOG LINES ACTUALLY INTERPOLATE. Both sites log `req.url`, so the
   * property "no log contains a receipt" reduces to "no URL contains one" — and
   * this pins that the sites still log the whole URL, because if one ever logs
   * something richer this reduction stops holding and the guard should be revisited.
   */
  it('logs the URL at both sites, which is why the URL is what must stay clean', () => {
    const routes = readFileSync(join(here, '..', 'servers', 'tower-routes.ts'), 'utf8');
    const boot = readFileSync(join(here, '..', 'servers', 'tower-server.ts'), 'utf8');
    expect(routes, 'the 401 log no longer interpolates req.url').toContain('${req.url ?? \'/\'}');
    expect(boot, 'the boot 503 log no longer interpolates req.url').toContain('${req.url}');
  });

  /*
   * PREFLIGHT ADVERTISES IT. A header a browser cannot send is a header the
   * remote client cannot use — the cross-origin poll would fail at preflight,
   * before any of this reasoning ran, and the obvious fix would be to put the
   * value back in the URL where no preflight is needed.
   */
  it('is advertised in the CORS allow-header list', () => {
    const routes = readFileSync(join(here, '..', 'servers', 'tower-routes.ts'), 'utf8');
    const header = routes.slice(routes.indexOf('Access-Control-Allow-Headers'));
    expect(header.slice(0, 400)).toContain('X-Codev-Approval-Receipt');
  });
});
