# air-219 — Run #179 items 3 and 4 live against the pinned t3 server

## Mission
Exercise, live, two acceptance criteria of spec 146 phase 9:
- Item 3: an architect is a thread whose worktree is the workspace root — in production, not against an in-memory engine.
- Item 4: an architect thread survives a **server** restart and resumes **with context**.

Report what was observed. "Could not exercise" must not share a signal with "failed" or "passed".

## Findings while orienting (before any run)

1. **`afx workspace add-architect` cannot reach the thread path in production.**
   `workspaceAddArchitect` gates on `tryGetThreadEngine()`, and nothing in that command
   calls `ensureThreadBackendReady`. Every `afx` invocation is a fresh process with no engine
   registered, so the branch that calls `createArchitectThread` is dead from the CLI and the
   command always falls through to Tower. The phase 9 verification doc already recorded this
   for `interrupt`/`cleanup`/`add-architect`; item 3 is the one it blocks outright.

2. **The harness wipes the server's data dir on every `start`.**
   `t3-server.mjs start` does `rmSync(dataDir, {recursive:true, force:true})` before spawning.
   So `stop` + `start` is not a restart of the same server — it is a new server with an empty
   database. Item 4 run that way would report "did not survive" for a reason that has nothing
   to do with the criterion.

## Status
- Orienting complete. Next: probe restart-with-preserved-data and pairing-token reissue.

## What the live run found (2026-08-29)

Own pinned server, port 3801, data dir under this worktree, so the architect's
server on 3799 was never touched. `verify` matched the pin (082e6ea52186) on every
start. Node 26.4.0, pinned CLI t3@0.0.36.

### Item 3 was not merely unrun — it was broken

`createArchitectThread` passes `branch: ''`. t3code types `thread.create`'s `branch` as
`NullOr(TrimmedNonEmptyString)`, so the empty string is not "no branch" on the wire: the
server refuses it with a `Die` naming a schema path. Every architect thread failed at
creation against a real server. Nothing in the suite could see it — the in-memory engine
does not validate the payload.

Fixed in `DriverThread.create`: `branch === '' ? null : branch`.

### Both criteria then passed, observed

Item 3 — the server's own record (`orchestration.subscribeShell` snapshot):
`worktreePath` == the workspace root, `branch: null`, title `architect-air219`.

Item 4 — turn 1 established a codeword, the server was restarted with its data dir
preserved (new pid), a fresh process attached to the surviving thread, and turn 2 wrote
the codeword back. Not just a reconnect: the value existed only in the pre-restart
conversation.

### What had to be built to get there
- `t3-server.mjs restart` — `stop` + `start` was a cold start wearing a restart's name,
  because `start` wipes the data dir.
- `DriverThread.attach` / `ThreadEngine.attach` — the engine could only create, so nothing
  could resume a thread it had not made.
- `workspaceAddArchitect` now calls `ensureThreadBackendReady`, without which its thread
  branch was dead code in every fresh `afx` process.

## Done
Full suite green (6810 passed, 0 failed; v2 180 passed). Live test passed and was
mutation-checked by swapping `restart` back to `stop` + `start`, which fails it at
"item 4: the thread did not survive the server restart". Verification record at
`codev/projects/146-codev-client-on-the-t3code-ser/146-phase_9-items-3-4-live-verification.md`.
Items 6 and 7 untouched: still held by the architect, still unrun, not ticked.

## Review round 2 (architect REQUEST_CHANGES on PR #221)

Three blocking issues, all fixed, and fixing the first exposed a fourth defect.

1. **A thread-backed architect could not receive mail.** `ensureThreadBackendReady` runs in
   the `afx` process, which exits; Tower is a different process with no engine, so
   `deliverThreadTurn` threw there and a bare `catch { return false }` held the message
   silently. The delivery session now carries a `ThreadDeliveryContext` and `writeMessage`
   registers an engine and attaches in Tower's own process. The bare catch is four named
   ERROR sentences. A fourth `MailboxReason` is the complete fix and is NOT made here —
   it is a migration on the user-global DB and a vocabulary change, so it is the
   architect's call. Raised, not decided.

2. **Found by fixing 1, on its first run: `project.create` is not idempotent.** t3code
   refuses a second active project for a workspace root, and `ensureThreadBackendReady`
   created one unconditionally — so it worked in the first `afx` process against a
   workspace and failed in every one after. Now it looks up the existing project over
   `GET /api/orchestration/shell` first, with three answers (found / none / unknown) and
   symlink-normalised path comparison.

3. **Collision contract.** The thread path consulted `existing` only when auto-numbering,
   so an explicit `--name` collision made a second thread and overwrote the row. Now
   refused with Tower's own sentence.

4. **`restart` could report a restart that did not happen** — `stop` preserves the data
   dir, so the data-dir guard proved nothing. Now requires a running owned server and
   waits for the port to release.

The live test's post-restart turn now goes through a real child process calling
`makeDeliveryPorts().writeMessage` against the built dist. That is what catches issue 1;
driving the engine from the test process cannot see it.
