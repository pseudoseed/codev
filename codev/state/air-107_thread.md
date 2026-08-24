# air-107 — apps/v2 Playwright is not in the root CI matrix

Protocol: AIR (strict). Issue #107.

## Implement

Added a `v2-playwright` job to `.github/workflows/test.yml`. It installs Chromium
without `--with-deps`, builds types, then runs `apps/v2` `pnpm test:e2e` (build +
fixture on 127.0.0.1:4173). No Tower.

Contract test: `packages/codev/src/__tests__/air-107-v2-playwright-ci.test.ts`.

Porch implement checks: build 16.0s, tests 392.4s, then done re-ran build 15.1s / tests 282.1s.

## PR

Opened after implement. Review is the PR body, not a `codev/reviews/` file. CMAP skipped: workflow YAML plus a contract test.
