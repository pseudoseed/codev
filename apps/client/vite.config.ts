import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MACHINES_FILE = path.join(CLIENT_ROOT, '.dev-machines.json');

interface DevMachine {
  readonly id: string;
  readonly origin: string;
}

/** Read per request, so re-pairing takes effect on reload rather than restart. */
function devMachines(): DevMachine[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed as DevMachine[] : [];
  } catch {
    return [];
  }
}

/**
 * Serve the machine list, and reverse-proxy each machine under `/m/<id>/`.
 *
 * THE PROXY IS DERIVED FROM THE FILE, not a hardcoded port table. An earlier
 * version named alpha on 4101 and beta on 4102, which worked only for whoever
 * happened to start those two hosts on those two ports — and failed silently for
 * anyone else, because an unproxied path 404s into the SPA fallback.
 *
 * It is a middleware rather than Vite's `proxy` option because these responses
 * are SSE streams: they must be piped, and the connection must be torn down when
 * the upstream dies rather than left open forever.
 *
 * `apply: 'serve'` — a built bundle never carries a credential. `scripts/serve.mjs`
 * is the equivalent for the built bundle.
 */
function devMachineServer(): Plugin {
  return {
    name: 'dev-machine-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.split('?')[0] === '/client/machines.json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(devMachines().map((machine) => ({ ...machine, origin: `/m/${machine.id}` }))));
          return;
        }

        const proxied = /^\/m\/([^/]+)(\/.*)$/.exec(url);
        if (!proxied) return next();
        const machine = devMachines().find((candidate) => candidate.id === proxied[1]);
        if (!machine) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"signal":"UNKNOWN_MACHINE"}');
          return;
        }
        const target = new URL(machine.origin);
        const upstream = http.request({
          host: target.hostname,
          port: target.port,
          path: proxied[2],
          method: req.method,
          headers: { ...req.headers, host: target.host },
        }, (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
          // `pipe` does not end the destination when the source errors, and this
          // response is a stream that never ends on its own.
          answer.on('aborted', () => res.destroy());
          answer.on('error', () => res.destroy());
        });
        upstream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
          }
          res.end('{"signal":"UPSTREAM_GONE"}');
        });
        req.pipe(upstream);
        res.on('close', () => upstream.destroy());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devMachineServer()],
  server: {
    // `frame-ancestors` cannot be delivered by a <meta> CSP, so it is a header.
    // `scripts/serve.mjs` sends the same one for the built bundle.
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
  },
  base: '/client/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
