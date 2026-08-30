# Phase 9 items 3 and 4 — run live against the pinned server

Issue #219. `146-phase_9-verification.md` recorded these two as "runnable once air-180's PR
merges" and did not tick them. They have now been run.

Both are **met**, and getting there found that item 3 was not merely unrun: it could not have
passed. The rest of this document is what was observed and what had to be built to observe it.

## The run

| | |
|---|---|
| Checkout | `/Users/chris/dev/t3code` at `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`, clean — `verify` exit 0 on every start |
| CLI | pinned `t3@0.0.36`, never `t3@latest` |
| Server interpreter | Node 26.4.0 via `T3_NODE`, outside `engines.node ^24.13.1`; the harness emits its ADVISORY and continues |
| Port / data dir | 3801, `.builders/air-219/tools/t3-server/.runtime/data` — a server this builder owned, so the architect's on 3799 was never touched |
| Test | `packages/codev/src/agent-farm/__tests__/spec-146-phase-9-live-architect-thread.test.ts` |
| Result | 2 passed, 22.8 s. Cold start pid 78373 → restart pid 80002 → stop |

Reproduce:

```bash
T3_NODE=/absolute/path/to/node T3_HARNESS_PORT=3801 T3_LIVE=1 \
  pnpm --filter @cluesmith/codev exec vitest run \
  src/agent-farm/__tests__/spec-146-phase-9-live-architect-thread.test.ts
```

## Item 3 — "an architect is a thread whose worktree is the workspace root"

**Met, and it was broken before this.**

`createArchitectThread` passes `branch: ''`, because `ThreadRecord.branch` is a plain string and
an architect has no branch. t3code types `thread.create`'s `branch` as
`NullOr(TrimmedNonEmptyString)`, so `''` is not "no branch" on the wire — it is a value the
server refuses. Observed, before the fix, against the pinned server:

```
RpcFailureError: t3code RPC request 2 failed (Die):
  [{"_tag":"Die","defect":"Expected a value with a length of at least 1\n  at [\"branch\"]"}]
```

Every architect thread failed at creation. Nothing in the suite could see it: the in-memory
engine records what it is handed and validates no payload, so the criterion read as satisfied
by a test that never sent anything anywhere. This is the phase's own thesis — a check reporting
a value it was not positioned to observe — sitting inside the criterion written to prevent it.

Fixed in `DriverThread.create`: `branch: options.branch === '' ? null : options.branch`.

**What was then observed.** From the server's own record, read out of an
`orchestration.subscribeShell` snapshot rather than from the engine's copy of its input:

```json
{
  "id": "c45fc239-327b-4f2f-b44d-05df232f3484",
  "title": "architect-air219",
  "worktreePath": "<the workspace root passed to createArchitectThread>",
  "branch": null
}
```

The thread's worktree is the workspace root. The turn that followed ran in it: the agent wrote
the file it was asked to write.

### The command that makes an architect a thread could not reach that branch

`workspaceAddArchitect` gates on `tryGetThreadEngine()`, and nothing in the command registered
an engine. Every `afx` invocation is a fresh process, so the gate was always false and a
workspace configured for threads still got a Tower terminal. `146-phase_9-verification.md`
recorded this for `interrupt`, `cleanup` and `add-architect` as a known limitation; for item 3
it was the whole criterion.

It now calls `ensureThreadBackendReady(workspacePath)` first, which is what `afx spawn` already
does. An unconfigured workspace is unchanged — `not-configured`, no engine, Tower. A configured
but unreachable server throws rather than falling through to Tower, which is that module's
standing rule.

## Item 4 — "an architect thread survives a server restart and resumes with context"

**Met.** Not a reconnect: the post-restart turn produced a value that existed only in the
pre-restart conversation.

Sequence, all against the same server process lineage:

1. Cold start (pid 78373). Architect thread created, rooted at the workspace root.
2. Turn 1: "remember this codeword: `ZEBRA-<random>`; confirm by writing `ack.txt`." `ack.txt`
   appeared, so the turn was received and acted on.
3. **Server restarted with its data dir preserved** (pid 80002). New process, same state.
4. A fresh connection, a fresh engine, and `attach` — not `create` — onto the surviving thread.
5. Turn 2: "write the codeword I asked you to remember earlier to `recall.txt`."
6. `recall.txt` contained the codeword.

The codeword is randomised per run, and the workspace is a fresh temp directory, so a stale
file cannot produce a pass.

### `stop` + `start` is not a restart, and running it as one would have reported a false negative

`t3-server.mjs start` does `rmSync(dataDir, { recursive: true, force: true })` before spawning.
That is right for the phase-1 cold-start evidence — a start-twice proof is only a proof if each
run begins with an empty database — and it means `stop` then `start` is a **new server**. Item 4
run that way reports "the thread did not survive", for a reason that has nothing to do with the
criterion: the harness deleted it.

Added `t3-server.mjs restart`, which keeps the data dir and refuses with exit `3`
(`NO_DATA_TO_KEEP`) when there is none to keep, rather than silently cold-starting under a
restart's name.

**Mutation-checked.** Replacing `restart` with `stop` + `start` in the live test fails it at
"item 4: the thread did not survive the server restart" — so the restart is load-bearing and
the test can see a thread that is gone.

### The engine could not resume anything

`createPorchThreadEngine` had `create` and no way to adopt a thread it had not made, which
`146-phase_9-verification.md` recorded and assigned to "items 3 and 4". Added:

- `DriverThread.attach` — builds the thread object with no `thread.create` dispatch and no
  worktree-setup write. Creating instead would mint a second thread and overwrite a worktree an
  agent has been working in, which would make the criterion unfalsifiable.
- `ThreadEngine.attach`, on both the porch engine and the in-memory one, so a test double cannot
  diverge from the contract.

An attached thread carries an **empty** event log, because this process holds no subscription to
it. That is "I have not been told", not "nothing happened", and it is stated on the method rather
than left for a caller to discover. `activeTurnId` is `null` for the same reason and no caller
may read it as "the thread is idle".

## Review round 2 — three more defects, all of the same shape

The first version of this work made an architect a thread and left it unreachable. Review
caught it; all three are fixed and the live test now covers the first.

### A thread-backed architect could not receive mail at all

`ensureThreadBackendReady` runs in the `afx` CLI process, which exits. Tower is a different,
long-lived process and registers no engine, so `deliverThreadTurn` threw there for every
thread-backed row — and `writeMessage` wrapped it in a bare `catch { return false }`, which the
delivery path holds as `no-live-pty`. Configuring threads therefore traded a working Tower
architect for one that could never receive mail, silently. Starvation through a different door.

Fixed at the delivery seam: the session now carries a `ThreadDeliveryContext` (workspace root,
worktree, branch, agent — none of which is derivable from a thread id), and `writeMessage`
registers an engine in **this** process and adopts the thread before starting the turn.

The bare catch is gone. Four failures, four sentences: no context on the session (a wiring
fault here), a thread-backed row in a workspace naming no server (a contradiction in the state),
a server that could not be used, and a server that refused the turn. They still all hold the row
the same way — `MailboxReason` is `busy | no-profile | no-live-pty` and a CHECK constraint on
the mailbox table pins it — but each names itself at ERROR instead of leaving through the same
silence. **A fourth held reason is the complete fix and is not made here**: it is a migration on
the user-global database and a user-visible vocabulary change, which is the architect's call.

### `project.create` is not idempotent, and the second process paid for it

**It fails on the second use, which means it fails for the user and not for the author.** It
worked in the first process to run against a workspace and failed in every one after, so it
would have passed any test that ran once and any manual check by whoever built it.

Found by the fix above, on its first run. t3code refuses a second active project for a workspace
root (`requireActiveProjectWorkspaceRootAbsent`), and `ensureThreadBackendReady` created one
unconditionally. So it worked in the **first** process to run against a workspace and failed in
every one after it — and every `afx` invocation is a fresh process. Observed:

```
Orchestration command invariant failed (project.create):
  Active project '8d48788a…' already exists for workspace root '/…/air-219-ws-prW7MK'.
```

It reached the caller as "the server was named and could not be used", which sends a reader to
check a server that is fine.

Now the existing project is looked up first, over `GET /api/orchestration/shell` rather than
through `orchestration.subscribeShell` — the subscription never exits, so taking one snapshot
from it would leave a live subscription behind for the life of the process. Three answers, not
two: `found`, `none`, and `unknown`. `unknown` is not `none`, because the caller's next move on
`none` is to create a project, which is exactly what fails when the truth was "I could not tell".
Paths are compared normalised: `/var` and `/private/var` are the same directory on macOS, and a
string compare answers `none` for a project that exists.

### The thread path violated the collision contract

`workspace-add-architect` consulted the existing set only when auto-numbering. With an explicit
`--name` that was already registered it created a **second** thread and `setArchitectByName`
overwrote the row, leaving the first thread alive on the server with nothing pointing at it. The
Tower path refuses that. Now both do, with the same sentence, so a user cannot tell which engine
refused. Auto-numbering now uses `autoNumberArchitectName` rather than a second copy of the rule.

### `restart` could report a restart that did not happen

The first guard checked only that the data dir existed — and `stop` **preserves** the data dir,
so `stop` then `restart` succeeded having replaced no process at all. It now requires a running
server this harness owns, and waits (bounded, 30 s) for the port to be released before starting,
because `stop` signals and does not wait. Three named refusals: `NOT_RUNNING`, `NO_DATA_TO_KEEP`,
`PORT_NOT_RELEASED`, all exit 3.

### The interface gained a member and a double diverged from it in the same commit

`ThreadEngine` gained a required `attach` — stated in this document as the reason to put it on
the interface, "so a test double cannot diverge from the contract". A double diverged from it
immediately: `spec-146-phase-9-interrupt-side-effect.test.ts` returns `ThreadEngine & {…}` from
an object literal that had no `attach`.

Nothing would ever have surfaced it. `packages/codev/tsconfig.json` excludes `**/__tests__/**`,
the package has no check-types script, and CI's only typecheck covers `packages/types`. A type
error in a test file is invisible here — issue #210's blind spot, doing real damage rather than
theoretical, in the commit that added the guarantee.

The double is fixed, and the five test files this issue touches were typechecked with the
exclude lifted and are clean. Lifting it for the tree is not attempted: 289 pre-existing errors
are behind it, which is #210's scope and not this one's.

## Review round 3 — the delivery fix moved into a multi-workspace process

Round 2's fix put engine registration inside Tower, which is what it needed. Tower is
multi-workspace in a way the CLI never was, and three of these four exist because of that move.
The codex and claude lanes were re-run independently and both landed on the first one without
seeing each other.

### One process-global engine served every workspace

`thread-runtime.ts` held a bare `let engine`, and `ensureThreadBackendReady` returned
`already-installed` **before reading the requested root**. Harmless in the CLI: one process, one
workspace, exit. Tower drains mail for every workspace in `global.db`, so the first
thread-configured workspace to connect pinned the socket, the `projectId`, the dispatcher and the
journal — and workspace B's turns ran against workspace A's server, under A's project. Silently,
because a turn dispatched to the wrong server succeeds.

Now a `Map` keyed on the canonical workspace root. A keyed lookup **never falls back** to an
engine registered elsewhere, and an unkeyed registration is not a fallback for a keyed lookup or
the reverse — a fallback would restore the same bug one indirection further away. The key is the
same canonicalisation the project lookup uses, so `/var` and `/private/var`, trailing slashes and
`.`-relative forms are one workspace rather than two engines for it.

Concurrent first deliveries raced the singleton too: both saw no engine, both connected, and the
second overwrote the first — an orphaned socket, and two `project.create` attempts for one root.
One in-flight initialisation per workspace now, shared by everyone who asks. The test counts
**bootstrap-token exchanges at the server**, because a pairing grant is one-time: a second
exchange is not merely wasteful.

### `--no-enter` silently became a submitted turn

`writeMessage` received `noEnter` and discarded it on the thread branch. `--no-enter` exists so a
message **sits** and a human decides — it is how gate notifications are sent. On a thread-backed
agent that message executed itself: a thread has no composer, and `thread.turn.start` is the
submit.

A message that does not arrive is the failure this project spent two days on. A message that
arrives and runs itself is the worse half of it.

Refused rather than approximated. The row stays held and stays visible in `afx inbox`, which is
what `--no-enter` asks for minus the composer. Nothing is attempted before the refusal, so there
is no path by which the turn could start.

### Tower never invalidated a dead socket

`connectDispatcher`'s post-handshake listener only warned. **Item 4 of this work proves the
t3code server can be restarted** — after which Tower held the dead engine forever and every
delivery held until Tower itself was restarted. A `close` handler now evicts that workspace's
engine, and only that one; the next call reconnects with a fresh credential exchange. It evicts
only if the engine it registered is still the registered one, so a late close from an old socket
cannot drop a newer engine.

### `restart` could signal a process it does not own

`readPid` did `process.kill(pid, 0)` — liveness, not ownership. Pids are reused, so a stale pid
file could name an unrelated live process and `stop` would SIGTERM its whole process **group**.
`ownsProcess` already existed for the port sweep, which refuses to kill what it cannot prove it
owns; the pid path was the one place that rule was not applied, and it is the one that can
destroy someone else's work.

`readOwnedPid` now gates the signal, and `stop` clears the stale file and says why rather than
leaving the workspace wedged. Mutation-checked, and the mutation **killed the bystander process**
in the test — which is the damage, observed.

## Review round 4 — a race between two awaits

Round 3's four are fixed. These are narrower, and two reviewers independently went to the same
two lines.

### A socket closing DURING initialisation registered a permanently dead engine

The close handler carried a comment saying it "can only fire after this function has finished
registering" the engine. That was false, and once written as a guarantee it stopped being
checked.

The socket is **open while the HTTP project lookup runs**. A close in that window left
`registered` undefined, so the guard compared `undefined === undefined`, evicted nothing, and
initialisation went on to register an engine backed by an already-closed socket. No further close
could fire, because it already had. Round 3's dead-engine defect again, in a narrower window —
and the eviction tests could not see it, because they close the socket *after* initialisation.

Now a monotonic `closed` flag, set the moment the socket goes whether or not an engine exists,
checked **before and after** registration: the window between the check and the write is closed
by the second check rather than by an argument about ordering. The comment says what makes it
true instead of asserting that it is.

The new test drops the socket while delaying the shell-snapshot response, which is that window.

### The project lookup had no bound

It sits between a completed handshake and a registered engine, and a server that accepted the
request and never answered left `ensureThreadBackendReady` unsettled forever, having reported
nothing. Unbounded is not slow; it never ends. Bounded now by the same value the caller controls
for the socket upgrade, and the signal covers the body read as well as the headers.

### The `--no-enter` refusal was right in substance and wrong in lifecycle

Refusing was correct. Holding the refusal was not: a retryable hold is retried every drain tick,
re-logs at ERROR each time, and eventually raises a **starvation notice to a human with no remedy
that applies** — no action of theirs can give a thread a composer. That is #190, a notice
promising something unreachable.

It is terminal now, once, and loud: the row is dismissed with a single ERROR line naming the
sender, the recipient, why it can never be delivered, and how to re-send it. `reason: null` is
what keeps it out of `findStarvingAgents`, which does not filter on `escalated` — marking it
escalated would have suppressed `findEscalatable` and left the starvation notice firing.

A control test asserts `--no-enter` to a PTY-backed agent is unchanged, so this is a rule about
the one transport that cannot honour the flag rather than about the flag.

### `restart` read an `lsof` failure as "port released"

`ownedPortHolders` caught every failure and returned an empty list, so a tool that could not look
read exactly like a port with nothing on it. Three answers now: `known: false` only when the tool
itself failed (spawn error, or a non-empty stderr), and an empty listing with `known: true` is a
real checked negative. `restart` refuses with `PORT_STATE_UNKNOWN` rather than starting a second
server against a port whose state is unknown. The mutation check produces the confident negative
the fix removes.

## Review round 5 — an opt-in feature was charging everyone

Round 4's four are fixed. These are what moving the connect into Tower's tick cost.

### The connect stalled mail for every workspace, including PTY-only ones

Tower's drainer awaits agents sequentially, and `deliverToThread` awaited
`ensureThreadBackendReady`. A connect is bounded by design — 15 s per stage, up to 30 s across a
token exchange, a ticket and an upgrade — so one workspace's connect stalled delivery for **every
agent in every workspace, including PTY-only ones that never opted into threads**. The bound that
makes the connect safe is exactly what makes the stall long. An opt-in feature is not opt-in if
declining it still costs you your mail.

The tick no longer awaits a connect. `requestThreadBackend` is synchronous by construction: it
answers `ready`, `connecting`, `cooling-down`, `misconfigured` or `not-configured`, starts the
connect in the background when there is one to start, and returns. The row is held, and the next
tick — 1.5 s later — finds the engine ready. A workspace that names no server reads its config
from disk and costs the tick nothing.

The CLI keeps the awaited `ensureThreadBackendReady`: one workspace, one process, and a spawn that
returned before its server was reachable would be lying.

### A failed connect retried every 1.5 seconds, spending a one-time credential

There was no backoff, so a workspace whose server was down re-ran the whole connect on every tick
— a full bootstrap-token exchange each time, against a credential this module's own documentation
says may be one-time. The retry loop would spend the thing it needs to retry with. Sixty-second
cooldown now, reported as its own state with the failure that caused it, and cleared on success.

### The upgrade bound did not cancel the connection

It rejected and walked away, leaving the socket alive: a server that accepts the TCP connection and
holds the upgrade open kept a live connection past the advertised deadline, and Tower retries — so
it accumulated one orphan per attempt, each holding a descriptor. A bound that does not cancel is
not a bound. The socket is closed on the timeout and on the error path, from one `abandon` that
also clears the timer, so there is a single place where the handshake stops mattering.

### `ownsProcess` claimed a proof it did not perform

Its docblock promised "a `t3 serve` for OUR data directory". The code was
`cmd.includes(runtimeDir)`. A substring of a path is not that: `tail -f
<runtimeDir>/server.log` satisfies it, and so does an editor with the path in its argv — and that
process then takes the group SIGTERM.

Round 3 established that liveness is not ownership. The fix chosen was a substring, which is not
ownership either, and the docblock asserted the stronger claim — the same shape as the
close-handler comment the round before, in the one function whose entire job is deciding what to
kill.

It now requires a bare `serve` argument **and** `--base-dir <dataDir>` as a real argument pair,
checked against both processes the harness creates (the `npm exec` wrapper and the `node .../t3`
grandchild that holds the port). Still an argv heuristic rather than a proof of parentage — but it
is the claim the docblock makes, which the substring was not. The test is a live `tail -f` on the
runtime log.

### One comment, corrected

`deliverToThread`'s `--no-enter` log said "the row stays held". The caller dismisses it. One rule
in two files with one of them wrong is how the next reader is misled.

## Review round 6 — the stall that survives a healthy connect

Round 5 took the CONNECT off Tower's drain tick. These are what was still on it, plus a lie the
route was telling about a row the delivery path had ended.

### The turn submission was still on the tick

`MailboxDrainer.tick` walks agents **sequentially**, and a thread submission is
`thread.turn.start` over RPC — bounded at 30 s by the client, not by anything in the mailbox. So
an **already-connected but unresponsive** server stalled delivery for every agent in every
workspace, PTY-only ones included. The connect was one path to that stall; this is the other, and
it is the one that survives a healthy connect.

The submission now runs out of band and the tick returns immediately. The row stays held until the
submission says otherwise, which is what held is for. An in-flight guard keyed by agent is what
makes not awaiting safe: the row is still held, so the next tick 1.5 s later would submit the same
message a second time — one message, several turns.

### A post-upgrade failure leaked the socket

The upgrade timeout closes the socket it gives up on, but a connection that upgraded
**successfully** and then failed at the project lookup or `project.create` was simply dropped: the
reference went out of scope and the socket stayed open. The 60 s cooldown then retries, and Tower
accumulates one live connection per attempt.

`connectDispatcher` returns a disposer now, and every exit before an engine owns the socket hangs
up. The successful path deliberately does not — the engine holds it for its lifetime, and its own
`close` handler evicts it.

### The route told the sender a row was held when it had been ended

`deliverAgentMail` ends a `--no-enter` row to a thread-backed agent terminally. The route reported
that as `held: true, reason: 'no-live-pty'` — promising a retry that cannot happen, and handing
back a mailbox id that lists nowhere.

`delivered: false, held: false` alone would have been worse: the CLI's final branch reads that as
**delivered**. So the refusal has its own word — `refused` with a `refusedReason` sentence — on
both route sites, in the SDK response type, and on both CLI paths, each checked *before* the
`held` branch and before the delivered fallthrough so an older Tower's answer is unchanged.

The vocabulary migration this points at is still **#226**; this is the one line that was
user-visibly false.

### A stale thread id silently shadowed a live PTY

`resolveLiveSessionForAgent` returned a thread session before consulting the terminal map, so a
row whose `thread_id` was stale sent its mail to a thread that no longer served the agent — while
the agent sat at a live prompt. Low probability, completely silent.

The two identities are mutually exclusive by construction (`assertExclusiveIdentity`), so both
being present is a contradiction in the state rather than a preference. The PTY wins, because it
is the one observed live, and the contradiction is logged rather than resolved in silence. A
not-writable PTY entry is not a live PTY and does not displace the thread.

### One more test isolation, found on the way

`tower-routes.test.ts` mocked `getGlobalDb` but not `getDb`, so `state.js`'s builder and architect
reads reached the **real user-global database** — a route test's answer depended on what happened
to be registered on the machine running it. Both now point at the in-memory test DB.

## Review round 7 — a message could run twice

### The idempotency hole

`dispatchCommand` leaves an **unanswered** command pending on purpose: a dead socket or a timed-out
request does not say whether the server applied it, and journalling that as failed would spell "I
could not tell" exactly like "no". So a turn whose acknowledgement was lost is still, as far as
anyone knows, running.

The mailbox then held the row, a later tick submitted the same message, and `startTurn` mints a
**fresh `commandId`** per call — so t3code, which collapses duplicates by `commandId`, saw two
different commands and ran the turn twice. For a builder that is two PRs, or the same destructive
instruction carried out twice.

Round 6's in-flight guard does not cover it. That guard prevents a retry while the original
promise is *unsettled*; an ambiguous rejection settles it and the guard opens.

Delivery now replays the pending intent under its **original** id rather than issuing a new one.
The match is on the thread and the exact message text, because the journal on disk is the only
record of the attempt that survives a Tower restart — an in-process map does not.

**`recoverPendingCommands` existed, was tested, and nothing in production called it.** The
recovery mechanism for this bug was already in the tree and had never run. This is the caller it
never had, and it replays every pending command, which is right: all of them are equally
ambiguous, and every one is collapsed by the server if it already landed.

A refusal is **not** ambiguous — the server answered, and answered no — so it is not replayed, and
a fresh submit after one is correct. That distinction has its own test, because without it the fix
would replay decisions that were already made.

### One rule, one encoding

The `--no-enter`-on-a-thread rule is enforced at three points, which is correct. It was *stated*
at three points, which is not — and that duplication had already gone stale twice in this issue,
in the same pair of files. `servers/thread-no-enter.ts` now owns the condition and the words, and
`spec-146-phase-9-no-enter-rule.test.ts` fails if any site restates them instead of importing
them. Mutation-checked by hardcoding the sentence at one site.

### Two docblocks that came adrift

Inserting `refusedReasonFor` and `deliverToThread` left `handleInboxList`'s and
`makeDeliveryPorts`' docblocks sitting above the new functions — both then documented the wrong
thing and both real functions were undocumented. The same comment-lies pattern as the close
handler and `ownsProcess`, in its most mundane form: **inserting a function is enough to cause
it.** Both reattached.

## Review round 8 — the round-7 fix had two independent holes

Two lanes that did not see each other found two different ways the idempotency fix was wrong, and
**both produced the outcome it existed to prevent**. It was reworked rather than patched twice.
The shape is now: *this delivery recovers its own intent, identified unambiguously, and touches
nothing else.*

### It matched on message text

Two identical messages to one agent are ordinary — a retried instruction, a repeated nudge, any
templated notice. Text matching let a STALE intent answer for the current message, so delivery
reported `recovered` and the row was marked delivered for a message that had never been submitted.

That trade goes the wrong way. A duplicate turn is visible and recoverable; a false "delivered" is
neither.

The mailbox row id is now carried through to the journal as the intent's `ref` — a new optional
field on the journal record, never sent to the server, because the wire payload is t3code's schema
and this is the caller's bookkeeping. Recovery matches on that.

### It drained the whole workspace journal

`recoverTurn` called `recoverPendingCommands`, which replays EVERY pending intent and marks them
all dispatched. Round 6 made submissions concurrent across agents, so two lost acknowledgements in
one workspace is a state this PR can now produce — and draining the journal marked the sibling's
intent dispatched while its mailbox row was still held. Its next tick found nothing pending,
`startTurn` minted a fresh id, and the duplicate appeared one agent over. A mid-loop throw was
worse: the intents replayed before it were already settled.

It now replays only its own intent, under its own command id, with the same unanswered/refusal
split — `recoverPendingCommands`' per-intent body, scoped to one intent.

**That leaves `recoverPendingCommands` without a production caller again, and this document said
otherwise last round.** The correction is worth stating: whole-journal replay is a
process-startup operation, and doing it from a per-row delivery is precisely what made it wrong.
Claiming it as the caller that function never had was a claim about the code's shape, not about
what it does.

### `afx send` to a healthy thread-backed agent reported a PTY diagnosis

Two places, and the deeper one was not where the review expected it. `MailboxReason` is
`busy | no-profile | no-live-pty` — three words about a PTY, pinned by a CHECK constraint. **Not
one of them describes any state a thread transport can be in**: no profile, no prompt to be busy,
no PTY to be missing.

The submission wrote `no-live-pty` onto the row whenever the write did not happen, and the route
then defaulted a reasonless row to `no-live-pty` as well. Both are fixed: a thread row that was
not written carries **no** reason, the route reports the row's reason as-is, and `afx send`
renders that as "pending". The four states this actually distinguishes are named in the log. The
missing word is #226's migration; inventing the nearest wrong one until then is what this did.

### `realpathSync` ran on every engine lookup — and this section was wrong for a round

A synchronous filesystem syscall, once per agent per 1.5 s tick, inside the sequential drain loop
that three rounds of this issue went into clearing of blocking work. A network call and a blocking
syscall on that loop differ in magnitude, not in kind. Cached on the raw input, with the trade
stated: a symlink repointed under a running Tower keeps its old resolution for the life of the
process.

**This section asserted that fix for a full review round before the code contained it.** The edit
that was supposed to apply it silently did not — two scripted edits ran in one step, one failed on
a missed anchor, and the failure was attributed to the other. It was reported as done, this
document recorded it as done, and the architect closed the blocker on that report. The next round
read the source and found no cache.

Two things made it possible, and only the second is interesting:

- The edit was never verified after being made. An "ok" that belongs to a different operation is
  not evidence.
- **It was the only round-8 fix with no test.** Every other one had a mutation check that would
  have failed loudly if the change were absent; this one had nothing that could notice. A fix with
  no test is the fix that silently is not there — and the one most likely to be reported from
  intent rather than from observation.

It now has a test that fails when the cache is removed, mutation-checked with an assertion that
the mutation itself applied.

### Forty identical log lines per cooldown

`deliverToThread` logged at ERROR every 1.5 s for a stable `cooling-down` or `misconfigured`
state. It logs the **transition** now, and forgets the last complaint when the workspace goes
ready — so a fault after a recovery is reported rather than suppressed as a repeat of something
that had resolved.

## Item 4 RE-OBSERVED after all eight rounds, under a second driver

The criterion had last been observed before eight rounds of change to delivery, recovery and the
engine registry, and the codex-driver re-run could not evaluate it (below). Item 4 is a claim
about **threads** — that one survives a server restart carrying its context — and nothing in it is
specific to a provider, so it was re-run under the `claude` driver instead of waiting ~18 hours
for a quota reset.

| | |
|---|---|
| Head | `89cfc8918` plus the driver override |
| Driver | `claude` / `claude-haiku-4-5` (`T3_LIVE_HARNESS` / `T3_LIVE_MODEL`) |
| Checkout | `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`, clean, `verify` exit 0 on both starts |
| Sequence | cold start pid 46899 → turn 1 → **restart, data dir preserved** → pid 52501 → turn 2 → stop |
| Result | 2 passed, 21.9 s |

Both criteria observed, on the current code: the server's own snapshot showed the architect thread
rooted at the workspace root, and after the restart a fresh child process delivered a turn through
`makeDeliveryPorts().writeMessage` that produced the randomised codeword established **before** the
restart.

**The default is unchanged.** `codex` / `gpt-5.6-luna` remains what the test runs without the
override, so the earlier recorded runs still describe what a plain invocation does. The driver in
use is named in every `COULD_NOT_TELL` message, so a future run cannot report an outcome without
saying which driver produced it.

## The round-8 codex-driver re-run did NOT evaluate item 4, and that is not a failure

Recorded because it is exactly the distinction this whole document is about.

The live test was re-run after the round-8 changes and threw:

```
COULD_NOT_TELL: FIRST_TURN_TIMEOUT — the pre-restart turn never ran, so nothing was
established for the restart to preserve. Item 4 was NOT evaluated.
```

**Item 3 was re-observed** — the throw is at the ack wait, after the shell-snapshot assertions,
so the architect thread was created and the server's own record showed it rooted at the workspace
root. **Item 4 was not evaluated**: no pre-restart turn ran, so there was nothing for a restart to
preserve. That is neither "it passed" nor "it failed", and the test spells it as neither.

**Cause, now better than an inference:** the same test, same head, same server, same criterion
passed under the `claude` driver minutes later. That does not prove the codex quota was the
mechanism, but it removes the code from suspicion — whatever stopped the turn was on the codex
side. The account's codex quota was exhausted this evening — the codex review lane
printed "You've hit your usage limit" and produced no review, with a stated reset at 21:53. The
run was at 21:26. The pinned server's log shows a clean start and no error, so this is
inference from the account state, not something confirmed at the server.

**Ruled out:** the round-8 changes cannot have caused it. The `ref` travels in `DispatchOptions`
and is journalled beside the intent — the wire payload is byte-identical — and stage A calls
`engine.startTurn` directly, never `deliverThreadTurn`, so the recovery path is not on it at all.
Items 3 and 4 were both observed on earlier runs of the same test against the same pinned server.

## A thread-backed architect receives NO GATE NOTICE

Stated plainly rather than left to be derived from two facts in different files.

Porch's gate notifications are sent with `--no-enter` — that is the whole point of them: the
message sits in the composer and a **human** decides. A thread has no composer, so a thread-backed
agent refuses `--no-enter` messages terminally.

**Therefore an architect that has been moved onto a thread will not be told when a gate opens.**
Not "will be told late" — will not be told. The row is dismissed, the sender is told it was
refused and why, and nothing arrives at the architect.

That is correct behaviour for a composer-less transport and it is a real hole in the workflow. It
is not a regression today, because thread-backed spawning is opt-in and is not enabled anywhere.
The standing instruction, adopted from #221's round-9 review: **do not enable thread-backing on
any workspace that receives porch `--no-enter` gate notifications until that path has an owner
decision.** #226 is where the decision belongs.

## Recorded, not fixed

- **An architect's `attach` passes no harness or model**, so it depends on the engine's
  `defaultHarness`/`defaultModel` being the same at attach time as at create time. The builder
  path is right — it reads `harness`/`model` off the row — but the `architect` table has no such
  columns, so there is nothing to read. Two defaults staying equal is a weaker guarantee than
  reading what was recorded.
- **`activeProjectForWorkspace` hand-builds a second auth path**: a bare `fetch` with an
  `authorization` header, next to `@cluesmith/t3-client/auth`, which owns every other request.
  It works and it is one request, but the client is where that knowledge belongs.
- **`installThreadSpawnFactory` writes a process-global from Tower's multi-workspace process.**
  It is the bug the engine map just fixed, one door down. Unreachable today — `chooseSpawnPath`'s
  only consumer is the CLI, which is one workspace per process — so it is recorded rather than
  fixed, and the factory at least closes over the workspace it was installed for.

All of the above, plus `afx interrupt` and `afx cleanup` on the thread path, are filed as **#227**.
The mailbox-vocabulary work — every non-delivered status reported as held/`no-live-pty`, and
`dismiss()` now carrying system refusals as well as operator ones — is **#226**, which wants the
same migration as **#223**: one migration on the user-global database, not two.

## What is still NOT met, stated rather than left to be discovered

**`afx interrupt` and `afx cleanup` are unchanged.** Both still reach `getThreadEngine()` in a
process where none is registered. The delivery path is fixed; these two are not, and the same
init-plus-attach shape would fix them.

**The held-reason vocabulary is still three values.** "Tower cannot reach the thread" and "the
PTY is gone" are held identically. The log now separates them; the row does not — and the
operator's next action differs: a missing PTY means restart the session, an unreachable thread
means the backend is not initialised in Tower's process. Filed as **#223** rather than built
here, on the architect's ruling: it is a migration on the user-global `global.db`, and
`schema.ts:278` pins the vocabulary with a CHECK constraint so the migration and the writers
have to land together.

## Explicitly not attempted

**Item 6** (one architect and six builders, measured) and **item 7** (`/arch-save` exercised)
remain held by the architect, per #219's scope. Not attempted, not measured, and no claim is
made about either.

## Tests

| File | Tests |
|---|---|
| `spec-146-phase-9-live-architect-thread.test.ts` | 2 — the live run above, and the companion that names the exact reason it could not check. Its post-restart turn is delivered by a **real child process** through `makeDeliveryPorts().writeMessage`, against the built `dist` |
| `spec-146-phase-9-thread-delivery-states.test.ts` | 11 — delivery from a process holding no engine, six not-delivered states compared against each other, the connect that is never awaited, the backoff state, and the `--no-enter` refusal with its control |
| `spec-146-phase-9-engine-per-workspace.test.ts` | 15 — the keyed registry with no fallback in either direction, two workspaces in one process against a real fake t3code server, concurrent init counted at the server, socket-close eviction with its reconnect, a close DURING initialisation with its reconnect, the project lookup's bound, the non-blocking request, the failed-connect cooldown, the upgrade bound closing the socket it gave up on, and a post-upgrade failure hanging up rather than leaking |
| `send-delivery.test.ts` | +5 — a `--no-enter` row ends terminally with a PTY control; a hung thread submission does not delay a PTY agent behind it; a second tick does not re-submit an in-flight turn; the row delivers when the submission settles |
| `tower-routes.test.ts` | +2 — a terminally refused row is reported `refused`, not `held`, with an ordinary send to the same thread-backed agent as the control |
| `spec-146-phase-9-render-gate.test.ts` | +3 — a stale thread id beside a live PTY delivers to the PTY and logs the contradiction, with a thread-only control and a not-writable-PTY control |
| `spec-146-phase-9-thread-backend.test.ts` | +6 — the project lookup's three answers, driven against a real HTTP server, and the symlink-normalised match |
| `spec-146-phase-9-architect-thread-resume.test.ts` | 17 — branch normalisation, `attach` vs `create`, idempotence, the unattached-thread message, `DriverThread.attach`, and the replay-not-repeat set: an unacknowledged turn replays under its ORIGINAL id, a refusal is not replayed, an identical-text second row is not answered by the first row's stale intent, and recovering one thread does not settle another's |
| `spec-146-phase-9-add-architect-thread-path.test.ts` | 6 — the backend is registered before the engine is read; the collision refusal; auto-numbering; unconfigured still uses Tower; unreachable propagates |
| `spec-146-phase-9-no-enter-rule.test.ts` | 8 — the `--no-enter`-on-a-thread rule has one encoding, and a site that restates it instead of importing it fails |
| `spec-146-phase-9-spawn-factory-dormancy.test.ts` | 3 — `chooseSpawnPath` has exactly one production consumer and it is the CLI spawn path; nothing under `servers/` reads it; and the install still happens, so this is dormancy rather than absence |
| `spec-146-t3-contract.test.ts` | +5 — `restart` is distinct from a cold start and refuses to fake one; `stop` refuses to signal a live pid it cannot prove it owns, and refuses a live `tail -f` whose argv merely mentions the runtime directory; an `lsof` that cannot answer is `PORT_STATE_UNKNOWN` rather than a free port; the live opt-in check now covers both live files rather than one |

Mutation-checked: reverting the branch normalisation fails the item-3 payload test; removing the
`ensureThreadBackendReady` call fails two of the three add-architect tests; replacing `restart`
with `stop` + `start` fails the live test.

Full suite green **on the merged tree** — this branch with `origin/main` merged in, which is what
will actually land: `352 passed | 3 skipped` files, `6911 passed | 52 skipped` tests, plus the v2
suite's `180 passed`, 0 failed. Run with `env -u CODEV_WORKTREE_ROOT -u CODEV_BUILDER_ID
-u CODEV_ARCHITECT_NAME`, the workaround #189 still requires.

The cold-start evidence in `codev/research/146-harness-coldstart-evidence.json` was regenerated,
because `t3-server.mjs` changed and the phase-1 staleness guard refuses evidence older than the
harness it describes. Both runs passed, both dispatched a real command, both left the port free.
