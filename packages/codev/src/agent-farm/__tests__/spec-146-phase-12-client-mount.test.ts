/**
 * Tower serves the codev-client (Spec 146, Phase 12; issue #228 item 1).
 *
 * Phase 11 left `scripts/serve.mjs` — a loopback script run from a checkout — as
 * the only server for the built bundle, so the client was something you could
 * open rather than something you use. These assert the mount that changes that,
 * and the three properties it must not lose:
 *
 *   1. `frame-ancestors` travels as a RESPONSE HEADER. A `<meta>` CSP silently
 *      ignores that directive, so a mount that relies on the meta tag ships a
 *      protection that does nothing.
 *   2. Tower's shared key is NEVER injected into this page, unlike `/v2/`. The
 *      key cannot be revoked for one machine without rotating it for all.
 *   3. Four different machine-list problems answer four different signals. An
 *      absent file and a mistyped one need opposite next actions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import {
  CLIENT_CSP,
  isClientPath,
  originProblem,
  readClientMachines,
  serveClientStatic,
  setClientDistRoot,
  setClientMachinesFileForTests,
} from '../servers/client-static.js';
import { isPublicRoute } from '../utils/server-utils.js';

const SHELL = '<!doctype html><html><head><title>Codev</title></head><body><div id="root"></div></body></html>';
const KEY = 'ab'.repeat(32);

function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: { host: 'localhost:4100' }, pipe: vi.fn() } as unknown as http.IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  let code = 200;
  const hdrs: Record<string, string> = { 'Access-Control-Allow-Origin': '*', Vary: 'Origin' };
  const removed: string[] = [];
  const res = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
    }),
    setHeader: vi.fn((k: string, v: string) => { hdrs[k] = v; }),
    removeHeader: vi.fn((k: string) => { removed.push(k); delete hdrs[k]; }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    on: vi.fn(),
    headersSent: false,
    destroy: vi.fn(),
  } as unknown as http.ServerResponse;
  return { res, body: () => chunks.join(''), status: () => code, headers: () => hdrs, removed };
}

function url(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'http://localhost:4100');
}

let dist: string;
let machinesFile: string;

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-client-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), SHELL);
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  setClientDistRoot(dist);
  machinesFile = path.join(dist, 'client-machines.json');
  setClientMachinesFileForTests(machinesFile);
});

afterEach(() => {
  setClientDistRoot(null);
  setClientMachinesFileForTests(null);
  fs.rmSync(dist, { recursive: true, force: true });
});

function writeMachines(entries: unknown, mode = 0o600): void {
  fs.writeFileSync(machinesFile, JSON.stringify(entries), { mode });
  fs.chmodSync(machinesFile, mode);
}

describe('the shell', () => {
  it('serves the bundle at /client/', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/'), out.res, url('/client/'));
    expect(out.status()).toBe(200);
    expect(out.body()).toContain('<div id="root">');
  });

  it('sends frame-ancestors as a header, because a meta CSP ignores it', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/'), out.res, url('/client/'));
    expect(out.headers()['Content-Security-Policy']).toBe(CLIENT_CSP);
    expect(CLIENT_CSP).toContain('frame-ancestors');
  });

  /*
   * THE ONE THAT WOULD BE EASY TO BREAK BY COPYING `v2-static.ts`. That module
   * injects `window.__CODEV_TOWER_KEY__`; this one must not, and the assertion
   * is on the served bytes rather than on the absence of a call.
   */
  it('never injects Tower\'s shared key into the page', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/'), out.res, url('/client/'));
    expect(out.body()).not.toContain('__CODEV_TOWER_KEY__');
    expect(out.body()).not.toContain(KEY);
  });

  it('redirects the URL a person types, keeping the query string', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client?view=tree'), out.res, url('/client?view=tree'));
    expect(out.status()).toBe(301);
    expect(out.headers().Location).toBe('/client/?view=tree');
  });

  it('serves a deep link as the shell rather than 404ing on an SPA route', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/anything'), out.res, url('/client/anything'));
    expect(out.status()).toBe(200);
    expect(out.body()).toContain('<div id="root">');
  });
});

describe('assets', () => {
  it('serves a built asset with its media type', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/assets/app.js'), out.res, url('/client/assets/app.js'));
    expect(out.status()).toBe(200);
    expect(out.headers()['Content-Type']).toContain('javascript');
  });

  /*
   * `%2e%2e` IS THE INTERESTING ONE. WHATWG `URL` normalises it to `..`, so this
   * arrives at the handler as `/client/secret.js` — outside the asset prefix
   * entirely. It must 404 rather than fall into the SPA shell fallback, which
   * would answer a script request with HTML.
   */
  it.each([
    '/client/assets/%2e%2e/secret.js',
    '/client/assets/app.sh',
    '/client/missing.js',
  ])('refuses %s', (attempt) => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', attempt), out.res, url(attempt));
    expect(out.status()).toBe(404);
    expect(out.body()).not.toContain('<div id="root">');
  });

  it('never serves a file from outside the asset root', () => {
    const secret = path.join(dist, 'secret.js');
    fs.writeFileSync(secret, 'const stolen = 1;');
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/assets/%2e%2e/secret.js'), out.res,
      url('/client/assets/%2e%2e/secret.js'));
    expect(out.body()).not.toContain('stolen');
  });
});

describe('the machine list', () => {
  it('rewrites every origin to a same-origin path so connect-src stays self', () => {
    writeMachines([{
      id: 'alpha', label: 'alpha', origin: 'http://127.0.0.1:4101',
      workspacePath: '/w', credential: 'id.secret',
    }]);
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/machines.json'), out.res, url('/client/machines.json'));
    const parsed = JSON.parse(out.body()) as Array<{ origin: string }>;
    expect(parsed[0].origin).toBe('/m/alpha');
  });

  /*
   * FOUR SITUATIONS, FOUR SIGNALS. Collapsing them into an empty list is the
   * defect this client exists to avoid: an operator who has configured nothing
   * and an operator whose file is mode 644 need opposite next actions, and an
   * empty list with no reason reads as a broken client rather than either.
   */
  it('names an absent list rather than serving a silent empty one', () => {
    const read = readClientMachines();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.signal).toBe('CLIENT_MACHINES_ABSENT');
  });

  it('refuses a group- or world-readable list, because it holds credentials', () => {
    writeMachines([], 0o644);
    const read = readClientMachines();
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.signal).toBe('CLIENT_MACHINES_MODE');
      expect(read.message).toContain('chmod 600');
    }
  });

  it('names a list it cannot parse', () => {
    fs.writeFileSync(machinesFile, '{not json', { mode: 0o600 });
    fs.chmodSync(machinesFile, 0o600);
    const read = readClientMachines();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.signal).toBe('CLIENT_MACHINES_UNREADABLE');
  });

  it('drops a malformed entry rather than serving half of one', () => {
    writeMachines([
      { id: 'good', label: 'g', origin: 'http://127.0.0.1:1', workspacePath: '/w', credential: 'a.b' },
      { id: 'nocred', label: 'n', origin: 'http://127.0.0.1:2', workspacePath: '/w' },
    ]);
    const read = readClientMachines();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.machines.map((m) => m.id)).toEqual(['good']);
  });

  it('answers a signal, not an empty array with no reason, when the file is gone', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/client/machines.json'), out.res, url('/client/machines.json'));
    const parsed = JSON.parse(out.body()) as { signal?: string; machines?: unknown[] };
    expect(parsed.signal).toBe('CLIENT_MACHINES_ABSENT');
    expect(parsed.machines).toEqual([]);
  });
});

describe('the machine proxy', () => {
  it('404s a machine nobody configured, and says which signal', () => {
    writeMachines([]);
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/m/ghost/api/agent/v1/x'), out.res, url('/m/ghost/api/agent/v1/x'));
    expect(out.status()).toBe(404);
    expect(JSON.parse(out.body()).signal).toBe('UNKNOWN_MACHINE');
  });

  it('reports the configuration problem rather than UNKNOWN_MACHINE when there is no list', () => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/m/alpha/api/agent/v1/x'), out.res, url('/m/alpha/api/agent/v1/x'));
    expect(JSON.parse(out.body()).signal).toBe('CLIENT_MACHINES_ABSENT');
  });
});

describe('the dispatcher and the key allowlist', () => {
  it('claims every path the mount owns and nothing else', () => {
    for (const owned of ['/client', '/client/', '/client/assets/a.js', '/m/alpha/api/agent/v1/x']) {
      expect(isClientPath(owned), owned).toBe(true);
    }
    for (const foreign of ['/v2/', '/api/version', '/clients', '/machine/alpha']) {
      expect(isClientPath(foreign), foreign).toBe(false);
    }
  });

  /*
   * The proxy carries POST — an approval is a POST — so it cannot ride the
   * GET-only half of the allowlist. The reasoning for why this surface takes a
   * per-machine credential instead of Tower's shared key is in `isPublicRoute`.
   */
  it('lets the shell, its assets, the machine list and the proxy through keyless', () => {
    expect(isPublicRoute('GET', '/client/')).toBe(true);
    expect(isPublicRoute('GET', '/client/assets/app.js')).toBe(true);
    expect(isPublicRoute('GET', '/client/machines.json')).toBe(true);
    expect(isPublicRoute('POST', '/m/alpha/api/agent/v1/gates/approve')).toBe(true);
  });

  it('does not make the machine list writable by an unkeyed caller', () => {
    expect(isPublicRoute('POST', '/client/machines.json')).toBe(false);
  });
});

/**
 * WHICH ORIGINS MAY BE PROXIED, and why the check is here rather than in the
 * dial.
 *
 * Both failures below used to be spelled `UPSTREAM_GONE`, "that machine did not
 * answer" — a configuration mistake reported as a dead host, which sends an
 * operator to restart something that is fine.
 */
describe('machine origins', () => {
  it('accepts https anywhere and http on loopback', () => {
    for (const origin of [
      'https://box.tailnet.ts.net',
      'https://10.0.0.4:4100',
      'http://127.0.0.1:4100',
      'http://localhost:4100',
    ]) {
      expect(originProblem(origin), origin).toBeNull();
    }
  });

  /*
   * The spec's constraint is that all remote transport is HTTPS/WSS, and the
   * thing being carried is a machine credential. Plaintext to a remote host puts
   * it on the wire.
   */
  it('refuses plaintext http to a non-loopback host, naming the credential', () => {
    const problem = originProblem('http://box.tailnet.ts.net');
    expect(problem).toContain('plaintext');
    expect(problem).toContain('credential');
  });

  it.each(['ftp://host', 'file:///etc/passwd', 'not a url', ''])('refuses %s', (origin) => {
    expect(originProblem(origin)).not.toBeNull();
  });

  it('answers a bad origin as a configuration refusal, never as a dead machine', () => {
    writeMachines([{
      id: 'remote', label: 'remote', origin: 'http://box.tailnet.ts.net',
      workspacePath: '/w', credential: 'id.secret',
    }]);
    const out = makeRes();
    serveClientStatic(makeReq('GET', '/m/remote/api/agent/v1/x'), out.res, url('/m/remote/api/agent/v1/x'));
    const answer = JSON.parse(out.body()) as { signal: string; message: string };
    expect(answer.signal).toBe('MACHINE_ORIGIN_REFUSED');
    expect(answer.signal).not.toBe('UPSTREAM_GONE');
    expect(out.status()).toBe(400);
  });
});

/**
 * A PROXY PATH THAT NAMED NO RESOURCE IS NOT AN SPA ROUTE.
 *
 * `/m`, `/m/` and `/m/<id>` miss the proxy regex, and the extensionless SPA
 * fallback caught them — so a machine request was answered with the page, 200,
 * and a client parsing HTML as JSON.
 */
describe('proxy paths that name nothing', () => {
  it.each(['/m', '/m/', '/m/alpha'])('404s %s instead of serving the shell', (path) => {
    const out = makeRes();
    serveClientStatic(makeReq('GET', path), out.res, url(path));
    expect(out.status()).toBe(404);
    expect(out.body()).not.toContain('<div id="root">');
  });
});
