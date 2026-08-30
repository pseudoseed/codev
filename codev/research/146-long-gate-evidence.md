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

## The 24-hour gate: started

| | |
|---|---|
| Started | **2026-08-30T06:38:59Z** |
| Expected completion | ~2026-08-31T06:50Z (24h gate plus the turns and checks either side) |
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

The 24-hour clock was restarted twice before it was left to run. Both restarts are recorded
because both are about evidence rather than about servers.

**First restart, 05:19:46Z → 05:48:09Z.**

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

**Second restart, 05:48:09Z → 06:38:59Z.** Chasing the opencode failure produced a real fix to
`packages/porch-driver/src/turn.ts` — a session refusal now fails fast with the server's own
sentence instead of timing out — and a change to the launcher so it opts the driver in. Both
are on the path this run exercises, so the clock was restarted rather than leaving a day-long
run describing code that no longer exists. `codev/research/146-driver-parity.md` carries the
finding.

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
phase that consumes it. Started 2026-08-30T06:38:59Z, still elapsing when this branch was
opened.

| Criterion | Outcome | Detail |
|---|---|---|
| `gate-resumes-with-context` | *pending* | |
| `gate-dispatched-nothing` | *pending* | |
| the other eight | *pending* | |
