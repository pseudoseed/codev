# Bugfix #174 builder thread

## Investigate — 2026-08-29

Reproduced the spawn-gate leak against the real running Tower after installing/building the worktree dependencies. A standalone run of `src/agent-farm/__tests__/spawn-gate-profile.test.ts` passed all 6 tests but increased live `shellper-main` processes whose command config names `spawn-gate-profile-*` from 7 to 9 (delta **+2**). Those are the two positive-harness cases at lines 135–149. The test teardown at lines 59–72 restores cwd/HOME and recursively removes the workspace without killing or waiting for the terminal recorded by `spawn()`; the 2-second `rmSync` retry only masks the race and cannot end a detached shellper.

Tower's cap leak is the ordering in the four fresh persistent-session paths. The general route is representative: `tower-routes.ts:812` awaits `SessionManager.createSession()` (which spawns and registers the shellper), then `tower-routes.ts:828` calls `TerminalManager.createSessionRaw()`. The only max-session check is inside `createSessionRaw()` at `pty-manager.ts:132`; its throw is caught as generic shellper failure at `tower-routes.ts:857`, but that catch neither kills the already-created shellper nor prevents the non-persistent fallback from hitting the same cap. The workspace-shell and both architect launch paths use the same spawn-then-adopt ordering. The production log in the issue is the direct trace of this path: shellper PID created, then `Maximum 100 sessions reached`, then fallback failure.

The cap also counts stale `TerminalManager.sessions` entries. Entries are normally removed only after a delivered `PtySession` exit/timeout event (exit has an additional 30-second retention), and there is no process-liveness reconciliation before the cap check or during Tower runtime. Startup reconciles SQLite/shellper state once, but the global cap is enforced against the in-memory map. The bare `Maximum N sessions reached` message has no ownership context even though `workspaceTerminals` already maps each workspace's architect/builder/shell IDs.

Scope remains BUGFIX-sized (<300 LOC): make capacity checking reap dead in-memory sessions and expose an early preflight; invoke it before every fresh shellper spawn and roll back any just-created shellper on later adoption failure; run the same reconciliation periodically; append top workspace counts to cap errors; replace the spawn-gate test's retry-first teardown with terminal kill/wait before directory removal. Regression tests will prove cap rejection does not call shellper creation, dead entries free capacity, ownership appears in the error, and the standalone integration test leaves no new scoped shellpers. Mutation verification will deliberately restore post-spawn capacity checking and confirm the regression test fails.

## Fix — 2026-08-29

Implemented the focused fix in 8 source/test files (219 inserted lines before the thread log, below BUGFIX's 300-LOC ceiling):

- `TerminalManager.assertCanCreateSession()` reconciles dead process records before rejecting at the cap, retains the post-await `createSessionRaw` check as a concurrency backstop, and includes Tower's top three workspace counts in the error.
- All four fresh shellper creation paths now preflight capacity before spawn and roll back the shellper plus any raw terminal if a later step fails.
- Tower's existing one-minute terminal monitor now also reconciles dead in-memory sessions.
- `spawn-gate-profile.test.ts` kills each real Tower terminal (whose delete path waits for the shellper process to exit), removes its builder row, and only then removes the temp workspace. The old broad `rmSync` retry is gone.

Regression coverage: focused tests passed (117/117). Deliberately removed the general route's pre-spawn capacity call; the new test failed because `shellperManager.createSession` was called once, then restored the call and re-ran green. The spawn-gate test passed 10 consecutive standalone runs with no `ENOTEMPTY` and scoped shellper delta 0. The full `src/agent-farm` suite passed (176 files + 1 skipped; 3,525 tests + 34 skipped) with total shellper count 44 before/44 after and scoped delta 0. The full package suite passed (326 files + 3 skipped, 6,458 tests + 48 skipped; codev-v2 14 files/180 tests) with total shellper count 44 before/44 after. `pnpm --filter @cluesmith/codev build` also passed.

## PR review — 2026-08-29

Opened PR #175. Initial CMAP: Gemini APPROVE, Codex APPROVE, Claude REQUEST_CHANGES. Addressed Claude's two blockers and cheap edge cases: dead-session reconciliation now calls `session.kill()` before dropping the record; exited sessions retain their deliberate 30-second status window but no longer count as active capacity; EPERM is treated as proof the PID exists; spawn-gate teardown restores cwd/HOME/removes the tree in `finally`; and default Tower route/instance manager mocks now include the new preflight method. Focused tests passed (186/186), build passed, and the spawn-gate rerun again had shellper delta 0.
