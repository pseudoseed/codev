/**
 * Playwright configuration for spec 250's fork sidebar E2E.
 *
 * Separate from `playwright.config.ts` because that one starts TOWER and serves
 * the Codev dashboard. This suite is about t3code's own web app, on its own
 * origin, with a fork server the spec's fixture starts itself — sharing a config
 * would mean every run of either suite booted the other's stack.
 *
 * Run: npx playwright test --config playwright.spec250.config.ts
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/__tests__/e2e',
  // The fixture restarts the fork server and seeds it over the wire before the
  // first test; a cold Vite dev server then transforms the module graph on the
  // first page load.
  timeout: 120_000,
  retries: 0,
  workers: 1,
  // No webServer. The fork's Vite dev server is a long-lived foreground process
  // this suite has no business owning — an absent one is reported as a skip with
  // the command to start it, never started silently and left running.
  use: {
    baseURL: process.env.T3_WEB_URL || 'http://localhost:5733',
  },
});
