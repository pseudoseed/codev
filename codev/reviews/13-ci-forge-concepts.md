# PIR Review: CI concepts for the forge layer

Fixes #13

## Summary

Adds four CI concepts to the forge layer — `ci-runs`, `ci-run-view`, `ci-failures`, `ci-run-log` — for both `github` and `gitea`, tiered so that only the last two ever read log bytes. A builder asking why CI failed now gets the failing job, the failing step and the assertion instead of a log: on the reference run, **293 KB becomes a 1.2 KB response**. Also adds `codev forge <concept>`, because naming a concept script by path bypasses resolution and would silently ignore a repo's own overrides.

## The record this PR corrects

**Issue #13 says `gh run view --log-failed` "already returns only failed steps" and instructs the implementer not to re-derive that. It does not, and the instruction is wrong.** Measured on run `32515040122` of this repository:

```
gh run view 32515040122 --log-failed   →  2528 lines, 293 KB, 2.0 s
Unit Tests	UNKNOWN STEP	2026-08-21T18:47:09.5820646Z Current runner version: '2.336.0'
```

Every one of those 2528 lines is tagged `UNKNOWN STEP`. `--log-failed` selects the failing **job** and returns all of it; `gh` maps log files to steps by name and falls back to `UNKNOWN STEP` when that mapping misses. The architect independently reproduced this on run `32448538074`: 919 lines, all 919 tagged `UNKNOWN STEP` — and had read that same output earlier the same day while diagnosing #6 without registering what it meant.

**One precision, raised by the claude lane and verified:** that attribution is *unreliable*, not always absent. On run `32536232930` the same command attributed all 1193 lines to the failing step correctly. It changes nothing about the design — attributed or not, what comes back is **a whole job or a whole step**, 293 KB and 108 KB respectively, and never the assertion — but "always UNKNOWN STEP" would have been an overstatement, so it is not claimed here or in `arch.md`.

So codev extracts on **both** providers, and neither uses `--log-failed`. Both fetch `actions/jobs/{id}/logs` — one job, no invented step column, the same shape Forgejo 16 serves — which is also why they share one cache and one extractor. The failing step *name* comes from `gh run view --json jobs`, which is structured and reliable.

Anyone reading #13 later should read this section instead of its "Provider notes".

## What the two forges actually do

Everything below was measured against live instances on 2026-08-21, not reasoned about.

**Forgejo has no Actions job-log API before 16.0** (released 2026-07-16). `git.pseudoseed.com` reports `15.0.2+gitea-1.22.0`, and there `tea actions runs view` and `tea actions runs logs` both 404 — they call `/actions/runs/{id}/jobs` and `/actions/jobs/{id}/logs`, neither of which exists. Every alternative route was probed. The web UI's own log route exists but is session-only: it rejects `Authorization: token` and HTTP basic auth alike, while the API accepts the same token (verified as a control). There is no token-reachable log on 15.x by any path.

`tea actions runs list --output json` is also lossy where it does work — `workflow`, `branch`, `started` and `duration` all come back as empty strings — so these scripts go through `tea api`, as #12 established.

Four query-parameter facts, all footguns:

| | |
|---|---|
| `limit` is ignored unless `page` is also sent | `actions/runs?limit=3` returned **all 6922 runs** |
| `status=` filters server-side | works, and is used |
| `branch=` and `event=` are silently ignored | branch filtering is client-side |
| `status=canceled` is rejected | `{"message":"unknown status: canceled"}`; `cancelled` returns 2240 runs — the opposite of what `tea`'s own `--help` documents |

And two shape facts:

- **A `pull_request` run records `head_branch` as `#3847`** — the PR number, not a branch. In the first 100 tasks on the reference repo: `#3869` ×32, `#3865` ×10, `main` ×7, `v1.0.230` ×1. So `CODEV_BRANCH_NAME=builder/x` matches *nothing* on a repo that runs CI on pull requests unless the branch is resolved to its PR first, which `ci-runs` does with #12's base/head lookup.
- **Run `id` and `index_in_repo` are two id spaces, and both resolve on `/actions/runs/{x}`** to different real runs. The web URL shows the second. `ci-runs` emits both, the log concepts take `id` only, and a non-numeric value is refused rather than guessed.

On Forgejo 16 (verified on codeberg.org, `16.0.0-dev-694`): `actions/runs/{id}/jobs` returns jobs carrying both `id` and `task_id`, and **the log endpoint accepts the job `id`, not the `task_id`** — passing the task id returns `{"message":"resource does not exist"}`, which is exactly the 404 that reads as "no logs" if it is not distinguished. `actions/jobs/{id}/logs` served 142 KB / 1599 lines in 1.02 s as `text/plain` with `accept-ranges: bytes`; `?step=N` is accepted and ignored.

## Design

### Tiering

| Question | Concept | Reads a log? |
|---|---|---|
| Did my push pass? | `ci-runs` | No |
| Is it still running, which job is pending? | `ci-runs`, `ci-run-view` | No |
| It failed — why? | `ci-failures` | Yes, one job |
| Is this mine or pre-existing? | `ci-runs` + `CODEV_CI_WORKFLOW` | No |
| Extraction gave up — show me | `ci-run-log` | Yes, one window |

`ci-run-log` is a separate concept rather than a flag, per the issue's second comment: a window parameter on the main call gets passed by habit, and then every status question drags a log again.

### The extraction ladder, and the three traps it was built against

All three are from the real captured logs, and each is a test:

1. **ANSI.** The payload line is `ESC[41mESC[1m FAIL ESC[22mESC[49m src/…`, so a matcher that does not clean first matches **nothing** and reports "no recognized failure" on a log that plainly contains one. Cleaning is not cosmetic.
2. **"First line matching an error pattern" returns line 1257 of 2528**: `[artifact-canvas] Error: host blew up` — a fixture string printed by a *passing* test. The real failure is at 2471. The ladder's generic rung therefore anchors patterns at the **start** of the line; that decoy's `Error:` is mid-line and cannot match, and anchoring holds even in logs with no test summary to measure against.
3. **`Test Files` appears four times before the failing summary**, three of them saying `passed` and one a shell line echoing `grep -q "Test Files.*passed"`. Any rule taking the first match reports a passing suite as the failure.

Rungs, in order, with the one that fired named in `matchedBy`: `vitest`/jest → `go-test` → `tsc` → the runner's `##[error]` marker → line-anchored `first-error` → refusal. Runner recognition sits above the `##[error]` marker deliberately (and as issue #13's own priority order asks): the marker returns one sentence, the vitest rung returns the whole Failed Tests block — test name, assertion, expected/received, file:line.

**Deviation from the approved plan, stated plainly.** The plan said the generic rung would fire only *after* a passing-suite boundary and otherwise fall through to refusal. Implemented, it fires with anchoring always and the boundary as a preference. Anchoring is what actually kills the observed false positive; refusing whenever no test summary exists would have returned `extracted: false` for the whole class of install/setup/compile failures and bought no safety.

### Refusal is a handoff

```json
{ "extracted": false, "reason": "no recognized failure pattern",
  "failures": [{ "jobId": 11952749, "jobName": "test-unit", "logLines": 1599 }],
  "next": "ci-run-log CODEV_CI_RUN_ID=6554924 CODEV_CI_JOB_ID=11952749 CODEV_CI_LOG_TAIL=80" }
```

No log lines at all. A builder handed 50 arbitrary lines treats them as the diagnosis and reasons from noise; one told extraction failed reads the log with the call the response already handed it.

### Errors are values

Every ci-* concept prints one JSON object on stdout on success **and** failure, so `timeout` / `not-found` / `unsupported-server` / `forge-error` / `bad-input` stay distinguishable after `executeForgeCommand` has flattened everything else to `null`. `executeForgeCommandDetailed` is added for callers that need the distinction in TypeScript: it returns `{ok, data, stdout, stderr, exitCode, timedOut, unavailable, durationMs}` and keeps stdout on the failure path.

On a Forgejo below 16 the response is `unsupported-server`, naming the version found and the version needed **and still listing the failing job names it could determine** — never an empty `failures` array. It calls that list `failingJobs`, not `failures`, and the difference is deliberate: a `failures` entry carries an extract (`matchedBy`, `text`, `from`/`to`, `returnedLines`), and these have none — only a name and an id. Reusing the key would make an unsupported server shaped like a successful extraction with the details missing, which is a smaller version of the same lie the envelope exists to prevent. (Raised as an inconsistency by the claude lane; kept, with the reason stated here.) "Your CI is fine" and "I cannot see your CI at all" are opposite facts and must not be the same observation.

### `codev forge <concept>`

Added at the architect's direction at the dev-approval gate, and the reasoning is correctness rather than convenience: calling `packages/codev/scripts/forge/github/ci-failures.sh` by path **bypasses resolution** — the config lookup, the provider preset, and any per-repo override — so a repo that overrides a concept gets the github default against its own forge. The reference Forgejo repo carried three such overrides until #12 shipped. It delegates to `executeForgeCommandDetailed`, prints stdout verbatim and exits with the script's code; its own additions are exit 2 for an unknown concept (listing the valid ones) and exit 3 for a concept disabled for the provider, named.

## Files Changed

- `packages/codev/scripts/forge/_ci-extract.sh` (+202 / -0) — the extraction ladder
- `packages/codev/scripts/forge/_ci-lib.sh` (+399 / -0) — envelope, caps, cache, windows, id validation
- `packages/codev/scripts/forge/_timeout.sh` (+100 / -0) — #12's watchdog, now shared by both providers
- `packages/codev/scripts/forge/gitea/_lib.sh` (+8 / -79) — sources the shared watchdog
- `packages/codev/scripts/forge/gitea/_ci.sh` (+229 / -0)
- `packages/codev/scripts/forge/gitea/{ci-runs,ci-run-view,ci-failures,ci-run-log}.sh` (+468 / -0)
- `packages/codev/scripts/forge/github/_lib.sh` (+55 / -0)
- `packages/codev/scripts/forge/github/{ci-runs,ci-run-view,ci-failures,ci-run-log}.sh` (+407 / -0)
- `packages/codev/src/lib/forge.ts` (+119 / -11) — registration, gitlab/linear disabled, `executeForgeCommandDetailed`
- `packages/codev/src/lib/forge-contracts.ts` (+181 / -0)
- `packages/codev/src/commands/forge.ts` (+97 / -0) — `codev forge <concept>`
- `packages/codev/src/cli.ts` (+19 / -0)
- `packages/codev/src/__tests__/pir-13-ci-concepts.test.ts` (+976 / -0)
- `packages/codev/src/__tests__/fixtures/pir-13/{github-vitest-failure,forgejo-go-failure,github-vitest-worker-crash}.log.gz` (3 files, 98 KB) — the third is this branch's own red CI run, which produced the capture-block decoy
- `packages/codev/src/__tests__/forge.test.ts` (+10 / -2) — concept count 18 → 22
- `packages/codev/src/__tests__/spec-1280-measurement-instrument.test.ts` (+18 / -25) — timeout ceiling, see Flaky Tests
- `.claude/skills/forge/SKILL.md`, `.codex/skills/forge/SKILL.md` (+133 / -0 each, byte-identical twins)
- `codev/resources/arch.md`, `codev/resources/lessons-critical.md`, `codev/resources/lessons-learned.md`
- `codev/plans/13-ci-forge-concepts.md`, `codev/reviews/13-ci-forge-concepts.md`, `codev/state/pir-13_thread.md`

## Commits

- `700aefc63` feat(forge): CI concept plumbing — shared timeout, extraction ladder, envelope
- `d4605f6b2` feat(forge): the four CI concepts for GitHub
- `1fd18d491` feat(forge): the four CI concepts for Gitea/Forgejo
- `346243ef5` test(forge): pin the CI concepts against two real captured logs
- `5cd31ef16` fix(forge): send status=cancelled, the spelling both forges actually accept
- `3e552014e` fix(forge): a CLI that exits 0 with non-JSON still gets an envelope
- `494a17352` fix(forge): gitea ci-runs reports truncation when it hits the page ceiling
- `8e26a661a` fix(forge): reject a non-numeric run or job id before it reaches a URL
- `067f7b179` test(forge): the concept count is 22, not 18
- `9893db9cd` test: give the prompt-surface instrument a ceiling above its own cost
- `3334bf9e8` feat(cli): codev forge <concept> — run a concept through the real resolver
- `5f57f107e` Review + retrospective
- `79fb7b664` docs: record the review-lane coverage gap and porch's wrong remedy
- `8a57b262c` fix: the two defects the claude review lane found
- `9a5a19bac` docs: test counts after the review-lane fixes (5572 passed, 67 new)
- `5a61226d6` fix: an unusable TMPDIR must not be reported as a missing run
- `b1f8c7fce` fix(forge): the extractor pointed at a passing test

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass — 5622 passed, 0 failed, 48 skipped (5670), after merging `origin/main`. **70 new tests** in `pir-13-ci-concepts.test.ts`, plus the two concept-count assertions updated in `forge.test.ts`.

### Branch CI: red, and NOT because of a failing test

**Read this before reading `npm test: ✓ pass` above.** That line is the local suite; the branch's own CI is a separate claim, and for several commits it was **red** while this file said nothing about it. The claude review lane caught that.

**CI is green at HEAD** (`b1f8c7fc`: `Tests` ✓, `CLI Integration Tests` ✓), which confirms the diagnosis below — the red was an intermittent worker-teardown crash, not a failing test. The guard defect that turned that flake into a hard failure is still there for whoever hits it next.

The last red run (`32536232930`) reports:

```
Test Files  280 passed | 3 skipped (284)
⎯⎯ Unhandled Errors ⎯⎯
Error: [vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly
```

**No test failed.** A vitest worker fork died during teardown, so one file went unreported. `.github/workflows/test.yml` already knows about this and tries to tolerate it — its own comment says *"Vitest forks pool has a known issue where the worker process crashes during cleanup after all tests pass"* — with:

```sh
if grep -q "Test Files.*passed" /tmp/vitest-output.txt && ! grep -q "failed" /tmp/vitest-output.txt; then
  echo "::warning::Vitest worker crashed during cleanup but all tests passed"
```

**That guard cannot fire.** `grep -q "failed"` runs over the whole captured output, and "failed" appears in it six times on this run — none of them a failing test:

| line | what it is |
|---|---|
| 1475 | **the guard's own script**, echoed into the log by the Actions runner |
| 1657, 1663, 1664 | `spec-1470` test names and stdout — `reentry-failed`, `clear-failed`, "reports a **failed** Tower send" |
| 2202, 2205 | `git fetch … failed` warnings printed by consult tests |

So *any* worker crash in this repository is a hard CI failure regardless of the test results, and the tolerance the workflow author wrote has never been reachable — which is why a flake that later cleared on a re-run cost this PR two red runs and a diagnosis. That is a defect in `test.yml`, not in this diff, and it is **not fixed here** — fixing another team's CI gate to turn an unrelated red green is the scope creep the review phase warns against. It is reported to the architect with this evidence.

What this PR *did* cause, and has fixed, is the earlier red: the `TMPDIR` harness bug above, which failed 31 tests on Linux while passing locally.

### Verification coverage — three tiers, and they are not the same

**Do not read the third as if it were the first two.**

**1. GitHub — live, end to end through the real dispatcher** (config load → preset → env → script → JSON parse), against `pseudoseed/codev`:

| Call | Time | Result |
|---|---|---|
| `ci-runs` (limit 3) | 987 ms | 3 runs, `truncated: true` |
| `ci-runs --status failure` | 695 ms | 3 runs |
| `ci-runs --branch builder/pir-12` | 875 ms | 3 runs |
| `ci-run-view` run 32515040122 | 1464 ms | 5 jobs, 1 failing, failing step named |
| `ci-failures` (cold) | 2503 ms | `vitest`, **23 of 2528 lines**, 1.2 KB response |
| `ci-failures` (cached) | 1323 ms | identical answer, no download |
| `ci-run-log` tail 10 | 1215 ms | lines 2519–2528 |
| `ci-run-log` head 5 | 1232 ms | lines 1–5 |
| `ci-run-log` grep AssertionError | 1190 ms | 14 lines, matched at 2472 and 2497 |
| `ci-run-log` with no window | 29 ms | `bad-input` — refused before spending an API call |

Also verified against a second real run (`32448538074`, the architect's): 919 lines → 20, `matchedBy: vitest`.

**2. Forgejo 15.0.2 — live, end to end through the real dispatcher**, against `~/dev/entriq` on the bare `gitea` preset with no overrides:

| Call | Time | Result |
|---|---|---|
| `ci-runs` (limit 3) | 726 ms | 3 runs |
| `ci-runs --status failure` | 407 ms | 3 runs |
| `ci-runs --branch builder/air-364` | 2255 ms | 2 runs, matched via PR ref `#3855` |
| `ci-run-view` run 11130 | 3269 ms | **10 jobs via `tasks-scan`**, 1 failing |
| `ci-failures` run 11130 | 3737 ms | `unsupported-server`, both versions named, failing job still listed |
| `ci-run-log` run 11130 | 3903 ms | `unsupported-server` |

`codev doctor` in that repo resolves all four concepts to `tea`. **entriq was read-only** — nothing was written to it. Its working tree carries an unrelated uncommitted `.codev/config.json` edit that predates this session (13:34 MDT, deleting the three overrides #12 made redundant).

**3. Forgejo 16 — HTTP level only. NOT driven through the dispatcher against a live v16 server.** The v16 routes were verified with unauthenticated `curl` against `codeberg.org/forgejo/forgejo` (jobs list, job log 200/`text/plain`/142 KB/1.02 s, run-log zip), and the code path is covered by unit tests driving a stubbed `tea` that serves the **real captured codeberg job log**. Driving it through the dispatcher needs `tea` to hold a Codeberg login, which the architect deferred. `git.pseudoseed.com` was still on 15.0.2 at the time of writing; the owner has filed the Forgejo 16 upgrade, and if it lands the same code lights up with no change.

**4. Provider degradation**: `resolveAllConcepts` reports all four concepts as `disabled` for `gitlab` and `linear` — not merely absent, which would fall through to the github default and run `gh` against whatever remote it resolved.

## ⚠ Review lane coverage — read this before trusting the review depth

**The rotation this review ran under was `["gemini", "codex", "claude", "opencode"]`**, the four-lane list in effect at the time (2026-08-21, ~16:50–17:30 MDT). The owner removed `gemini` from the rotation shortly afterwards — `["codex", "claude", "opencode"]` — so a later reader will see three names where this table has four. The table records what actually ran, not the current config.

The first pass had only ONE lane available and the PR was **held** rather than merged on it; the `opencode` lane (PR #24) was merged and installed mid-flight, which is what made a second live reviewer possible.

| Lane | Verdict | Notes |
|---|---|---|
| **claude** (`claude-opus-5`) | **APPROVE**, HIGH | Ran twice more than required. First pass found the timeout inversion and the `sed -n "1,0p"` portability bug; second pass, on the corrected code, found the extractor pointing at a passing test and this file claiming green CI while the branch was red. Third pass, after those fixes: APPROVE, "no blocking issues", shellcheck and tsc clean, review claims verified independently. |
| **opencode** (`xai/grok-4.6`) | **APPROVE**, HIGH | No key issues. Checked the three documented deviations rather than the code alone. |
| **codex** (gpt-5.6-sol) | **NEVER RAN** | Provider quota, refused in seconds: *"You've hit your usage limit… try again at Aug 27th, 2026 4:01 PM."* Same quota blocked #2, #4, #11 and #12 the same day. |
| **gemini** (agy) | **NEVER RAN** | Provider quota, **not** the reason porch reported — see below. Resets ~2026-08-28. Removed from the rotation by the owner after this review ran. |

Every finding from every lane was reproduced before being acted on, and none was argued down. The four that changed the code are described in **What the lanes found** below.

**Porch's own gate summary will say otherwise, and it is wrong.** Both lane files carry `VERDICT: SKIPPED`, which `parseVerdict` (`porch/verdict.ts`) does not recognise — it knows only `APPROVE`, `REQUEST_CHANGES`, `COMMENT` — so it falls through to the "treat as COMMENT" default, and `allApprove` counts `COMMENT` as approval. Porch will print **"All reviewers approved!"** over two reviewers that read nothing. That is **#20**, filed by PIR #12; it is porch behaviour, not anything in this diff, and it is not fixed here. Read this table, not the summary line.

**The lane files themselves are gitignored** (`.gitignore:65`, `codev/projects/*/*.txt`), which is why the evidence is restated here, where it survives the merge.

### Porch reported a remedy that cannot work

The gemini skip notice read:

> The Gemini (Antigravity `agy`) reviewer was skipped: agy exited with code 1. This is a non-blocking skip; the remaining reviewers still apply. To enable the Gemini lane, install the CLI (https://antigravity.google/cli/install.sh) and run `agy` once to sign in.

agy **is** installed and authenticated. Probed directly, verbatim:

```
$ agy --version
1.1.17
$ which agy
/Users/chris/.local/bin/agy
$ echo hello | agy -p "reply with the single word OK"
Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 157h50m8s.
rc=1
```

Reinstalling and signing in again would have changed nothing and cost whoever followed the advice their afternoon. A confidently printed remedy that cannot work is the same defect class as #21, where the stuck-mailbox alert names a command that cannot clear a composer. The architect is filing it separately.

### What the lanes found

**First pass — claude, COMMENT/HIGH.** Two real defects, both in precisely the class the absent lanes exist to catch.

**1. The timeout layering was inverted, and my own test hid it.** `executeForgeCommandDetailed` defaults to a 30s ceiling; the scripts default to a 60s `CODEV_FORGE_TIMEOUT`. **At the defaults the outer kill fires first**, so a stalled forge arrived as a generic Node kill and the script's *named* timeout envelope — the entire point of the inner watchdog, and the thing #17 and #8 are about — never printed. The comment in `forge.ts` asserted the opposite ordering.

The reason it survived to review is worth more than the fix: **the timeout test forced `CODEV_FORGE_TIMEOUT=2`, and a test that overrides the defaults cannot detect the defaults being wrong.** It proved the watchdog works when you tell it to; it could not prove that the watchdog is the ceiling that fires. The correction is a test that pins the **ordering at defaults** — it lets the real 60s-vs-30s relationship decide, and fails if the outer ceiling ever eats the inner one again.

**The inversion predates this PR.** #12 gave the gitea scripts a 60s watchdog under this same 30s ceiling; it was inherited here, not introduced. Correcting it globally would change the timeout behaviour of every concept and every caller, so what this PR does is narrower: `codev forge` sets its ceiling to the script watchdog plus 30s, and `forge.ts` now documents the real ordering instead of the intended one. The general case is left to a caller passing `timeoutMs`.

**2. `sed -n "1,0p"` on an empty job log.** head/tail built a reversed range whenever a log came back empty. **BSD sed tolerates it and GNU sed rejects it** — so this was invisible on the macOS box it was written on, and on Linux, *which is where CI runs*, the script would have aborted under `set -e` with nothing at all on stdout: the one shape these concepts promised never to produce. It is the textbook case for why the absent lanes matter, found by the lane that ran on the platform where it cannot bite. An empty log is now an answer (`logLines: 0`, empty window, `truncated: false`), pinned for all three window modes plus an assertion against the reversed range itself.

A third finding was cosmetic (a misindented `exit` and a trailing space in `gitea/ci-runs.sh`), fixed.

**Second pass — claude, REQUEST_CHANGES/HIGH**, on the code after those fixes. Three findings, all correct:

- **This file claimed CI was green when the branch was red.** Addressed in the CI section above: disclosed, diagnosed, and the guard defect reported rather than fixed.
- **`ci-failures` pointed at a passing test** — the capture-block decoy, above. The best finding of the review, because it was found by *running this PR's tool against this PR's own failing CI*.
- **"How to Test Locally" gave commands that do not work here.** The globally installed `codev` predates this PR and has no `forge` subcommand; the worktree build predated the `opencode` lane and rejected the workspace config. `main` is now merged (fixing the second) and the instructions build the branch and invoke its own CLI (fixing the first).

**Third pass — claude, APPROVE/HIGH.** No blocking issues; four minor notes, all documentation accuracy, all applied: the fixture count (2 → 3), the commit list, the `--log-failed` overstatement corrected above and in `arch.md`, and the reason `failingJobs` is deliberately not spelled `failures`.

A further note was noted rather than requested: the `Ci*` contracts in `forge-contracts.ts` are documentation-only, with no conformance test tying them to actual script output. **Deliberately not done here.** Adding it for the four CI contracts alone would leave the other eighteen forge contracts untested while implying they were covered — worse than uniformly untested. The architect is filing it as its own issue across all forge contracts.

### What CI on this PR found that the local suite could not

The branch's own CI went red while `npm test` was green locally, and the cause is the same platform split the review lane had just warned about — this time with a **wrong answer** at the end of it rather than a crash.

**The trigger was a test-harness bug**: the harness pointed `TMPDIR` at a directory it never created. macOS `mktemp -d` ignores an unusable `TMPDIR` and falls back to the system temp dir; GNU `mktemp` honours it strictly and fails. So 31 tests passed on the Mac and failed on the Linux runner.

**What the failure exposed is the part worth reading.** Every CI concept needs a temp dir, and the watchdog in `_timeout.sh` needs one for *every single call*. With `TMPDIR` unusable, `mktemp -d` failed inside the watchdog, `gh` was never run, and the wrapper returned 1 — indistinguishable from the wrapped command failing. The concept then answered:

```json
{"ok":false,"error":"not-found","detail":"run 32515040122 could not be read (gh exit 1); pass the `id` from ci-runs, not the run `number`"}
```

A temp-directory problem wearing the face of a missing run, complete with confident advice about which id to pass. That is the same rule this PR's hot-tier lesson is about, arriving one more time: **"I could not tell" must never be spelled the same way as "no."**

Three fixes, and the diagnosis was made in an `ubuntu:24.04` container rather than by round-tripping CI:

1. `forge_timeout` returns **125** when it cannot create a temp dir, not 1 — the command never ran, so it must not share a status with the command failing.
2. Every CI concept runs `ci_require_tmpdir` before it touches a forge, which fails by name with `forge-error` and makes **no forge call at all**.
3. The check tests `[ -d "$TMPDIR" ]` explicitly rather than leaning on `mktemp`, so macOS and Linux behave **identically**. Relying on `mktemp` alone would have preserved the split — and the log cache, which reads `${TMPDIR:-/tmp}` directly, silently does nothing on macOS in that state anyway.

The harness bug is fixed, and the misdiagnosis is pinned by a test that passes on both platforms.

### Why this PR is held rather than merged on one lane

One of three would be the thinnest coverage of the day, on the diff least suited to it: five POSIX `sh` scripts, a hand-rolled awk extractor and a pile of jq, where the two absent lanes are the ones that most often catch quoting and portability defects — and where two of the three bugs found during implementation were exactly that class. PR #24 (issue #22) adds an **opencode** consult lane on an account unrelated to either exhausted quota; the architect is merging it and re-running this review phase with that lane available, rather than waiting for the Aug 27/28 quota resets or merging thin. **This section is rewritten with the real verdicts once that re-run completes.**

## Architecture Updates

**COLD — `codev/resources/arch.md`**, § Integration Points → Forge Concept Commands. Concept count 18 → 22, plus four additions, all current-state reference rather than changelog:

1. **How to invoke a concept**, and that naming a script by path bypasses resolution — the defect `codev forge` exists to close.
2. **`executeForgeCommandDetailed`** and when the `null`-flattening of `executeForgeCommand` is not good enough.
3. **The ci-* contract**: errors as values on stdout, `logLines`/`returnedLines`/`truncated` on anything carrying log text, refusal carrying no log lines, and where the shared implementation lives.
4. **The measured CI behaviour of both forges** — the `--log-failed` correction, the Forgejo 16 log-API floor, the four query-parameter footguns, the `#<pr>` branch labelling, the two id spaces, the `cancelled` spelling, and the per-endpoint costs.

**Nothing promoted to `arch-critical.md`.** It is at its cap of ten, and all of this matters only when writing or calling a forge concept — the SKILL.md and the cold map carry it to whoever needs it.

## Lessons Learned Updates

**HOT — `codev/resources/lessons-critical.md`**, one entry rewritten in place rather than a displacement, because the new instance is the same lesson arriving through a wider door. The existing entry covered truncation only:

> ~~A truncated result is indistinguishable from a complete one once emitted — give "I stopped early" its own signal and emit nothing, never a partial answer that reads as whole.~~

is now

> **"I could not tell" must never be spelled the same way as "no". A truncation, an unreachable API, and a server too old to answer each need their own signal and must emit nothing else — a partial or empty answer reads as a complete, negative one.**

The architect counted this as the seventh arrival of the same rule in one day. This PR met it three times: an old Forgejo that would have looked like a green run, a page ceiling that reported `truncated: false`, and a CLI exiting 0 with non-JSON that produced no stdout at all. The file stays at ten entries.

**COLD — `codev/resources/lessons-learned.md`**, seven entries across Process and Testing:

- Measure a tool before building on the claim that it already does the work (`--log-failed`).
- Extraction must recognise, not truncate — and must strip ANSI before it can recognise anything; anchor generic error patterns at the start of the line.
- A CLI's `--help` is not the API's vocabulary (`canceled` vs `cancelled`).
- Ask which id space an endpoint means when two plausible ids both resolve.
- Under `set -e`, a helper returning non-zero decides its caller's exit status.
- A shell helper that "sets a global" sets nothing when the caller captures it in `$( )`.
- A test whose ceiling sits below its own cost reads as flaky.

## Things to Look At During PR Review

- **`_ci-extract.sh`, the awk program.** It is the piece most likely to be subtly wrong on a runner nobody here uses. The ladder is ordered and each rung names itself in `matchedBy`, so a wrong answer is at least attributable — but a new runner format falls to `first-error` or to refusal, and the refusal path is the safe one by design.
- **`ci_clean_log`'s sed pipeline.** ANSI/OSC stripping in POSIX `sed` with a literal ESC. It is line-count preserving, which is what makes `from`/`to` usable as line numbers into the raw log; a change that drops or adds a line silently breaks the `ci-run-log` handoff.
- **The Forgejo-15 `tasks-scan` fallback** (`gitea/_ci.sh`). It pages `actions/tasks` filtering on `run_number`, stops the moment it walks past the run, and reports truncation only when it ran out of allowance *before* reaching it. The early stop is what keeps a recent run at one page; the ceiling is a separate, higher knob (`CODEV_CI_TASKS_MAX_PAGES`, default 20) because a page of 50 tasks spans only ~6 runs.
- **`executeForgeCommandDetailed`'s `timedOut`** is derived from `err.killed && err.signal`, not from an exit code — a killed process can still exit with a status, which is the exact confusion #12 documented in `gitea_timeout`.
- **The gzipped fixtures.** They are verbatim captures; the tests assert against traps that only exist because the bytes are real. Regenerating or normalising them would quietly delete the coverage.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-13` → **Review Diff**
- **Build the branch first, and invoke ITS cli** — the globally installed `codev` predates this
  PR and has no `forge` subcommand (`error: unknown command 'forge'`):
  ```bash
  pnpm --filter @cluesmith/codev build
  CODEV_CI_RUN_ID=32515040122 node packages/codev/dist/cli.js forge ci-failures | jq
  # 23 lines out of 2528: the AssertionError, the test file and line, the step name
  ```
  Substitute `node packages/codev/dist/cli.js` for `codev` in every command below. After this
  merges and you reinstall globally, plain `codev forge …` works.
- **The windows**, and that the second call is free (cached):
  ```bash
  CODEV_CI_RUN_ID=32515040122 CODEV_CI_LOG_GREP=AssertionError node packages/codev/dist/cli.js forge ci-run-log | jq '{from,to,matches,matchLines}'
  CODEV_CI_RUN_ID=32515040122 node packages/codev/dist/cli.js forge ci-run-log   # refuses: no window
  ```
- **Loud degradation**, from a Forgejo repo (`~/dev/entriq`):
  ```bash
  CLI=/path/to/this/worktree/packages/codev/dist/cli.js
  CODEV_CI_RUN_ID=11130 node $CLI forge ci-run-view | jq '{jobSource, jobs: (.jobs|length)}'   # works
  CODEV_CI_RUN_ID=11130 node $CLI forge ci-failures | jq '{error, serverVersion, needs}'       # unsupported-server
  node $CLI forge team-activity                                                                # named, exit 3
  node $CLI forge ci-failure                                                                   # unknown, lists valid, exit 2
  ```
- **`codev doctor`** in both repos: four new concepts, `gh` under github, `tea` under gitea.

## Flaky Tests

None skipped. One pre-existing flake was **fixed rather than skipped**:

`packages/codev/src/__tests__/spec-1280-measurement-instrument.test.ts` capped every test at 60 s inline, while `scripts/measure-prompt-surface.sh` costs 25–30 s per invocation and several of those tests invoke it two or three times (two locales, two runs for determinism, a fixture plus the live repo). Under full-suite load a *different* pair failed each run — the signature of a ceiling set below the work, not of a defect. The file passes 24/24 in isolation before and after. Raised to 240 s via one named constant (`INSTRUMENT_TIMEOUT_MS`), which is the same coverage given room; `.skip` would have bought a green run by deleting the check.
