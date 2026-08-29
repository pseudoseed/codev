# Phase 4, iteration 3 — post-force-advance review, and what it changed

The iteration-3 diff was **unreviewed by construction**: force-advance means the fixes
answering the final round went in without a further review. The architect asked for it
to be reviewed rather than carried into phase 5. It now has two verdicts.

| Lane | Verdict | Findings |
|---|---|---|
| claude | APPROVE | 4, all real, all fixed in `1e2a215a6` |
| opencode | APPROVE | `KEY_ISSUES: None` |
| codex | — | **quota-exhausted, no review** |

**The lane count is stated rather than rounded up.** Codex hit its usage limit and
**exited 0 having written no output file** — a silent failure whose shape reads
exactly like "reviewed, no findings". I substituted opencode, whose first run also
returned no verdict; that run was **re-run, not counted**. The architect notes this is
the same silent-failure shape as issues #149 and #150.

## claude's findings, all fixed

### 1. The harness still carried the retracted cause

`ed5bd25e7` corrected `queue.ts` and the evidence document but not
`146-phase4-live/run.mjs`, which was the last copy of "never resolved / not
diagnosed" — **in the file a Phase 14 implementer opens to see how this was wired.**

A correction that lands in two of three places is how a wrong explanation survives.
This is the same rule that has now bitten this phase four times: *applying a fix where
the bug was reported is not the same as applying it where the reason holds.* It
applies to retractions as much as to code.

### 2. The class header overstated its own invariant

It claimed every message goes through the same FIFO **always**, while `send`'s
`journalHasDispatched` branch dispatches outside the drain chain. It cannot reorder
anything observable — the branch fires only for a `commandId` the server collapses —
but an unstated exception to an absolute claim teaches a later reader to distrust the
whole comment. The exception is now stated.

### 3. A leaked timer

The bounded wait left one unref'd 30 s timer per waited drain pass. Cleared in a
`finally`.

### 4. Directory fsync — recorded, deliberately not fixed

`ScheduleStore` and `DispatchJournal` both fsync the file they wrote, but
`openSync(path, 'a')` **creates** the file on the first append, and a create needs an
fsync of the containing **directory**. A crash right after the very first
`schedule()` can leave no file at all.

Not fixed here: it is one write per store lifetime, the identical pattern is in Phase
3's `commands.ts`, and it should be fixed in both places at once. Recorded in the
evidence document's limits and filed by the architect as **issue #158**.

## What opencode contributed that a rubber stamp would not have

It **argued** the two judgement calls rather than accepting them:

- **The bound is degrade-on-timeout, not a hidden sleep.** Projection lag is
  milliseconds; 30 s is orders of magnitude above that race and below a hung drain.
  It does hide the stall for anyone who wires `expectTurn` in production — nobody
  does, and the harness records why.
- **The `#pendingTurn` identity check is defensive, not load-bearing.** The drain is
  one promise chain and nothing else writes the field, so `this.#pendingTurn ===
  pending` is always true when reached. Correct, and worth knowing it is belt-and-
  braces rather than load-bearing.

It also **confirmed the limits I had claimed against my own work**, which is the
useful direction for a reviewer to agree in:

- the multi-byte assertion would still pass a `'w'` rewrite — so the torn-tail test
  does not cover the crash window, as stated;
- the dead-signal test claims liveness, not non-interleaving;
- the interleave test only closes the race when `expectTurn` actually resolves.

And it was explicit that **it did not re-run the 31 tests or the live 5/5**, so those
counts remain my claim rather than an independently verified one. Recorded because a
reviewer's silence about what it did not check is how an unverified number acquires a
second signature.

## Both lanes agree on the state of the race

Non-interleaving is **not** demonstrated live. Unwiring `expectTurn` is not a fix and
is not an omission; it is the honest position given the displacement defect. The
architect has recorded the race as **open, not fixed**, in **issue #157**, blocking
phase 14: whoever wires the queue to production resolves it first.
