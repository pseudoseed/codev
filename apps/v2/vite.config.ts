import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const KEY_RE = /^[0-9a-f]{64}$/;

function readDevKey(): string | null {
  const env = process.env.CODEV_TOWER_KEY?.trim();
  if (env && KEY_RE.test(env)) return env;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.agent-farm', 'local-key'), 'utf8').trim();
    return KEY_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function injectDevKey(): Plugin {
  return {
    name: 'inject-dev-key',
    apply: 'serve',
    transformIndexHtml(html) {
      const key = readDevKey();
      if (!key || !html.includes('</head>')) return html;
      const tag = `<script>window.__CODEV_TOWER_KEY__ = ${JSON.stringify(key)};</script>`;
      return html.replace('</head>', `${tag}</head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), injectDevKey()],
  server: {
    proxy: {
      '/api': 'http://localhost:4100',
      '/v2/events': 'http://localhost:4100',
    },
  },
  base: '/v2/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
