# Spec 146, Phase 4, iteration 2 — responses to the review

Split verdict: **codex REQUEST_CHANGES, claude APPROVE**. Nothing is disputed.

The split is narrower than it looks. Both lanes found the **same** defect and
described it in the same terms; they disagreed only on whether it blocks. Codex is
the one I acted on, because the defect falsifies a type, and a type that lies is not
a severity judgement — it is the property this phase exists to establish, stated
wrongly in the one place a future caller will read.

## Accepted and fixed

### 1. The scheduled receipt type was lying, and a cast hid it — BOTH LANES

`ScheduledDelivery`'s injected `send` was typed `Promise<AcceptedByServer>`. The
queue wiring **its own doc comment recommends** returns `SendReceipt`, because the
queue answers `queued-by-porch` whenever a turn is active. The test bridged the gap
with `as never` (`spec-146-delivery.test.ts:687`).

So `fireDue()` could hand back a `queued-by-porch` object wearing a type that said
the server had answered. That is precisely the distinction this phase built the
union to preserve, collapsed at the one seam where a scheduled message meets an
active turn — which is not an edge case, since a due time has no relationship to
what the thread is doing.

**The cast is the finding.** A cast is the type system reporting a mismatch; writing
`as never` does not resolve the mismatch, it silences the report. This is the same
shape as the earlier defects in this phase: a double faithful to the shape of the
thing and not to its behaviour. Here the double was the type itself.

**Fixed** by widening `send`, `#fire`, `#firing` and `fireDue` to `SendReceipt`, and
deleting the cast. The queue-wiring test now asserts
`receipts[0].kind === 'queued-by-porch'` — the assertion the cast had made
unwritable. Codex's alternative, awaiting `queue.accepted(key)` before claiming
acceptance, was not taken: it would block the fire until the turn settles, which
reintroduces the hang iteration 1 fixed. Telling the truth about the receipt is the
cheaper correct answer.

### 2. `markFired`'s comment claimed the stronger guarantee — claude

The comment said `markFired` runs "AFTER the dispatch". Under the queue wiring it
runs after the **enqueue**: the row leaves `pending()` while the message is still
only in porch's queue and journal.

Nothing is lost — the queue fsyncs the intent before admitting it and
`recoverPendingCommands` replays it under the same derived `commandId` — so
durability **moved** rather than being skipped. But two wirings give two different
guarantees and the comment stated one of them as if it were both. It now says which
is which, and says the part that actually changes behaviour: the store's own retry
path no longer covers a message the queue has taken.

**A comment stating an invariant is a claim that nothing checks.** My own recorded
rule; this is its second instance in this phase.

### 3. `fireDue()` aborted the rest of the due batch — claude

It returned on the first rejection, so one unreachable thread left every later due
message **unattempted** while the caller was told the drain failed. Those messages
stay pending, so nothing is lost — but "not tried" was being spelled the same way as
"tried", which is the failure mode this project has a standing lesson about.

Fixed: every due message is attempted, and the error is rethrown afterwards, so it
still fails loudly. A single failure rethrows as itself (the existing assertion on
`'socket closed'` still holds); several become an `AggregateError`.

### 4. The timer retry had no regression test — codex

Codex's reasoning is the part worth keeping: the existing failure coverage drives
`fireDue()`, and **`fireDue()` is not the path that breaks.** It is called by a test
or an on-demand caller, either of which will call again. The path that goes dormant
is the **timer**, which removes itself before firing — so a failure there ends the
message's life in a healthy long-lived process. A test on `fireDue()` would still
pass with the re-arm deleted.

Fixed with an injected `retryDelayMs` (5 ms in the test) and a test that starts a
real timer. **Verified to fail without the fix: 1 attempt, not 2.**

The batch fix has a regression test verified the same way: without it, `k-fine` is
never attempted.

## Not disputed, and not fixed here

Claude's fourth observation — that no call site outside the tests and the live
harness passes the queue as `send` — is correct and is Phase 14's wiring, not this
phase's. It is recorded so that "production wiring passes the thread's queue" is not
carried forward as though it were already done.

The iteration-1 deferrals stand unchanged and unchallenged by either lane:
`#accepted` growth, the `journalHasDispatched` scan, and `ScheduleStore` compaction.

## Evidence

- **26 tests** in `packages/codev/src/__tests__/spec-146-delivery.test.ts`, up from
  24; `tsc --noEmit` clean on `packages/porch-driver`.
- Both new tests were run against a mutated source to confirm they fail without
  their fix, and the mutations were reverted and the suite re-run green.
- The live evidence is regenerated at the fix commit, so `clientCommit` matches the
  tree a reviewer can check out rather than the tree that existed before this round.
