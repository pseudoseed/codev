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

## RETRACTED — the lane was right and my dispute was wrong

**This section originally disputed the lane's finding. The dispute was wrong. It is
kept here rather than deleted, because a rebuttal that quietly disappears teaches
nobody anything.**

What I wrote: that `porch status 146` reports phase_4 current, so the lane had read
a file instead of asking the tool that owns the state.

What is actually true: **there are two `status.yaml` files for project 146.**

```
.builders/spir-146/.builders/task-gBv6/codev/projects/146-.../status.yaml
   current_plan_phase: phase_4   iteration: 2   phase_3 complete, phase_4 in_progress

.builders/spir-146/codev/projects/146-.../status.yaml
   current_plan_phase: phase_3   iteration: 3   phase_3 in_progress, phase_4 pending
```

The second is the real one. The first lives inside a **nested builder worktree**
that should not exist, and porch — run from this worktree — resolves the project
through it. So every `porch done` and `porch next` since that worktree appeared has
been mutating the nested copy, including phase 3's force-advance into phase 4.

My `porch status` and the architect's printed different phases against what looked
like one file, and both were honest reads. Only one of us checked whether a second
file existed.

**The error in reasoning, which is the part worth keeping.** The lane reported a
*state discrepancy*. I answered about *which tool it had used*, and asserted the
tool that owns the state agreed with me — without ever checking whether there was
more than one file for that tool to own. That is this phase's own rule, broken in
an argument about the phase: **applying a fix where the bug was reported is not the
same as applying it where the reason holds.** I broke it twice in one phase, once in
`queue.ts` and once here.

It also inverts the rule I reached for. "Verify against the tool, not the file" is
sound advice and it was the wrong instrument: the tool reads the file, so when they
disagree the answer is never "trust the tool", it is **"find out why there are two
answers"**. A disagreement between two honest readers is evidence about the world,
not a scoring problem between the readers.

The protocol state is being reconciled through porch's own commands under the
architect's direction. Nothing here is hand-edited.

## Evidence

- **24 tests** in `packages/codev/src/__tests__/spec-146-delivery.test.ts`, all
  passing; `tsc --noEmit` clean.
- Live: all five delivery properties re-demonstrated against a real pinned t3code
  server after these fixes, from a clean tree, with the evidence regenerated at the
  fix commit.
- The two lanes' blocking findings are covered by tests that fail without their
  fixes, not by inspection.
