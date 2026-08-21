# air-14 builder thread

## Issue #14 — Let the dashboard hide tabs from config (Analytics, Team)

Protocol: AIR (strict). Single implement phase, no spec/plan/review artifacts.

### What shipped

- `dashboard.hideTabs?: string[]` added to both config type surfaces
  (`packages/codev/src/lib/config.ts` `CodevConfig`, `packages/codev/src/agent-farm/types.ts`
  `UserConfig` — the two parallel config shapes the loader casts between). Both already had
  a `dashboard` block (`frontend`), so this slots in rather than adding a new block.
- New `getDashboardConfig(workspaceRoot?)` in `packages/codev/src/agent-farm/utils/config.ts`,
  same pattern as the existing `getWorktreeConfig`. Wired into `handleWorkspaceState` in
  `tower-routes.ts` alongside the existing `teamEnabled` line, populating a new
  `DashboardState.hideTabs` field (`packages/types/src/api.ts`).
- `apps/web/src/hooks/useTabs.ts`: `buildTabs` filters the static tab set (`work`/`analytics`/
  `team`) against `hideTabs` *after* the `teamEnabled` push, so an explicit hide wins over the
  derived `codev/team/`-existence check per the issue's requirement. Unknown ids in the list
  warn once (module-scoped `Set` dedupes repeat warnings across re-renders) rather than
  throwing. The existing "active tab disappeared" fallback (previously always landing on the
  `'architect'` tab) now special-cases the hidden-via-config path to land on `'work'` instead —
  added as an early branch so the architect-tab fallback behavior for other disappearance
  causes (sibling architect removed, etc.) is untouched.
- `apps/web/src/components/App.tsx`: `AnalyticsView`/`TeamView` are now conditionally
  *mounted* (not just `display:none`) when hidden.

### Analytics mount/fetch investigation (per architect's ask)

Traced `AnalyticsView` → `useAnalytics(isActive)` (`apps/web/src/hooks/useAnalytics.ts`):
the fetch is a one-shot `load(range)` inside a `useEffect` gated on `isActive`, no
`setInterval`/websocket/poll. So it was already not over-fetching while merely hidden via CSS —
`isActive` was always false unless it's literally the active tab. Making the hide also skip the
mount is a mount-cost cleanup (fewer components in the tree, no wasted initial render), not a
fix for wasted network calls — there weren't any. Verified this in the browser too: clicking
into Analytics fired exactly one `/api/analytics` request, and hiding it afterward (live, no
reload) did not add another.

### Browser verification (Playwright, no afx dev / no Tower spawn)

Followed the architect's steer: never hit `POST /api/launch` for this worktree. Instead ran
`pnpm exec vite --port 5183 --strictPort` standalone from `apps/web/`, and drove it with
Playwright (`packages/codev/node_modules/playwright`) with `page.route` mocking `/api/state`,
`/api/overview`, `/api/analytics`, and aborting `/api/events` (SSE) — no real Tower backend
involved at all, so the `codev-tower-key` auth requirement never came into play for this
verification. Confirmed:
- `hideTabs: []` → Work/Analytics/Team all show.
- `hideTabs: ['analytics','team']` → only Work shows (screenshot).
- Analytics active, then hidden live (no reload, via the app's own 1s poll) → tab strip drops
  to Work/Team, `activeTabId` falls back to `work`, and the Work pane actually renders content
  (not a blank pane) — screenshot confirms this end-to-end.

Scratch scripts + screenshots live under this session's scratchpad dir (not committed — dev-only
verification artifacts, not deliverables).

### Noted for the record (per architect's message)

Tower API calls now require the `codev-tower-key` header (value = contents of
`~/.agent-farm/local-key`); an unauthenticated call 401s with a `text/plain` body. Didn't need
to touch this directly since verification used route mocking instead of a live Tower instance,
but noting it here since the architect asked it be recorded on the issue/thread.

### Tests

- `apps/web/__tests__/useTabs.hideTabs.test.ts` (new, 8 tests): default-visible, hide analytics,
  hide wins over `teamEnabled`, team shows when not hidden, unknown id warns-not-throws, unknown
  id doesn't remove known tabs, live fallback to `work`, `activeTab` never undefined.
- `packages/codev/src/agent-farm/__tests__/config.test.ts` (+3 tests): `getDashboardConfig`
  default/populated/omitted-hideTabs cases.
- Full `apps/web` suite: 345 passed / 1 skipped (pre-existing skip, unrelated).
- `packages/codev`: ran `tower-routes.test.ts` + `spec-761-api-state.test.ts` (107 passed) plus
  the scoped `agent-farm/utils`/`lib`/`config.test.ts` set (27 passed) rather than the full
  package suite — the full suite times out past 5 minutes in this sandbox and e2e tests are
  excluded by the repo's own vitest config (they spawn real servers, ~$4/run per its own
  comment). Scoped runs cover every file this change touches.

### Flaky/pre-existing failure noticed, unrelated to this change

`packages/codev/src/__tests__/update.test.ts` fails 17/27 in isolation on this branch before any
of my edits touch anything it imports (it only imports `node:fs`/`node:path`/`node:os`/`chalk`
mocks — nothing from `dashboard`/`config`/`tower-routes`). `result.gitignoreAdded` etc. come back
`undefined` — looks like a pre-existing regression in the `update` command's gitignore-backfill
path, not something this PR touches or should fix. Flagging per the flaky-test protocol rather
than silently working around it.

### LOC

~212 lines changed across 9 files (8 modified + 1 new test file) — within AIR's ~300 LOC budget.
