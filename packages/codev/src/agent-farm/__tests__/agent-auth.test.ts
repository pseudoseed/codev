/**
 * Spec 146 Phase 7: transport and service security posture.
 *
 * The acceptance criteria in one file, each driven against the real dispatcher or
 * the real store rather than against a description of one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  AGENT_ROUTES,
  AGENT_ROUTE_PREFIX,
  HUMAN_SESSION_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PAIRING_TOKEN_HEADER,
  TRANSPORT_SIGNAL,
  decideBindPolicy,
  isAgentOriginAllowed,
  isUpgradeOriginAllowed,
  matchAgentRoute,
} from '../servers/agent-auth.js';
import {
  MACHINE_SIGNAL,
  MachineCredentialStore,
  MachineStoreUnreadable,
  defaultMachineRoot,
} from '../lib/machine-credentials.js';
import { PAIRING_SIGNAL, PairingStore, defaultPairingRoot, redactPairingToken } from '../lib/pairing.js';
import { ApprovalCapabilityStore, ApprovalNonceStore } from '../lib/approval-capability.js';
import {
  HumanPairedSessionRegistry,
  handleAgentRoute,
  initAgentRoutes,
  shutdownAgentRoutes,
} from '../servers/agent-routes.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-phase7-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  shutdownAgentRoutes();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  return db;
}

interface Captured {
  res: http.ServerResponse;
  statusCode: number;
  body: string;
}

function fakeRes(): Captured {
  const captured: Captured = { statusCode: 0, body: '', res: null as unknown as http.ServerResponse };
  captured.res = {
    writeHead(status: number) {
      captured.statusCode = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return this;
    },
    setHeader() { return this; },
    write(chunk: string) { captured.body += chunk; return true; },
    on() { return this; },
    once() { return this; },
    destroyed: false,
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return captured;
}

function fakeReq(
  method: string,
  headers: Record<string, string>,
  body = '',
): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as http.IncomingMessage;
  stream.method = method;
  stream.headers = headers;
  return stream;
}

/** Let the promise chain inside a body-reading handler settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  machines: MachineCredentialStore;
  pairings: PairingStore;
  sessions: HumanPairedSessionRegistry;
  approvals: ApprovalCapabilityStore;
  logs: string[];
}

function harness(options: { knownWorkspace?: boolean } = {}): Harness {
  const machines = new MachineCredentialStore({ root: join(tmp(), 'machines') });
  const pairings = new PairingStore({ root: join(tmp(), 'pairing') });
  const sessions = new HumanPairedSessionRegistry();
  const approvals = new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' });
  const logs: string[] = [];
  const database = memoryDb();
  initAgentRoutes({
    db: () => database,
    log: (level, message) => logs.push(`[${level}] ${message}`),
    isKnownWorkspace: () => options.knownWorkspace ?? true,
    humanSessions: sessions,
    approvalCapabilities: approvals,
    approvalNonces: new ApprovalNonceStore({ root: tmp() }),
    machineCredentials: machines,
    pairings,
  });
  return { machines, pairings, sessions, approvals, logs };
}

function url(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 1: every route refuses an unauthenticated request, and
// the set of routes is READ FROM THE ROUTER, not typed here.
// ---------------------------------------------------------------------------

describe('every codev-agent route is authenticated', () => {
  it('refuses an unauthenticated request at every route the table names', async () => {
    harness();
    // Derived, not listed. Adding a route to AGENT_ROUTES adds a case here.
    expect(AGENT_ROUTES.length).toBeGreaterThan(0);
    for (const route of AGENT_ROUTES) {
      const out = fakeRes();
      const handled = handleAgentRoute(fakeReq(route.method, {}, '{}'), out.res, url(route.probe));
      await flush();
      expect(handled, `${route.id} was not handled by the dispatcher`).toBe(true);
      expect(
        out.statusCode,
        `${route.id} (${route.method} ${route.probe}) answered ${out.statusCode} to a request with no credentials`,
      ).toBe(401);
      const body = JSON.parse(out.body) as { signal: string };
      // A refusal must SAY which credential is missing. "401" alone sends a
      // client to guess between "pair this machine" and "log in".
      expect(body.signal, `${route.id} refused without naming a signal`).toBeTruthy();
      expect(body.signal).not.toBe('AGENT_ROUTE_NOT_FOUND');
    }
  });

  it('refuses a BOGUS credential at every route, not only a missing one', async () => {
    harness();
    for (const route of AGENT_ROUTES) {
      const out = fakeRes();
      const headers: Record<string, string> = {
        [MACHINE_CREDENTIAL_HEADER]: 'not-a-real-id.not-a-real-secret',
        [PAIRING_TOKEN_HEADER]: 'not-a-real-id.not-a-real-secret',
        [HUMAN_SESSION_HEADER]: 'not-a-real-id.not-a-real-secret',
      };
      handleAgentRoute(fakeReq(route.method, headers, JSON.stringify({ machine: 'intruder' })), out.res, url(route.probe));
      await flush();
      expect(
        out.statusCode,
        `${route.id} accepted a credential nothing issued`,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  // THE GUARD ASSERTS ITS OWN REACH.
  //
  // The two tests above enumerate AGENT_ROUTES. That catches a route added to the
  // table without auth, and misses a route added to the DISPATCHER without a
  // table entry — the same defect one layer out, and the shape this spec has hit
  // repeatedly. So this reads the dispatcher's source for path literals and
  // requires the table to name each one.
  //
  // NAMED ANCHORS, NOT A COUNT. A floor like "more than three" is a number that
  // drifts and then passes while seeing less; each anchor below is a path that
  // must be found, so a collector that stops matching a shape fails BY NAME.
  it('the dispatcher serves no path the table does not name', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'agent-routes.ts'),
      'utf8',
    );
    // Two shapes a route path takes in that file: a template literal built on the
    // prefix constant, and an anchored regex over the literal prefix.
    const templatePaths = [...source.matchAll(/\$\{AGENT_ROUTE_PREFIX\}(\/[A-Za-z0-9\-/]*)/g)]
      .map((m) => `${AGENT_ROUTE_PREFIX}${m[1]}`);
    const regexPaths = [...source.matchAll(/\/\^\\\/api\\\/agent\\\/v1\\\/([A-Za-z0-9\-\\/]*?)\\\/?\(/g)]
      .map((m) => `${AGENT_ROUTE_PREFIX}/${m[1].replace(/\\\//g, '/')}`);
    const found = new Set([...templatePaths, ...regexPaths]);
    // The bare prefix is the "does this request belong to codev-agent at all"
    // guard, not a route. Excluded by name rather than by a pattern that would
    // also swallow a real one-segment route.
    found.delete(`${AGENT_ROUTE_PREFIX}/`);

    // One anchor per collected shape. If either pattern stops matching this
    // file's style, the missing anchor says which.
    expect(found, 'the template-literal collector has gone blind')
      .toContain(`${AGENT_ROUTE_PREFIX}/approval-capabilities`);
    expect(found, 'the regex collector has gone blind')
      .toContain(`${AGENT_ROUTE_PREFIX}/workspaces`);
    expect(found).toContain(`${AGENT_ROUTE_PREFIX}/machines`);

    for (const path of found) {
      // A path literal in the dispatcher must be reachable through the table by
      // at least one method. Method-specific coverage is the enumeration above.
      const named = AGENT_ROUTES.some(
        (route) => route.pathname === path
          || route.probe === path
          || route.probe.startsWith(`${path}/`)
          || route.pattern?.test(`${path}/probe`),
      );
      expect(named, `the dispatcher mentions ${path} but no AGENT_ROUTES entry names it`).toBe(true);
    }
  });

  // The mirror of the test above: a table entry the dispatcher never handles.
  // At runtime that answers 501 rather than serving something unauthenticated,
  // which is safe but silent — this makes it loud, and names the route.
  it('every table entry has a case in the dispatcher', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'agent-routes.ts'),
      'utf8',
    );
    for (const route of AGENT_ROUTES) {
      expect(source, `AGENT_ROUTES names ${route.id} but the dispatcher has no case for it`)
        .toContain(`case '${route.id}'`);
    }
  });

  it('every table entry\'s probe actually matches that entry', () => {
    for (const route of AGENT_ROUTES) {
      expect(matchAgentRoute(route.method, route.probe)?.id, `${route.id}'s probe matches a different route`)
        .toBe(route.id);
    }
  });

  it('an unknown path under the prefix is a 404, not an unauthenticated pass-through', () => {
    harness();
    const out = fakeRes();
    const handled = handleAgentRoute(fakeReq('GET', {}, ''), out.res, url(`${AGENT_ROUTE_PREFIX}/nothing-here`));
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(404);
    expect((JSON.parse(out.body) as { signal: string }).signal).toBe('AGENT_ROUTE_NOT_FOUND');
  });

  it('a paired machine reaches protocol state, and an unpaired one does not', async () => {
    const h = harness();
    const credential = h.machines.issue({ machine: 'ipad' });
    const workspace = Buffer.from('/tmp/ws').toString('base64url');

    const denied = fakeRes();
    handleAgentRoute(fakeReq('GET', {}, ''), denied.res, url(`${AGENT_ROUTE_PREFIX}/workspaces/${workspace}/state`));
    await flush();
    expect(denied.statusCode).toBe(401);
    expect((JSON.parse(denied.body) as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED);

    const allowed = fakeRes();
    handleAgentRoute(
      fakeReq('GET', { [MACHINE_CREDENTIAL_HEADER]: credential.presentation }, ''),
      allowed.res,
      url(`${AGENT_ROUTE_PREFIX}/workspaces/${workspace}/state`),
    );
    await flush();
    // Success is spelled as success: the refusal is gone AND real state came back.
    expect(allowed.statusCode).toBe(200);
    expect((JSON.parse(allowed.body) as { schemaVersion: number }).schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 2: a pairing token redeems once; an expired one is refused.
// ---------------------------------------------------------------------------

describe('pairing tokens', () => {
  it('redeems once and refuses the second presentation as REDEEMED, not UNKNOWN', () => {
    const store = new PairingStore({ root: tmp() });
    const issued = store.issue();

    const first = store.redeem(issued.token, { machine: 'ipad' });
    expect(first.redeemed).toBe(true);
    expect(first.code).toBe(PAIRING_SIGNAL.PAIRING_TOKEN_ACCEPTED);

    const second = store.redeem(issued.token, { machine: 'ipad' });
    expect(second.redeemed).toBe(false);
    expect(second.code).toBe(PAIRING_SIGNAL.PAIRING_TOKEN_REDEEMED);
    // "Already spent" and "never existed" send an operator to different places.
    expect(second.code).not.toBe(PAIRING_SIGNAL.PAIRING_TOKEN_UNKNOWN);
    expect(second.code).not.toBe(PAIRING_SIGNAL.PAIRING_TOKEN_EXPIRED);
  });

  it('refuses an expired token as EXPIRED, not UNKNOWN', () => {
    let now = 1_000_000;
    const store = new PairingStore({ root: tmp(), now: () => now });
    const issued = store.issue({ ttlMs: 60_000 });
    now += 60_001;
    const outcome = store.redeem(issued.token, { machine: 'ipad' });
    expect(outcome.redeemed).toBe(false);
    expect(outcome.code).toBe(PAIRING_SIGNAL.PAIRING_TOKEN_EXPIRED);
    expect(outcome.code).not.toBe(PAIRING_SIGNAL.PAIRING_TOKEN_UNKNOWN);
  });

  it('caps the requested TTL rather than honouring an unbounded one', () => {
    let now = 0;
    const store = new PairingStore({ root: tmp(), now: () => now });
    const issued = store.issue({ ttlMs: 365 * 24 * 60 * 60 * 1000 });
    // One hour is the cap. A token good for a year is a permanent credential
    // with no revocation story, which is the thing the bound exists to prevent.
    expect(Date.parse(issued.expiresAt)).toBe(60 * 60 * 1000);
  });

  it('a token with the right id and a wrong secret is UNKNOWN, revealing no state', () => {
    const store = new PairingStore({ root: tmp() });
    const issued = store.issue();
    const [id] = issued.token.split('.');
    expect(store.redeem(`${id}.wrong-secret`, { machine: 'x' }).code)
      .toBe(PAIRING_SIGNAL.PAIRING_TOKEN_UNKNOWN);
    // And the real token still works: the failed attempt did not consume it.
    expect(store.redeem(issued.token, { machine: 'x' }).redeemed).toBe(true);
  });

  it('an unparseable store reports UNREADABLE rather than "no such token"', () => {
    const root = tmp();
    const store = new PairingStore({ root });
    store.issue();
    writeFileSync(store.path, '{ not json');
    expect(() => store.redeem('a.b', { machine: 'x' })).toThrow(/PAIRING_STORE_UNREADABLE/);
  });

  it('the token never appears in the log stream, over the whole redemption flow', async () => {
    const h = harness();
    const issued = h.pairings.issue();
    const secret = issued.token.slice(issued.token.indexOf('.') + 1);

    const out = fakeRes();
    handleAgentRoute(
      fakeReq('POST', { [PAIRING_TOKEN_HEADER]: issued.token }, JSON.stringify({ machine: 'ipad' })),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/pairing/redeem`),
    );
    await flush();
    expect(out.statusCode).toBe(201);
    const body = JSON.parse(out.body) as { credential: string; machine: string };
    expect(body.machine).toBe('ipad');

    // The whole captured log stream, not a line somebody remembered to check.
    const stream = h.logs.join('\n');
    expect(stream).not.toContain(secret);
    expect(stream).not.toContain(issued.token);
    // Nor the credential the redemption just minted.
    expect(stream).not.toContain(body.credential.slice(body.credential.indexOf('.') + 1));
    // The log is not empty — otherwise this would pass by logging nothing at all.
    expect(stream).toContain('paired machine ipad');
  });

  it('the store on disk holds no presentable token', () => {
    const store = new PairingStore({ root: tmp() });
    const issued = store.issue();
    const secret = issued.token.slice(issued.token.indexOf('.') + 1);
    expect(readFileSync(store.path, 'utf8')).not.toContain(secret);
  });

  it('redaction keeps the pairing id and drops the secret', () => {
    const store = new PairingStore({ root: tmp() });
    const issued = store.issue();
    const redacted = redactPairingToken(`pairing token issued: ${issued.token}`);
    expect(redacted).toContain(issued.pairingId);
    expect(redacted).not.toContain(issued.token.slice(issued.token.indexOf('.') + 1));
    expect(redacted).toContain('<redacted>');
  });

  it('redemption over the route yields a credential that actually authenticates', async () => {
    const h = harness();
    const issued = h.pairings.issue();
    const out = fakeRes();
    handleAgentRoute(
      fakeReq('POST', { [PAIRING_TOKEN_HEADER]: issued.token }, JSON.stringify({ machine: 'studio' })),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/pairing/redeem`),
    );
    await flush();
    const body = JSON.parse(out.body) as { credential: string };
    // A 201 with a junk body would pass a status check. This does not.
    expect(h.machines.verify(body.credential).authorized).toBe(true);
  });

  it('redemption without a machine name is a 400, and does not spend the token', async () => {
    const h = harness();
    const issued = h.pairings.issue();
    const out = fakeRes();
    handleAgentRoute(
      fakeReq('POST', { [PAIRING_TOKEN_HEADER]: issued.token }, '{}'),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/pairing/redeem`),
    );
    await flush();
    expect(out.statusCode).toBe(400);
    expect(h.pairings.redeem(issued.token, { machine: 'later' }).redeemed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 3: revoking machine A leaves machine B working.
// ---------------------------------------------------------------------------

describe('per-machine credentials', () => {
  it('revoking one machine leaves another working, asserted at the store', () => {
    const store = new MachineCredentialStore({ root: tmp() });
    const a = store.issue({ machine: 'ipad' });
    const b = store.issue({ machine: 'laptop' });
    expect(store.verify(a.presentation).authorized).toBe(true);
    expect(store.verify(b.presentation).authorized).toBe(true);

    expect(store.revoke('ipad')).toBe(true);

    const revoked = store.verify(a.presentation);
    expect(revoked.authorized).toBe(false);
    expect(revoked.code).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED);
    // The neighbours it must not collapse into.
    expect(revoked.code).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN);
    expect(revoked.code).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_EXPIRED);
    expect(revoked.code).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_INVALID);

    // The other machine is untouched.
    expect(store.verify(b.presentation).authorized).toBe(true);
    expect(store.describe('laptop')?.revokedAt).toBeUndefined();
  });

  it('stores each machine in its own file, so a revocation cannot rewrite another', () => {
    const root = tmp();
    const store = new MachineCredentialStore({ root });
    store.issue({ machine: 'ipad' });
    store.issue({ machine: 'laptop' });
    const files = readdirSync(root).filter((name) => name.endsWith('.json'));
    // "Stored separately" as a filesystem fact, not as a promise about the write
    // code: two machines, two files.
    expect(files).toHaveLength(2);

    const laptopBefore = readFileSync(store.pathFor('laptop'), 'utf8');
    store.revoke('ipad');
    expect(readFileSync(store.pathFor('laptop'), 'utf8')).toBe(laptopBefore);
  });

  it('revocation fails a machine closed at the ROUTE, not only at the store', async () => {
    const h = harness();
    const ipad = h.machines.issue({ machine: 'ipad' });
    const laptop = h.machines.issue({ machine: 'laptop' });
    const workspace = Buffer.from('/tmp/ws').toString('base64url');
    const statePath = `${AGENT_ROUTE_PREFIX}/workspaces/${workspace}/state`;

    h.machines.revoke('ipad');

    const denied = fakeRes();
    handleAgentRoute(fakeReq('GET', { [MACHINE_CREDENTIAL_HEADER]: ipad.presentation }, ''), denied.res, url(statePath));
    await flush();
    // 403, not 401: "withdrawn" is a different instruction from "authenticate".
    expect(denied.statusCode).toBe(403);
    expect((JSON.parse(denied.body) as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED);

    const ok = fakeRes();
    handleAgentRoute(fakeReq('GET', { [MACHINE_CREDENTIAL_HEADER]: laptop.presentation }, ''), ok.res, url(statePath));
    await flush();
    expect(ok.statusCode).toBe(200);
  });

  it('a machine name cannot escape the store directory', () => {
    const root = tmp();
    const store = new MachineCredentialStore({ root });
    store.issue({ machine: '../../../etc/passwd' });
    // The file name is a hash, so a name shaped like a path is not one.
    expect(store.pathFor('../../../etc/passwd').startsWith(root)).toBe(true);
    expect(readdirSync(root).every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
  });

  // A spawned test Tower must not write credentials into the developer's real
  // ~/.agent-farm (#1515). The claim is only worth making if something checks it.
  it('honours the CODEV_AGENT_FARM_DIR isolation override', () => {
    const root = tmp();
    const saved = process.env.CODEV_AGENT_FARM_DIR;
    process.env.CODEV_AGENT_FARM_DIR = root;
    try {
      expect(defaultMachineRoot().startsWith(root)).toBe(true);
      expect(defaultPairingRoot().startsWith(root)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CODEV_AGENT_FARM_DIR;
      else process.env.CODEV_AGENT_FARM_DIR = saved;
    }
  });

  it('the store on disk holds no presentable credential', () => {
    const store = new MachineCredentialStore({ root: tmp() });
    const issued = store.issue({ machine: 'ipad' });
    const secret = issued.presentation.slice(issued.presentation.indexOf('.') + 1);
    expect(readFileSync(store.pathFor('ipad'), 'utf8')).not.toContain(secret);
  });

  it('an expired credential is EXPIRED, not UNKNOWN', () => {
    let now = 1_000_000;
    const store = new MachineCredentialStore({ root: tmp(), now: () => now });
    const issued = store.issue({ machine: 'ipad', lifetimeMs: 60_000 });
    now += 60_001;
    const verdict = store.verify(issued.presentation);
    expect(verdict.code).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_EXPIRED);
    expect(verdict.code).not.toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN);
  });

  it('a corrupt store reports UNREADABLE rather than "that machine was never paired"', () => {
    const root = tmp();
    const store = new MachineCredentialStore({ root });
    const issued = store.issue({ machine: 'ipad' });
    writeFileSync(store.pathFor('ipad'), '{ not json');
    expect(() => store.verify(issued.presentation)).toThrow(MachineStoreUnreadable);
  });

  it('an unreadable store answers 503 at the route, never a 401 that reads as "not paired"', async () => {
    const h = harness();
    const issued = h.machines.issue({ machine: 'ipad' });
    writeFileSync(h.machines.pathFor('ipad'), '{ not json');
    const out = fakeRes();
    handleAgentRoute(
      fakeReq('GET', { [MACHINE_CREDENTIAL_HEADER]: issued.presentation }, ''),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/session`),
    );
    await flush();
    expect(out.statusCode).toBe(503);
    expect((JSON.parse(out.body) as { signal: string }).signal)
      .toBe(MACHINE_SIGNAL.MACHINE_STORE_UNREADABLE);
  });

  it('re-pairing a machine invalidates its previous credential', () => {
    const store = new MachineCredentialStore({ root: tmp() });
    const first = store.issue({ machine: 'ipad' });
    const second = store.issue({ machine: 'ipad' });
    expect(store.verify(second.presentation).authorized).toBe(true);
    expect(store.verify(first.presentation).authorized).toBe(false);
  });

  it('a revocation tombstone survives until the original expiry, then sweeps', () => {
    let now = 1_000_000;
    const store = new MachineCredentialStore({ root: tmp(), now: () => now });
    const issued = store.issue({ machine: 'ipad', lifetimeMs: 60_000 });
    store.revoke('ipad');
    expect(store.verify(issued.presentation).code).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED);
    now += 60_001;
    expect(store.sweep()).toBe(1);
    // Past expiry, "revoked" and "never paired" are the same answer, so dropping
    // the tombstone loses nothing.
    expect(store.verify(issued.presentation).code).toBe(MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN);
  });

  it('revoking through the route reports whether anything was live', async () => {
    const h = harness();
    h.machines.issue({ machine: 'ipad' });
    const operator = h.machines.issue({ machine: 'laptop' });
    const session = h.sessions.completePairing({ pairingId: 'p', principalKind: 'human-client' });
    const headers = {
      [MACHINE_CREDENTIAL_HEADER]: operator.presentation,
      [HUMAN_SESSION_HEADER]: `${session.sessionId}.${session.credential}`,
    };

    const first = fakeRes();
    handleAgentRoute(fakeReq('DELETE', headers, ''), first.res, url(`${AGENT_ROUTE_PREFIX}/machines/ipad`));
    await flush();
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      signal: MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED,
      revoked: true,
    });

    const second = fakeRes();
    handleAgentRoute(fakeReq('DELETE', headers, ''), second.res, url(`${AGENT_ROUTE_PREFIX}/machines/ipad`));
    await flush();
    // Already revoked is not an error, and is not spelled as a fresh revocation.
    expect(JSON.parse(second.body)).toMatchObject({ signal: 'MACHINE_CREDENTIAL_NOT_LIVE', revoked: false });
  });

  it('an agent holding only a machine credential cannot reach an approval route', async () => {
    const h = harness();
    const credential = h.machines.issue({ machine: 'builder-host' });
    const out = fakeRes();
    handleAgentRoute(
      fakeReq('POST', { [MACHINE_CREDENTIAL_HEADER]: credential.presentation }, '{}'),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/approval-capabilities`),
    );
    await flush();
    expect(out.statusCode).toBe(401);
    expect((JSON.parse(out.body) as { signal: string }).signal).toBe('HUMAN_SESSION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 4: a non-loopback bind without TLS is refused at startup.
// ---------------------------------------------------------------------------

describe('binding policy', () => {
  it('allows loopback with no declaration at all', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const decision = decideBindPolicy({ host });
      expect(decision.allowed, `${host} was refused`).toBe(true);
      expect(decision.exposed).toBe(false);
      expect(decision.code).toBe(TRANSPORT_SIGNAL.BIND_LOOPBACK_ONLY);
    }
  });

  it('REFUSES a plaintext non-loopback bind rather than warning about it', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '100.64.0.3']) {
      const decision = decideBindPolicy({ host });
      expect(decision.allowed, `${host} was allowed without a TLS declaration`).toBe(false);
      expect(decision.code).toBe(TRANSPORT_SIGNAL.INSECURE_NON_LOOPBACK_BIND_REFUSED);
      // The refusal has to say how to proceed, or the operator's next move is to
      // delete the check.
      expect(decision.message).toContain('CODEV_BRIDGE_TLS=terminated');
    }
  });

  it('allows an exposed bind only when TLS termination is explicitly declared', () => {
    const decision = decideBindPolicy({ host: '0.0.0.0', tlsDeclaration: 'terminated' });
    expect(decision.allowed).toBe(true);
    expect(decision.exposed).toBe(true);
    // And it says what it does NOT know, rather than claiming the transport is
    // encrypted. A process cannot see the proxy in front of it.
    expect(decision.message).toContain('cannot verify');
  });

  it('does not accept a vague or truthy declaration', () => {
    for (const declaration of ['1', 'true', 'yes', 'TERMINATED', '']) {
      expect(
        decideBindPolicy({ host: '0.0.0.0', tlsDeclaration: declaration }).allowed,
        `CODEV_BRIDGE_TLS=${declaration} was accepted`,
      ).toBe(false);
    }
  });

  it('the refusal is wired into tower-server, not only available to it', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'tower-server.ts'),
      'utf8',
    );
    // Derived from the file that does the binding: a policy nothing calls is a
    // policy that does not exist.
    expect(source).toContain('decideBindPolicy');
    expect(source).toMatch(/if \(!bindDecision\.allowed\)[\s\S]{0,200}process\.exit\(1\)/);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 5: a WebSocket upgrade from a disallowed origin is refused.
// ---------------------------------------------------------------------------

describe('origin rules', () => {
  const saved = process.env.CODEV_TOWER_ALLOWED_ORIGINS;
  beforeEach(() => { delete process.env.CODEV_TOWER_ALLOWED_ORIGINS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEV_TOWER_ALLOWED_ORIGINS;
    else process.env.CODEV_TOWER_ALLOWED_ORIGINS = saved;
  });

  it('refuses a WebSocket upgrade from a disallowed origin', () => {
    const req = { headers: { origin: 'https://evil.example' } } as unknown as http.IncomingMessage;
    expect(isUpgradeOriginAllowed(req)).toBe(false);
  });

  it('admits a loopback origin, and an operator-configured one', () => {
    const loopback = { headers: { origin: 'http://localhost:4100' } } as unknown as http.IncomingMessage;
    expect(isUpgradeOriginAllowed(loopback)).toBe(true);

    process.env.CODEV_TOWER_ALLOWED_ORIGINS = 'https://tower.tail-scale.ts.net';
    const configured = {
      headers: { origin: 'https://tower.tail-scale.ts.net' },
    } as unknown as http.IncomingMessage;
    expect(isUpgradeOriginAllowed(configured)).toBe(true);
  });

  it('an upgrade with NO origin is not refused here — the key is its control', () => {
    // The Node `ws` clients in this repo send no Origin. Refusing them would
    // break every one while stopping no attack, and the deliberate property is
    // that this check can only ever REFUSE, never admit.
    const req = { headers: {} } as unknown as http.IncomingMessage;
    expect(isUpgradeOriginAllowed(req)).toBe(true);
  });

  it('the upgrade handler calls the origin rule before the key check', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'tower-websocket.ts'),
      'utf8',
    );
    const originAt = source.indexOf('isUpgradeOriginAllowed(req)');
    const keyAt = source.indexOf('isWebSocketAllowed(req)');
    expect(originAt).toBeGreaterThan(-1);
    expect(keyAt).toBeGreaterThan(-1);
    expect(originAt).toBeLessThan(keyAt);
  });

  it('refuses an HTTP agent request from a disallowed origin, before any credential check', async () => {
    const h = harness();
    const credential = h.machines.issue({ machine: 'ipad' });
    const out = fakeRes();
    handleAgentRoute(
      fakeReq('GET', {
        origin: 'https://evil.example',
        [MACHINE_CREDENTIAL_HEADER]: credential.presentation,
      }, ''),
      out.res,
      url(`${AGENT_ROUTE_PREFIX}/session`),
    );
    await flush();
    expect(out.statusCode).toBe(403);
    expect((JSON.parse(out.body) as { signal: string }).signal).toBe(TRANSPORT_SIGNAL.ORIGIN_NOT_ALLOWED);
  });

  it('a request with no origin is judged on its credential, not on the header', () => {
    expect(isAgentOriginAllowed(undefined)).toBe(true);
    expect(isAgentOriginAllowed('')).toBe(true);
    expect(isAgentOriginAllowed('https://evil.example')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The runbook is part of the deliverable, so its content is asserted rather than
// assumed. A runbook that loses its teardown step is the failure the spec names.
// ---------------------------------------------------------------------------

describe('remote-access runbook', () => {
  const runbook = (): string => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(
      join(here, '..', '..', '..', '..', '..', 'codev', 'resources', '146-remote-access-runbook.md'),
      'utf8',
    );
  };

  it('documents pairing, exposure and teardown', () => {
    const text = runbook();
    expect(text).toContain('npx t3 pair --tailscale');
    // The spec records that the mapping PERSISTS until it is torn down, so the
    // teardown command is the part that must not go missing.
    expect(text).toContain('tailscale serve --https=443 off');
    expect(text).toContain('CODEV_BRIDGE_TLS=terminated');
  });

  it('names the revocation path, which is what an operator needs under pressure', () => {
    expect(runbook()).toContain(`${AGENT_ROUTE_PREFIX}/machines/`);
  });
});
