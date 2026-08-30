# Spec 146 — the long-gate evidence

Phase 10's fourth deliverable, in the plan's own words: *"The 24-hour gate run is started and
its start recorded."* Starting it is this phase's work; the completed evidence is a later
phase's input. The plan's reason for putting the start here is scheduling — a day-long gate
has to be running well before the phase that consumes it begins, and there is no way to
compress it afterwards.

## What a long gate is testing

Not our clock. Theirs.

A porch gate is a human approval pause: the protocol stops, nothing is dispatched, and the
thread sits idle until someone approves. The question a long gate asks is what the **server**
does to a thread nobody has spoken to in a day — whether the session is still there, and
whether it still holds the conversation.

The pinned server answers part of that at startup, in its own log:

```
provider.session.reaper.started { inactivityThresholdMs: 1800000, sweepIntervalMs: 300000 }
```

Thirty minutes of inactivity, swept every five. So a gate shorter than 30 minutes never
crosses the reaper at all, and a fake clock moves ours rather than the reaper's. Both gates
here are elapsed for real.

The one-hour gates clear the threshold once with margin. The 24-hour gate crosses it 48
times, which is the case Phase 13 depends on and the one nothing in this program has run.

## WHICH START TO READ

**`2026-08-30T08:28:53Z`.** That is the run still going, the only one whose evidence will ever
land, and the one the phase that consumes this should read. Four earlier starts appear below,
with their reasons; none of them produced evidence and none of them should be quoted.

The restarts were free for Phase 10, whose deliverable is a *recorded start*. They are not free
for the phase that needs the elapsed result, which is why this one is left alone: **it is not
restarted again, including for tidiness after the PR merges.**

## This run lives somewhere it should not

The process, the server on 3805 and the evidence path are all inside `.builders/air-235/`, and
the normal completion path for a builder worktree is `afx cleanup`, which removes it. Today
cleanup refuses on this worktree only because porch's post-merge state commits are stranded on the
branch (#233) — so a day of evidence a later phase depends on is protected by an unrelated defect,
in the command whose purpose is to delete that directory. When #233 is fixed the protection
disappears silently.

Filed as **#245**. The likely answer is that long-lived evidence should run outside any worktree
in the first place: `T3_HARNESS_DIR` and the output path are already configurable.

Until then: **do not `afx cleanup` air-235 and do not restart this run.**

## The 24-hour gate: started

| | |
|---|---|
| Started | **2026-08-30T08:28:53Z** |
| Expected completion | ~2026-08-31T08:36Z (24h gate plus the turns and checks either side) |
| Driver | `claude` / `claude-haiku-4-5` → driver kind `claudeAgent` |
| Port | 3805, data dir `tools/t3-server/.runtime-gate-24h` |
| Server | pinned checkout `082e6ea52186`, pinned CLI `t3@0.0.36`, Node 26.4.0 |
| Command | `T3_NODE=/abs/path/to/node tools/t3-server/full-protocol-run.sh 3805 claude claude-haiku-4-5 86400 gate-24h` |
| Evidence lands at | `tools/t3-server/.runtime-runs/gate-24h.json` |

**Why claude and not codex.** The account's codex quota was exhausted at the time of the run,
with a reset roughly sixteen hours out — the same condition Phase 9 hit. The criterion is
about *threads*: that one survives a day of silence carrying its context. Nothing in it is
specific to a provider, and re-observing it under a driver that can run beats not observing
it. The run says which driver produced it, as every run in this program does.

## Why the start time is later than the first attempt

The 24-hour clock was started five times. All three are recorded, because a start timestamp
with no history behind it leaves a later reader wondering which run it belongs to — and because
every restart here was for the same reason: **the code underneath had changed, and a day-long
run describing code that no longer exists is not evidence.**

Restarting costs nothing against this phase. The deliverable is a started run and a recorded
start, not an elapsed one, so re-recording a start is the whole of the work.

**First start, 05:19:46Z. Abandoned at 05:48.**

- The runner was still being changed. `spec-146-phase-10-full-protocol.test.ts` refuses
  evidence older than the runner that produced it, so every edit after a run starts makes
  that run's evidence stale by the project's own rule. A 24-hour run is the most expensive
  possible thing to invalidate, so the runner was frozen first and the clock restarted.
- The first attempt shared its server with two orphaned runners left behind by killed
  launcher shells. Its second connection came back
  `401 EnvironmentAuthInvalidError / invalid_credential`, and the run stopped at
  `RESUBSCRIBE_TIMEOUT` — correctly, and with the underlying auth failure recorded in
  `observations.subscriptionError` rather than swallowed. `full-protocol-run.sh` now refuses
  a port it does not own, which is the condition that produced it.

**Second start, 05:48:09Z. Abandoned at 06:38.** Chasing the opencode failure produced a real
fix to `packages/porch-driver/src/turn.ts` — a session refusal now fails fast with the server's
own sentence instead of timing out — and a change to the launcher so it opts the driver in. Both
are on the path this run exercises. `codev/research/146-driver-parity.md` carries the finding.

**Third start, 08:07:39Z. Abandoned at 08:22.** The first CMAP round found four assertions that
could not fail, two of which are on this path: the gate was measured with `setTimeout` and came
up 36 ms short of the hour it claimed, and the "porch restart" rebuilt its subscription in the
same process rather than recovering in a new one. Both fixed, clock restarted.

**Fourth start, 08:22:32Z. Abandoned at 08:28.** Reviewing the corrected runner found that
`fixTurnWatch` — the state that scored the restart criterion before a child process took the job
— was still being written on every event and read by nobody, under a forty-line comment
explaining a design the code no longer used.

**Fifth start, 08:28:53Z. This is the one running.** Reviewing the child found a false negative
waiting to happen: it required a non-null `activeTurnId` in the catch-up before counting a null
one, but the cursor is mid-turn by construction, so the `running` event is at or below it and
`afterSequence` excludes it. It held on every run measured, which is what made it dangerous. The
latch is now the parent's own observation, handed over. Its hash is in
`codev/research/146-phase10-live-evidence.json` under `describes`.

**Why five and not one.** Every restart followed a real defect found in the code the run was
about to describe, and four of the five were found by review rather than by the runs failing.
Restarting is the cheap half of this phase's deliverable — a recorded start, not an elapsed gate
— so the alternative was a day-long run standing as evidence for code nobody would ship.

## Harvesting it

The run writes `tools/t3-server/.runtime-runs/gate-24h.json`, which is gitignored. When it
completes, copy it into `codev/research/` and fill the table below; the criterion names are
the same ten every run records.

`gate-resumes-with-context` is the one this gate exists for. Its three outcomes are kept
apart deliberately:

- **met** — the thread returned the codeword established 24 hours earlier. It resumed.
- **not-met** — it came back and produced something else. It reconnected; it did not resume.
- **undetermined** — the post-gate turn never ran at all. Whether context survived is
  **unknown**, and that is not the same fact as "context was lost". A run that reports this
  has not failed the criterion; it has not evaluated it.

## Result

**Started, not complete — and that is the deliverable met, not a gap.** The plan asks this
phase for a started run and a recorded start; the completed evidence belongs to the later
phase that consumes it. Started 2026-08-30T08:28:53Z, still elapsing when this branch was
opened.

| Criterion | Outcome | Detail |
|---|---|---|
| `gate-resumes-with-context` | *pending* | |
| `gate-dispatched-nothing` | *pending* | |
| the other eight | *pending* | |
