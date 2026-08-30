# air-227 — thread path: process-global spawn factory, interrupt/cleanup, two smaller seams

Issue #227, AIR (strict). Four discrete fixes, taken in the order the issue lists them.

## Orientation

Read `thread-runtime.ts`, `thread-backend.ts`, `db/thread-identity.ts`,
`servers/mailbox-wiring.ts`, `commands/interrupt.ts`, `commands/cleanup.ts`,
`commands/workspace-add-architect.ts`, `porch-thread-engine.ts`, `db/schema.ts`,
`db/index.ts`, `state.ts`, `packages/t3-client/src/auth.ts`.

Architect note (2026-08-30): builder-pir-241 owns #241 in parallel and also touches
`thread-backend.ts`. If we collide, I rebase onto it. Do not touch `.builders/air-235`.

## Plan

1. **Keyed spawn factory.** `setSpawnThreadFactory` is a module singleton in
   `db/thread-identity.ts`. Key it by canonical workspace root, the way the engine map in
   `thread-runtime.ts` already is. `canonicalWorkspaceKey` lives in `thread-runtime.ts`,
   which imports `db/thread-identity.ts` — so the key helper moves to a new
   `workspace-key.ts` to avoid a cycle, and `thread-runtime.ts` re-exports it.
2. **`afx interrupt` / `afx cleanup`.** Both reach `getThreadEngine` in a fresh process
   with nothing registered. Follow the delivery path's shape: `ensureThreadBackendReady`,
   then `engine.attach` from the row, then act.
3. **Architect harness/model.** `architect` table has no such columns, so
   `mailbox-wiring.ts` builds a context without them and `attach` silently falls back to
   whatever `.codev/config.json` says NOW. Add the columns (migration v22), record them at
   create time, read them at attach time.
4. **`activeProjectForWorkspace` auth.** A bare `fetch` with a Bearer header next to
   `@cluesmith/t3-client/auth`, which owns every other request to that server. Move the
   knowledge into the client.

## Progress

**2026-08-30.** All four items implemented; typecheck clean; 22 new tests pass; full suite
running.

Notes worth keeping:

- The worktree had **no `node_modules`**. `pnpm --filter … build` and `./node_modules/.bin/tsc`
  both exited 0 while doing nothing — a "command not found" inside a pipeline reports success.
  Verified nothing until `pnpm install --prefer-offline` (3s) plus
  `pnpm --filter "@cluesmith/codev^..." build`. Check that a check actually ran.
- `GLOBAL_SCHEMA` is a **template literal**. A SQL comment containing backticks terminates
  the string; it surfaces as `TS1005: ',' expected` on a line that looks like SQL.
- Items 1 and 4 turned out related: the hand-built `fetch` skipped `assertTransportSafe`,
  so it was the one call willing to put a bearer token on plaintext to a non-loopback host.
  Moving it to `@cluesmith/t3-client/auth` as `authorizedGet` fixes that as a side effect.
- Item 3 needed one more piece than the issue lists: recording the *config* values would
  still lose the engine's own `'codex'` fallback, so the row would pin a pair the thread
  never ran under. `ThreadEngine.defaults` reports the resolved pair, and
  `DEFAULT_THREAD_HARNESS` names the fallback once instead of three times.
- Migration **v22** adds `architect.harness` / `architect.model`, PRAGMA-gated ADD COLUMN
  mirroring v18. `GLOBAL_CURRENT_VERSION` 21 → 22; the source guard in
  `send-architect-identity.test.ts` pins that constant and was updated.

## Test baseline, and why the first full run looked bad

First full run: **20 files / 84 tests failed**. None of it was the change. The worktree had
never been built, so `packages/codev/skeleton/` and `dist/` did not exist — hot-tier
injection, protocol resolution, consultation lanes and the shellper all resolve through
those. `pnpm --filter @cluesmith/codev build` took it to **3 files / 5 tests**, and those
three were real:

- `bugfix-214-publish-scrub` — `packages/artifact-canvas` had no `dist`. Environmental;
  `pnpm --filter @cluesmith/codev-artifact-canvas build` clears it.
- `spec-146-phase-8-thread-identity` — mine, and the good kind. Its convergence test
  compares a fresh `GLOBAL_SCHEMA` database against a migrated one **including column
  order**, and its pre-v21 fixture is derived from the shipped schema by stripping
  `thread_id`. Adding `harness`/`model` after `thread_id` left them in the fixture, ahead of
  the `thread_id` v21 appends. Fixed by stripping all three from the fixture and applying
  v21 then v22 — which meant extracting v22's ALTERs as `applyArchitectAgentMigration`, so
  the test walks the real migration rather than a re-typed copy of it.
- `spec-146-phase-9-add-architect-thread-path` — mocks `../thread-runtime.js` wholesale, so
  the new `architectThreadDefaults` export was missing. Added to the mock, and the existing
  assertion extended to check the pair actually lands on the row.
