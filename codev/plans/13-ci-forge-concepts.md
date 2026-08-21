# PIR Plan: CI concepts for the forge layer — `ci-runs`, `ci-run-view`, `ci-failures`, `ci-run-log`

Issue: #13 · Branch: `builder/pir-13` · Verification targets: `pseudoseed/codev` on GitHub (`gh` 2.87.0), `~/dev/entriq` (live Forgejo **15.0.2**, `tea` 0.14.2), and `codeberg.org/forgejo/forgejo` (live Forgejo **16.0.0-dev**, public, unauthenticated).

## Understanding

A builder asking "why did CI fail" currently shells out and pastes log text into its context. `KNOWN_CONCEPTS` (`packages/codev/src/lib/forge.ts:65-70`) has 18 concepts and none of them touch workflow runs. The issue and its two comments ask for four concepts, tiered so that only one of them ever fetches a log:

| Question | Concept | Fetches a log? |
|---|---|---|
| Did my push pass? | `ci-runs` | No |
| Is it still running / which job is pending? | `ci-runs`, `ci-run-view` | No |
| It failed — why? | `ci-failures` | Yes, one job |
| Is this mine or pre-existing? | `ci-runs` (same workflow, other commits) | No |
| Extraction gave up — show me the log | `ci-run-log` (deliberate, separate) | Yes, windowed |

I spent the investigation measuring the two providers rather than reasoning about them, because the issue's premises about both turned out to be **wrong in ways that change the design**.

---

## What is actually true, measured 2026-08-21

### 1. `gh run view --log-failed` does NOT narrow to the failing step

The issue says GitHub "already does the extraction for you." It does not, at least not here. Against a real failing run in this repository:

```
gh run view 32515040122 --log-failed   →  2528 lines, 293 KB, 2.0 s
```

Every one of those 2528 lines is labelled `UNKNOWN STEP`:

```
Unit Tests	UNKNOWN STEP	2026-08-21T18:47:09.5820646Z Current runner version: '2.336.0'
```

`--log-failed` selected the failing **job** and returned all of it. `gh` maps log files to steps by name and falls back to `UNKNOWN STEP` when that mapping fails, which is what happened. **293 KB is precisely the context bomb this issue exists to prevent**, so codev must do its own extraction on GitHub too — the same extractor both providers use. What `--log-failed` still buys is job selection: it is one call, and it never returns a passing job's log.

### 2. The naive extraction heuristics both pick the wrong line on that same log

The real failure is at line 2471 of 2528:

```
2471: FAIL src/commands/consult/__tests__/agy-auth-cache.test.ts > gemini lane burst behaviour (#1077 regression)
2472: AssertionError: expected null to be 'unauth' // Object.is equality
2491: Test Files  1 failed | 276 passed
2497: ##[error]AssertionError: expected null to be 'unauth' // Object.is equality
```

- **"First line matching an error pattern"** returns line 1257: `[artifact-canvas] Error: host blew up` — a fixture string printed by a **passing** test. A builder handed that would go debugging a host crash that never happened.
- **"Last N lines"** happens to work on this log and would not on the next one; the run's tail here is git-submodule cleanup and a Node deprecation warning.
- **`Test Files …`** appears **five** times, the first four all `passed` (lines 296, 317, 1450, 1477). Matching the first is wrong; the summary that matters is the one containing `failed`.
- Every payload line is wrapped in ANSI SGR codes — the raw bytes are `\e[41m\e[1m FAIL \e[22m\e[49m src/…`. **A matcher that does not strip ANSI first matches nothing at all.** This is the single most likely way for an extractor to silently return `extracted: false` on a log that plainly contains the answer.
- GitHub emits `##[error]` at the true failure (2 occurrences, both real). On GitHub that marker is the highest-precision signal available and costs nothing.

### 3. Forgejo 15.0.2 has **no Actions log API at all**, and `tea actions` is broken against it

`tea actions runs list --status failure --output json` works but is **lossy** — `workflow`, `branch`, `started` and `duration` all come back empty strings:

```json
{ "id": "11130", "status": "failure", "workflow": "", "branch": "", "event": "pull_request", "started": "", "duration": "" }
```

The other two subcommands from the issue do not work at all against this server:

```
tea actions runs view 11130   → Error: failed to get jobs: unknown API error: 404
                                 GET /api/v1/repos/pseudoseed/entriq/actions/runs/11130/jobs
tea actions runs logs 6881 --job 40084
                              → Error: failed to get logs for job 40084: unknown API error: 404
                                 GET /api/v1/repos/pseudoseed/entriq/actions/jobs/40084/logs
```

Both routes 404 because **they were added in Forgejo v16.0** (released 2026-07-16); `git.pseudoseed.com` reports `15.0.2+gitea-1.22.0`. I probed every plausible alternative on 15.0.2 — `actions/runs/{id}/jobs`, `actions/runs/{n}/jobs/{j}/logs`, `actions/tasks/{id}`, `actions/tasks/{id}/logs`, `actions/jobs/{id}`, `actions/artifacts`, `actions/workflows` — all 404. The web UI's own log route (`/{owner}/{repo}/actions/runs/{n}/jobs/{j}/logs`) exists but is **session-only**: it rejects both `Authorization: token` and HTTP basic auth with the API token (the API accepts the same token fine — verified as a control). There is no token-reachable path to a log on 15.0.2.

So on this fork's own reference Forgejo, `ci-failures` and `ci-run-log` **cannot work**. That is a fact about the server, not a gap in the implementation, and the only correct response is to say so by name — see "the version gate" below.

### 4. What Forgejo 15.0.2 *does* have, and what it costs

| Endpoint | What it returns | Measured |
|---|---|---|
| `actions/runs?page=1&limit=N` | runs, each embedding a **full repository object** | 0.30 s / 3.8 KB at N=1; 0.33 s / **892 KB** at N=50 |
| `actions/runs/{id}` | one run | 0.3 s |
| `actions/tasks?page=1&limit=N` | **jobs**, GitHub-shaped (`id`, `name`, `head_branch`, `head_sha`, `run_number`, `status`, `workflow_id`, `url`) | 0.22 s / 507 B at N=1; 0.30 s / 24 KB at N=50 |

Unlike `/pulls` in #12, these are priced **per request, not per item** — 50 runs cost the same 0.3 s as one. The cost is bytes, not seconds: `actions/runs` is 17.8 KB per run because of the embedded repo object, so it must be reduced with `jq` immediately. `actions/tasks` is 482 B per job and is the better list to build on.

Three query-parameter facts, all measured, all footguns:

- **`limit` is ignored unless `page` is also present.** `actions/runs?limit=3` returned **all 6922 runs**; `actions/runs?page=1&limit=3` returned 3. That is a #12-class hazard sitting in a default.
- **`status=` is honoured server-side** (`status=failure` → `total_count` 1541 of 6922).
- **`branch=` and `event=` are silently ignored** on both endpoints. Filtering by branch must happen client-side.
- `actions/tasks` caps at 50 per page regardless of `limit`.

And the branch itself is not what you would expect: for `pull_request` runs, Forgejo reports `head_branch` / `prettyref` as **`#3847`** — the PR number, not the branch name. Only `push`/`schedule` runs carry a real branch. In the first 100 tasks on entriq: `#3869`×32, `#3865`×10, `main`×7, `v1.0.230`×1. So `CODEV_BRANCH_NAME=builder/pir-13` matches **nothing** on a repo that runs CI on pull requests unless the branch is first resolved to its PR number.

Finally, Forgejo has **two id spaces** and both are valid inputs to the same route: run `id` 11130 has `index_in_repo` 6881, and `actions/runs/6881` resolves to a *different* run (a real one, whose own index is 4258). The web URL shows the index. A concept that guessed would confidently answer about the wrong run.

### 5. Forgejo 16 does have it — verified live, unauthenticated

`codeberg.org` runs `16.0.0-dev-694` and `forgejo/forgejo` is public with real Forgejo Actions history, so the v16 code path can be verified for free:

| Call | Result |
|---|---|
| `GET repos/forgejo/forgejo/actions/runs/6554924/jobs` | JSON array of jobs: `id`, `task_id`, `name`, `status`, `needs`, `runs_on` |
| `GET repos/forgejo/forgejo/actions/jobs/11952749/logs` | **200**, `text/plain`, 142 KB, 1599 lines, 1.02 s, `accept-ranges: bytes` |
| the same with `?step=3` | **byte-identical** — `?step=` is not honoured on this build |
| `GET repos/forgejo/forgejo/actions/runs/6554924/logs` | 200, `application/zip`, 522 KB, every job's log |

Two things to carry into the design: the log endpoint takes the **job `id`** (11952749), *not* the `task_id` (8848703) that `actions/tasks` lists — passing the task id returns `{"message":"resource does not exist"}`, which is exactly the sort of 404 that reads as "no logs" if it is not distinguished. And `accept-ranges: bytes` means a tail can be fetched as a byte range instead of downloading 142 KB to print 50 lines.

---

## Proposed Change

Four concepts, one shared extraction contract, and a hard rule that **every response is a JSON envelope that says how much of the truth it contains**.

### The envelope

Every ci-* concept prints one JSON object on stdout, on success *and* on failure, so a caller always gets something structured and never has to interpret an empty string:

```jsonc
// ci-failures, extraction succeeded
{
  "ok": true, "provider": "github", "runId": 32515040122,
  "failures": [{
    "jobId": 96874679182, "jobName": "Unit Tests",
    "stepName": "Run unit tests with coverage", "stepNumber": 15,
    "matchedBy": "vitest",                 // which rung of the ladder fired
    "text": "FAIL src/…/agy-auth-cache.test.ts > gemini lane burst…\nAssertionError: expected null to be 'unauth'…",
    "logLines": 2528, "returnedLines": 24, "truncated": false
  }],
  "jobsFailed": 1, "truncated": false
}

// ci-failures, extraction gave up — a HANDOFF, not a dead end (issue comment 2)
{
  "ok": true, "provider": "gitea", "runId": 11130,
  "extracted": false, "reason": "no recognized failure pattern",
  "failures": [{ "jobId": 11952749, "jobName": "test-unit", "logLines": 1599 }],
  "next": "ci-run-log CODEV_CI_RUN_ID=11130 CODEV_CI_JOB_ID=11952749 CODEV_CI_LOG_TAIL=80"
}

// any concept, transport failure — a timeout is NEVER an empty result
{ "ok": false, "error": "timeout", "seconds": 60,
  "detail": "GET repos/pseudoseed/entriq/actions/tasks did not return within 60s",
  "remedy": "raise CODEV_FORGE_TIMEOUT" }

// gitea, server too old
{ "ok": false, "error": "unsupported-server", "serverVersion": "15.0.2+gitea-1.22.0",
  "needs": ">=16.0",
  "detail": "this Forgejo has no Actions job-log API (added in Forgejo 16.0); ci-runs and ci-run-view still work" }
```

`logLines` / `returnedLines` / `truncated` are on **every** response that returns log text, per the issue. Never a bare array, never a bare string.

**Exit statuses** keep the #12 contract — `0` answered, `1` could not answer, `2` bad input — with one addition specific to these concepts: **the JSON envelope is printed on stdout even when the exit status is non-zero**, because "the concept failed" and "the concept failed *because the API timed out at 60 s*" must not be the same observation. stderr still carries the one-line human message.

### `ci-runs` — the cheap question

Inputs: `CODEV_BRANCH_NAME` (opt), `CODEV_CI_STATUS` (opt: `success|failure|pending|queued|in_progress|skipped|canceled`), `CODEV_CI_LIMIT` (opt, default 20), `CODEV_CI_WORKFLOW` (opt — the "is it mine or flaky" filter).

Output: `{ ok, provider, runs: [{ id, number, name, workflow, status, conclusion, branch, sha, event, url, createdAt }], truncated }`.

- **github**: one `gh run list --json …` call (measured 0.7 s), `--branch`/`--status`/`--workflow`/`--limit` passed through.
- **gitea**: `actions/runs?page=1&limit=N&status=…`, always with `page=1` (see the `limit` footgun), reduced by `jq` on the way out. `status` server-side; `branch` **client-side**, and when `CODEV_BRANCH_NAME` is set and the repo runs CI on pull requests, the branch is first resolved to its PR number with the base/head lookup #12 already built (`gitea_default_branch` + `pulls/{base}/{head}`, ~1 s), then matched against `#N` as well as the literal branch. `conclusion` is emitted as `null` — Forgejo has no such field; `status` carries `failure`/`success` — and this asymmetry is documented rather than faked.
- The client-side branch filter walks at most `CODEV_CI_MAX_PAGES` (default 4 → 200 runs) and sets `truncated: true` with a stderr line if it stops early. It never returns a short list that reads as a complete one.

### `ci-run-view` — status per job, still no log

Input: `CODEV_CI_RUN_ID` (required). Output: the run plus `jobs: [{ id, name, status, conclusion, startedAt, completedAt, failedSteps: [{ name, number, conclusion }] }]`.

- **github**: `gh run view <id> --json jobs,status,conclusion,headBranch,headSha,workflowName,url,displayTitle` — 1.3 s, and it already carries per-step conclusions, so `failedSteps` is a `jq` filter over data we already paid for.
- **gitea, Forgejo ≥16**: `actions/runs/{id}` + `actions/runs/{id}/jobs`. Job `id` (not `task_id`) is what the output carries, because that is what the log endpoint takes.
- **gitea, Forgejo 15**: `actions/runs/{id}` gives `index_in_repo`; jobs are recovered by scanning `actions/tasks` for `run_number == index_in_repo`, bounded to `CODEV_CI_MAX_PAGES`. The response says which route answered (`"jobSource": "runs/jobs" | "tasks-scan"`) so a reader knows whether it is seeing the server's own grouping or ours. Forgejo has no per-step data on either version, so `failedSteps` is `[]` there — stated in the output, not silently omitted.

`CODEV_CI_RUN_ID` is always the **API id** from `ci-runs`'s `id` field, never the URL number. `ci-runs` emits both `id` and `number` and the docs say which to pass; the two-id-space ambiguity above is why the concept refuses to guess.

### `ci-failures` — the one that matters

Input: `CODEV_CI_RUN_ID` (required), `CODEV_CI_JOB_ID` (opt, to pin one job).

1. Find the failing jobs (from `ci-run-view`'s data, one call).
2. Fetch **only the first failing job's** log — `gh run view --log-failed` on GitHub (job-scoped, one call), `actions/jobs/{id}/logs` on Forgejo ≥16. "Prefer the FIRST failing step in the first failing job" per the issue; later failures are usually downstream. Other failing jobs are *listed* (name + id) but not fetched, and the response says so.
3. Strip ANSI, strip the `job\tstep\t` prefix and the leading RFC3339 timestamp, then run the ladder.
4. Cap: **2 KB per failing step, 8 KB per response**, `truncated: true` when either bites.

**The extraction ladder** (first rung that matches wins, and the response names the rung in `matchedBy`):

| Rung | Matches | Returns |
|---|---|---|
| 1. `runner-marker` | `##[error]` (GitHub) | the marker line plus 3 lines of leading context |
| 2. `vitest` / `jest` | `FAIL <path> > <name>` and/or `AssertionError:` / `expected … to …`, anchored by the `Test Files … failed` summary — **the one containing `failed`**, not the first | the `Failed Tests` block from the first `FAIL` to the summary |
| 3. `tsc` | `error TS####:` | the first such line plus following lines of the same diagnostic |
| 4. `first-error` | first `^Error:` / `error:` / `Exception` **after the last passing-suite boundary**, never the first in the file | the line plus 3 either side |
| 5. give up | — | `extracted: false` + `jobId`, `jobName`, `logLines`, and a ready-to-run `next` |

Rung 4 is deliberately weaker than "first match in the file": on the real log above, the unqualified version returns a passing test's fixture string from line 1257. The rule is only allowed to fire after the last recognisable "N passed" boundary, and if there is no such boundary it falls to rung 5 rather than guessing. **Rung 5 never returns arbitrary lines.** A builder that receives 50 unexplained lines treats them as the diagnosis; one told extraction failed goes and looks, which is correct and cheaper.

### `ci-run-log` — the deliberate escape hatch

Input: `CODEV_CI_RUN_ID`, `CODEV_CI_JOB_ID` (opt — defaults to the first failing job, else the only job), and **exactly one** window: `CODEV_CI_LOG_TAIL=N`, `CODEV_CI_LOG_HEAD=N`, or `CODEV_CI_LOG_GREP=<ere>` with `CODEV_CI_LOG_CONTEXT` (default 3). Zero windows or more than one is exit 2 with a named message — not a silent default, because a defaulted window is how this becomes "tail by habit," which the issue's second comment exists to prevent.

Output: `{ ok, runId, jobId, jobName, logLines, returnedLines, from, to, truncated, lines: [...] }`. Same 8 KB response cap. `from`/`to` are 1-based line numbers into the full log, so a builder always knows where it is standing.

It is a separate concept, not a flag on `ci-failures`, for exactly the reason the issue gives.

### Caching

A completed run's log is immutable. Both log-fetching concepts cache the **raw** log to `${TMPDIR}/codev-ci-logs/<provider>/<repo-slug>/<jobId>.log`, and read from it when present, **only when the job's status is terminal** (`success|failure|skipped|canceled`). An in-progress job is never cached and never read from cache. `CODEV_CI_NO_CACHE=1` bypasses; entries over `CODEV_CI_CACHE_MAX_MB` (default 32) are not written. This makes the realistic sequence — `ci-failures`, then `ci-run-log … TAIL`, then `ci-run-log … GREP` — cost exactly one download.

### Timeouts, and making a timeout say "timeout"

Three layers, because the current stack loses the distinction at every one of them:

1. **Scripts.** gitea routes through `gitea_api` (#12's watchdog, `CODEV_FORGE_TIMEOUT`, default 60 s). GitHub has no equivalent today: `github/*.sh` call `gh` bare. I will extract #12's `gitea_timeout` into `scripts/forge/_timeout.sh`, source it from both providers, and wrap every `gh` call in the new scripts. Existing github scripts are left alone — retrofitting them is a separate change.
2. **Envelope.** Timeout ⇒ `{"ok":false,"error":"timeout","seconds":N,…}` on stdout, message on stderr, exit 1.
3. **Dispatcher.** `executeForgeCommand` returns `null` for every failure mode (`forge.ts:390-403`), so a timeout, a crash and unparseable output are one value. I will add `executeForgeCommandDetailed()` returning `{ ok, data, stdout, stderr, exitCode, timedOut, durationMs }` — non-destructive, existing callers untouched — and have it set `timedOut` from `err.killed`/`err.signal`, which #12 verified fires reliably at the Node level. Without this the shell layer can be as honest as it likes and the TS layer still flattens it to `null`.

### gitlab and linear must be *disabled*, not absent

`buildPresetFromScripts` only sets keys for concepts that have a script, and `getForgeCommand` falls back to the **github default** for anything unset (`forge.ts:280-296`). So adding four concepts without touching those presets would make a GitLab repo silently run `gh run list` — the exact silent-fallthrough class #1455 closed. All four go in the disabled list for `gitlab` and `linear`, so they resolve as `disabled` and `describeUnavailableConcept` names the provider.

### Commits

1. `_timeout.sh` extraction + `executeForgeCommandDetailed` + `KNOWN_CONCEPTS` + preset disables (github/gitea unblocked, gitlab/linear explicitly null).
2. GitHub scripts: `ci-runs`, `ci-run-view`, `ci-failures`, `ci-run-log` + the shared extractor.
3. Gitea scripts: the same four, with the version gate and the 15-vs-16 job-source fallback.
4. Tests, both `SKILL.md` twins, `arch.md` / `lessons-learned.md` routing.

---

## Files to Change

- `packages/codev/src/lib/forge.ts:65-70` — add `ci-runs`, `ci-run-view`, `ci-failures`, `ci-run-log` to `KNOWN_CONCEPTS`.
- `packages/codev/src/lib/forge.ts:126-135` — add all four to the disabled lists for `gitlab` and `linear`; leave `gitea` enabled.
- `packages/codev/src/lib/forge.ts:390-403` — new `executeForgeCommandDetailed()` beside `executeForgeCommand`.
- `packages/codev/src/lib/forge-contracts.ts` — `CiRunItem`, `CiRunViewResult`, `CiFailuresResult`, `CiRunLogResult`, and the shared `CiError`.
- `packages/codev/scripts/forge/_timeout.sh` — **new**, `gitea_timeout` lifted verbatim (it is provider-neutral) with its comments; `gitea/_lib.sh` sources it instead of defining it.
- `packages/codev/scripts/forge/_ci-extract.sh` — **new**, the ANSI-stripping extraction ladder, shared by both providers so they cannot drift.
- `packages/codev/scripts/forge/github/{ci-runs,ci-run-view,ci-failures,ci-run-log}.sh` — **new** (mode 755; `bugfix-693-forge-exec-bit.test.ts` pins the bit).
- `packages/codev/scripts/forge/gitea/{ci-runs,ci-run-view,ci-failures,ci-run-log}.sh` — **new**.
- `packages/codev/src/__tests__/pir-13-ci-concepts.test.ts` — **new**.
- `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md` — the concept table, the env-var table, the envelope, the Forgejo-16 requirement. Byte-identical; the twin test from #12 covers it.
- `codev/resources/arch.md` (§ Integration Points → Forge Concept Commands) — the measured Forgejo facts. `codev/resources/lessons-learned.md` — the extraction lesson. Hot-tier promotion only if it displaces something; likely not.
- `codev/reviews/13-ci-forge-concepts.md` — at review time.

No `codev-skeleton/` mirror: forge scripts and `SKILL.md` are single-source (established in #12).

---

## Risks & Alternatives Considered

- **Risk: `ci-failures` cannot work on the fork's own reference Forgejo.** entriq is 15.0.2 and the log API is 16.0+. Mitigation: the version gate returns `error: "unsupported-server"` naming both versions, `ci-runs`/`ci-run-view` keep working there, and the v16 path is verified against Codeberg. This is loud degradation, which is what the issue asks for from `gitlab`; it would be dishonest to hide it for gitea. **If `git.pseudoseed.com` is upgraded to Forgejo 16, the same code starts working with no change.**
- **Risk: the extractor is tuned to the two logs I have.** Mitigation: both are captured as fixtures (a 2528-line GitHub vitest failure and a 1599-line Forgejo `test-unit` failure), the ladder names its rung in `matchedBy`, and rung 5 is a first-class outcome rather than a fallback into guessing. When it is wrong it says so.
- **Risk: `##[error]` is GitHub-only.** Forgejo runners do not emit it. Rungs 2-4 carry Forgejo, which is why the ladder is shared rather than per-provider.
- **Alternative rejected: parse `gh run view --log-failed`'s step column.** It is `UNKNOWN STEP` on the very first run I tested. Step attribution comes from `--json jobs` instead, which is structured and reliable.
- **Alternative rejected: a `tail` flag on `ci-failures`.** The issue's second comment gives the reason and I agree with it: a flag gets passed by habit and every status question starts dragging a log.
- **Alternative rejected: implementing via `tea actions …` subcommands.** They are broken against 15.0.2 and lossy where they work. `tea api` is the load-bearing surface, as #12 established.
- **Alternative rejected: caching under `.codev/`.** Logs are large and disposable; `$TMPDIR` avoids polluting a repo and inherits OS cleanup.
- **Risk: response caps hide the answer.** Mitigation: `truncated` is always present, and `ci-run-log` exists precisely so the next call is targeted rather than blind.

---

## Test Plan

**Unit** (`pir-13-ci-concepts.test.ts`, stubbing `gh`/`tea` on `PATH`, the #12 pattern):

1. Extraction against the **real captured** 2528-line GitHub log: returns the `agy-auth-cache` assertion, and specifically **not** `[artifact-canvas] Error: host blew up` (line 1257) and **not** the four passing `Test Files` summaries.
2. ANSI-wrapped `FAIL`/`AssertionError` still match (the raw fixture bytes carry the escapes).
3. A log with no recognisable failure ⇒ `extracted: false` with `jobId`/`jobName`/`logLines`/`next`, and **zero** log lines in the payload.
4. Caps: a >2 KB step extract sets `truncated: true`; `returnedLines < logLines`.
5. `ci-run-log`: zero windows ⇒ exit 2; two windows ⇒ exit 2; tail/head/grep return correct `from`/`to`; grep honours `CODEV_CI_LOG_CONTEXT`.
6. A stub that sleeps past `CODEV_FORGE_TIMEOUT` ⇒ `{"ok":false,"error":"timeout"}` on stdout, non-zero exit, and `executeForgeCommandDetailed().timedOut === true`.
7. gitea `ci-runs` sends `page=1` (the `limit`-ignored footgun) and never calls a bare `actions/runs?limit=`.
8. gitea `ci-runs` with `CODEV_BRANCH_NAME` matches a `#<PR>` `head_branch`, not just a literal branch.
9. `ci-failures` on a Forgejo-15 stub ⇒ `error: "unsupported-server"` with both versions named; `ci-run-view` on the same stub still answers via the tasks scan and reports `jobSource: "tasks-scan"`.
10. `resolveAllConcepts` reports all four as `disabled` for `gitlab` and `linear`, and as `preset` for `gitea`.
11. Exec bit on all eight new scripts; `SKILL.md` twins byte-identical.

**Live, through the real dispatcher** (config load → preset → env → script → JSON parse), with timings reported in the review the way #12 did:

- **GitHub / `pseudoseed/codev`**: `ci-runs` (all, by branch, `--status failure`), `ci-run-view` on run 32515040122, `ci-failures` on the same run (must return the assertion, not 293 KB), `ci-run-log` tail/head/grep, and a second `ci-failures` proving the cache makes it free.
- **Forgejo 15.0.2 / `~/dev/entriq`**, bare `gitea` preset, no overrides: `ci-runs` unfiltered, `--status failure`, and by branch via the PR-number mapping; `ci-run-view` on run 11130 via the tasks scan; `ci-failures` and `ci-run-log` returning the named `unsupported-server` envelope. entriq's config is read-only for this — nothing is written to it.
- **Forgejo 16 / `codeberg.org/forgejo/forgejo`**: the v16 log path end-to-end on run 6554924 / job 11952749. See the open question below about how deep this can go.

**Manual, at the `dev-approval` gate**: `codev doctor` in this worktree and in entriq shows the four concepts with the right source per provider; a deliberately broken `CODEV_CI_RUN_ID` produces a named error rather than an empty object.

---

## Open Questions for the Architect

1. **Codeberg token.** The gitea v16 log path is verified at HTTP level today (unauthenticated curl against `codeberg.org`, timings above). Driving it through the **real dispatcher** needs `tea` to have a login for codeberg, and `tea` requires a token to add one. If you have a Codeberg read-only token, that lane becomes a full end-to-end verification instead of an HTTP-level one. If not, I ship with the HTTP-level verification plus fixture tests and say exactly that in the review.
2. **Is a Forgejo 16 upgrade for `git.pseudoseed.com` on the cards?** It does not change the code — the same scripts light up — but it changes whether `ci-failures` is usable on entriq the day this merges, and I would rather the review state the real situation than a hopeful one.
