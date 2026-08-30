/**
 * Serves the apps/client bundle under `/client/`, and reverse-proxies each
 * configured machine under `/m/<id>/` (Spec 146, Phase 12, issue #228 item 1).
 *
 * ## Why this exists
 *
 * Phase 11 put `apps/client` on main with `scripts/serve.mjs` as its only
 * server — a loopback script run from a checkout. A bundle whose only server is
 * a developer's script is something you can open, not something you use. This is
 * the mount that makes it reachable from an iPad on a tailnet, which is
 * criterion 6.
 *
 * It deliberately mirrors `v2-static.ts` rather than generalising it. The two
 * differ in three ways that matter, and a shared helper would have to carry all
 * of them as flags: `/v2/` injects Tower's shared key into the HTML and this one
 * must NOT (the client authenticates per machine, and Tower's key is
 * all-or-nothing across every workspace on the host); `/client/` sends
 * `frame-ancestors` as a real header, which a `<meta>` CSP silently ignores; and
 * `/client/` answers a machine list and proxies to those machines.
 *
 * ## The machine list is the operator's, and Tower does not mint it
 *
 * `machines.json` is read from `<agent-farm dir>/client-machines.json` if the
 * operator put one there. Tower does not create it, does not add entries, and
 * does not issue the credentials in it — minting those is `afx pair`, which does
 * not exist yet (#228 item 4, moved to its own issue). When the file is absent
 * the list is EMPTY AND SAYS WHY, because a client showing no machines with no
 * stated reason reads as a broken client rather than an unconfigured one.
 *
 * ## The file holds credentials, so its mode is checked
 *
 * Each entry carries a machine credential. `apps/client/README.md` requires the
 * dev copy be mode 0600 for that reason, and a file Tower serves over a tailnet
 * has the same requirement or a stronger one. A group- or world-readable file is
 * REFUSED rather than served, and the refusal names the file and the mode — a
 * silently-ignored config is how an operator concludes the mount is broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLIENT_DIST = path.resolve(__dirname, '../../../client-dist');
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

/** `frame-ancestors` is ignored inside a `<meta>` CSP. It has to be a header. */
export const CLIENT_CSP = "frame-ancestors 'none'";

let clientDistRoot = DEFAULT_CLIENT_DIST;
let machinesFileOverride: string | null = null;

export function setClientDistRoot(root: string | null): void {
  clientDistRoot = root ?? DEFAULT_CLIENT_DIST;
}

export function setClientMachinesFileForTests(file: string | null): void {
  machinesFileOverride = file;
}

export interface ClientMachine {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly workspacePath: string;
  readonly credential: string;
}

export type MachineListRead =
  | { readonly ok: true; readonly machines: readonly ClientMachine[] }
  | { readonly ok: false; readonly signal: string; readonly message: string };

function machinesFile(): string {
  if (machinesFileOverride !== null) return machinesFileOverride;
  const override = process.env.CODEV_AGENT_FARM_DIR;
  const root = override ? path.resolve(override) : path.join(process.env.HOME ?? '', '.agent-farm');
  return path.join(root, 'client-machines.json');
}

/** Loopback, where plaintext never leaves the host. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Why an origin is CHECKED here rather than only dialled later.
 *
 * Two failures, both of which used to be spelled "that machine did not answer":
 *
 *   - `https://host` dialled with `http.request` reaches port 80 in cleartext
 *     and fails, reporting a configuration mistake as a dead machine — the exact
 *     conflation the rest of this module spends its comments avoiding. The proxy
 *     now picks its module from the scheme, so https works.
 *   - `http://` to a NON-LOOPBACK host sends a machine credential in cleartext
 *     over whatever network is between here and there. The spec's constraint is
 *     that all remote transport is HTTPS/WSS (spec 146, "Constraints"), so this
 *     is refused rather than proxied, with its own signal.
 */
export function originProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `uses ${url.protocol}, and only http: and https: can be proxied`;
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return 'is plaintext http: to a non-loopback host, which would send its machine '
      + 'credential in the clear. Use https: for a remote machine.';
  }
  return null;
}

function wellFormed(value: unknown): value is ClientMachine {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && entry.id.length > 0
    && !entry.id.includes('/')
    && typeof entry.label === 'string'
    && typeof entry.origin === 'string'
    && typeof entry.workspacePath === 'string'
    && typeof entry.credential === 'string';
}

/**
 * Absent, unreadable, wrong mode and malformed are FOUR situations and each gets
 * its own signal. Collapsing them into an empty list is the defect this client
 * was built to stop: an operator who mistyped a path and an operator who has not
 * configured anything need opposite next actions.
 */
export function readClientMachines(): MachineListRead {
  const file = machinesFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {
      ok: false,
      signal: 'CLIENT_MACHINES_ABSENT',
      message: `No machine list at ${file}. Tower serves the client but has nothing to connect it to; `
        + 'create that file (mode 0600) with one entry per paired machine.',
    };
  }
  // 0o077 is every group and other bit. The file carries machine credentials.
  if ((stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      signal: 'CLIENT_MACHINES_MODE',
      message: `${file} is mode ${(stat.mode & 0o777).toString(8)} and holds machine credentials. `
        + 'Refusing to serve it. Run: chmod 600 on that file.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      signal: 'CLIENT_MACHINES_UNREADABLE',
      message: `${file} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, signal: 'CLIENT_MACHINES_UNREADABLE', message: `${file} is not a JSON array.` };
  }
  return { ok: true, machines: parsed.filter(wellFormed) };
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function serveIndex(res: http.ServerResponse): void {
  let html: string;
  try {
    html = fs.readFileSync(path.join(clientDistRoot, 'index.html'), 'utf8');
  } catch {
    notFound(res);
    return;
  }
  /*
   * NO KEY INJECTION, unlike `/v2/`. Tower's shared key cannot be revoked for
   * one machine without rotating it for all, so a page holding it would have
   * Tower-wide access that revoking a machine credential would not take away.
   * The client does not need it: `isRequestAllowed` exempts `/api/agent/v1/*`
   * from the shared key precisely so a paired device reaches that surface
   * holding only what pairing gave it.
   */
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Vary');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': CLIENT_CSP,
  });
  res.end(html);
}

function serveMachines(res: http.ServerResponse): void {
  const read = readClientMachines();
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Vary');
  if (!read.ok) {
    // 200 WITH A STATED REASON, not an error status. The client renders a
    // configuration problem as text a person can act on; a 500 renders as a
    // machine that is down, which is a different situation with a different fix.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ signal: read.signal, message: read.message, machines: [] }));
    return;
  }
  /*
   * Each machine is announced at a path on THIS origin, so the page never makes
   * a cross-origin request and `connect-src 'self'` stays closed — the same
   * posture `scripts/serve.mjs` and the e2e harness hold. The credential is
   * still sent to the page: it is what the page authenticates with.
   */
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(read.machines.map((machine) => ({ ...machine, origin: `/m/${machine.id}` }))));
}

function serveAsset(res: http.ServerResponse, pathname: string): void {
  const rel = pathname.slice('/client/assets/'.length);
  if (rel === '' || rel.includes('..') || rel.includes('\0') || path.isAbsolute(rel) || rel.includes('\\')) {
    notFound(res);
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  if (!ASSET_EXT.has(ext)) {
    notFound(res);
    return;
  }
  const assetsRoot = path.resolve(clientDistRoot, 'assets');
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

/**
 * `/m/<id>/...` → that machine's `codev-agent`.
 *
 * STREAMED, NOT BUFFERED. The response under test is an SSE stream that never
 * ends, so anything that collects a whole body first delivers a stream that is
 * live on the wire and empty in the page.
 */
function proxyToMachine(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  machineId: string,
  rest: string,
): void {
  const read = readClientMachines();
  const machine = read.ok ? read.machines.find((candidate) => candidate.id === machineId) : undefined;
  if (!machine) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      signal: read.ok ? 'UNKNOWN_MACHINE' : read.signal,
      message: read.ok ? `No machine "${machineId}" is configured on this host.` : read.message,
    }));
    return;
  }
  const problem = originProblem(machine.origin);
  if (problem !== null) {
    // NOT 502, and not UPSTREAM_GONE. Nothing was dialled; this is a
    // configuration answer, and reporting it as a dead machine sends an
    // operator to restart a host that is fine.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      signal: 'MACHINE_ORIGIN_REFUSED',
      message: `The origin configured for "${machine.id}" ${problem}`,
    }));
    return;
  }
  const target = new URL(machine.origin);
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    host: target.hostname,
    // `URL.port` is '' for a default port, which `request` reads as "use the
    // module's default" — 443 for https, 80 for http. Passing it through is
    // therefore correct for both, but only because the module now varies.
    port: target.port,
    path: rest,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
    // `pipe` does not end the destination when the source errors, and this
    // response is a stream that never ends on its own. Without these the page
    // waits forever on a server that is already gone.
    answer.on('aborted', () => res.destroy());
    answer.on('error', () => res.destroy());
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ signal: 'UPSTREAM_GONE', message: `${machine.id} did not answer.` }));
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
}

/** True for every path this module owns, so the dispatcher is one predicate. */
export function isClientPath(pathname: string): boolean {
  return pathname === '/client'
    || pathname.startsWith('/client/')
    || pathname === '/m'
    || pathname.startsWith('/m/');
}

export function serveClientStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const proxied = /^\/m\/([^/]+)(\/.*)$/.exec(`${url.pathname}${url.search}`);
  if (proxied) {
    proxyToMachine(req, res, proxied[1], proxied[2]);
    return;
  }
  /*
   * `/m`, `/m/`, and `/m/<id>` with no trailing path are PROXY paths that named
   * no resource — not SPA routes. They missed the regex above and fell through
   * to the shell, so a machine request got HTML and a 200 back. A request under
   * this prefix is answered by the proxy or by a 404, never by the page.
   */
  if (url.pathname === '/m' || url.pathname.startsWith('/m/')) {
    notFound(res);
    return;
  }
  if (req.method !== 'GET') {
    notFound(res);
    return;
  }
  if (url.pathname === '/client') {
    // The URL a person types. Without this it 404s and reads as a missing mount.
    res.writeHead(301, { Location: `/client/${url.search}` });
    res.end();
    return;
  }
  if (url.pathname === '/client/machines.json') {
    serveMachines(res);
    return;
  }
  if (url.pathname === '/client/') {
    serveIndex(res);
    return;
  }
  if (url.pathname.startsWith('/client/assets/')) {
    serveAsset(res, url.pathname);
    return;
  }
  /*
   * Any other EXTENSIONLESS path under `/client/` is the SPA's own, and the SPA
   * is one page: serving the shell keeps a reloaded deep link working instead of
   * 404ing on a route the server has never heard of.
   *
   * A path that names a FILE does not get that treatment. `/client/missing.js`
   * is a request for a script, and answering it with HTML is MIME confusion
   * rather than a helpful fallback — the browser gets a parse error where it
   * should get a 404. It also matters for traversal shapes: WHATWG `URL`
   * normalises `%2e%2e` to `..`, so `/client/assets/%2e%2e/secret.js` arrives
   * here as `/client/secret.js`, and a blanket fallback answers it 200.
   */
  if (path.extname(url.pathname) !== '') {
    notFound(res);
    return;
  }
  serveIndex(res);
}
