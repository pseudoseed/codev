# Plan iter 1 rebuttals — spec 83

Lanes: gemini skipped (agy exit 1). claude COMMENT. opencode COMMENT. codex REQUEST_CHANGES.

## Codex REQUEST_CHANGES

**Bare `GET /v2` public / served.** Accepted. `tower-routes.ts:282` is `startsWith('/v2/')` and C1 freezes it, so `/v2` never reaches `handleV2Route`. D9 names `/v2/` and `/v2/assets/*` only. Dropped the alias from `isPublicRoute` and from `v2-static.ts`.

**Phase 5 topology.** Accepted. Fixture on `127.0.0.1:4173` is the sole HTTP owner: `/v2/`, `/v2/assets/*`, `/api/workspaces`, `/v2/events`. No `vite preview`. Playwright `baseURL` is that origin.

**`@playwright/test` missing from `apps/v2`.** Accepted. Phase 5 adds it as a devDependency.

**State ownership contradictory.** Accepted. Shared rules now define one composed `AppState`. Reducer is frames only. Unreachable is `connection`. Empty is derived (`nodes` empty and `darkPaths` empty). Display precedence is listed.

**Scenario 16 only hits `isPublicRoute`.** Accepted. Phase 1 tests `isRequestAllowed` as well: keyless `/v2/` and assets allowed; keyless `/v2/events` and `POST /v2/` rejected.

## Opencode COMMENT

All five points accepted: drop unreachable from the reducer; bootstrap calls `reconnectBackoff`; one HTTP owner; empty vs dark-plot; `vitest run`.

## Claude COMMENT

Accepted: `passWithNoTests: true`; packaging test runs `copy-v2` itself; no `/v2` alias; `removeHeader` only on the index branch; serve-only key injection for `pnpm dev`; ESM `__dirname` shim; `site.css` is a hand translation and web fonts stay on the token fallbacks; duplicate the unexported test helpers; `Cache-Control: no-store` noted, not fought.

## Gemini

Did not review. Not treated as approval.
