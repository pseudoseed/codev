/**
 * The client mount driven through Tower's REAL dispatcher over REAL HTTP.
 *
 * ## Why this exists beside the unit test
 *
 * `spec-146-phase-12-client-mount.test.ts` drives `serveClientStatic` directly.
 * That proves the module, and proves nothing about whether Tower reaches it —
 * which is exactly the failure this initiative keeps repeating: phase 5's
 * registry published only thread-backed rows, phase 6 and 7 built a capability
 * with no route that could obtain one, phase 9 shipped a path that sent
 * `branch: ''`. In all of them the unit was tested directly and nothing asked
 * what the wired-up system does.
 *
 * So this one binds a socket, puts `isRequestAllowed` in front of
 * `handleRequest` in the same order `tower-server.ts` does, and drives it with
 * `fetch`. Everything it asserts is a property of the composition rather than of
 * the module:
 *
 *   - the key allowlist lets the shell, assets, machine list and proxy through,
 *     and still refuses an ordinary Tower route;
 *   - `frame-ancestors` survives as a response header all the way to a client;
 *   - a POST reaches the upstream, which the GET-only half of the allowlist
 *     would have blocked — an approval is a POST;
 *   - the machine credential is forwarded rather than dropped;
 *   - traversal is refused with NOTHING served, by whichever guard catches it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicRoute, isRequestAllowed } from '../utils/server-utils.js';
import { handleRequest } from '../servers/tower-routes.js';
import { setClientDistRoot, setClientMachinesFileForTests } from '../servers/client-static.js';

const SHELL = '<!doctype html><html><head><title>Codev</title></head><body><div id="root"></div></body></html>';

const dirs: string[] = [];
/*
 * Closed in the `beforeAll` teardown, NOT in an `afterEach`. Both servers are
 * created once for the whole file, so tearing them down per test left every
 * case after the first talking to a closed socket — a harness failure that
 * reads exactly like a broken mount.
 */
const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready((server.address() as { port: number }).port));
  });
}

let base: string;
let machinesFile: string;
let upstreamSaw: { path: string | undefined; credential: string | string[] | undefined };

const routeCtx = {
  log: () => undefined,
  port: 0,
  version: 'test',
  startedAt: Date.now(),
  templatePath: null,
  reactDashboardPath: '/nonexistent',
  hasReactDashboard: false,
  getShellperManager: () => null,
  broadcastNotification: () => undefined,
  addSseClient: () => false,
  removeSseClient: () => undefined,
} as unknown as Parameters<typeof handleRequest>[2];

beforeAll(async () => {
  const state = mkdtempSync(join(tmpdir(), 'codev-mount-e2e-'));
  dirs.push(state);
  const dist = join(state, 'client-dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), SHELL);
  writeFileSync(join(dist, 'assets', 'app.js'), 'export const built = true;');
  setClientDistRoot(dist);

  // A stand-in for a machine's codev-agent, so the proxy has something real to
  // reach and can report what actually arrived.
  const upstreamPort = await listen(createServer((req, res) => {
    upstreamSaw = { path: req.url, credential: req.headers['codev-machine-credential'] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));

  machinesFile = join(state, 'client-machines.json');
  writeFileSync(machinesFile, JSON.stringify([{
    id: 'alpha',
    label: 'alpha',
    origin: `http://127.0.0.1:${upstreamPort}`,
    workspacePath: '/w',
    credential: 'cred-id.cred-secret',
  }]));
  chmodSync(machinesFile, 0o600);
  setClientMachinesFileForTests(machinesFile);

  // THE ORDER `tower-server.ts` USES. Putting the allowlist inside the handler
  // would test a Tower that does not exist.
  const towerPort = await listen(createServer((req, res) => {
    if (!isRequestAllowed(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    void handleRequest(req, res, routeCtx).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  }));
  base = `http://127.0.0.1:${towerPort}`;

  return () => {
    setClientDistRoot(null);
    setClientMachinesFileForTests(null);
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  };
});

async function probe(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  return {
    status: response.status,
    csp: response.headers.get('content-security-policy'),
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

describe('Tower actually serves the client', () => {
  it('serves the shell without a key, and with frame-ancestors as a header', async () => {
    const shell = await probe('/client/');
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<div id="root">');
    // The directive a <meta> CSP silently ignores. It has to survive to here.
    expect(shell.csp).toBe("frame-ancestors 'none'");
  });

  it('does not hand the page Tower\'s shared key', async () => {
    const shell = await probe('/client/');
    expect(shell.body).not.toContain('__CODEV_TOWER_KEY__');
  });

  it('redirects the bare URL a person types, keeping the query', async () => {
    const redirect = await probe('/client?view=tree');
    expect(redirect.status).toBe(301);
    expect(redirect.location).toBe('/client/?view=tree');
  });

  it('serves an asset', async () => {
    const asset = await probe('/client/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.contentType).toContain('javascript');
  });

  it('answers the machine list with same-origin paths', async () => {
    const machines = await probe('/client/machines.json');
    expect(machines.status).toBe(200);
    expect((JSON.parse(machines.body) as Array<{ origin: string }>)[0].origin).toBe('/m/alpha');
  });
});

describe('the proxy, through the whole stack', () => {
  it('forwards a GET to the machine with its path intact', async () => {
    const answer = await probe('/m/alpha/api/agent/v1/workspaces/x/state');
    expect(answer.status).toBe(200);
    expect(upstreamSaw.path).toBe('/api/agent/v1/workspaces/x/state');
  });

  /*
   * THE ONE THE GET-ONLY HALF OF THE ALLOWLIST WOULD HAVE BROKEN. An approval is
   * a POST, so a proxy reachable only by GET is a proxy an operator cannot
   * approve a gate through — and it would have passed every GET test above.
   */
  it('forwards a POST, and forwards the machine credential with it', async () => {
    const answer = await probe('/m/alpha/api/agent/v1/gates/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'codev-machine-credential': 'cred-id.cred-secret' },
      body: JSON.stringify({ projectId: '1' }),
    });
    expect(answer.status).toBe(200);
    expect(upstreamSaw.credential).toBe('cred-id.cred-secret');
  });
});

describe('the mount does not widen anything else', () => {
  /*
   * ASSERTED ON THE PREDICATE, NOT OVER HTTP, and the reason is worth stating so
   * nobody "strengthens" it back into a request. `vitest-setup.ts` scrubs every
   * CODEV_* variable (#189), so this process's notion of Tower's shared key is
   * whatever the host machine happens to have — which makes an HTTP 401 here a
   * measurement of the developer's `~/.agent-farm`, not of this change.
   *
   * The claim is anyway a property of the allowlist: the mount added its own
   * paths and nothing else. That is exactly what `isPublicRoute` decides, and
   * it decides it from its arguments alone.
   */
  it('adds its own paths to the allowlist and no others', () => {
    for (const owned of ['/client', '/client/', '/client/assets/app.js', '/client/machines.json']) {
      expect(isPublicRoute('GET', owned), owned).toBe(true);
    }
    expect(isPublicRoute('POST', '/m/alpha/api/agent/v1/gates/approve')).toBe(true);

    // Neighbours that must NOT have been swept in by a prefix that is too wide.
    for (const keyed of ['/api/overview', '/api/terminals', '/machines.json', '/clients/', '/m']) {
      expect(isPublicRoute('GET', keyed), keyed).toBe(keyed === '/m');
    }
    // The list is readable without a key; it is not WRITABLE without one.
    expect(isPublicRoute('POST', '/client/machines.json')).toBe(false);
  });

  /*
   * TWO GUARDS, AND WHICH ONE CATCHES IT IS NOT THE POINT. WHATWG `URL`
   * normalises %2e%2e to .., so the first of these arrives as `/package.json` —
   * outside `/client/` entirely, where the key allowlist refuses it before the
   * mount is consulted. Asserting a specific status would pin which guard fired;
   * what must hold is that nothing is served.
   */
  it.each([
    '/client/assets/%2e%2e/%2e%2e/package.json',
    '/client/assets/%2e%2e/client-machines.json',
    '/client/assets/../../package.json',
  ])('serves nothing for %s', async (attempt) => {
    const traversal = await probe(attempt);
    expect([401, 404]).toContain(traversal.status);
    expect(traversal.body).not.toContain('cred-secret');
    expect(traversal.body).not.toContain('"dependencies"');
  });

  it('refuses a group-readable machine list without leaking what is in it', async () => {
    chmodSync(machinesFile, 0o644);
    try {
      const loose = await probe('/client/machines.json');
      const parsed = JSON.parse(loose.body) as { signal: string; machines: unknown[] };
      expect(parsed.signal).toBe('CLIENT_MACHINES_MODE');
      expect(parsed.machines).toEqual([]);
      expect(loose.body).not.toContain('cred-secret');
    } finally {
      chmodSync(machinesFile, 0o600);
    }
  });
});
