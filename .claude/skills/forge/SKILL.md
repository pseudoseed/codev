# Forge Concept Commands

Forge concept commands decouple codev from direct `gh` CLI calls. Each GitHub operation is routed through a configurable external command.

## Concepts

| Concept | Env Vars | Description |
|---------|----------|-------------|
| `issue-view` | `CODEV_ISSUE_ID` | Fetch issue details (JSON) |
| `pr-list` | — | List open PRs (JSON array) |
| `issue-list` | — | List issues (JSON array) |
| `issue-comment` | `CODEV_ISSUE_ID`, `CODEV_COMMENT_BODY` | Post a comment on an issue |
| `pr-exists` | `CODEV_BRANCH_NAME` | Check if a PR exists for a branch |
| `recently-closed` | `CODEV_SINCE_DATE` (optional) | List recently closed issues |
| `recently-merged` | `CODEV_SINCE_DATE` (optional) | List recently merged PRs |
| `user-identity` | — | Get current user's handle (plain text) |
| `team-activity` | `CODEV_GRAPHQL_QUERY` | Run a batched GraphQL query |
| `on-it-timestamps` | `CODEV_ISSUE_NUMBERS`, `CODEV_GRAPHQL_QUERY`, `CODEV_REPO_OWNER`, `CODEV_REPO_NAME` | Get "on it" comment timestamps |
| `pr-create` | `CODEV_PR_TITLE`, `CODEV_PR_BODY`, `CODEV_PR_BASE` (optional), `CODEV_PR_HEAD` (optional), `CODEV_PR_REPO` (optional), `CODEV_PR_DRAFT` (optional) | Open a PR; prints `{"number", "url"}` |
| `pr-merge` | `CODEV_PR_NUMBER` | Merge a PR |
| `pr-search` | `CODEV_SEARCH_QUERY` | Search PRs (JSON array) |
| `pr-view` | `CODEV_PR_NUMBER`, `CODEV_INCLUDE_COMMENTS` (optional) | View PR details (JSON or text) |
| `pr-diff` | `CODEV_PR_NUMBER`, `CODEV_DIFF_NAME_ONLY` (optional) | Get PR diff |
| `auth-status` | — | Check forge authentication status |
| `ci-runs` | `CODEV_BRANCH_NAME`, `CODEV_CI_STATUS`, `CODEV_CI_WORKFLOW`, `CODEV_CI_LIMIT` (all optional) | List workflow runs (no log bytes) |
| `ci-run-view` | `CODEV_CI_RUN_ID` | One run plus per-job status (no log bytes) |
| `ci-failures` | `CODEV_CI_RUN_ID`, `CODEV_CI_JOB_ID` (optional) | The failing job's assertion, extracted and capped |
| `ci-run-log` | `CODEV_CI_RUN_ID`, `CODEV_CI_JOB_ID` (opt), and exactly one of `CODEV_CI_LOG_TAIL` / `CODEV_CI_LOG_HEAD` / `CODEV_CI_LOG_GREP` | A raw log window |

## CI concepts

Four concepts, **tiered so the cheap question stays cheap**. A builder asks about
CI at four moments and they cost very different amounts:

| Question | Concept | Reads a log? |
|---|---|---|
| Did my push pass? | `ci-runs` | No |
| Is it still running, and which job is pending? | `ci-runs`, `ci-run-view` | No |
| It failed — why? | `ci-failures` | Yes, one job |
| Is this mine or pre-existing? | `ci-runs` with `CODEV_CI_WORKFLOW` | No |
| Extraction gave up — show me the log | `ci-run-log` | Yes, one window |

`ci-run-log` is a separate concept rather than a flag on `ci-failures` on
purpose: a window parameter on the main call gets passed by habit, and then
every status question drags a log again.

### The response envelope

Every ci-* concept prints ONE JSON object on stdout — **on success and on
failure**. Errors are values, not absences, because `executeForgeCommand`
flattens every failure mode to `null`:

```json
{ "ok": false, "error": "timeout", "seconds": 60,
  "detail": "GET repos/o/r/actions/tasks did not return within 60s",
  "remedy": "raise CODEV_FORGE_TIMEOUT" }
```

`error` is one of `timeout`, `not-found`, `unsupported-server`, `forge-error`,
`bad-input`. Use `executeForgeCommandDetailed()` (not `executeForgeCommand`) when
you need to tell a timeout from a failure — it returns `{ok, data, stdout,
stderr, exitCode, timedOut, unavailable, durationMs}` and keeps stdout on the
failure path.

**Any response carrying log text also carries `logLines`, `returnedLines` and
`truncated`.** A trimmed answer must never read as a whole one.

### `ci-failures`, and what it does when it cannot tell

Extraction runs a ladder and names the rung that fired in `matchedBy`:
`vitest`, `go-test`, `tsc`, `runner-marker`, `first-error`. When nothing
matches it does **not** fall back to the last N lines:

```json
{ "extracted": false, "reason": "no recognized failure pattern",
  "failures": [{ "jobId": 11952749, "jobName": "test-unit", "logLines": 1599 }],
  "next": "ci-run-log CODEV_CI_RUN_ID=6554924 CODEV_CI_JOB_ID=11952749 CODEV_CI_LOG_TAIL=80" }
```

A builder handed 50 arbitrary lines treats them as the diagnosis; one told
extraction failed reads the log with the targeted call the response hands it.

### `ci-run-log` windows

Exactly one of `CODEV_CI_LOG_TAIL=N`, `CODEV_CI_LOG_HEAD=N`, or
`CODEV_CI_LOG_GREP=<ere>` (with `CODEV_CI_LOG_CONTEXT`, default 3). Zero or two
is exit 2 — there is deliberately no default. The response carries `from` and
`to` as line numbers into the full log; in grep mode `contiguous` is false and
`matchLines` lists exactly which lines matched.

### Run ids

`CODEV_CI_RUN_ID` is always the **`id`** field from `ci-runs`, never `number`.
On Forgejo the two are separate id spaces and **both resolve on the same
route**, so passing the number silently answers about a different, real run.

### Provider notes

| | GitHub | Forgejo/Gitea |
|---|---|---|
| Runs | `gh run list` | `GET actions/runs` (always with `page=`) |
| Jobs | `gh run view --json jobs` | `GET actions/runs/{id}/jobs` (Forgejo ≥16) or a scan of `actions/tasks` (Forgejo 15) |
| Log | `gh api repos/{owner}/{repo}/actions/jobs/{id}/logs` | `GET actions/jobs/{id}/logs` (**Forgejo ≥16 only**) |
| Per-step data | yes | no — `failedSteps` is always `[]` |
| `conclusion` | yes | always `null`; `status` carries it |

**`gh run view --log-failed` is not used**, despite selecting failed steps in
principle. Measured on run 32515040122 of this repository it returned 2528
lines / 293 KB with every line tagged `UNKNOWN STEP`: it selects the failing
JOB, and its filename-to-step mapping had missed. The per-job log endpoint is
used on both providers instead.

**Forgejo below 16.0 has no Actions log API at all.** `ci-failures` and
`ci-run-log` return `error: "unsupported-server"` there, naming the version
found and the version needed and still listing the failing job names;
`ci-runs` and `ci-run-view` keep working. An old server must never be
mistaken for a run with no failures.

**Forgejo records a `pull_request` run's branch as `#<pr-number>`**, not as a
branch name, and ignores `branch=` on the query. `ci-runs` resolves
`CODEV_BRANCH_NAME` to its PR ref first and filters client-side, so a branch
with no PR gets a `note` saying only push runs can match.

**`gitlab` and `linear` have all four concepts explicitly disabled**, not merely
unimplemented — otherwise they would fall through to the GitHub default and run
`gh` against whatever remote it resolved.

### Log cache

A terminal job's log is immutable, so both log concepts cache it under
`$TMPDIR/codev-ci-logs/<provider>/<repo>/<jobId>.log`. An in-progress job is
never cached or read from cache. `CODEV_CI_NO_CACHE=1` bypasses it.

## Configuration

In `.codev/config.json`:

```json
{
  "forge": {
    "provider": "gitlab",
    "issue-comment": "my-custom-script $CODEV_ISSUE_ID"
  }
}
```

### Resolution order
1. Manual concept override in `forge` section
2. Provider preset (if `provider` is set)
3. Default (GitHub via `gh` CLI)

### Providers

Built-in presets: `github` (default), `gitlab` (via `glab`), `gitea` (via `tea`).

**Note:** Non-GitHub presets are best-effort. Output schemas may differ from GitHub's JSON contracts. Non-conforming JSON returns `null` — consumers handle this gracefully. Override individual concepts if a preset doesn't match your CLI version.

### Gitea / Forgejo specifics

Forgejo has no GitHub-style PR search and charges its `/pulls` list endpoint per
returned PR object (~0.65s each, measured against Forgejo 15.x), so the gitea
scripts avoid list endpoints wherever a targeted one exists.

| Concept | How gitea answers it |
|---|---|
| `pr-exists` | `GET pulls/{base}/{head}` — one request. Base is `CODEV_PR_BASE`, else the repo's default branch. |
| `pr-search` | `head:` queries use the same base/head lookup; issue-number queries search `issues?type=pulls&q=` and then resolve each match. |
| `pr-diff` | `pulls/{n}.diff`, or `pulls/{n}/files` for `CODEV_DIFF_NAME_ONLY=1`. |
| `recently-merged` | `issues?type=pulls&state=closed&since=` (a server-side window), then one `pulls/{n}` per match for the head branch. |
| `team-activity`, `on-it-timestamps` | Disabled, permanently. Both are `gh api graphql` pass-throughs and Forgejo has no GraphQL. Callers say so on stderr rather than returning empty. |

**pr-search query grammar.** The query is parsed, not forwarded. Understood
terms: `head:<branch>`, `is:open`, `is:merged`, `is:closed`, `in:body`, and a
bare issue number (`123` or `#123`). With no `is:` qualifier the search spans
every state, so a merged PR is findable after the fact. Anything outside the
grammar returns `[]` and says so on stderr rather than guessing.

**A merged PR's branch name.** Gitea rewrites `head.ref` to `refs/pull/N/head`
once a merged PR's source branch is deleted, but `head.label` keeps the branch
name. The gitea scripts read `head.label` first, which is what lets `pr-exists`
and `pr-search head:` still find a merged PR.

**Base branches other than the default.** `pr-exists` and `pr-search head:` need
a base branch. They use the repository's default unless `CODEV_PR_BASE` is set,
so a PR targeting an integration branch needs that variable.

### Environment overrides

| Variable | Default | Effect |
|---|---|---|
| `CODEV_REPO` | derived from `origin` | `owner/repo` for the gitea scripts |
| `CODEV_PR_BASE` | the repo's default branch | base branch for `pr-exists` / `pr-search head:` |
| `CODEV_FORGE_TIMEOUT` | 60 | seconds before a single `tea api` call is killed and reported |
| `CODEV_FORGE_PAGED_DEADLINE` | 120 | seconds before a paged walk stops early (exit 3) |
| `CODEV_FORGE_CONCURRENCY` | 8 | parallel PR fetches |
| `CODEV_FORGE_MERGED_DAYS` | 7 | `recently-merged` window when `CODEV_SINCE_DATE` is unset |
| `CODEV_FORGE_MERGED_MAX` | 300 | merged PRs `recently-merged` will resolve before refusing |
| `CODEV_FORGE_SEARCH_MAX` | 10 | PRs `pr-search` resolves for one issue number |
| `CODEV_CI_LIMIT` | 20 | runs `ci-runs` returns |
| `CODEV_CI_MAX_PAGES` | 4 | pages `ci-runs` walks while filtering client-side |
| `CODEV_CI_TASKS_MAX_PAGES` | 20 | pages the Forgejo-15 task scan walks (it stops early once past the run) |
| `CODEV_CI_MAX_STEP_BYTES` | 2048 | cap on one extracted failure |
| `CODEV_CI_MAX_BYTES` | 8192 | cap on a whole ci-* response |
| `CODEV_CI_NO_CACHE` | unset | `1` disables the log cache |
| `CODEV_CI_CACHE_MAX_MB` | 32 | largest log that will be cached |

### Exit statuses

`0` is an answer and `1` is a failure, as usual. **`3` means the result was
truncated**, and the concept prints nothing on stdout when it returns it: a
partial list is indistinguishable from a complete one once printed, so "nothing
matched" (`[]`, status 0) and "I stopped looking" (status 3) are deliberately
different. `2` is a missing or unusable input.

### Disabling concepts

Set a concept to `null` to disable it:
```json
{
  "forge": {
    "team-activity": null
  }
}
```

## Validation

Run `codev doctor` to see forge concept status, provider, and validation results.

## Code

- **Dispatcher**: `packages/codev/src/lib/forge.ts`
- **Contracts**: `packages/codev/src/lib/forge-contracts.ts`
- **Spec**: `codev/specs/589-non-github-repository-support.md`
