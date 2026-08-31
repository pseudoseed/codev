# bugfix-242 — full-protocol-run.sh hardening

Issue #242: unvalidated `LABEL` reaches `rm -rf`, and cleanup only runs on the happy path.

## Investigate (2026-08-31)

### The blocker the issue named is already paid

#242 said the fix should wait because `tools/t3-server/full-protocol-run.sh` is hashed into
`codev/research/146-phase10-live-evidence.json`, so touching it invalidates two one-hour runs
and the 24-hour gate. That evidence is **already superseded** — `supersededBy` was set on
2026-08-30 for spec 236 (`client.ts` gained `onRequestId`), with the matching note in
`146-driver-parity.md:257`. `spec-146-phase-10-full-protocol.test.ts:272` returns early when
`supersededBy` is present, so the content-hash assertion is inert. Changing the launcher now
costs nothing extra.

The other launcher assertions in that file are content-shape, not hashes, and must keep
passing: the `printf '{"providers":{"%s":{"enabled":true}}}` regex, and the ordering
`start` < `SETTINGS=` < `restart`.

### Both defects reproduced

Sandbox: the real launcher bytes copied into a temp tree, with a stub `node` on PATH standing
in for `t3-server.mjs` and the runner.

**1. Traversal reaches `rm -rf`.** With `LABEL='x/../../../../../victim'` (and a
`.runtime-runs/work-x` left by a prior run), line 112's
`rm -rf "${RUNS:?}/work-$LABEL"` resolved outside `.runtime-runs` and deleted the sentinel
directory whole. `${RUNS:?}` guards an empty `RUNS`, not what `$LABEL` appends to it.
`T3_HARNESS_DIR` (line 44) escapes the same way, and `t3-server.mjs start` wipes
`$T3_HARNESS_DIR/data`. A label with no `/` cannot escape — the `.runtime-`/`work-` prefixes
absorb a bare `..` — which is why this needs a whitelist, not a `..` blocklist.

**2. No teardown off the happy path.** SIGINT to the launcher while the runner was in flight
produced **0** `stop` calls after `RUNNER STARTED`. The only `stop` is line 126, reached only
when the runner returns. `set -u` is set; there is no `trap`. The server survives, and once
`.runtime-<label>` is deleted it is orphaned beyond any `stop` and can only be killed by pid.

### Root cause

`LABEL` (`$5`), `PORT` (`$1`) and `GATE` (`$4`) are assigned at line 33 and interpolated into
paths, `lsof -iTCP:`, and the runner env with no validation, and the script registers no signal
handler for the window between the server starting (line 76) and the stop at line 126.

### Scope

Two blocks: an argument-validation section after line 33, and a `cleanup`/`trap ... EXIT INT
TERM` around the server lifetime. Well under 300 LOC. BUGFIX holds.

## Fix (2026-08-31)

`tools/t3-server/full-protocol-run.sh`, two blocks:

**Validation, before any path is built.** `LABEL` must match `[A-Za-z0-9._-]+`, `PORT` an
integer in 1..65535, `GATE` a non-negative integer; each refusal exits 2 with its own signal
(`BAD_LABEL` / `BAD_PORT` / `BAD_GATE`). A whitelist, not a `..` blocklist — a bare `..` cannot
escape here because the `.runtime-`/`work-` prefixes absorb it, and that near-miss is exactly
what makes a blocklist look sufficient while `x/../..` walks past it.

**`trap stop_server EXIT` + `on_signal` on INT/TERM**, armed immediately before `start`.
`STOP_ON_EXIT` keeps it honest: an exit before `start` reports no teardown, and the three
deliberate stops (settings, token, end) now call `stop_server` so they cannot double-fire.

**The runner had to become a background job.** Bash defers a trap until the current foreground
command returns, so with the runner in the foreground the handler would have waited out the
hour — or the day. It is now `node ... & RUNNER_PID=$!; wait "$RUNNER_PID"`, and `stop_server`
kills the runner before stopping the server, which is what makes the `pkill`-the-launcher case
work at all. The documented contract ("the exit status is the RUNNER's") is preserved by `wait`
and pinned by a test.

### Regression test

`packages/codev/src/agent-farm/__tests__/bugfix-242-launcher-hardening.test.ts`, 5 tests.

Validation runs against the real script at its real path. Lifetime runs against the launcher's
own bytes copied into a temp tree with a stub `node` ahead of it on PATH — real bash, real
signal, only the t3 harness and the protocol runner stood in for, because the genuine ones need
a pinned checkout and an hour. Asserting a `trap` line is present would test the text; this
tests whether the teardown fires.

### Harness notes

- SIGINT cannot be delivered in a plain shell repro: a background job of a non-interactive shell
  inherits `SIG_IGN` for INT, and bash refuses to trap a signal ignored on entry. The test uses
  `child_process.spawn` + SIGTERM, where dispositions are default.
- The suite serializes on a shared Tower lock, so a single-file vitest run can sit for ~5 minutes
  before it starts.

### Fail-without-the-fix, verified directly

Against the original bytes (`git show HEAD:tools/t3-server/full-protocol-run.sh`) in the same
sandbox:

- Every bad argument — traversal label, port 99999, gate `abc` — answers `NO_INTERPRETER` and
  exits 3. The label is never examined, so all three validation assertions fail.
- SIGTERM mid-run: 0 stops after `RUNNER`, no `INTERRUPTED` line, and the runner process
  survives the launcher.
- The traversal itself: with `.runtime-runs/work-x` present, `LABEL='x/../../../../../victim'`
  deleted the sentinel directory five levels up, whole.

With the fix, SIGINT via `child_process.spawn` (where dispositions are default) exits 130, prints
`INTERRUPTED sigint-check on SIGINT`, and records the teardown. SIGTERM exits 143 the same way.
Happy path: runner status 7 propagates, exactly one teardown.

### Incident: the revert check left the repo holding the original

The first fail-without-the-fix run swapped the original launcher in, ran vitest, and restored on
its last line. The job was killed while queued on the suite lock, so the restore never ran and the
worktree sat holding the ORIGINAL launcher — the same shape as the bug being fixed here. Caught by
diffing on-disk against the saved copy before committing. The retry wrapper restores from a
`trap ... EXIT INT TERM`.

### Suite lock contention

`packages/codev/vitest-global-setup.ts` serializes every vitest run in every worktree on a single
loopback socket (127.0.0.1:13999), with a 900s wait timeout. bugfix-273 and bugfix-260 were both
running full suites, so single-file runs here queued for minutes at a time. `lsof -nP -iTCP:13999
-sTCP:LISTEN` names the holder.

### Known-failing test, not mine (#278)

`spec-250-vendoring-identities.test.ts` fails in this worktree and in at least two others. The
fork checkout at `/Users/chris/dev/t3code-codev` is dirty with an untracked `tools/` (holding `lan-serve.mjs`) plus three modified `apps/web/src/components/Sidebar.*` files,
so `assertClean` (`tools/t3-server/t3-server.mjs:188`) exits after printing `FORK_AHEAD_OF_CONTRACT`
and the second assertion cannot run. Filed as #278 by the architect. Documented in the PR body; the
assertion is not skipped and the fork checkout is not touched.

### Suite result

`pnpm test`: 380 files passed, 1 failed; 7417 tests passed, 2 failed, 58 skipped (1054s).

Both failures are `src/__tests__/spec-250-vendoring-identities.test.ts` and both are #278, the
dirty fork checkout — "exits 1 against the real fork checkout when it is ahead of a fork-sourced
pin" and "describes the fork commit that is actually checked out" (fork HEAD `2f64a1b0…` against
the recorded `26b4c2dc…`). Neither touches anything in this change. `pnpm build` exits 0.

### Fail-without-the-fix, formally

The vitest revert run was terminated three times while queued on the contended suite lock, so the
test file's assertions were run against the original launcher bytes directly
(`assert-fails-without-fix.mjs`, no vitest, no lock). All six fail without the fix:

```
FAILS without fix  ✓  refuses a traversal label (status 2 + BAD_LABEL)
FAILS without fix  ✓  refuses a label with a space
FAILS without fix  ✓  refuses port 99999 (status 2 + BAD_PORT)
FAILS without fix  ✓  refuses gate "abc" (status 2 + BAD_GATE)
FAILS without fix  ✓  stops the server when signalled mid-run (1 stop after RUNNER)
FAILS without fix  ✓  says it was interrupted
```

The original records 0 stops after the runner starts. With the fix, the same six assertions pass
under vitest (6 tests, one file).

A seventh assertion — the runner still receives all ten `RUN_*` variables now that it is a
background job, and the `/`-bearing model `xai/grok-4.6` passes through — was checked by having the
stub runner print its environment: all ten arrive intact and status 7 propagates.

## PR (2026-08-31)

PR #282. First CMAP: claude=APPROVE, opencode=APPROVE, codex=REQUEST_CHANGES.

### What review caught, and it was real

**The port guard failed open** (codex). `[ "$PORT" -lt 1 ]` on a 30-digit port prints "integer
expression expected" and returns 2, which the `if` reads as false — so the run continued and the
refusal that eventually arrived was `NO_INTERPRETER`, about something else entirely. A guard whose
failure mode is falling through reads as a guard while being none. Fixed by matching the shape
first — at most five digits, no leading zero, so `[ 08 … ]` cannot be read as octal either — and
comparing only after. Gate bounded at 9 digits for the same reason.

**SIGHUP was untrapped** (claude). The 24-hour gate outlives the terminal that started it.

**`stop_server` did not reap the runner** (claude), so the teardown could race its last write and
leave a truncated `$LABEL.json` — an evidence file that exists and is wrong.

**The stub runner leaked a `sleep`** (architect). It slept in the foreground, so the `sleep` was a
grandchild the launcher never names and it outlived each signal test by five minutes. The stub now
sleeps in the background under its own TERM/INT/HUP trap, and both signal tests bound
`FAKE_RUN_SECONDS` at 30. Verified by hand: nothing from the sandbox survives the SIGTERM.

The remaining grandchildren gap — `kill RUNNER_PID` reaches the runner but not the porch and t3
processes `air-235-full-protocol.mjs` spawns — is #283, not this issue, and a stub with no children
cannot see it.

Branch synced with main (was 7 behind). 7 tests, all passing; re-CMAP dispatched.

### Re-CMAP and the gate

Re-CMAP on the updated PR: claude=APPROVE, opencode=APPROVE, codex=COMMENT.

Codex's two items were README drift and are fixed: it listed `EXIT`/`INT`/`TERM` after `HUP` had
joined them, and described the gate as any non-negative integer after it gained a nine-digit bound.
The README now also records why the port's shape is matched before its value is compared.

Claude's remaining notes are non-blocking and deliberately not acted on:

- The `wait` in `stop_server` is unbounded, so a runner that ignored SIGTERM would hang rather than
  leak. Theoretical for a node child, and a timeout would be a second mechanism to get wrong.
- `kill "$RUNNER_PID"` does not reach grandchildren — the porch and t3 processes
  `air-235-full-protocol.mjs` spawns. That is #283, and a stub with no children of its own cannot
  test it.

`pr` gate approved by the architect. Merge waits on CI, which is green-pending on the final push;
the architect's instruction was explicit that a pending CI is not a merge.
