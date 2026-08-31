# Bugfix #242: full-protocol-run.sh — unvalidated label reaches `rm -rf`, cleanup only on the happy path

## Summary

`tools/t3-server/full-protocol-run.sh` built deletion paths from an unvalidated label, and stopped
its server only on the path that reached the end. It now refuses the arguments it builds paths and
numbers from, and tears the server down on `EXIT`, `INT`, `TERM` and `HUP`.

Merged as `793b39d43` (PR #282), 9/9 CI checks green.

## Root Cause

**The label reached `rm -rf` unexamined.** `$5` is interpolated into `T3_HARNESS_DIR`, into the
run's output paths, and into `rm -rf "${RUNS:?}/work-$LABEL"`. The `:?` guards an **empty** `RUNS`;
it says nothing about what the label appends to it. Reproduced against the shipped bytes: with
`LABEL='x/../../../../../victim'` and a `.runtime-runs/work-x` left by a prior run, the `rm -rf`
resolved five levels above `.runtime-runs` and deleted a sentinel directory whole. `PORT` and
`GATE` were equally unchecked.

**The only `stop` was the last line**, so nothing ran it if the launcher did not get there.
Reproduced: a SIGTERM mid-run produced zero teardowns. The server keeps its port, the next run's
`ready` then answers truthfully about the stranger holding it, and once `.runtime-<label>` is
deleted that server is orphaned beyond any `stop` and can only be killed by pid — which is how two
runs were lost during #238.

## Fix

1. **Validation before any path is built.** Label `[A-Za-z0-9._-]+`; port an integer in 1..65535
   with no leading zero; gate a non-negative integer of at most nine digits. Each refused with its
   own signal (`BAD_LABEL` / `BAD_PORT` / `BAD_GATE`, exit 2).
2. **`trap stop_server EXIT` plus `INT`/`TERM`/`HUP`**, armed immediately before `start`, with a
   flag so an exit before `start` reports no teardown and the three deliberate stops cannot
   double-fire.
3. **The runner became a background job the script `wait`s on**, because bash defers a trap until
   the current *foreground* command returns. `stop_server` kills and reaps the runner before
   stopping the server.

## Files Changed

| File | Change |
|------|--------|
| `tools/t3-server/full-protocol-run.sh` | Argument validation; EXIT/INT/TERM/HUP trap; runner backgrounded and reaped |
| `tools/t3-server/README.md` | Documents both refusals and the trap |
| `packages/codev/src/agent-farm/__tests__/bugfix-242-launcher-hardening.test.ts` | 7 regression tests |

## Test Results

- 7 regression tests, all passing. Validation runs against the real script at its real path; the
  lifetime tests copy the launcher's own bytes into a temp tree with a stub `node` ahead of it on
  PATH, so a real bash takes a real signal.
- Every assertion predating review was confirmed to **fail** against the original launcher bytes.
- `pnpm build` exit 0. Porch's checks: build 29.2s, tests 450.3s, both green.

## CMAP Results

| Reviewer | First round | Re-review | Notes |
|---|---|---|---|
| Claude | APPROVE | APPROVE | Found the untrapped SIGHUP and the unreaped runner |
| Codex | REQUEST_CHANGES | COMMENT | Found the port guard failing open; then two README drift items |
| opencode (grok-4.6) | APPROVE | APPROVE | No issues |

Gemini was not run: this workspace's `.codev/config.json` sets `consultation.models` to
`["claude", "opencode"]`, and codex was added to reach three concrete verdicts.

## Lessons

**A whitelist, because the near-miss makes a blocklist look sufficient.** A bare `..` cannot escape
here — the `.runtime-`/`work-` prefixes absorb it into a literal `.runtime-..` — so a `..` blocklist
would have tested clean while `x/../..` walked straight past it.

**A guard can fail open, and then it reads as a guard while being none.** The first version of the
port check was `[ "$PORT" -lt 1 ]`. On a 30-digit port that prints "integer expression expected" and
returns 2, which an `if` reads as false, so the run continued and the refusal that eventually
arrived was `NO_INTERPRETER` — about something else entirely. Found by the codex lane. The shape is
now matched before the value is compared, and the test asserts the stderr carries neither
`NO_INTERPRETER` nor `integer expression expected`, because "it refused" and "it refused for this
reason" are different facts.

**Bash defers a trap until the current foreground command returns.** A `trap ... EXIT INT TERM`
above a foreground runner is not a bug you can see in a short test — it fires correctly there and
would have sat unfired for the rest of the hour, or of the day, in production. The runner had to
become a background job for the fix to be a fix.

**A test that leaks a process is a test that costs someone an afternoon.** The stub runner slept in
the foreground, so its `sleep` was a grandchild the launcher never names, and it outlived every
signal test by five minutes. The stub now sleeps in the background under its own trap.

**The blocker in the issue can be already paid.** #242 was deferred because the launcher is hashed
into `codev/research/146-phase10-live-evidence.json`. That evidence had already been declared
superseded on 2026-08-30 for spec 236, so the content-hash assertion returns early and the change
cost no re-runs. Checking the guard's actual state beat re-deriving the issue's premise.

## Not fixed here

- **#283** — `kill "$RUNNER_PID"` reaches the runner but not the porch and t3 processes
  `air-235-full-protocol.mjs` spawns. A stub with no children of its own cannot test it.
- The `wait` in `stop_server` is unbounded, so a runner that ignored SIGTERM would hang rather than
  leak. Theoretical for a node child; a timeout would be a second mechanism to get wrong.

## Environmental

- **#278** — `spec-250-vendoring-identities.test.ts` fails whenever the fork checkout at
  `/Users/chris/dev/t3code-codev` is dirty or ahead of `pin.commit`: `assertClean`
  (`tools/t3-server/t3-server.mjs:188`) exits after printing `FORK_AHEAD_OF_CONTRACT`, so the first
  assertion passes and the second cannot. Nothing was skipped and the checkout was not touched.
- Every vitest run in every worktree serializes on one loopback socket (127.0.0.1:13999, 900s wait
  timeout). With four builders active, single-file runs queued for 5–15 minutes each, and three
  runs were killed while queued. `lsof -nP -iTCP:13999 -sTCP:LISTEN` names the holder.
