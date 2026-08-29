# Spec 146 — message delivery semantics, and what they gate

**Success criterion 12b.** The spec makes the mailbox's deletion (criterion 13)
conditional on five properties. If any of them fails, the mailbox stays and the
deletion phase is not attempted — that is the spec's stated behaviour, not a
defect. This document is the record a reviewer can check.

Machine-readable results: `codev/research/146-phase4-live-evidence.json`, written
by `codev/experiments/146-phase4-live/run.mjs` against a real pinned t3code server.
Unit tests: `packages/codev/src/__tests__/spec-146-delivery.test.ts`.

---

## The five properties

| # | Property | Where it is demonstrated |
|---|---|---|
| 1 | Messages to one builder are delivered in the order sent | live scenario 1, checked against the **server's** event log |
| 2 | A message sent during an active turn is queued and delivered on settle, never dropped, never interleaved | live scenario 2 |
| 3 | Every send returns an acknowledgement meaning the server accepted it durably, and does not claim the agent read it | live scenario 3 + the receipt types |
| 4 | Commands carry caller-generated idempotency keys; a retry after an ambiguous failure delivers once | live scenario 4 |
| 5 | With the server unreachable, a send fails loudly at the call site and does not silently queue | live scenario 5 |

Ordering is driven with **concurrent** sends, not a sequential loop. A sequential
loop passes against a queue with no ordering guarantee at all, because nothing ever
races. And the assertion reads the server's own event log rather than the client's
idea of what it sent — a client-side list passes against a queue that reordered on
the wire.

---

## RULING: a message to a builder IS a turn

Decided by the architect, recorded here so nobody re-derives it.

There is no `thread.message.send` in t3code's command union. There is no
`thread.message.*` at all. The way user text reaches a thread is
**`thread.turn.start`**.

So on this path, sending a message to a builder starts a turn with that text, and
"queued during an active turn, delivered when it settles" means **the queued
message becomes a new turn once the current one settles**. That satisfies the
spec's words exactly — "queued and delivered when the turn settles, never dropped
and never interleaved" — and *never interleaved* is the load-bearing half. The old
mailbox could only approximate this by typing into a PTY and hoping the render gate
had classified the prompt as ready, which is the failure this replaces.

### Three queued messages are three turns, not one merged turn

Also ruled, because the cheaper option is available and wrong. Merging queued
messages into a single turn silently rewrites what the sender said: two
instructions concatenated are not the same as two instructions given in order.
Sequential turns also preserve ordering trivially, which is criterion 8.

`ThreadMessageQueue.#drain` dispatches one message per iteration, so this is what
the implementation already does; it is written down here so it cannot be
"optimised" later by someone who reads a merge as free.

### BEHAVIOUR CHANGE — flag for release notes

**`afx send` now costs a turn.** Today it is a keystroke typed into a terminal.
After this it is a real agent turn, with real tokens and real latency. That is
user-visible and it is a cost change, not just an implementation change. Anyone
scripting `afx send` in a loop is scripting model turns.

---

## RULING: `afx inbox` is retired, not repointed

Decided by the architect. An earlier draft of `scheduled.ts` assumed the opposite
and said so in a comment; that comment has been corrected.

Every part of that command's surface exists to manage a **hold**: it lists messages
held because the render gate could not classify a screen, shows the reason each is
held, and lets a human dismiss one. On the thread path there is no hold state, no
reason code and nothing to dismiss — a send either lands or fails loudly at the
call site, and a message waiting for a turn to settle is not "held", it is queued
and it will go.

Repointing `afx inbox` at the queue or at the schedule store would give it rows to
display while removing the reason anyone ever opened it.

**Therefore:** `afx inbox` retires **with the mailbox, in Phase 14** — not before.
Until then it keeps working for PTY-backed builders, which still have a mailbox and
still have holds. It must be named in Phase 14's deletion list, and its removal is
a **release-note line**, because it is a command people type. A command that
silently stops working is worse than one that is removed.

---

## Durable scheduled delivery, and why it is in this phase

Two surviving features reach the mailbox directly, and Phase 13 deletes it:
`servers/cron-delivery.ts` imports `db/mailbox.js` and `mailbox-delivery.js`, and
`servers/delayed-send.ts` persists every `--delay` body as a mailbox row.

Deleting the mailbox without a replacement is a silent loss of `afx send --delay`
and of every cron notification — the kind of loss discovered by a user months later
as "the reminder never came". So it is built here, where it can be tested against
the properties this phase is already establishing, rather than improvised in the
deletion phase.

The requirement is deliberately narrow: a pre-due message survives a restart, fires
once at its due time, and is deduplicated by the same idempotency key. Cron's
*scheduling* stays where it is; only the durable due-time delivery moves.

**At-least-once firing, exactly-once delivery.** The store marks a row fired
**after** the dispatch, never before. A crash in that window re-fires, and the
re-fire is the same `commandId`, which the server collapses. Marking it fired first
would lose the message at exactly the point the store exists to survive — the same
ordering the sequence cursor uses, for the same reason.

---

## How idempotency works, and why there is no second store

The `commandId` is **derived** from the caller's idempotency key: a UUIDv5-shaped
digest over a fixed namespace. The same key always produces the same `commandId`,
so a retry is automatically the same command, and t3code's receipt table collapses
it (`OrchestrationEngine.ts:142-169` at the pinned commit, demonstrated live in
Phase 3's scenario E).

The obvious alternative — a durable key→commandId map — is a second persistent
store that must be kept in step with the dispatch journal. This repository's own
lesson is that a single source of truth beats distributed state. The derivation
holds no state at all, so there is nothing to reconcile and nothing to lose in a
restart.

The journal is still consulted first, so a retry porch can settle locally never
touches the network. That is an optimisation. **The server's dedup is the
guarantee.**

---

## Two defects this phase found, and how

Both are recorded because the *way* they were found is the transferable part.

### 1. The queue re-sent a failed message forever

`ThreadMessageQueue.#drain` caught a failed send, rejected the caller, and did not
remove the item from the queue. It stayed at the head of a `while` loop and was
re-sent forever — a hot spin that never drains and starves everything behind it.

The file's own comment already said what should happen: *"Loud, at the call site,
and out of the queue."* The shift was missing, so **the comment described behaviour
the code did not have.** Third instance of that failure mode in this project's
recent history, and the strongest form of the rule: documentation is untested code,
and a comment stating an invariant is a claim that nothing checks.

It presented as the test file hanging rather than failing. The existing
"rejects at the call site rather than silently queueing" test asserts `depth` is 0
and **would** have caught it — but it sits after the test the spin was starving, so
it never ran. *A test that cannot be reached is not coverage.*

### 2. The delivery layer dispatched a command that does not exist

`MESSAGE_METHOD` was `thread.message.send`. All 21 unit tests were green. Every one
of them injects a fake dispatcher that accepts any payload, so **the suite could not
have caught a command the server does not have.** The live server refused it on
sight.

This is Phase 3's lesson, unlearned one phase later. Phase 3's iteration-1 review
found `thread.create` requires `modelSelection`, invisible for exactly the same
reason, and the fix then was to shape-check the outbound payload against the
vendored contract's own input schema. That check was not carried into Phase 4.

It is now: `checkPayload(DISPATCH_METHOD, 'input', payload).status` must be `'ok'` —
**not** `not.toBe('failed')`, because the checker also answers `unchecked`, and "I
could not check this" must not pass as "this is valid".

A third, smaller one worth the line: the live harness imports
`packages/porch-driver/dist`, so the first two live runs after the fix were testing
**stale compiled code** and reproduced the original failure. `pnpm --filter
@cluesmith/porch-driver build` is part of running the harness, not a separate
chore.

---

## Limits — what this evidence does NOT establish

- **No scenario claims the agent read anything.** Criterion 12b is about the server
  accepting durably. The receipt type is named `AcceptedByServer` so the stronger
  claim cannot be made by accident, and there is deliberately no type called
  `Delivered` in the module.
- The scenarios run against **one thread on one freshly created server**. They do
  not measure concurrency across threads, multi-day retention, or behaviour under a
  server restart mid-scenario.
- Scheduled delivery's restart property is demonstrated by reconstructing the store
  over the same file with an injected clock, not by killing and restarting a real
  process. Phase 3 used real `SIGKILL`s for its crash windows; this is weaker, and
  it is named here rather than left to be assumed.
- **The projection race is closed in the unit-tested path and NOT demonstrated
  live.** `isTurnActive` is fed by the event subscription, so between the server
  accepting a `thread.turn.start` and the subscription projecting it, the flag still
  reads false — and a drain that trusts it dispatches the next queued message into
  the turn it just started. The queue takes an optional `expectTurn` so it can wait
  on the turn its own dispatch began instead, and a unit test reproduces the
  interleaving without it.

  Wiring that to `TurnTracker.expectTurn` in this harness **did not work**: `settled`
  resolves only after the turn is seen RUNNING, and for these message-started turns
  it never resolved, so every message waited out the drain's bound and scenario 2
  failed twice at 300 s. **Why it never resolves is not diagnosed**, and this
  document does not imply otherwise. The harness therefore uses the settle poll that
  is demonstrated, which preserves ORDER — never at risk, the queue is FIFO and
  dispatches one at a time — while leaving NON-INTERLEAVING dependent on the
  projection being current. Scenario 2 measures zero messages reaching the server
  during the turn and has never observed an interleave, but it does not force the
  lag, so it is not evidence that the race cannot occur.

  Phase 14 wires the production path and should resolve this before relying on it.
  Recorded as an open question rather than a closed one, because a partial answer
  read as a complete one is the failure this project has a standing rule about.
