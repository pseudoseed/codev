# Spec 146, Phase 5 — ruling on the missed-watch-event hole

**Decision: option 2, with option 1 folded into it. Option 3 is rejected as proposed
and replaced with a different requirement that the plan already demands.**

Ruled by the phase 5 owner at the architect's request. `air-156` is holding on this.

## The defect, restated so the fix is judged against the right thing

`watchAgentState` can permanently miss a state change. Evidence: 8 full agent-farm
suite runs on `acdff323d`, 7 clean, 1 failure that names its own cause —
`WATCHER_NEVER_FIRED diagnostics={watchStarted:2, watchErrors:0, scheduleCalls:0,
snapshotCalls:1}`. Both watchers created, no errors, callback never fired, only the
initial snapshot. On macOS, `watch()` returning is not the FSEvents source being live;
arming is async and unobservable from Node.

**The window is guaranteed, not incidental.** `emitSnapshot()` calls
`options.snapshot()` *first* and `rebuildWatchers()` *after*
(`agent-state-stream.ts`), and the initial `emitSnapshot()` is what arms the watchers
at all. So every subscription reads its state and only then starts watching. Even
ignoring the macOS arming lag, the ordering alone opens a gap on every connect.

The consequence is this phase's own rule broken one level down: **a lost event is
spelled exactly like no event.** Nothing re-stats, nothing reconciles, and the client
never learns it missed anything.

## Why option 2

**Only option 2 closes the hole, because it is the only one that does not depend on
the watcher having worked.** That is the whole test. A fix whose correctness is
conditional on the component that failed is not a fix.

- **1 narrows the window.** It cannot close it, because "after `watch()` returned" is
  not "after FSEvents is live" and Node cannot tell you when the latter happened.
- **3 cannot see the miss at all** — see below.
- **2 is self-healing.** A change missed by the watcher is found by the next
  reconciliation pass regardless of why it was missed, including reasons nobody has
  thought of yet. That last property is what makes it the right choice: the failure
  mode here was discovered at a rate of 1 in 8, and the next one will not announce
  itself either.

### The spec language holds, and this is not a technicality

Both no-polling statements are **client-scoped**, and the words are the plan's, not
the spec's — the spec says nothing about polling at all:

- Deliverable: *"Streams porch state changes, so **the client** does not poll."*
- Acceptance: *"With porch state changing on disk, **a connected client** receives the
  change without polling."*

What that constraint is protecting is the client-to-server link — a browser on an iPad
over a tailnet must not hammer a Mac to learn nothing changed. A server re-stat'ing
local files it already has open is not that link and does not touch it. The client
still receives pushes and still polls nothing.

I am ruling this as satisfying the criterion, not as an exception to it.

## Why option 3 is rejected as proposed

**As built, sequence numbers are structurally incapable of detecting this miss.**
`AgentStateStreamEvent.sequence` is `++sequence` at each `onEvent` call — it counts
**emissions, not state versions**. A missed change produces no emission, so it
produces no gap. Client-visible gap detection over that counter can never fire on the
bug it was proposed to catch.

Making it work would mean numbering *state versions* at the producer, which means
knowing the state changed, which is the thing that failed. It is circular.

## What replaces it, and it is not optional

**A change found by reconciliation must be emitted as its own event type, distinct
from a watcher-driven snapshot.** Not because gap detection is salvageable, but
because the plan already requires it: *"Each failure mode emits its own distinct
signal"*, and every failure-matrix row must state its signal, what the client renders,
and whether it is auto-resolved.

"The watcher missed a change and reconciliation caught it" **is** a failure mode. It
needs a matrix row. Emitted as an ordinary `PROTOCOL_STATE_SNAPSHOT`, a silent repair
becomes indistinguishable from a working watcher — which is how a 1-in-8 defect stays
invisible for another eight runs.

### The distinction that will otherwise be argued about

Someone will read the spec's *"disagreement is reported, never auto-resolved"* as
forbidding a reconciler that fixes things. It does not, and the difference is worth
stating once:

- **`status.yaml` versus thread state** is a disagreement between **two authorities**.
  Neither is a copy of the other, so resolving it means choosing a winner — a judgement
  the spec reserves for a human. Reported, never resolved.
- **The stream versus `status.yaml`** is a **cache and its source**. The file is
  authoritative and the stream is a projection of it. Repairing a projection from its
  source is not choosing a winner; leaving it stale is simply serving wrong data.

Auto-resolve the second. Never the first. The matrix should carry both rows so the
distinction is written down rather than re-derived.

## Shape of the fix

1. **Reconcile on a slow interval**, comparing cheaply — `mtime` and size per
   `status.yaml` — and re-reading and emitting only what actually changed. Not
   re-parsing every project every tick.
2. **Run one reconciliation pass immediately after arming** the watchers. This is
   option 1, and once the reconciler exists it is a function call, not new code. It
   turns the reported scenario — connect while a write is in flight — from "wait one
   interval" into "immediate", and it also fixes the snapshot-before-arm ordering.
3. **Distinct event type** for a reconciliation-sourced change, per above.
4. **The reconciler's own failures must surface.** If it cannot read the projects
   directory that is `STATUS_UNREADABLE`, not "no changes". A backstop that swallows
   its own errors reintroduces the exact bug it was added to fix, one layer up.

Interval: I suggest **5 s** as the starting value, and it should be a named constant
with the reason attached. Fast enough that a human watching a builder tree does not
perceive the lag on the rare miss; slow enough that stat'ing a handful of small files
is free. Tune with evidence, not by feel.

## Does this change what Phase 11 can assume? Yes. Four things.

Phase 11 is the client tree and live status, so it consumes exactly this guarantee.

1. **Completeness is eventual, not instantaneous.** The client's view converges within
   the reconciliation interval. Phase 11 may design for bounded staleness; it may not
   assume the view is current at every instant.
2. **"No event" does not mean "no change."** Phase 11 must never infer absence of
   change from absence of a message — that is this defect one level up, and it is the
   assumption a live-status tree most naturally makes.
3. **Apply snapshots idempotently; do not accumulate deltas.** A reconciliation
   emission can deliver a change that was never announced as a discrete event, so a
   client that folds events into local state will diverge. Snapshot-replace is the
   only safe model, and the stream already emits whole snapshots.
4. **Freshness is renderable and should be rendered.** Bounded staleness is now a
   designed property rather than an accident, so the client can show the age of what
   it is displaying. For gated builders especially, "this is what I knew 4 s ago" is a
   materially different claim from "this is true now", and the operator is entitled to
   the difference.

## What this ruling does not claim

It does not claim the macOS arming window is now closed — it is not, and it cannot be
from Node. It claims the window stops mattering, because a missed event is repaired on
a bounded schedule and the repair is visible. Those are different statements and the
failure matrix should record the second, not the first.
