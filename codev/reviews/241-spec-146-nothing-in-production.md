# PIR Review: The production thread subscriber

Fixes #241

## Summary

`TurnTracker` resolves a turn's `running` and `settled` promises from observed
`thread.session-set` events and from nothing else, and nothing in production ever fed it —
`DriverThread.observe` and `ResumingSubscription` had no caller outside `__tests__/`. So every
thread-backed turn read permanently active, `DriverThread.runTurn` never returned, and #238's
`SessionStartFailedError` could not be raised at all. This adds the missing subscriber: a
`ThreadSubscriptionPool` holding one `ResumingSubscription` per adopted thread, owned by Tower
alongside the engine and keyed the same way, with the cursor on disk so a restart resumes rather
than resubscribes cold; plus a `ThreadAdoptionSweeper` so threads are adopted after a restart
instead of only when somebody messages them.

## Files Changed

- `packages/codev/src/agent-farm/thread-subscriptions.ts` (+610 / -0) — new
- `packages/codev/src/agent-farm/__tests__/spec-241-thread-subscriptions.test.ts` (+565 / -0) — new
- `packages/codev/src/agent-farm/__tests__/spec-241-live-settle.test.ts` (+259 / -0) — new
- `packages/codev/src/agent-farm/__tests__/spec-241-thread-adoption-sweeper.test.ts` (+224 / -0) — new
- `packages/codev/src/agent-farm/__tests__/spec-241-subscriber-is-wired.test.ts` (+94 / -0) — new
- `packages/codev/src/agent-farm/porch-thread-engine.ts` (+112 / -0)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+97 / -0)
- `packages/codev/src/agent-farm/thread-backend.ts` (+78 / -0)
- `packages/t3-client/src/subscription.ts` (+55 / -0)
- `packages/codev/src/agent-farm/thread-runtime.ts` (+24 / -0)
- `codev/plans/241-spec-146-nothing-in-production.md` (+299 / -0)
- `codev/state/pir-241_thread.md` (+139 / -0)
- `codev/projects/241-spec-146-nothing-in-production/status.yaml` (+91 / -0)

## Commits

- `135f671b3` [PIR #241] docs: CMAP findings and what was done about them
- `a1ab36084` [PIR #241] fix: a stream that dies before synchronizing is not an attached one
- `56688ab18` [PIR #241] test: name T3_HARNESS_DIR in the live test's skip
- `fbd3430e0` [PIR #241] docs: builder thread log
- `8406bfda5` [PIR #241] test: prove a turn settles, and that production is what does it
- `aacde3aca` [PIR #241] feat: subscribe to every adopted thread so turns settle
- `fd958f6a1` [PIR #241] Plan draft

## Test Results

- `pnpm build`: ✓ pass (38.5s under porch)
- `pnpm test`: ✓ pass — **7184 passed**, 54 skipped, 0 failed (361.5s under porch); 37 new
  across four `spec-241-*` files (36 pass, 1 live test skipped without `T3_LIVE`)
- **Live verification** at the `dev-approval` gate, run by the architect against the pinned
  t3code server: **2 passed, 12.4s**. The harness cold-started its own server, paired, drove a
  real turn, and `record.activeTurnId` returned to null on its own. That is the first turn to
  settle through production code on spec 146.

Two things the architect verified in the source rather than taking from the report: `create()`
awaits `subscriptions.ensure()` before the first `beginTurn`, and `CursorUnreadableError`
propagates rather than degrading to a cold start, with the absent-vs-damaged distinction spelled
out.

## Architecture Updates

**COLD only** — `codev/resources/arch.md`, two new subsections under *Agent Farm Internals*:

- **Thread-Backed Agents (t3code)** — where each piece lives across `t3-client`,
  `porch-driver` and `agent-farm`; that everything is keyed by canonical workspace root in
  Tower's process; that one socket carries three views (dispatcher, streamer, subscriber) because
  a second connection would spend a one-time bootstrap token; that turn lifetime is observed and
  never inferred from session status; who feeds `observe`; and why only a *cold first*
  subscription can lose history, which is what makes the `create`/`startTurn` vs `attach`
  ordering non-obvious.
- **Verified-Wrong Assumptions: t3code subscriptions** — three system-shape surprises, routed
  here rather than to lessons-learned because they are properties of this system, not general
  patterns: a `gap` from `onResume` means one of two different things; `transport.close()` runs
  on every attempt rather than at stop; a registered engine does not imply a live subscription.

**Nothing promoted to HOT.** `arch-critical.md` is at its 10-fact cap and the hot tier is for
facts that should change a decision on *unrelated* work. This one only matters to someone
touching the thread path, so promoting it would have cost a displacement without earning one.
Recorded as a decision rather than an omission — the thread path is busy right now (#227, #240,
phase 14), and "currently busy" is not the same as "durably cross-cutting."

Both new sections are `###` under an existing `##`, so the hot file's top-level map needs no
change. `CLAUDE.md` / `AGENTS.md` reference the hot files by `@` include rather than inlining
them, so no regeneration was needed and the two remain byte-identical.

## Lessons Learned Updates

**HOT** — `codev/resources/lessons-critical.md`, one addition at the cap, funded by folding
rather than by demotion:

> A test that constructs the collaborator itself proves the collaborator works, never that
> production constructs it — assert the wiring against the production source too.

This earns the hot slot because it is the reason a whole spec's worth of correct, well-tested
work shipped unreachable. The two adjacent "when stuck" lessons were near-duplicates and were
folded into one line, so the file stays at 10 entries and 30 lines with nothing demoted — which
is a better outcome than displacement and is the fold the skill's own discipline calls for.

**COLD** — `codev/resources/lessons-learned.md`:

- *Testing* — the long form of the hot lesson, with the concrete failure (spec 146's driver,
  tracker and subscription were each correct and separately tested while no production path
  opened a subscription), and its corollary: when a component is only reachable through a
  factory, test the factory's **call site**, not just the factory.
- *Debugging* — two failure modes that arrive as the same value need a flag, not a heuristic.
  Both review lanes independently proposed keying on `outcome.kind`, which is wrong in whichever
  direction you choose it; the fix was to make the producer say which it meant. When two
  reviewers converge on the same wrong fix, the thing that is wrong is usually the value, not the
  check.
- *Debugging* — a review lane that skipped is not a verdict and must never be counted as one.

## What This Does NOT Do

**`afx spawn` still does not FAIL on a session refusal.** Raised by the opencode lane, verified,
and worth stating precisely because the issue's framing invites the opposite reading.

`SessionStartFailedError` now fires — the subscription feeds `TurnTracker.observe`, which is
what it was missing. But `track()` follows `started.running` rather than awaiting it, by design:
its caller asked to start a turn, not to wait for one. Its rejection handler was `() => {}`, so
the refusal fired into nothing and stayed invisible. That handler now **logs** the error with
the server's own sentence, which is as far as `track` can honestly go.

Failing the spawn would mean some caller awaiting `running`, and none does today. So the chain
is: raised (this PR), visible (this PR), *acted on* — not yet. The plan's manual step 4 said the
spawn would "report `SessionStartFailedError` in seconds"; what it actually does is log it in
seconds while the spawn succeeds. Corrected here rather than left standing.

## Things to Look At During PR Review

**The `synchronized` flag on `onResume`, in `packages/t3-client`.** This is the one change
outside `agent-farm`, and it is the fix for the only bug the CMAP round found that mattered.
`ResumingSubscription` reports `kind: 'gap'` from two places that mean opposite things — the
synchronized path (server declined the cursor; the subscription is up, reconcile) and the
`finally` (the attempt died before catch-up; it never came up). The pool counted the second as
attachment, so `ensure()` resolved and a turn could dispatch into precisely the snapshot race
this PR closes. Worth checking that the flag is set in both places and that no other caller of
`onResume` was missed.

**`SubscriptionTransport.client` narrowed from `T3Client` to `SubscriptionClient`.** Structural,
so no existing caller changes, but it is a published package's exported type.

**The ordering rules in `porch-thread-engine.ts`.** `create` and `startTurn` await; `attach`
does not. The asymmetry is deliberate and the reasoning is subtle: only a cold first subscription
can lose history into the server's snapshot, because every resubscription after it sends
`afterSequence` and replays. If that reasoning is wrong, the `attach` path is wrong.

**The 30s attach budget.** It doubles the mailbox drain loop's worst case, to 30s + 30s, and an
earlier comment claimed otherwise. Both bounds are `T3Client.requestTimeoutMs` on one socket and
are only reached when the server has stopped answering — but it is a real change to a path whose
own comments warn against new awaits.

**Two subscriptions per watched thread.** `T3codeSessionCache` keeps its own display stream.
Deliberate, explained in the module header, and tracked as #251 — including that the cost was
never measured.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-241` → **Review Diff**
- **Unit**: from `packages/codev`, `pnpm exec vitest run src/agent-farm/__tests__/spec-241-*`
- **Live** (the only proof a real server emits these events in this order):

  ```
  T3_LIVE=1 T3_NODE=<node> T3_HARNESS_DIR=<main checkout>/tools/t3-server/.runtime \
    pnpm exec vitest run src/agent-farm/__tests__/spec-241-live-settle.test.ts
  ```

  `T3_HARNESS_DIR` is not optional from a builder worktree.
  `tools/t3-server/t3-server.mjs:39` resolves the runtime directory relative to **its own
  script**, and every worktree carries a copy — so from `.builders/<id>/` the harness looks in
  that worktree's empty `.runtime` while a server started from the main checkout is still
  answering on 3799, and reports `printed no pairing token`. That reads as "the server is broken"
  and means "I looked somewhere else." The test now checks this up front and skips with
  `NO_HARNESS_RUNTIME` naming the variable.

## Consultation

### Porch's review-phase pass (2-way)

**claude: APPROVE** (HIGH). Five findings, none blocking. Three were fixed here — two comments
that still claimed `attach` awaits the subscription's attach budget (it calls `start`, which
returns at once), and `ensure` waiting out its full 30s budget when `run()` rejects for a NAMED
terminal reason, reporting "the stream never came up" in place of the server's own sentence that
was available immediately. The remaining two are one cause and are filed as **#259**. It also
caught a factual error in this file: the status.yaml path is `codev/projects/`, not
`codev/state/`.

**opencode: COMMENT** (HIGH), on a retry. Its first attempt exited 1 after 361s having written
nothing; that was recorded as a lane that did not review rather than as an approval, and since
the same lane had succeeded on the PR pass 17 minutes earlier it was retried as transient rather
than configuration. Two findings: that a session refusal does not fail the spawn (see *What This
Does NOT Do* above — the swallowing handler is fixed, the claim is corrected), and that `attach`
uses `start` rather than awaiting `ensure`, which is the deliberate design documented above.

### The earlier advisory CMAP pass at the PR

One advisory CMAP pass, **three real verdicts**: codex `REQUEST_CHANGES`, claude `COMMENT`,
opencode (`xai/grok-4.6`) `COMMENT`. The gemini lane **skipped** — `agy` exited 1 on quota,
which is `LANE_DID_NOT_REVIEW` and not an approval, so it is not counted as one of the three;
opencode took the slot.

Findings and what was done are in the PR body and in `codev/state/pir-241_thread.md`. All were
fixed in `a1ab36084`; the suite was green afterwards.

## Follow-ups

- **#259** — Tower's pool never prunes. `subscriptions.stop` is reachable only through
  `removeWorktree` → `cleanup.ts`, which runs in the **afx CLI process**; Tower's own paths hold
  only `stopAll` on socket close. So a thread that leaves `global.db` keeps its subscription
  until Tower restarts, and a stale `thread_id` is re-adopted and WARNs every 5s forever.
  `T3codeSessionCache` reconciles both directions; `ThreadAdoptionSweeper` reconciles one.
  Raised by the claude lane, grounded by reading the call sites, and filed rather than folded in
  so this PR does not grow on the critical path.
- **#251** — fold `T3codeSessionCache`'s display subscription onto this one. Its `watching` /
  `stale` vocabulary is built on a stream that ends, and a `ResumingSubscription` never does, so
  it is a rewrite of that vocabulary plus its tests rather than a wiring change.
- **Not measured**: whether two streams per watched thread costs anything observable on a real
  server. #251 says so rather than leaving it implied.
- `isReady: requestThreadBackend(...)` in the sweeper has a side effect — it starts background
  connects, so Tower now attempts one per configured workspace every 5s with no mail pending.
  Bounded by the negative-config cache and the 60s cooldown, and it is what adoption needs.
  Raised by the claude lane as non-blocking; recorded here rather than actioned.
