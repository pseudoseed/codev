# Spec 146, Phase 3, iteration 1 — responses to the review

Both lanes returned **REQUEST_CHANGES**. Every finding is accepted and fixed.
Nothing is rebutted as wrong. Two are answered with a correction that goes
further than the finding did, and one thing the lanes could not have seen is
disclosed at the end.

## Accepted and fixed

### 1. The check timeout did not bound the call — BOTH LANES, blocking

`checks.ts` signalled the shell's own PID and resolved on `close`. Both are wrong
for every check porch will actually run, and the single test it had used the one
shape that hides it.

One lane measured it rather than inferring it: **20,019 ms against a
`timeoutMs: 1000`** for `sleep 20; true`, and 30,021 ms with a backgrounded
grandchild. `bash -lc 'sleep 30'` execs, so the shell's pid *is* the sleep's and
killing it works; `sleep 20; true` forks, so the signal reached a shell that was
merely waiting. Every real check — `npm test`, `pnpm build` — is the second shape.

**Fixed:** `detached: true`, `process.kill(-pid, signal)` for the whole group with
a `child.kill` fallback, and the result resolves on `exit` rather than `close`.

I measured the matrix myself before believing either half:

| | `exit` | `close` |
|---|---|---|
| attached | 705 ms | **20,018 ms** |
| detached | 705 ms | 706 ms |

That has a consequence for the mutation harness, and it is why two mutations were
**removed** rather than left green: with `detached`, either fix alone bounds the
compound case, so no test can go red for reverting just one. A mutation that
cannot fail is not evidence, and listing it would have been the same error as the
test it replaced. The grandchild test does discriminate `detached`; the
`exit`/`close` change is defended by the measurement above and by the escape it
covers that the group kill does not — a pipe-holder in another session.

Three tests added: a compound command bounded under 6 s against a 700 ms budget, a
backgrounded grandchild whose marker file must be absent afterwards, and a
`trap "" TERM` check that must still be bounded.

**Also accepted, from the same lane:** unbounded stdout/stderr buffering in a
process that caps its event log. Now capped at 4 MiB per stream, keeping the
**tail** — a failing check explains itself in its last lines — with
`stdoutTruncated` / `stderrTruncated` so a trimmed log is never presented as the
whole one.

**The `detached` consequence, stated rather than buried:** the child is in its own
process group, so a Ctrl-C in porch's terminal no longer reaches it. Porch is a
long-lived driver that owns its checks explicitly, and a timeout that cannot stop
the thing it is timing is worse. A caller shutting down mid-check must signal the
group; that is written in the function's doc comment.

### 2. `thread.create` requires `modelSelection` — codex, blocking

Confirmed against the vendored contract:

```
"required": ["type","commandId","threadId","projectId","title",
             "modelSelection","runtimeMode","branch","worktreePath","createdAt"]
```

`mapHarness` omits `modelSelection` when no `--model` is given, and that is
correct for `thread.turn.start`, which does **not** require one. It is wrong for
`thread.create`. A harness-only spawn would have been refused by the server in a
way the caller could not read as "you forgot the model" — and neither the unit
tests (a permissive fake dispatcher) nor the live evidence (always supplies a
model) could see it.

**Fixed:** `DriverThread.create` resolves `model ?? defaultModel` and throws
`ModelSelectionRequiredError` before dispatching anything.

**The test gap is the more useful half of this finding**, so it got the stronger
fix: the new test shape-checks the outbound payload against the vendored
contract's own **input** schema via `checkPayload(method, 'input', payload)`. That
is where an omission like this is caught by construction rather than by someone
noticing.

### 3. A torn tail was recognised but never removed — codex, blocking

Real, and worse than the finding says. Skipping the partial line on read while
appending after it means the next record is glued onto it, producing a corrupt
line in the **middle** of the file. From then on every read throws
`JournalCorruptError` and recovery is dead permanently — one crash after the crash
the journal exists to survive.

**Fixed:** `#truncateTornTail` runs before every append, and `repairTornTail()`
returns what it discarded so a recovering caller can report the repair rather than
find the file already quietly fixed. Two tests: an append after a torn tail leaves
a readable journal with both records, and the repair reports its contents once.

### 4. Scenario C did not exercise `ResumingSubscription` — codex, blocking

Accepted. Closing one raw stream and opening another with `afterSequence` proves
the **server** replays. The exit condition is about `packages/t3-client`
resubscribing at its own applied cursor.

**Fixed:** scenario C now drives the real `ResumingSubscription`, kills its live
socket mid-stream at the sequence the subscription itself last applied, lets it
resubscribe on its own, and compares the eventIds it applied against the control
connection's record. Result: 2 attempts, the second `resumed: true` with
`kind: 'replayed'` (not a gap), 8 eventIds matching exactly.

### 5. The retired-harness assertion was not load-bearing — both lanes

Correct: it compared the real registry to the literal `['gemini']`, so the
duplicated copy and the registry were never compared to each other. Now
`RETIRED_HARNESS_NAMES` is compared to `Object.keys(RETIRED_HARNESSES)`, and a
mutation adding a name to the copy turns it red.

The related caveat one lane raised — that the model-accepting set currently
coincides with `Object.keys(BUILTIN_HARNESSES)`, so the assertion cannot tell
"accepts a model" from "is a builtin" — is accurate and left as is. Both facts are
asserted separately; the day a builtin appears without a model hook, the first
assertion is the one that goes red, and it is computed from the live predicate
rather than from a list.

### 6. `runTurn` doubled the caller's budget — claude, minor

Two `#withTimeout` calls each held the full `timeoutMs`, so 60 s could take 120 s.
One deadline now spans the turn. The test that proves it needed a sharper margin
than the one I first wrote — with the running signal arriving at 250 ms the two
behaviours were 650 ms and 400 ms against a 700 ms bound, which does not
discriminate. It arrives at 350 ms now and the bound is 600 ms.

### 7. The plan box — both lanes

Line 630 checked.

## Disclosed, because no lane saw it

`dispatchCommand`'s catch branch: both lanes flagged the comment as explaining a
hazard the code could not have had, and one noted that the real consequence — a
transport failure is journalled `failed` and never recovered — was not stated.

**That code had already changed when the reviews landed.** Re-reading the file
while the lanes were running, I split the two cases: a **refusal** (`name ===
'RpcFailureError'` — the server answered no) is journalled `failed`, and an
**unanswered** command (dead socket, timeout, protocol error, anything
unrecognised) stays **pending** so recovery re-dispatches it under the same
`commandId`. Safe by construction, because t3code keys a receipt on `commandId`
and returns the original result rather than applying twice
(`OrchestrationEngine.ts:142-169`).

So the finding is fixed and then some — but the fix went in **during** the review
round, which means no lane has reviewed it. That is the same gap the architect
flagged for Phase 2's force-advance, and disclosing it is the point of this
section. The diff is ~20 lines in `commands.ts` plus two tests; both are
mutation-checked.

## Evidence

- `npm test`: 6,362 passed, 48 skipped, 0 failed.
- `codev/research/146-phase3-mutation-check.py`: 29 properties, all red without
  their fix, tree verified clean afterwards.
- `codev/research/146-phase3-live-evidence.json`: regenerated from a clean tree
  at the fixed commit.
