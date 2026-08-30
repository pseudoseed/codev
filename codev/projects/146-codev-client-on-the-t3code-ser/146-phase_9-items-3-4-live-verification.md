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
| `spec-146-phase-9-thread-delivery-states.test.ts` | 7 — delivery from a process holding no engine, the four failure sentences, and a fifth test comparing them against each other |
| `spec-146-phase-9-thread-backend.test.ts` | +6 — the project lookup's three answers, driven against a real HTTP server, and the symlink-normalised match |
| `spec-146-phase-9-architect-thread-resume.test.ts` | 9 — the branch normalisation, `attach` vs `create`, idempotence, the unattached-thread message, and `DriverThread.attach` |
| `spec-146-phase-9-add-architect-thread-path.test.ts` | 6 — the backend is registered before the engine is read; the collision refusal; auto-numbering; unconfigured still uses Tower; unreachable propagates |
| `spec-146-t3-contract.test.ts` | +1 — `restart` is distinct from a cold start and refuses to fake one; the live opt-in check now covers both live files rather than one |

Mutation-checked: reverting the branch normalisation fails the item-3 payload test; removing the
`ensureThreadBackendReady` call fails two of the three add-architect tests; replacing `restart`
with `stop` + `start` fails the live test.

Full suite green with these changes: `345 passed | 3 skipped` files, `6810 passed | 52 skipped`
tests, plus the v2 suite's `180 passed`. Run with `env -u CODEV_WORKTREE_ROOT -u CODEV_BUILDER_ID
-u CODEV_ARCHITECT_NAME`, the workaround #189 still requires.

The cold-start evidence in `codev/research/146-harness-coldstart-evidence.json` was regenerated,
because `t3-server.mjs` changed and the phase-1 staleness guard refuses evidence older than the
harness it describes. Both runs passed, both dispatched a real command, both left the port free.
