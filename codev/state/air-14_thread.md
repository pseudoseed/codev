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

## PR review round 1 (architect)

Caught a real bug: `hideTabs: ["work"]` blanked the dashboard. `KNOWN_HIDEABLE_TAB_IDS`
included `work` (so config could "validly" hide it), and the vanished-active-tab fallback
hardcoded `setActiveTabId('work')` — with `work` itself filtered out of `tabs`, `activeTabId`
pointed at a tab that no longer existed.

Fixed both halves as two independent guards, per the architect's framing that they're separate
failures:
1. **Server won't offer the setting.** `getDashboardConfig` (`agent-farm/utils/config.ts`) now
   strips `work` out of a configured `hideTabs` list before it ever reaches `DashboardState`,
   warning once via `logger.warn`. `work` also dropped from the client's
   `KNOWN_HIDEABLE_TAB_IDS`, so if it ever arrives anyway it's reported as an "unknown" id.
2. **Client fallback no longer hardcodes an id config could remove.** The vanished-active-tab
   fallback (for the hideTabs-triggered case) now sets `activeTabId` to `tabs[0]?.id` — the
   first tab that actually survived the rebuild — instead of the literal string `'work'`.
3. Added defense-in-depth belt-and-suspenders on top of both: `buildTabs`'s filter now
   explicitly exempts `t.id === 'work'` regardless of what `hideTabs` contains, so even a
   state object built by hand (bypassing the server) can't blank the dashboard through this
   hook. Went a bit further than the two explicit asks here since the architect's framing
   ("it is the home tab... config should not offer a setting that bricks the view") read as
   wanting a hard guarantee, not just a config-level nudge — flagging this in case that's
   overreach on my part.

New tests: `useTabs.hideTabs.test.ts` — `hideTabs: ['work']` still renders Work with real
content and warns; a vanished-tab-with-no-match-ever case resolves to some real rendered tab
rather than a dangling id. `config.test.ts` — `getDashboardConfig` strips `work` and warns.
Also re-verified live in the browser (mocked `/api/state` sending `hideTabs: ['work']`
directly, bypassing the server-side strip) — Work tab and its content render normally.

### update.test.ts false alarm

Flagged `packages/codev/src/__tests__/update.test.ts` as a pre-existing unrelated failure
(17/27 failing) earlier. Architect couldn't reproduce on either the main checkout or this
worktree. Re-ran it 4x fresh from `packages/codev` — 27/27 clean every time, cannot reproduce.
Likely cause: my original run came right after I let a full-package `pnpm vitest run` hit the
Bash tool's 5-minute timeout and get SIGTERM'd mid-suite, on a machine `ps aux` shows is heavily
shared (99 node processes at the time, including a vitest run I didn't start, from another
session's checkout). Best guess is resource contention or a killed-run side effect, not a real
product bug — flagged as unconfirmed/likely-noise to the architect rather than left ambiguous.
