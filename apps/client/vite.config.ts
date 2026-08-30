import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serve the machines `scripts/pair-dev.ts` paired, as JSON on this origin.
 *
 * NOT an injected inline script. The CSP is `script-src 'self'` precisely
 * because this page holds N machines' credentials, and punching an
 * `unsafe-inline` hole in it to deliver configuration would trade the
 * deliverable for a convenience.
 *
 * `apply: 'serve'` — a built bundle never carries a credential. The file is
 * gitignored and read per request, so re-pairing takes effect on reload.
 */
function serveDevMachines(): Plugin {
  return {
    name: 'serve-dev-machines',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split('?')[0] !== '/client/machines.json') return next();
        let body = '[]';
        try {
          body = fs.readFileSync(path.join(__dirname, '.dev-machines.json'), 'utf8');
        } catch {
          /* not paired yet; an empty list is the honest answer */
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

/**
 * The client holds credentials for N machines, so an XSS here steals credentials
 * rather than defacing a page. The CSP is declared in `index.html` so it applies
 * to the built bundle wherever it is served from, not only behind a dev proxy.
 */
export default defineConfig({
  plugins: [react(), serveDevMachines()],
  server: {
    /**
     * `frame-ancestors` cannot be delivered by a <meta> CSP, so it is a header.
     * Whatever serves the built bundle has to send the same one.
     */
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    /**
     * Each machine is proxied under a path prefix of its own, so the browser
     * reaches every server same-origin. That is what lets `connect-src 'self'`
     * stay closed in development instead of being widened to reach a second
     * port. `machines.json` names these prefixes as each machine's `origin`.
     */
    proxy: {
      '/m/alpha': { target: 'http://127.0.0.1:4101', rewrite: (p) => p.replace(/^\/m\/alpha/, '') },
      '/m/beta': { target: 'http://127.0.0.1:4102', rewrite: (p) => p.replace(/^\/m\/beta/, '') },
    },
  },
  base: '/client/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
