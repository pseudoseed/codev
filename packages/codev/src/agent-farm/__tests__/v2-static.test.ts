import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { handleV2Route, resetV2RoutesForTests } from '../servers/v2-routes.js';
import { injectV2Key, setV2DistRoot, setV2InjectedKeyForTests } from '../servers/v2-static.js';

const GOOD_KEY = 'ab'.repeat(32);
const SHELL = '<!doctype html><html><head><title>v2</title></head><body><div id="root"></div></body></html>';

function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: { host: 'localhost:4100' } } as http.IncomingMessage;
}

function makeRes(): {
  res: http.ServerResponse;
  body: () => string;
  statusCode: () => number;
  headers: () => Record<string, string>;
  removed: string[];
} {
  const chunks: string[] = [];
  let code = 200;
  const hdrs: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    Vary: 'Origin',
  };
  const removed: string[] = [];
  const res = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
    }),
    setHeader: vi.fn((k: string, v: string) => { hdrs[k] = v; }),
    removeHeader: vi.fn((k: string) => {
      removed.push(k);
      delete hdrs[k];
    }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => { chunks.push(data); }),
    on: vi.fn(),
    writableEnded: false,
    destroyed: false,
  } as unknown as http.ServerResponse;
  return {
    res,
    body: () => chunks.join(''),
    statusCode: () => code,
    headers: () => hdrs,
    removed,
  };
}

function urlFor(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'http://localhost:4100');
}

function makeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(dir, 'assets', 'secret.txt'), 'nope');
  return dir;
}

describe('injectV2Key', () => {
  it('embeds a well-formed 64-hex key via JSON.stringify before </head>', () => {
    const out = injectV2Key(SHELL, GOOD_KEY);
    expect(out).toContain(`<script>window.__CODEV_TOWER_KEY__ = ${JSON.stringify(GOOD_KEY)};</script></head>`);
    expect(out.indexOf('__CODEV_TOWER_KEY__')).toBeLessThan(out.indexOf('</head>'));
  });

  it('does not inject a malformed key', () => {
    expect(injectV2Key(SHELL, 'not-a-key')).toBe(SHELL);
    expect(injectV2Key(SHELL, `${GOOD_KEY}ff`)).toBe(SHELL);
    expect(injectV2Key(SHELL, `</script>${'a'.repeat(56)}`)).toBe(SHELL);
    expect(injectV2Key(SHELL, null)).toBe(SHELL);
    expect(injectV2Key(SHELL, GOOD_KEY.toUpperCase())).toBe(SHELL);
  });

  it('does not invent a placeholder when </head> is absent', () => {
    const bare = '<html><body></body></html>';
    expect(injectV2Key(bare, GOOD_KEY)).toBe(bare);
  });
});

describe('serveV2Static via handleV2Route', () => {
  let dist: string;

  beforeEach(() => {
    resetV2RoutesForTests();
    dist = makeDist();
    setV2DistRoot(dist);
    setV2InjectedKeyForTests(GOOD_KEY);
  });

  afterEach(() => {
    setV2DistRoot(null);
    setV2InjectedKeyForTests(undefined);
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('serves GET /v2/ with the key injected and CORS headers stripped', async () => {
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/'), out.res, urlFor('/v2/'));
    expect(out.statusCode()).toBe(200);
    expect(out.removed).toEqual(['Access-Control-Allow-Origin', 'Vary']);
    expect(out.headers()['Access-Control-Allow-Origin']).toBeUndefined();
    expect(out.headers().Vary).toBeUndefined();
    expect(out.body()).toContain(`window.__CODEV_TOWER_KEY__ = ${JSON.stringify(GOOD_KEY)}`);
    expect(out.body().indexOf('__CODEV_TOWER_KEY__')).toBeLessThan(out.body().indexOf('</head>'));
  });

  it('does not inject when the key is malformed', async () => {
    setV2InjectedKeyForTests('bad');
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/'), out.res, urlFor('/v2/'));
    expect(out.statusCode()).toBe(200);
    expect(out.body()).not.toContain('__CODEV_TOWER_KEY__');
    expect(out.removed).toEqual(['Access-Control-Allow-Origin', 'Vary']);
  });

  it('serves an allowlisted asset', async () => {
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/assets/app.js'), out.res, urlFor('/v2/assets/app.js'));
    expect(out.statusCode()).toBe(200);
    expect(out.body()).toBe('console.log(1)');
    expect(out.removed).toEqual([]);
  });

  it('refuses a non-allowlisted extension', async () => {
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/assets/secret.txt'), out.res, urlFor('/v2/assets/secret.txt'));
    expect(out.statusCode()).toBe(404);
    expect(out.body()).toBe('Not found');
  });

  it('refuses traversal via /v2/assets/../../etc/passwd', async () => {
    const out = makeRes();
    await handleV2Route(
      makeReq('GET', '/v2/assets/../../etc/passwd'),
      out.res,
      urlFor('/v2/assets/../../etc/passwd'),
    );
    expect(out.statusCode()).toBe(404);
  });

  it('refuses a pathname that still contains ..', async () => {
    const url = urlFor('/v2/assets/x');
    Object.defineProperty(url, 'pathname', { value: '/v2/assets/foo/../../../etc/passwd' });
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/assets/foo/../../../etc/passwd'), out.res, url);
    expect(out.statusCode()).toBe(404);
  });

  it('404s GET /v2/nonsense', async () => {
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/nonsense'), out.res, urlFor('/v2/nonsense'));
    expect(out.statusCode()).toBe(404);
    expect(out.body()).toBe('Not found');
    expect(out.removed).toEqual([]);
  });

  it('404s non-GET on /v2/', async () => {
    const out = makeRes();
    await handleV2Route(makeReq('POST', '/v2/'), out.res, urlFor('/v2/'));
    expect(out.statusCode()).toBe(404);
    expect(out.removed).toEqual([]);
  });

  it('404s GET /v2/ when dist is missing', async () => {
    setV2DistRoot(path.join(dist, 'does-not-exist'));
    const out = makeRes();
    await handleV2Route(makeReq('GET', '/v2/'), out.res, urlFor('/v2/'));
    expect(out.statusCode()).toBe(404);
  });
});
