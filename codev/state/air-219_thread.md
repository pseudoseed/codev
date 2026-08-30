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

## Review round 3 (claude lane, APPROVE HIGH with findings)

- **Fixed:** `spec-146-phase-9-interrupt-side-effect.test.ts` returned `ThreadEngine & {…}` from
  a literal with no `attach` — a type error nothing would ever surface, because
  `packages/codev/tsconfig.json` excludes `**/__tests__/**`, the package has no check-types
  script, and CI typechecks only `packages/types` (#210). The interface gained a member and a
  double diverged from it in the same commit that claimed doubles could not. Also re-pointed my
  own new test files at `@cluesmith/porch-driver/*` rather than `../../../../porch-driver/src/*`,
  which was producing duplicate-module-identity errors of the same invisible class; all five
  files this issue touches typecheck clean with the exclude lifted. 289 pre-existing errors are
  behind that exclude — #210's scope, not this one's.
- **Already closed in 35c37fd23, before the finding arrived:** the reviewer flagged that
  `restart` does not wait for the port to be released. It does — `t3-server.mjs:532-546` polls
  `ownedPortHolders()` to empty with a 30 s bound and exits 3 as `PORT_NOT_RELEASED`. The lane
  reviewed `b560e1b8c`, where it was absent.
- **Filed, not built:** #223 — a thread-backed row held as `no-live-pty` sends the operator to
  restart a session when the real fault is an uninitialised backend in Tower's process.
  Architect's ruling: it is a user-global DB migration and belongs in its own change.

## Review round 4 (codex + claude re-run on ad75b253a, both REQUEST_CHANGES HIGH)

Three of the four exist because round 2's fix moved engine registration into Tower, which
is multi-workspace in a way the CLI never was. Both lanes landed on the first independently.

1. **One process-global engine served every workspace.** `let engine` plus an unkeyed
   `already-installed` check meant the first thread-configured workspace pinned the socket,
   projectId, dispatcher and journal for all of them. Now a Map keyed on the canonical
   workspace root, with NO fallback in either direction, plus one in-flight init per
   workspace (concurrent deliveries raced the singleton). The concurrency test counts
   bootstrap-token exchanges at the server — a pairing grant is one-time.
2. **`--no-enter` became a submitted turn.** The flag was received and discarded on the
   thread branch, so a gate notification sent to sit for a human executed itself. Refused,
   with nothing attempted before the refusal.
3. **Tower never invalidated a dead socket.** The post-handshake listener only warned, so
   after a server restart — which item 4 proves is supported — Tower held the dead engine
   forever. Close now evicts that workspace's engine only, and only if it is still the
   registered one.
4. **`restart` could signal a process it does not own.** `readPid` proved liveness, not
   ownership; a reused pid would have been SIGTERMed as a group. `readOwnedPid` gates it.
   The mutation check killed the bystander process — the damage, observed.

All five mutation checks fired. Recorded, not fixed: architect `attach` passes no
harness/model (the `architect` table has no columns to read, so it rests on two defaults
staying equal), and `activeProjectForWorkspace` hand-builds a second auth path next to
`@cluesmith/t3-client/auth`.

## Review round 5 (codex + claude on 2280ca56b, both REQUEST_CHANGES HIGH)

Both went independently to the same two lines. Four fixed, four mutation checks fired.

1. **A socket closing DURING init registered a permanently dead engine.** The handler's
   comment claimed it "can only fire after this function has finished registering" — false,
   and once written as a guarantee it stopped being checked. The socket is open while the
   HTTP project lookup runs; a close there left `registered` undefined, so the guard
   compared `undefined === undefined` and evicted nothing. Now a monotonic `closed` flag
   checked BEFORE and AFTER registration, and the comment says what makes it true.
2. **The project lookup had no bound.** It sits between a completed handshake and a
   registered engine, so a server that accepted and never answered hung the whole call.
3. **The `--no-enter` refusal was right in substance, wrong in lifecycle.** Held under a
   retryable reason it re-logged every tick and raised a starvation notice with no
   applicable remedy (#190). Terminal now: dismissed with one loud line, `reason: null`, so
   it stays out of `findStarvingAgents` — which does not filter on `escalated`, so marking
   it escalated would have suppressed the wrong list.
4. **`restart` read an lsof failure as "port released".** Three answers now; `PORT_STATE_UNKNOWN`
   refuses rather than starting a second server against an unknown port.

Recorded: `installThreadSpawnFactory` writes a process-global from Tower's process — the bug
the engine map just fixed, one door down, unreachable today because `chooseSpawnPath`'s only
consumer is CLI-only.

## Review round 6 — architect drew a scope line

"Blocking means Tower-wide, destructive, or user-visibly false. Everything else goes to an
issue, including findings I agree with." Four blockers, one comment; the rest filed.

1. **An opt-in feature stalled mail for every workspace.** Tower's drainer awaits agents
   sequentially and `deliverToThread` awaited the connect, so one workspace's bounded connect
   stalled delivery for every agent everywhere, PTY-only included. `requestThreadBackend` is
   synchronous by construction; the connect runs in the background and the next tick finds it
   ready.
2. **No backoff.** A workspace whose server was down re-exchanged a possibly-one-time
   bootstrap token every 1.5 s. 60 s cooldown, reported as its own state.
3. **The upgrade bound did not cancel.** It rejected and left the socket alive, so Tower
   accumulated one orphan per retry. Closed on timeout and on error, from one `abandon`.
4. **`ownsProcess` claimed a proof it did not perform** — docblock said "a t3 serve for OUR
   data dir", code was `cmd.includes(runtimeDir)`, which `tail -f <runtimeDir>/server.log`
   satisfies. Now requires a bare `serve` AND `--base-dir <dataDir>` as real argument pairs,
   verified against both processes the harness creates. Tested with a live `tail -f`.

Comment corrected: `deliverToThread` said "the row stays held" while the caller dismisses it.

Filed: **#226** (mailbox reason/dismissal vocabulary — same migration as #223, one not two),
**#227** (process-global spawn factory in Tower, interrupt/cleanup still broken, architect
attach harness/model, second auth path).

The live child fixture now TICKS at Tower's 1.5 s cadence instead of calling once — a single
`false` is the first tick now, not a failure.

## Review round 7 (codex + claude round 6)

Three blockers, one permitted small fix, one ruling I agreed with, one verification task.

1. **The turn submission was still on the tick.** Round 5 took the CONNECT off; `thread.turn.start`
   is bounded at 30 s by the RPC client and the drainer walks agents sequentially, so an
   already-connected but unresponsive server still stalled every workspace. Submissions now run out
   of band with a per-agent in-flight guard — the row is still held, so without the guard the next
   tick would submit the same message again.
2. **Post-upgrade failures leaked sockets.** `connectDispatcher` returns a disposer; every exit
   before an engine owns the socket hangs up.
3. **The route lie.** A terminally-dismissed row was reported `held`/`no-live-pty`. `refused` +
   `refusedReason` end to end (route ×2, SDK type, CLI ×2), each checked BEFORE `held` and before
   the delivered fallthrough — `delivered:false, held:false` alone would have printed "Message
   delivered".
4. **Small fix taken here:** a stale `thread_id` silently shadowed a live PTY. The PTY wins and the
   contradiction is logged.

Found on the way: `tower-routes.test.ts` mocked `getGlobalDb` but not `getDb`, so route tests read
the REAL user-global database.

**Ruling I agree with:** the architect ruled the remaining `ownsProcess` gap (any command with bare
`serve` plus the matching `--base-dir`) non-blocking, since the residual is contrived and the
docblock no longer claims a proof. I have no counter-case; filed on #227.

**Verification asked for:** claude could not confirm its reviewed SHA. Established that
`7baa2474c` touched ONLY `mailbox-wiring.ts` (+8/−6, net +2, hunk at line 442), so the route
finding is against unmoved code and stands; `resolveLiveSessionForAgent` at ~117 did not move
either. My comment-only push landed as the lanes started — that ambiguity is mine.

## Review round 8 (codex round 7: one blocker; claude round 7: cosmetics only)

**The blocker: a message could run twice.** `dispatchCommand` leaves an unanswered command
pending on purpose — a lost acknowledgement is not a "no". The mailbox held the row, a later
tick re-submitted, and `startTurn` mints a fresh commandId per call, so t3code (which
collapses by commandId) saw two commands and ran the turn twice. Round 6's in-flight guard
does not cover it: it holds while the promise is UNSETTLED, and an ambiguous rejection
settles it.

Fixed by replaying the pending intent under its ORIGINAL id, matched on thread + exact
message text (the journal on disk is the only record that survives a Tower restart).
`recoverPendingCommands` existed, was tested, and had NO production caller — issue 222's
pattern again. This is the caller it never had.

A refusal is settled and is deliberately NOT replayed; that has its own test.

Also: single-sourced the --no-enter rule into `servers/thread-no-enter.ts` with a guard test
that fails if any of the three sites restates it (third time that duplication bit here);
reattached two docblocks that came adrift when new functions were inserted above them; and
removed the stray blank lines.

## Review round 9 (claude round 8: 3 blockers; opencode round 8: a 4th, independently)

Both lanes found holes in the SAME round-7 fix without seeing each other, and both produced the
duplicate-turn outcome it existed to prevent. Reworked rather than patched twice.

1. **Matched on message text.** Two identical messages to one agent are ordinary; a stale intent
   answered for the current one and reported delivered without delivering — worse than the
   duplicate it replaced. The mailbox row id now rides the journal intent as `ref` (new optional
   journal field, never sent to the server) and recovery matches on that.
2. **Drained the whole workspace journal.** `recoverPendingCommands` replays every pending intent
   and settles them all; with concurrent submissions that marked a sibling's intent dispatched
   while its row was still held, so its next tick minted a fresh id. Now replays only its own,
   under its own id, same unanswered/refusal split. **This leaves recoverPendingCommands without
   a production caller again — my round-7 claim to the contrary was wrong and the doc says so.**
3. **PTY vocabulary on a healthy thread row.** Deeper than the review placed it: the SUBMISSION
   wrote `no-live-pty` whenever the write did not happen, and the route also defaulted a
   reasonless row to it. Both fixed — a thread row carries no reason, the CLI renders "pending",
   the log names the state.
4. **realpathSync per engine lookup** on the drain loop. Cached.
Plus: log the transition, not the state (40 identical lines per 60s cooldown).

Also caught myself: my first M4 mutation silently no-op'd because the anchor did not match and I
had not asserted on it. Re-ran with an assert; it fails correctly. A mutation check that cannot
fail is worth nothing, and I nearly recorded one.

**Live re-run after round 8: item 4 NOT EVALUATED.** `COULD_NOT_TELL: FIRST_TURN_TIMEOUT` — the
pre-restart turn never ran within 300s. Item 3 WAS re-observed (the throw is after the
shell-snapshot assertions). Most likely the codex account quota that also took the codex review
lane out this evening (reset stated 21:53; run was 21:26); the server log is clean, so that is
inference, not confirmation. Ruled out as a cause: the round-8 changes — `ref` rides
DispatchOptions so the wire payload is unchanged, and stage A calls engine.startTurn directly,
never deliverThreadTurn.

**Item 4 RE-OBSERVED under the claude driver** at 21:35, on the current head. Cold start pid
46899 → turn 1 → restart with data preserved → pid 52501 → turn 2 returned the codeword → stop.
2 passed, 21.9s. The live test now takes `T3_LIVE_HARNESS` / `T3_LIVE_MODEL`, defaulting to
codex/gpt-5.6-luna so the earlier recorded runs still describe a plain invocation, and every
COULD_NOT_TELL message names the driver in use. This also removes the round-2..7 changes from
suspicion for the codex timeout: same head, same server, same criterion, different provider.

## Round 10 — I reported a fix that was not in the code

opencode round 9 found that blocker 4 from round 8 (cache `canonicalWorkspaceKey`) **never
landed**, while the verification doc asserted it had and the architect had closed the blocker on
my report.

**What happened:** I ran two scripted edits in one Bash step. The first (the cache) failed on a
missed anchor and printed a traceback; the second printed `ok`. I attributed the traceback to the
second script, "fixed" something that was already fine, and never revisited the first. The edit
was never verified after being made.

**Why it survived a whole round:** it was the ONLY round-8 fix with no test. Every other one had a
mutation check that would have failed loudly if the change were absent. A fix with no test is the
fix that silently is not there — and the one most likely to be reported from intent rather than
from observation.

**Rules I am now following, both learned the same night:**
1. Assert the mutation applied before trusting what a mutation check proves.
2. Verify an edit is present after making it. An `ok` that belongs to a different operation is not
   evidence.
3. Never batch edits into one step whose success cannot be attributed individually.

Fixed: the cache is in, it has a test that fails when it is removed, the mutation check asserted
its own application, and the verification doc now records that it claimed the fix a round early
rather than quietly becoming true.

Also filed: the two-writer journal race on #231 (this PR made Tower a second writer of
`.codev/commands.jsonl`, unlocked, and `#truncateTornTail` rewrites the whole file) as
blocking-for-enablement; and `afx send` always reporting pending for a thread-backed agent on
#227. Corrected #227's `installThreadSpawnFactory` fix shape — drop the call, do not key it — and
named the six doc files #226 must carry.

## Main-merge sequence complete

1. `git merge origin/main` — **no conflicts**. The two branches' changed-file sets do not
   intersect (main 67 files, mine 30, intersection empty), which the pre-merge reconnaissance
   predicted.
2. Cherry-picked the two air-220 porch state commits; `220-spec-146-phase-11-codev-client/status.yaml`
   now reads `phase: verified` rather than stalling at `pr`.
3. **On the merged tree:** full suite `351 passed | 3 skipped` files, `6908 passed | 52 skipped`
   tests, 0 failed, plus v2 `180 passed`. `porch check` green. Live criteria re-run under the
   claude driver: cold start pid 66278 → restart preserved → pid 69757 → codeword returned, 2
   passed.
4. PR body carries the disclosure for the 220 pair and the reason the merge mattered more.

Phase 11 and phase 9 do not interact badly. Phase 11's three new test files run alongside mine.
