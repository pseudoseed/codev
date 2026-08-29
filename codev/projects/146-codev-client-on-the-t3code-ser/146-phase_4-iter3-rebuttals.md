# Spec 146, Phase 4, iteration 3 — responses to the review

Both lanes **REQUEST_CHANGES**, one blocking finding each, and they are different
findings. Both are real. Nothing is disputed.

## Accepted and fixed — blocking

### 1. The drain raced its own dispatch — codex

`isTurnActive` is a **projection** fed by the event subscription. Between the server
accepting our `thread.turn.start` and the subscription projecting that turn as
active, the flag still reads false — and the drain loops straight into that window,
dispatching the next queued message into the turn it just started. That is the exact
interleaving this queue exists to prevent.

Codex also identified why nothing caught it: the live test counts persisted
`thread.message-sent` events, which the server records immediately, and never asserts
an active→settled transition between commands.

**My first fix was wrong, and the new test is what caught it.** I awaited the
expectation at the end of the loop body, which only guards the case where more items
remain *in that pass*. Each `send` schedules its **own** drain pass, so the race is
between passes. The queue now holds `#pendingTurn` — the turn it started and has not
seen finish — and consults that before any projection. A fact the queue owns rather
than one it waits to be told.

**Then the fix broke the live path, and that is the part worth recording.** With
`expectTurn` wired to `TurnTracker.expectTurn`, scenario 2 hung twice at 300 s.
`settled` resolves only after the turn is seen RUNNING — a correct latch, since a
null without a prior running is the thread-creation event — and for these
message-started turns it never resolved. Thirty unit tests passed throughout,
**because a fake expectation always resolves**. The doubles were faithful to the
shape of the signal and not to the possibility of its absence: this phase's recurring
defect in its fourth costume.

Two things came out of that:

- The wait is **bounded**. The window being closed is the projection lag, which is
  milliseconds; anything past the bound is not that race, it is a signal that is not
  coming. A test supplies an `expectTurn` that never resolves and asserts the backlog
  still drains in order.
- The harness is **not** wired to `expectTurn`. **Why `settled` never resolves is not
  diagnosed.** Two hypotheses failed against a six-minute feedback loop, so rather
  than keep guessing I reverted to the settle poll that is demonstrated and wrote
  down what is unknown. The race is closed in the unit-tested path and **not**
  demonstrated live; the limit is stated in the evidence document, including that
  scenario 2 does not force the lag and so is not evidence the race cannot occur.

### 2. A duplicate idempotency key hung — claude

`send` returned `await existing`, and `existing` only resolves when the drain
dispatches. So the **first** send of a key answered immediately with
`queued-by-porch` while the **second** blocked for the whole turn — and with no
`awaitSettle`, indefinitely. Same key, same queue state, opposite behaviour, and only
one of them honest. Claude reproduced it: still pending at 300 ms.

The iteration-1 hang fix had landed at one of its two sites. **Third instance this
phase of the same rule: applying a fix where the bug was reported is not the same as
applying it where the reason holds.** I have now broken it in `queue.ts` twice.

Fixed: if the item is still queued, nothing has been dispatched and the truthful
answer is already known, so it is returned now — at the **original** position and
timestamp, because a duplicate is the same message and a new position would describe
a queue that does not exist.

## Accepted and fixed — non-blocking

### 3. The torn-tail repair could lose the whole store — claude

`#truncateTornTail` opened with `'w'`, emptying the file and rewriting every
surviving record. A crash in that window lost every pending message — in the one
function whose premise is fsync discipline, and one reached only *because* an earlier
crash left a torn tail. The recovery path was the most dangerous code in the store.

Now `ftruncateSync` at a **byte** offset, which writes none of the retained bytes.

**The test does not demonstrate the crash window, and says so.** An earlier draft
watched the file on a timer and passed against **both** implementations: the write
never yields, so the window is unobservable from JavaScript on this thread. That
draft is described in the test rather than quietly deleted. What the test does prove
is that intact records survive, including a multi-byte one that a character-count
truncation cuts in half — verified by mutating the offset.

### 4. A queued message that failed on drain reached nobody — claude

A caller holding `queued-by-porch` has already returned, so the rejection landed on
`accepted(key)`, which it never has to await. Recovery-on-restart was the only
signal, and a long-lived process never restarts. Added `onDrainError`, and a broken
notifier cannot take the drain down with it.

## Also corrected, unprompted

`treeDirty()` in the harness scoped only to `packages/porch-driver` and
`packages/t3-client`, so a run whose **harness** was uncommitted would still be
recorded `clientTreeDirty: false` — a record nobody could repeat, labelled
reproducible. The measuring instrument is now in scope.

## Evidence

- **31 tests**, up from 26. Every new test was run against a mutated source and seen
  to fail: the interleave test reports `['b','c']` landing inside a running turn; the
  duplicate test reports `HUNG` rather than timing the suite out; the unresolved-turn
  test times out; the drain-failure test sees no notification; the torn-tail test
  loses a multi-byte record.
- `tsc --noEmit` clean; live evidence regenerated at `3564a8c4a` from a clean tree,
  **five of five demonstrated**, scenario 2 in 11 s.
