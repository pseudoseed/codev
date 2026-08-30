/**
 * Serve the built client, its machine list, and the CSP header a <meta> tag
 * cannot carry.
 *
 * WHY THIS EXISTS RATHER THAN A TOWER MOUNT. The built bundle asks for
 * `machines.json` on its own origin and reaches each machine through `/m/<id>/`,
 * and until phase 12 replaces the v2 client nothing in Tower mounts either. A
 * bundle whose only server is a dev-mode Vite plugin is a bundle nobody but its
 * author can run — so this is the smallest honest server for it, and the README
 * says plainly that Tower does not serve the client yet.
 *
 *   node scripts/serve.mjs [--port 4180] [--machines .dev-machines.json]
 */
import { createServer, request } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const DIST = join(CLIENT_ROOT, 'dist');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(flag('port', '4180'));
const machinesPath = resolve(CLIENT_ROOT, flag('machines', '.dev-machines.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('apps/client/dist is not built. Run: pnpm build');
  process.exit(1);
}

/** Read per request, so re-pairing takes effect on reload rather than restart. */
function machines() {
  try {
    const parsed = JSON.parse(readFileSync(machinesPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/client/machines.json') {
    // Each machine is announced at a path on THIS origin, so the page never
    // makes a cross-origin request and `connect-src 'self'` stays closed.
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(machines().map((machine) => ({ ...machine, origin: `/m/${machine.id}` }))));
    return;
  }

  const proxied = /^\/m\/([^/]+)(\/.*)$/.exec(req.url ?? '');
  if (proxied) {
    const machine = machines().find((candidate) => candidate.id === proxied[1]);
    if (!machine) {
      res.writeHead(404, { 'Content-Type': MIME['.json'] });
      res.end('{"signal":"UNKNOWN_MACHINE"}');
      return;
    }
    const target = new URL(machine.origin);
    const upstream = request({
      host: target.hostname,
      port: target.port,
      path: proxied[2],
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      // `pipe` does not end the destination when the source errors, and the
      // response here is a stream that never ends on its own. Without these the
      // page waits forever on a server that is already gone.
      answer.on('aborted', () => res.destroy());
      answer.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': MIME['.json'] });
      res.end('{"signal":"UPSTREAM_GONE"}');
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
    return;
  }

  const relative = path.replace(/^\/client\/?/, '') || 'index.html';
  const file = join(DIST, relative);
  const target = file.startsWith(DIST) && existsSync(file) && extname(file) !== ''
    ? file
    : join(DIST, 'index.html');
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    // `frame-ancestors` is ignored in a <meta> CSP, so it has to be a header.
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(readFileSync(target));
});

// Loopback only. This serves a page that holds N machines' credentials.
server.listen(port, '127.0.0.1', () => {
  console.log(`codev-client on http://127.0.0.1:${port}/client/`);
  console.log(`machines from ${machinesPath} (${machines().length} configured)`);
});
