# air-235 — Spec 146 Phase 10: full protocol on a second driver

## Orientation

Spawned on `builder/air-235` off `c0cfdd3cc`, which predated PR #221 (phase 9) landing on
main. **Rebased onto `origin/main` (`e241326a1`) before touching anything** — phase 10's
dependency is phase 9, and the worktree did not contain it. Everything below assumes that
rebase.

## What exists to build on (read, not assumed)

- `packages/porch-driver/src/` — 10 modules, 3,063 lines. No `__tests__` dir, no vitest
  config, no `test` script.
- `packages/codev/src/agent-farm/__tests__/spec-146-phase-9-live-*.test.ts` — the live
  tests, opt-in on `T3_LIVE=1`, driver overridable via `T3_LIVE_HARNESS`/`T3_LIVE_MODEL`.
- `tools/t3-server/t3-server.mjs` — acquire/verify/start/restart/ready/stop/status/runtime.
  `verify` exits 0 here: `/Users/chris/dev/t3code` clean at `082e6ea52186`.
- `apps/client/__tests__/suite-coverage.test.ts` — derives the five suites from
  `packages/codev/vitest*.config.ts` + `apps/client` scripts, and asserts each has a CI step.

## Decision: the test does NOT go where the plan says

The plan lists `packages/porch-driver/__tests__/full-protocol.test.ts`. That package has no
vitest config, no `test` script, and is not one of the five suites — and the coverage guard
derives only from `packages/codev` and `apps/client`, so it would not even notice. A test
file there is a suite nothing runs, which is the exact failure mode this program is written
against. It goes in `packages/codev/src/agent-farm/__tests__/` beside phase 9's live tests,
which the default suite covers.

## Log

- Rebased, surveyed, verified the pinned checkout. Port 3799 is the architect's server;
  this builder uses 3803 and its own `.runtime` inside the worktree.

## What the harness is

Three files, and the split is deliberate:

- `packages/codev/src/agent-farm/__tests__/helpers/air-235-pty-witness.mjs` — a
  `module.register` resolve hook that records every ESM specifier the process resolves.
  This is how "no PTY code path runs" becomes a measurement instead of a reading of the
  import graph.
- `.../helpers/air-235-full-protocol.mjs` — the runner. Standalone because the 1-hour and
  24-hour gates are elapsed for real and outlive any test timeout; the test drives this
  file rather than reimplementing it.
- `tools/t3-server/full-protocol-run.sh` — brings up a server the run owns, runs it, tears
  it down. Committed rather than left in scratch: it is the reproduction procedure the
  evidence docs point at.

## Bugs the harness found in itself, which is the point of running it live

1. **A probe that passed under claude timed out under opencode.** The subscription was
   fired but not awaited before the first dispatch, so the `running` transition landed
   before the stream attached. opencode/grok-4.6 finishes a trivial turn in ~14s; claude
   was slow enough to hide it. `awaitAttached` now gates every dispatch.
2. **The thread outlived its dispatcher.** `DriverThread` keeps the dispatcher it was
   constructed with, so the pr turn after the restart went down the socket the restart had
   closed — `NotConnectedError`. Fixed with a dispatcher facade over whichever connection
   is live. This is porch restarting and then being unable to drive the thread it just
   resumed, which is the failure the restart criterion exists to catch arriving one step
   later than the criterion looks for it.
3. **`awaitAttached` returned instantly on every subscription after the first**, because it
   waited for a non-empty list rather than for the count to pass a baseline. The resumed
   subscription's outcome was therefore read before it existed and recorded as `null` —
   which reads exactly like a subscription that reported nothing.
4. **The first restart check was unsound in the direction that looks safe.** It asked
   `thread.isTurnActive` after the dark window, but `isTurnActive` is fed by the event
   stream and during the dark window there is no stream. It could only ever record
   `undetermined`. Replaced with the real discriminator: catch-up handlers and `onResume`
   run on one serial chain, catch-up first, so an event whose handler sees
   `resumeOutcomes.length` still at the pre-resubscribe baseline was replayed out of the
   gap rather than seen live.
5. **`tools/t3-server/.gitignore` covered `.runtime/` only.** Phase 10 runs several servers
   at once with per-run `T3_HARNESS_DIR`s — `.runtime-gate-24h`, `.runtime-claude-1h` —
   holding the same private signing keys and pairing tokens the existing comment warns
   about. Widened to `.runtime*/`.

## Log

- 2026-08-30T05:19Z — 24-hour gate started on port 3805 under claude/claude-haiku-4-5.
  Evidence lands at `tools/t3-server/.runtime-runs/gate-24h.json` when it completes.

## The opencode investigation, including the hypothesis that was wrong

The first full-protocol run under `opencode` / `xai/grok-4.6` never started its investigate
turn: ten minutes, one `thread.turn.start` in the journal, no `opencode` process spawned by
the server. claude had just completed the same protocol end to end.

**Hypothesis 1, falsified.** The runner creates the thread on a *linked git worktree* (`.git`
is a file); the probe that had worked used a plain temp directory. A three-case repro — plain
dir, ordinary git repo, linked worktree — failed on **all three**, including the shape that
had worked forty minutes earlier. Worktree shape is not it.

**Hypothesis 2, falsified.** A cold `start` wipes the data dir, so a fresh server might have
no usable `opencode` provider instance while the long-lived one did. Ran the same repro
against both. Both failed, and `opencode run -m xai/grok-4.6` standalone answered in seconds
throughout — so neither the account nor the CLI was the constraint.

**What the instrumented repro showed.** Logging every frame: the subscription delivers a
`snapshot`, a `synchronized` marker, then four `thread.session-set` events carrying
`activeTurnId: null` before the one that carries a turn id. `TurnTracker` ignores those
because it latches on `#seenRunning` first — which is exactly why that latch exists. That run
started and settled normally.

So the three-case repro was itself the confound: it held three `subscribeThread` streams open
concurrently on one socket. The narrow repro, one thread and one stream, passes under
opencode. Re-running the real runner.

**Recorded rather than smoothed over:** opencode/grok-4.6 completes a trivial turn in ~11-14s
against claude-haiku's ~40s+. That speed is what exposed the subscribe/dispatch race in the
first probe, and it is the reason a slow driver is a bad place to look for ordering bugs.

## The opencode root cause, and the defect that hid it

Both hypotheses above were wrong, and so were two more. The answer was on the wire the whole
time.

`t3code` ships `OpenCodeSettings.enabled` defaulting to **false**, deliberately
(`packages/contracts/src/settings.ts:501-507`): *"Off by default (like Cursor and Grok): the
binding is not yet stable enough to probe on every install. Users opt in from Settings."*
`ClaudeSettings` does not default off. Every run in this harness gets its own `--base-dir`
because the runs are concurrent, so every run got a state directory nobody had opted in for.
The three successes earlier in the session were on the one data dir that happened to carry the
opt-in; every failure was on a fresh one. That split is exact and I did not see it for an hour.

The server refused at `startSession` and said so **twelve milliseconds** after dispatch, as
`status: "error"` with the sentence in `lastError`. `TurnTracker` read `activeTurnId` and
nothing else — and a refusal event carries `activeTurnId: null`, which falls through the
`seenRunning` latch and does nothing. So porch waited out its whole budget and reported
`Timed out after 599950ms waiting for the turn to start. This is "I stopped waiting", not "the
turn finished".`

Every word of that is true and the whole of it is wrong.

**This is the project's own rule running backwards.** "I could not tell" must never be spelled
like "no"; here "no" was spelled like "I could not tell". That is the more expensive direction,
because a hedged message that is correct about its own uncertainty does not look like it is
hiding a definite answer — it looks like patience. Four hypotheses were falsified with real
repros (worktree shape, cold-vs-warm state dir, a settling delay before dispatch, machine
memory pressure at 12.8GB of 14.3GB swap) purely because the real answer was unread.

Two fixes, both committed:

- `packages/porch-driver/src/turn.ts` — `sessionFailureOf` plus `SessionStartFailedError`,
  scoped to before `seenRunning` so a turn that ENDS in error still settles normally. Three
  tests, mutation-verified: neutering `sessionFailureOf` restores the hang and fails two.
- `tools/t3-server/full-protocol-run.sh` — writes the provider opt-in into the state directory
  the run owns, after the `start` that wipes it and before the `restart` that loads it. The
  user's own T3 Code settings are never touched.

With the opt-in, the opencode run that had produced nothing in ten minutes wrote its investigate
file in 36 seconds.

## Log

- 2026-08-30T06:38:59Z — all three runs relaunched on the final code. The 24-hour clock was
  restarted twice, both times because the code under it had changed and a day-long run
  describing code that no longer exists is not evidence. Both restarts are recorded in
  `146-long-gate-evidence.md`.

## The live block has actually been run

A `T3_LIVE=1` block that has never executed is a code path with a docstring. This one was run
end to end on port 3807 with a 60-second gate under claude/claude-haiku-4-5: server up, the whole
protocol, the branch pushed and merged, server stopped, 415s, all ten criteria `met`. The
recorded runs use 3600 because the criterion needs a real hour; the block itself needed proving
once.

Running it also found a hazard worth the trip. The block calls `t3-server.mjs stop` then `start`,
and both DEFAULT to port 3799 and `tools/t3-server/.runtime` — and 3799 is the architect's own
server. A live run with the variables unset would have stopped a colleague's server as its first
act, presenting as their session dying for no reason. An unset port is now refused rather than
defaulted, and the refusal is asserted so it reads as a refusal and not as a pass.
