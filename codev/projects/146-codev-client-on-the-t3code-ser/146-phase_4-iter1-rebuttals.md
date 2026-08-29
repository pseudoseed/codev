# Spec 146, Phase 4, iteration 1 — responses to the review

Both lanes returned **REQUEST_CHANGES**. **Every finding is accepted and fixed.**
One observation is disputed, and it is about porch state rather than about the code.

Both lanes found the blocking defect **independently**, which is the useful signal:
it was not that the second copy of the payload was wrong, it is that a second copy
existed at all.

## Accepted and fixed

### 1. The queue journalled a command the server has no branch for — BOTH LANES, blocking

`queue.ts` wrote its recovery intent as `thread.message.send` with the obsolete
body. When the command type was corrected earlier in this phase, only the
**dispatch** path was fixed. Nothing failed at the time, because the journal is
porch's own file and takes any object — so the damage sat exactly one crash away:
`recoverPendingCommands` would replay a payload no branch of `dispatchCommandInput`
accepts, and the queued messages recovery exists to save would be precisely the ones
lost. One lane reproduced it against `dist` and got `checkPayload` → `failed`.

**This is my own recorded rule, broken one phase after I wrote it down:** *applying
a fix where the bug was reported is not the same as applying it where the reason
holds.* `MESSAGE_METHOD` had two writers and I corrected one.

**Fixed structurally, not by editing the second copy.** `buildMessageCommand()` in
`deliver.ts` is now the only place the payload shape is written, and both
`sendMessage` and `ThreadMessageQueue.send`'s `recordIntent` call it. A third copy
cannot drift because there is nowhere to put one.

**And the test that could not have caught it now can.** The recovery test asserted
only `message.text`. It now also asserts the replayed `type` is `thread.turn.start`
and that `checkPayload(DISPATCH_METHOD, 'input', payload).status` is `'ok'` — the
assertion one lane specified exactly.

### 2. Scheduled delivery bypassed the queue — codex, blocking

`ScheduledDelivery.#fire` called `sendMessage` directly, so a message coming due
during an active turn would be interleaved into that turn. That breaks the single
property this phase exists to establish, and **no scheduled test would have noticed,
because they all drive the store with no thread at all.**

The finding is sharper than it first looks: a due time has no relationship to what
the thread is doing, so "due during an active turn" is not an edge case, it is the
expected case for any long-lived schedule.

**Fixed:** `ScheduledDelivery` takes a `send` function, and production wiring passes
the thread's queue. The default stays a direct dispatch because the store is usable
without a thread, and the doc comment says plainly that a caller wiring this to a
real builder and leaving the default has opted out of queue-until-settle.

**Test:** a message due while `isTurnActive` is true reaches the transport zero
times, sits at `queue.depth === 1`, and arrives after the turn settles.

### 3. A failed timer fire went dormant until restart — codex, blocking

Also correct, and it is the same silent-loss failure this store exists to prevent,
arrived at from the other side. `#arm` deletes the timer before firing, so a failed
fire left the row pending with **nothing armed**: "the next `start()` or `fireDue()`
picks it up" meant a restart or an external caller, and an `afx send --delay` whose
one attempt failed would sit dormant in a healthy long-lived process forever.

**Fixed:** a failed fire re-arms on a fixed 30 s retry delay — fixed rather than
immediate, so a server that is down does not become a hot loop. Still at-least-once:
the derived `commandId` collapses a later success with any attempt that did land.

### 4. `send()` could hang when `awaitSettle` is absent — claude, non-blocking

Real, and it is a hang rather than a wrong value. With no settle signal and no turn
active at send time, the caller awaits the server's answer; an earlier message in
the same drain pass dispatches first, **starts a turn**, and the drain stops with
this one still queued. Nothing resolves it, and the caller cannot know to call
`flush()` because it is blocked.

**Fixed:** `send` lets the current drain pass finish and then reports what is
actually true. Still queued means `queued-by-porch` — the weaker claim, and the
honest one.

### 5. Unbounded growth — claude, non-blocking

Accepted as a real limit and **not fixed in this phase**, deliberately.
`#accepted` and the `journalHasDispatched` scan grow with a long-lived queue, and
`ScheduleStore` never compacts. All three are bounded by a process lifetime and a
phase's worth of messages today; none is reachable by the acceptance criteria. Doing
compaction properly means a rewrite policy for two append-only files, which is its
own change with its own crash semantics, and slipping it into a phase whose subject
is delivery ordering would be the worse call. Recorded here so it is a known
deferral rather than an oversight.

## Disputed

### `status.yaml` says phase_3 while phase_4 is being reviewed — false positive

One lane flagged this as a porch state inconsistency needing architect
reconciliation. It is not one. `porch status 146` reports `CURRENT: phase_4 -
Message delivery semantics`, with phase_3 marked complete. Porch advanced normally
when phase_3 closed by force-advance.

The lane read a file rather than asking the tool, and `status.yaml` is written by
porch at its own moments. Worth noting only because it is the same shape as a
finding I would otherwise want a reviewer to make: **verify against the tool that
owns the state, not the file it happens to write.**

## Evidence

- **24 tests** in `packages/codev/src/__tests__/spec-146-delivery.test.ts`, all
  passing; `tsc --noEmit` clean.
- Live: all five delivery properties re-demonstrated against a real pinned t3code
  server after these fixes, from a clean tree, with the evidence regenerated at the
  fix commit.
- The two lanes' blocking findings are covered by tests that fail without their
  fixes, not by inspection.
