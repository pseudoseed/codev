import { defineConfig } from '@playwright/test';

/**
 * No `webServer` block. The servers here are part of what is under test — one of
 * them is killed mid-run and another has its credential revoked — so the spec
 * owns their lifecycle rather than Playwright's fixture.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  workers: 1,
  use: { viewport: { width: 1100, height: 900 } },
});
