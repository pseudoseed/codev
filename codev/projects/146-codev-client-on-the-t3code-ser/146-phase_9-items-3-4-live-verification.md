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

## What is still NOT met, stated rather than left to be discovered

**`afx send architect` in a fresh process still cannot resume a thread.** `deliverThreadTurn`
takes only a thread id and calls `startTurn`, which throws for a thread this process did not
create. `attach` is the capability that makes resumption possible; nothing yet calls it from the
mailbox path, because the worktree and branch it needs live on the row and `deliverThreadTurn`
is not handed one. Item 4's criterion is about the thread, and the thread resumes. The CLI
round trip on top of it is not proven here and is not claimed.

`afx interrupt` and `afx cleanup` are unchanged and still reach `getThreadEngine()` in a process
where none is registered.

## Explicitly not attempted

**Item 6** (one architect and six builders, measured) and **item 7** (`/arch-save` exercised)
remain held by the architect, per #219's scope. Not attempted, not measured, and no claim is
made about either.

## Tests

| File | Tests |
|---|---|
| `spec-146-phase-9-live-architect-thread.test.ts` | 2 — the live run above, and the companion that names the exact reason it could not check |
| `spec-146-phase-9-architect-thread-resume.test.ts` | 9 — the branch normalisation, `attach` vs `create`, idempotence, the unattached-thread message, and `DriverThread.attach` |
| `spec-146-phase-9-add-architect-thread-path.test.ts` | 3 — the backend is registered before the engine is read; unconfigured still uses Tower; unreachable propagates |
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
