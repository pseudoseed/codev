/**
 * Serves the apps/v2 shell and assets under GET /v2/ and GET /v2/assets/*.
 *
 * Mirrors injectWebKey / sendKeyInjectedHtml in tower-routes.ts (module-private,
 * file frozen by spec 83 C1). Three load-bearing properties, each tested:
 *   1. Key is embedded via JSON.stringify only when it matches /^[0-9a-f]{64}$/.
 *   2. Access-Control-Allow-Origin and Vary are removed from the HTML response.
 *   3. The injection lands before </head>, ahead of the deferred module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as http from 'node:http';
import { getExpectedKey } from '../utils/server-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_V2_DIST = path.resolve(__dirname, '../../../v2-dist');
const KEY_RE = /^[0-9a-f]{64}$/;
const ASSET_EXT = new Set(['.js', '.css', '.map', '.svg', '.woff2', '.png', '.ico']);
const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let v2DistRoot = DEFAULT_V2_DIST;
let keyOverride: string | null | undefined;

export function setV2DistRoot(root: string | null): void {
  v2DistRoot = root ?? DEFAULT_V2_DIST;
}

export function setV2InjectedKeyForTests(key: string | null | undefined): void {
  keyOverride = key;
}

function keyToInject(): string | null {
  return keyOverride !== undefined ? keyOverride : getExpectedKey();
}

export function injectV2Key(html: string, key: string | null): string {
  const injection = key && KEY_RE.test(key)
    ? `<script>window.__CODEV_TOWER_KEY__ = ${JSON.stringify(key)};</script>`
    : '';
  if (injection && html.includes('</head>')) {
    return html.replace('</head>', `${injection}</head>`);
  }
  return html;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function serveIndex(res: http.ServerResponse): void {
  const file = path.join(v2DistRoot, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    notFound(res);
    return;
  }
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Vary');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(injectV2Key(html, keyToInject()));
}

function serveAsset(res: http.ServerResponse, pathname: string): void {
  const rel = pathname.slice('/v2/assets/'.length);
  if (
    rel === '' ||
    rel.includes('..') ||
    rel.includes('\0') ||
    path.isAbsolute(rel) ||
    rel.includes('\\')
  ) {
    notFound(res);
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  if (!ASSET_EXT.has(ext)) {
    notFound(res);
    return;
  }
  const assetsRoot = path.resolve(v2DistRoot, 'assets');
  const file = path.resolve(assetsRoot, rel);
  const rootWithSep = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep;
  if (!file.startsWith(rootWithSep) && file !== assetsRoot) {
    notFound(res);
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    notFound(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(body);
}

export function serveV2Static(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  if (req.method !== 'GET') {
    notFound(res);
    return;
  }
  if (url.pathname === '/v2') {
    // #105: `/v2` is the URL a person types. Without this it 401s (it is not
    // in the public allowlist) and reads as a key problem. The query string
    // rides along so a scoped link keeps its scope across the redirect.
    res.writeHead(301, { Location: `/v2/${url.search}` });
    res.end();
    return;
  }
  if (url.pathname === '/v2/') {
    serveIndex(res);
    return;
  }
  if (url.pathname.startsWith('/v2/assets/')) {
    serveAsset(res, url.pathname);
    return;
  }
  notFound(res);
}
