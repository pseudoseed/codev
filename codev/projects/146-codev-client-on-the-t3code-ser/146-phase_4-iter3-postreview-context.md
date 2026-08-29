# Phase 4, iteration 3 — post-hoc review of a diff no lane has seen

**Read this scope note first. It is narrow on purpose.**

Phase 4 closed by **force-advance**: iteration 3 returned codex `REQUEST_CHANGES` and
claude `REQUEST_CHANGES`, porch's ceiling tripped, and the fixes made in response to
that round went in **without any further review**. The architect asked for this
review rather than carrying an unreviewed diff into phase 5.

So: phase 4 as a whole has already been reviewed three times and is closed. **Do not
re-review it.** Review the diff below.

## The exact scope

```
git diff cf4dd980d~1..230b339c6 -- packages/porch-driver/src/queue.ts \
    packages/porch-driver/src/scheduled.ts \
    packages/codev/src/__tests__/spec-146-delivery.test.ts \
    codev/experiments/146-phase4-live/run.mjs
```

Three commits: `cf4dd980d`, `d65d2603b`, `3564a8c4a`.

## What changed, and what each change was answering

### 1. `queue.ts` — `#pendingTurn` and a bounded wait

**The defect (codex, iteration 3):** `isTurnActive` is a **projection** fed by the
event subscription. Between the server accepting a `thread.turn.start` and the
subscription projecting that turn as active, the flag still reads false — and the
drain loops straight into that window, dispatching the next queued message into the
turn it just started. Polling `isTurnActive` inside `awaitSettle` does not help; it
reads the same stale projection and returns instantly.

**First attempt, wrong:** awaiting the expectation at the end of the drain's loop
body. That guards only the case where more items remain *in that pass*, and each
`send` schedules its **own** pass, so the race is between passes.

**Second attempt:** the queue holds `#pendingTurn`, the turn it started and has not
seen finish, and consults it before any projection.

**Which broke the live path**, and this is the part most worth your attention.
`TurnTracker.expectTurn(...).settled` resolves only after the turn is seen RUNNING —
a correct latch, since a null `activeTurnId` without a prior running is the
thread-creation event. For these **message-started** turns it never resolved, so
every message waited out the bound and live scenario 2 hung at 300 s, twice. Thirty
unit tests stayed green throughout, because a fake expectation always resolves.

**So the wait is bounded**, and the harness is **not** wired to `expectTurn`.

**Questions I actually want answered:**

- Is the bound a fudge that hides a defect, or the right shape for a liveness
  dependency on an external signal? Argue it either way, but argue it.
- `#pendingTurn` is held across drain passes and cleared with an identity check
  (`if (this.#pendingTurn === pending)`). Is there an interleaving where that check
  is wrong, or where the field leaks and stalls a later drain?
- The fallback after the bound is the older `isTurnActive`/`awaitSettle` guard. Is
  "order is never at risk, only non-interleaving" actually true?

### 2. `queue.ts` — the duplicate-key path (claude, iteration 3)

`send` returned `await existing`, which only resolves when the drain dispatches. The
**first** send of a key returned `queued-by-porch` immediately; the **second** blocked
for the whole turn, and forever with no `awaitSettle`. Now: if the item is still
queued, return `queued-by-porch` at the **original** position and `queuedAt`.

Is reusing the original position right, or should a duplicate report something else?
Is there a window where the item leaves the queue between the `#accepted` lookup and
the `#queue.find`, and does the fallthrough handle it correctly?

### 3. `queue.ts` — `onDrainError` (claude, iteration 3, non-blocking)

A caller holding `queued-by-porch` has already returned, so a later drain failure
reached nobody: recovery-on-restart was the only signal. The hook is wrapped so a
throwing notifier cannot take the drain down.

### 4. `scheduled.ts` — `#truncateTornTail` (claude, iteration 3, non-blocking)

Opened with `'w'`, which **emptied the file** and rewrote every surviving record — so
a crash in that window lost every pending scheduled message, in the function whose
premise is fsync discipline, reached only because an earlier crash left a torn tail.
Now `ftruncateSync` at a **byte** offset (`Buffer.byteLength`, not string length).

Is `r+` + `ftruncateSync` + `fsyncSync` sufficient here, or does the durability claim
also need an fsync of the containing **directory**?

### 5. `run.mjs` — the harness

`expectTurn` deliberately **not** wired, with the reason recorded in place.
`treeDirty()` widened to include the harness directory, because it previously scoped
only to `packages/porch-driver` and `packages/t3-client` and so could record
`clientTreeDirty: false` for a run whose measuring instrument was uncommitted.

## What I claim, so you can check it rather than take it

- **31 tests** pass; `tsc --noEmit` clean on `packages/porch-driver`.
- **Every test added in this diff was run against a deliberately mutated source and
  seen to fail**, then the mutation reverted and the suite re-run green. The
  interleave test reports `['b','c']` landing inside a running turn; the duplicate
  test reports `HUNG` rather than timing the suite out; the unresolved-turn test
  times out; the drain-failure test sees no notification; the torn-tail test loses a
  multi-byte record.
- One test in this diff **passed against both implementations** in an earlier draft
  and was rewritten. The torn-tail test does **not** demonstrate the crash window —
  the write never yields, so the window is unobservable in-process — and says so
  rather than implying coverage it does not have. **Check whether I have made that
  mistake anywhere else in this diff.**
- Live: five of five demonstrated at `3564a8c4a` from a clean tree.

## Known and deliberately not fixed here

- **Why `expectTurn().settled` never resolves for message-started turns is not
  diagnosed.** It is under separate investigation. The evidence document records the
  projection race as closed in the unit-tested path and **not** demonstrated live.
  Please do not report the revert as though the race were fixed, and do not report it
  as though it were ignored.
- Unbounded growth of `#accepted`, the `journalHasDispatched` scan, and
  `ScheduleStore` compaction — deferred since iteration 1, unchallenged by both lanes
  in iterations 2 and 3.
