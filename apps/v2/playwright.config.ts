import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: 'http://127.0.0.1:4173/v2/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
