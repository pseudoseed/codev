# Phase 4, iteration 1 — review context

Hand-written, because porch generates a context file only from iteration 2 onward.
It exists to put two bodies of **unreviewed code** explicitly in scope, and to hand
you the places most likely to be wrong.

---

## DISCLOSURE 1 — Phase 3's iteration-3 diff was never seen by any lane

Phase 3 closed by **force-advance**: iteration 3 returned codex `REQUEST_CHANGES`
and claude `APPROVE`, and porch's REQUEST_CHANGES ceiling tripped. The fixes made in
response to that round therefore went in without a further review.

Commit `db6f3d384`. What it changed:

- `checks.ts` — `finish()` now **spends** the pending SIGKILL escalation instead of
  cancelling it (`if (timedOut) signalGroup(child, 'SIGKILL')`). Without it, a
  descendant that ignored SIGTERM outlived the check that spawned it.
- `thread.ts` — `runTurn`'s deadline moved **above** the dispatch, which is now
  wrapped in `#withTimeout`. A hung `thread.turn.start` used to sit outside the
  caller's budget entirely.
- `turn.ts` — `TurnDisplacedError`; a displaced `expectTurn` waiter is rejected
  rather than left permanently unresolved.
- `checks.ts` — `appendCapped` carries a running byte count instead of re-encoding
  the whole buffer per chunk.
- `worktree-setup.ts` — `opencode.json` lists the role file only when it is written.
- a test assertion changed from `not.toBe('failed')` to `toBe('ok')`.

Phase 2 force-advanced too, and the architect's standing requirement is the same
both times: **disclosure plus explicit scope in the next round**, not a promise to
stop fixing.

## DISCLOSURE 2 — most of Phase 4's implementation was written by a different process

An `afx workspace start` run against this worktree instead of the main root started
a **second Claude process on the same session**, and it wrote a full Phase 4
implementation while the session you are reviewing was also running. That process
has since been stopped by the architect.

- `3d5f40382` preserves those 712 lines **with authorship stated as the duplicate
  process's, not mine.** It is a preservation commit, not a phase deliverable.
- Its message records precisely what was and was not verified about those bytes:
  `tsc` clean against them, but the 20/20 test green predated the final write by
  ~20 seconds and was **not** a receipt for what was committed. That caution turned
  out to matter — the writes in those 20 seconds introduced a hang.

I have since read all three modules and own them. **Review them as new code, not as
reviewed code**, because no lane and no human has read them before you.

---

## What I found and fixed after reading it

Three defects, in `82e379540` and `bf9eaec0e`. The through-line is the part worth
your attention:

**Every one hid behind a test double faithful to the SHAPE of the real thing and
not to its BEHAVIOUR.**

1. **`#drain` re-sent a failed message forever** — it rejected the caller without
   shifting the item off the queue, leaving it at the head of a `while` loop. The
   file's own comment already said *"Loud, at the call site, and out of the queue."*
   It presented as the test file **hanging**, and the existing `depth === 0` test
   that would have caught it sits *after* the test the spin was starving.
2. **`MESSAGE_METHOD` was `thread.message.send`, a command t3code does not have.**
   Twenty-one tests were green; every one injects a fake dispatcher that accepts any
   payload. Now `thread.turn.start` with the contract's real payload shape, and a
   `checkPayload(..., 'ok')` assertion — Phase 3's `modelSelection` lesson, re-armed.
3. **The backlog stalled at one message.** A message *is* a turn start, so the drain
   stopped on the turn its own dispatch had started. Live: exactly 5 of 10 arrived,
   in order, and 300 s of waiting never produced the rest. `QueueTarget.awaitSettle`
   fixes it.

## Architect rulings, so you do not re-litigate them

Recorded with reasoning in `codev/research/146-delivery-semantics-evidence.md`:

- A message to a builder **is** a `thread.turn.start`.
- Queued messages become **sequential turns, never one merged turn** — merging
  silently rewrites what the sender said.
- **`afx send` now costs a real turn.** User-visible; flagged for release notes.
- **`afx inbox` retires with the mailbox in Phase 14**, rather than being repointed
  at the queue or the schedule store.

## Where I would look hardest

- `queue.ts` — `awaitSettle` is new and load-bearing. Is there a case where the
  drain waits forever, or where `#accepted` leaks a key after a failure?
- `deliver.ts` — the derived `commandId`/`messageId` are the whole idempotency
  mechanism. A collision or a namespace change breaks retry-once silently.
- `scheduled.ts` — least exercised of the three. Its restart property is
  demonstrated by rebuilding the store over the same file with an injected clock,
  **not** by killing a real process, which is weaker than Phase 3's crash evidence
  and is named as a limit rather than left implied.
- The five live scenarios only ever prove the **server** accepted a message. No
  scenario claims the agent read anything, and there is deliberately no type called
  `Delivered`.

## Receipts

- 23 tests in `packages/codev/src/__tests__/spec-146-delivery.test.ts`, all passing.
- Full suite via `porch done`: build 14.2 s, tests 187.6 s, both green.
- `codev/research/146-phase4-live-evidence.json` — regenerated from a clean tree at
  `82e379540`, `clientTreeDirty: false`, **five of five scenarios demonstrated**
  against a real pinned t3code server.
