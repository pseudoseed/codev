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

## Round 2 — the 3-way review (2 APPROVE, 1 COMMENT)

Two required changes, four follow-ups filed (#254 #255 #256 #257).

### `workspaceRoot` is required now

`chooseSpawnPath` returned `pty` before ever reaching the loud failure in
`allocateSpawnThread`, so a caller that forgot the argument silently took a different
transport. Applied to the whole chain — `setSpawnThreadFactory`, `installThreadSpawnFactory`,
`chooseSpawnPath`, `allocateSpawnThread` — as `string | undefined` positionals, so every
unkeyed use is written out rather than defaulted into.

### The live run, and what only running could show

`afx interrupt` and `afx cleanup` now run against the pinned harness in
`issue-227-live-interrupt-cleanup.test.ts` (gated on `T3_LIVE=1` + `T3_NODE`). Four things
the source guards could never have caught, in the order they appeared:

1. **`cli.ts` exports `runAgentFarm` and calls nothing.** Running it directly exits 0 in
   silence. `bin/afx.js` is the invoker, and it imports `dist/` — which can be older than
   the change under test, so a live test built on it green-lights a previous build.
   `__tests__/helpers/air-227-afx-from-source.ts` is that file with the import repointed.
2. **The child inherited `CODEV_BUILDER_ID` / `CODEV_WORKTREE_ROOT` from my own session.**
   `detectWorkspaceRoot` reads those BEFORE cwd, deliberately, so the child resolved the
   real repository instead of the fixture. A live test acting on the operator's workspace is
   worse than no live test.
3. **`NODE_ENV=test` from vitest** makes `getGlobalDbPath` resolve `test.db`, so the child
   opened an empty database next to the seeded one and fell through to the PTY path.
4. **The real finding.** `afx interrupt` printed `Interrupt sent to thread <id>` and then
   never returned — killed at the timeout, exit 143. The interrupt had already landed. An
   open WebSocket is a live handle, so Node's loop does not drain while it exists; Tower
   wants that, a one-shot command does not. `closeThreadBackend(workspaceRoot)` hangs up, and
   both commands call it in a `finally`. The socket's close handler also stopped warning
   about a hang-up we asked for, which read as a server that went away.

A command that works and hangs is not a working command, and no amount of string-index
assertion reaches that.

Also, a token note for whoever runs this next: a pairing grant is one-time and the harness
prints one per server lifetime, while every `afx` process exchanges it again. The test
`restart`s between commands (data dir kept, new token) so each child has a credential it can
spend — and the side effect is that each command acts on a thread that outlived the server
it was created on.

## Round 3 — rebase onto main after #258

`git rebase origin/main` applied all six commits with **no conflicts**, which is the part
worth distrusting. Git merged both sets of edits to `thread-backend.ts` textually and left a
real gap underneath.

- **No migration collision.** #258 added none, so v22 stands.
- **The gap.** #258 gave the socket a subscription pool, stopped by `abandonConnection`
  BEFORE the socket closes — stated reason: closing out from under a running
  `ResumingSubscription` leaves it retrying against a shut client. My `closeThreadBackend`
  handed out the raw `connection.close`, so the pool was only stopped by the socket's
  `close` EVENT, asynchronously. Now `hangUp.set(key, abandonConnection)`, with a source
  guard in `issue-227-thread-seams.test.ts`.
- **A false warning my teardown caused.** A cancelled stream ends unsynchronized, which the
  pool cannot tell from a server dropping mid-catch-up — so `afx interrupt` succeeded and
  then printed *"ended before the server signalled catch-up was complete"* about a
  subscription it had just asked to stop. `Entry.isStopping`, set by `stop`/`stopAll` before
  teardown, silences it. The refusal to mark that attempt attached is unchanged.

**This last one is a behaviour change inside #258's module**, so it is flagged to the
architect rather than merged on my own judgement — the standing rule is no further review
round for the rebase *unless it changes behaviour*.

`render-gate.test.ts` failed once in the full run on a perf budget (322ms against 250ms) and
passed 80/80 on its own; it is load-sensitive and unrelated.
