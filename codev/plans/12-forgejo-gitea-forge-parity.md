# PIR Plan: Forgejo/Gitea forge parity — pr-search, pr-diff, and the pr-exists hang

Issue: #12 · Branch: `builder/pir-12` · Verification target: `~/dev/entriq` (live Forgejo 15.x at `git.pseudoseed.com/pseudoseed/entriq`, tea 0.14.2)

## Understanding

Three gaps keep a Forgejo repo from running on the bare `gitea` preset.

### 1. `pr-exists` does not hang — it takes about seventeen minutes

I reproduced it live and measured the cost. It is not auth, not connectivity, and not an infinite loop.

`packages/codev/scripts/forge/gitea/pr-exists.sh:27` calls `tea_api_paged "repos/${REPO}/pulls" "state=all"`, and `_lib.sh:56-75` walks every page at 50 items per page up to `GITEA_MAX_PAGES=100`. The per-request cost on Forgejo's `/pulls` list is **linear in the number of PR objects returned**, not per request:

| request | time |
|---|---|
| `GET /repos/pseudoseed/entriq/issues/1` | 0.59 s |
| `GET .../pulls?state=all&limit=1` | 0.78 s |
| `GET .../pulls?state=open&limit=1` | 0.94 s |
| `GET .../pulls?state=all&limit=50` | **32.8 s** |

That is ≈0.65 s per PR object — Forgejo materialises head/base commit info per pull on this endpoint. `x-total-count` on `.../pulls?state=all` reports **1599 PRs** in entriq, so `tea_api_paged` issues 32 requests totalling ≈17 minutes, on top of `jq -s 'add'` re-serialising the whole accumulator once per page (O(n²) on 1599 items). Killing at 25 s and at 120 s both land inside that window with nothing on stdout, which is exactly what was reported.

Two consequences for the design:

- **Raising the page size cannot fix this.** The cost is per item, so any approach that enumerates PRs pays ≈17 minutes on this repo. The fix has to stop enumerating.
- **In-process the symptom is different from the symptom that was reported.** `executeForgeCommand`/`executeForgeCommandSync` both pass `timeout: 30_000` (`forge.ts:335`, `forge.ts:378`), and I verified with a minimal repro that Node's `exec` timeout does fire even when a grandchild holds the stdout pipe (`sh -c "sleep 60 | cat"` rejected at 3009 ms under a 3 s timeout, `killed=true`). So under porch the `pr_exists` check does not hang — it fails after 30 s with `output: "null"` (`checks.ts:360-375`), which reads as "no PR exists" rather than "the concept could not answer". The unbounded hang is only visible when the script is run directly from a shell, which is how it was found. Both symptoms need fixing: the script needs its own timeout, and the check needs to distinguish "answered false" from "could not answer".

### 2 & 3. `pr-search` and `pr-diff` are disabled for gitea

`forge.ts:129` lists both in `buildPresetFromScripts('gitea', [...])`, which sets them to `null`. No gitea scripts exist. Forgejo has cheap endpoints for both — I verified all of them live (timings below).

### The fast primitive for branch→PR lookup

`GET /repos/{owner}/{repo}/pulls/{base}/{head}` answers "is there a PR from this branch" in one request, and it survives the caveat documented at `gitea/pr-exists.sh:16-20`. That caveat says a merged PR whose source branch was deleted reports `head.ref == "refs/pull/N/head"`, so branch-name matching misses it. True — but **`head.label` retains the original branch name**, and the base/head endpoint matches on the stored head branch, not on `head.ref`. Verified against a merged PR whose branch is gone:

```
GET /repos/pseudoseed/entriq/pulls/3869
  → state=closed  merged=true  head.ref="refs/pull/3869/head"  head.label="builder/aspir-3860"

GET /repos/pseudoseed/entriq/pulls/main/builder/aspir-3860
  → 200 in 1.19 s, returns PR 3869
GET /repos/pseudoseed/entriq/pulls/main/builder/air-364
  → 200 in 0.98 s, returns PR 3855 (open)
GET /repos/pseudoseed/entriq/pulls/main/no-such-branch-xyz
  → 404 in 0.28 s
```

Slashes in the head branch pass through unencoded (`.../pulls/main/builder/air-364` works), so no URL-escaping is needed. This makes the current scan-and-filter approach obsolete for both `pr-exists` and the `head:` form of `pr-search`: 1 request, ~1 s, and it is *more* correct than the scan because it finds merged PRs with deleted branches.

Its one limitation: it needs a base branch. Codev PRs target the default branch except for the sequential-PR case (branch from an integration branch). Handled below.

### Other verified endpoints

| purpose | endpoint | time |
|---|---|---|
| full diff | `GET /repos/{o}/{r}/pulls/{n}.diff` | 0.30 s |
| changed files | `GET /repos/{o}/{r}/pulls/{n}/files` | 0.51 s |
| search PRs by text | `GET /repos/{o}/{r}/issues?type=pulls&state=all&q=<term>` | 0.62 s |
| PR list metadata only | `GET /repos/{o}/{r}/issues?type=pulls&state=all&limit=50` | 1.75 s |

Note the last row against the 32.8 s in the first table: the `issues?type=pulls` view of the same 50 PRs is **19× cheaper** because it skips the commit materialisation. It carries `pull_request.merged` and `pull_request.merged_at` but no head/base refs, so it is the right index to search and the wrong shape to return — matches get their refs from a per-number `GET /pulls/{n}` (~0.3 s each).

### What upstream cluesmith/codev#1331 establishes

#1331 (open, unmerged; no PR against it in the fork) fixes `pr-search` to search all PR states, because `gh pr list --search` defaults to `--state open` and post-merge `consult --type pr` therefore failed with "No PR found for branch". Our fork still carries the unfixed `github/pr-search.sh` and `gitlab/pr-search.sh`.

The review on #1331 is as load-bearing as the fix, and I am taking three things from it:

1. **All-states breaks a caller.** `spawn-worktree.ts:592` queries `in:body #${issueNumber}` and relies on pr-search's open-only default to mean "open PRs". Under all-states it aborts every re-spawn with a factually wrong "Found N open PR(s)". The required fix is to make that call site say what it means: `in:body #${issueNumber} is:open`.
2. **Explicit `is:` qualifiers must override the default state.** `cleanup.ts:340-347` already depends on this with `head:X is:merged` / `head:X is:open`.
3. **`prs[0]` is not necessarily the live PR** once results span states. `PrSearchItem` (`forge-contracts.ts:113`) carries no `state`, so callers cannot defend themselves. Upstream filed this as a follow-up; since I am writing a search implementation from scratch I will order results deterministically (open first, then most recent) and add optional `state` and `baseRefName` to the contract.

Consequently the gitea `pr-search.sh` must parse a small query grammar rather than passing a string to a search engine that does not exist on Forgejo. The five query forms actually used in this codebase are:

| call site | query |
|---|---|
| `consult` `findPRForCurrentBranch` (index.ts:1947) | `head:<branch>` |
| `consult` `findPRForIssue` (index.ts:1975) | `<issue-number>` |
| `cleanup` merged check (cleanup.ts:341) | `head:<branch> is:merged` |
| `cleanup` open check (cleanup.ts:347) | `head:<branch> is:open` |
| `spawn-worktree` (spawn-worktree.ts:592) | `in:body #<issue>` → becomes `in:body #<issue> is:open` |

### Out of scope, per the issue

`team-activity` and `on-it-timestamps` stay `null` for gitea. Both are `exec gh api graphql` pass-throughs and Forgejo has no GraphQL. But the issue also asks that callers "degrade loudly rather than silently", and today one of them does not:

- `fetchOnItTimestamps` (`github.ts:338-345`) reads `forgeConfig?.['on-it-timestamps']` to decide whether a custom command is configured. For a gitea repo the key is absent from user config (it is `null` in the *preset*, not the config), so `customCmd === undefined` and it falls through to the GraphQL path, calls the concept, gets `null` back, and `continue`s — an empty map with nothing on stderr. Silent.
- `fetchTeamGitHubData` (`team-github.ts:337`) does return `error: 'team-activity concept returned no data'`, which surfaces. It just does not say *why*.

## Proposed Change

Four commits inside one PR.

### Commit 1 — `pr-exists`: replace the scan with the base/head lookup, and give every gitea script a timeout

`gitea/pr-exists.sh` rewritten to:

1. Resolve `owner/repo` via the existing `gitea_repo` helper.
2. Resolve the base branch: `CODEV_PR_BASE` if set (the name `pr-create.sh` already uses for a base branch), else the repo's `default_branch` from `GET repos/{owner}/{repo}` — the same resolution `pr-create.sh:78-81` already does.
3. `GET repos/{repo}/pulls/{base}/{branch}`; answer `true` when the response is a PR object with `state == "open"` or `merged == true`, `false` on 404 or a non-PR body.
4. Print `true`/`false` on stdout, nothing else. A *failure* to reach the API exits non-zero with a stderr message rather than printing `false` — "I could not tell" must not be spelled the same way as "no".

New in `_lib.sh`:

- `gitea_timeout <seconds> <cmd...>` — a portable POSIX watchdog (`gtimeout`/`timeout` when present, else a backgrounded child plus a killer subshell whose stdout is redirected to `/dev/null` so it cannot hold the command-substitution pipe open). Bound by `CODEV_FORGE_TIMEOUT`, default 60 s.
- `gitea_api` — `gitea_timeout $CODEV_FORGE_TIMEOUT tea api …`, with the timeout path reporting `gitea forge: <endpoint> timed out after Ns` on stderr and exiting non-zero. All gitea scripts route through this so a future hang surfaces as an error rather than a stuck phase.
- `tea_api_paged` gains a wall-clock deadline in addition to `GITEA_MAX_PAGES`, and warns loudly on stderr when it stops early rather than silently returning a truncated array.

`tea_api_paged` stays because `pr-list` and `recently-merged` still use it. I am not rewriting those two here — they are outside this issue's scope and are not overridden in entriq — but I will note in the review that on a 1599-PR repo `recently-merged` (`state=closed`, every page) costs the same ≈17 minutes and should get its own issue. The deadline turns that from a stall into a bounded, loud degradation.

### Commit 2 — `pr-search` for gitea, plus the `is:open` fix at the spawn call site

New `gitea/pr-search.sh`. Parses `CODEV_SEARCH_QUERY` into: an optional `head:<branch>` term, an optional `in:body` marker, zero or more `is:open` / `is:merged` / `is:closed` qualifiers, and any remaining bare term. Default state when no `is:` qualifier is given is **all states** (#1331's fix). Then:

- **`head:<branch>` present** → one `GET repos/{repo}/pulls/{base}/{branch}` (base resolved as in commit 1). Filter by the requested states.
- **bare issue number, with or without `in:body`** → `GET repos/{repo}/issues?type=pulls&state=<state>&q=<n>` for the candidate index, then `GET repos/{repo}/pulls/{n}` for each of the top matches (capped at 10, with a stderr note if the cap truncates) to get `headRefName`/`baseRefName`. A PR belongs to issue N when a word-bounded `#N` appears in title or body, or when N appears word-bounded in the head branch name — the same rule the working entriq shim uses, so `#3386` never matches `#33861`.
- **anything else** → `[]` on stdout, exit 0, and a one-line stderr note naming the unparsed query. No guessing.

Output: `[{number, title, state, url, headRefName, baseRefName}]`, ordered open-first then most-recently-updated, so `prs[0]` is the live PR.

`spawn-worktree.ts:592`: query becomes `in:body #${issueNumber} is:open`, with a comment naming #1331's review as the reason. This is inert for the current open-only `github/pr-search.sh` and load-bearing for gitea.

### Commit 3 — `pr-diff` for gitea, and enable both concepts in the preset

New `gitea/pr-diff.sh`:
- `CODEV_DIFF_NAME_ONLY=1` → `GET repos/{repo}/pulls/{n}/files` (paged via `tea_api_paged`), emit `.filename` one per line, matching `gh pr diff --name-only`, which is what `consult`'s `fetchPRData` splits on newlines (`index.ts:1483-1486`).
- otherwise → `GET repos/{repo}/pulls/{n}.diff`, raw text on stdout.
- `tea api` exits 0 on HTTP errors (established by `pr-create.sh:39-42`), so both paths assert the response shape and exit non-zero with a stderr message on an error body, rather than emitting an error page as a "diff".

`forge.ts:129` becomes `buildPresetFromScripts('gitea', ['team-activity', 'on-it-timestamps'])` — identical to the gitlab line.

### Commit 4 — loud degradation, contract, docs

- `github.ts` `fetchOnItTimestamps`: decide via `getForgeCommand('on-it-timestamps', forgeConfig)` / `isConceptDisabled` instead of `forgeConfig?.[...]`, so a preset-disabled concept is recognised. When disabled, warn once on stderr naming the provider and what degrades (analytics falls back to PR `createdAt`) and return the empty map.
- `team-github.ts` `fetchTeamGitHubData`: when the concept is disabled, return an error that says so — `team-activity is not available for provider "gitea" (no GraphQL on Forgejo)` — instead of "returned no data".
- `checks.ts` `runPrExistsViaConcept`: when `executeForgeCommand` returns `null`, fail with an explicit error ("the pr-exists concept returned no usable answer — it failed, timed out, or is disabled") rather than `passed:false, output:"null"`.
- `forge-contracts.ts`: add optional `state` and `baseRefName` to `PrSearchItem`, documenting that `consult`'s `findPRForIssue` already reads `baseRefName` and that ordering is open-first.
- `.claude/skills/forge/SKILL.md` and its byte-identical `.codex/skills/forge/SKILL.md` twin: record the gitea query grammar, `CODEV_FORGE_TIMEOUT`, `CODEV_PR_BASE` for `pr-exists`, and the base-branch limitation.

No `codev-skeleton/` mirror exists for `scripts/forge/` (confirmed by `find codev-skeleton -path '*forge*'` — empty), so these scripts are single-source. The skills directories are the only twin to keep in sync.

## Files to Change

- `packages/codev/scripts/forge/gitea/_lib.sh` — add `gitea_timeout`, `gitea_api`; add a wall-clock deadline and a loud truncation warning to `tea_api_paged`
- `packages/codev/scripts/forge/gitea/pr-exists.sh:25-29` — replace the `state=all` scan with the base/head lookup; distinguish "false" from "could not answer"
- `packages/codev/scripts/forge/gitea/pr-search.sh` — new
- `packages/codev/scripts/forge/gitea/pr-diff.sh` — new
- `packages/codev/src/lib/forge.ts:129` — stop disabling `pr-search` and `pr-diff` for gitea
- `packages/codev/src/lib/forge-contracts.ts:113-116` — `PrSearchItem` gains optional `state`, `baseRefName`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:592` — query gains `is:open`
- `packages/codev/src/lib/github.ts:338-357` — detect a preset-disabled `on-it-timestamps`; warn once
- `packages/codev/src/lib/team-github.ts:332-342` — name the reason when `team-activity` is disabled
- `packages/codev/src/commands/porch/checks.ts:360-375` — `null` from the concept is a distinct failure, not `false`
- `packages/codev/src/__tests__/pir-12-gitea-pr-concepts.test.ts` — new; fake-`tea` harness in the style of `bugfix-1455-pr-create-concept.test.ts`
- `.claude/skills/forge/SKILL.md`, `.codex/skills/forge/SKILL.md` — document the gitea specifics (kept byte-identical)
- `codev/state/pir-12_thread.md` — builder log, committed with the PR

Deliberately unchanged: `github/pr-search.sh` and `gitlab/pr-search.sh`. Adding `--state all` there is upstream #1331's diff, and duplicating it in the fork would collide when #1331 lands. Flagged for the architect below.

## Risks & Alternatives Considered

- **Risk: the base/head lookup misses a PR whose base is not the default branch.** Sequential-PR work branches from an integration branch. Mitigation: honour `CODEV_PR_BASE`, document it in the skill, and make the miss recoverable — `pr-exists` returning `false` blocks the porch `pr_exists` gate loudly rather than proceeding on a wrong answer. Rejected the obvious hedge (fall back to scanning open PRs when the lookup 404s) because on a repo with many open PRs that reintroduces exactly the 0.65 s-per-item cost this plan exists to remove, on the *failure* path where it would be least expected.
- **Risk: `head.label` is `owner:branch` for a cross-repo fork PR.** Codev builders push branches to the same repo, so the same-repo form is what we see. `pr-search` will pass a head containing `:` through verbatim, matching `pr-create.sh:311`'s established handling.
- **Risk: the query grammar drifts from its callers.** Five call sites, all in this repo, all listed above. Mitigated by testing the exact five strings.
- **Alternative: raise `GITEA_PAGE_LIMIT` / keep scanning.** Rejected — measured cost is per item, not per request; 1599 items cost ≈17 minutes at any page size.
- **Alternative: resolve branch→PR through `git ls-remote origin 'refs/pull/*/head'` and SHA matching.** One cheap network call and base-branch-independent, but it needs the branch's SHA, which is exactly what is gone after a merged branch is deleted. Rejected as fragile.
- **Alternative: raise the Forgejo server's `max_response_items`.** Rejected — it is a per-adopter server setting, and codev cannot require one.
- **Alternative: keep `pr-search` disabled and let entriq keep its shim.** Rejected — it is the issue's first acceptance criterion.

## Test Plan

### Unit — `packages/codev/src/__tests__/pir-12-gitea-pr-concepts.test.ts`

Fake `tea` on `PATH` recording its argv and replaying canned responses, in the style of `bugfix-1455-pr-create-concept.test.ts` (`it.skipIf(!hasJq())` for the jq-dependent cases).

- `pr-exists` issues exactly **one** `pulls/{base}/{head}` request and **never** a `state=all` list request — the regression pin for the 17-minute scan.
- `pr-exists` → `true` for an open PR; `true` for `merged: true` with `head.ref == refs/pull/N/head`; `false` on 404; **non-zero exit** (not `false`) when `tea` fails.
- `pr-exists` resolves the base from `default_branch` when `CODEV_PR_BASE` is unset, and prefers `CODEV_PR_BASE` when set.
- `gitea_timeout` kills a `tea` that never returns, exits non-zero, and prints the endpoint — asserted against a fake `tea` that sleeps.
- `pr-search` for each of the five real query strings: `head:X`, `head:X is:merged`, `head:X is:open`, `<n>`, `in:body #<n> is:open`. Assert the request shape and that no-`is:` defaults to all states (#1331).
- `pr-search` word-bounded issue matching: query `3386` does not match a PR titled `[Spec 33861]`.
- `pr-search` orders open before merged.
- `pr-search` emits `[]` and exits 0 on an unparseable query.
- `pr-diff` name-only emits bare filenames one per line; full mode emits the raw diff; an error body exits non-zero instead of printing it.
- `forge.ts`: `gitea` preset resolves `pr-search` and `pr-diff` to script paths, and still reports `team-activity` / `on-it-timestamps` as `disabled` (`resolveAllConcepts`).
- `spawn-worktree` passes a query containing `is:open` — anchored to the call, since the existing spawn test mocks the forge layer.
- `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md` are byte-identical.

Assertions on script *content* are anchored to the command line (`^exec`, argv shape), not `toContain`, so an explanatory comment cannot make a test pass with the code removed — the flaw called out in #1331's review.

### Live verification against Forgejo — the real gate

Run from `~/dev/entriq`, against this worktree's scripts, with `~/codev-evidence/entriq-backup-20260821-112045` as the restore point. Timings recorded in the review.

1. **Before**, with the overrides still in place, capture the baseline.
2. Point entriq at this branch's build and **delete all three overrides** (`issue-view`, `pr-exists`, `pr-search`) from `~/dev/entriq/.codev/config.json`, leaving `"provider": "gitea"` alone.
3. `pr-exists` for `builder/air-364` (open PR 3855) → `true`, **under 5 s**.
4. `pr-exists` for `builder/aspir-3860` (merged PR 3869, branch deleted) → `true` — the case the old scan could not answer at all.
5. `pr-exists` for a branch with no PR → `false`, under 5 s.
6. `pr-search` `head:builder/air-364` → PR 3855 with `headRefName` and `baseRefName`.
7. `pr-search` `3860` → PR 3869, `state` present, open-first ordering.
8. `pr-search` `in:body #<n> is:open` for an issue whose PR is merged → `[]`, i.e. `afx spawn` is not blocked (the #1331 regression).
9. `pr-diff` PR 3855 → real diff (≈30 KB); `CODEV_DIFF_NAME_ONLY=1` → bare filenames.
10. `issue-view` `CODEV_ISSUE_ID=1` → correct JSON on the bare preset, with the override gone.
11. `codev doctor` in entriq reports `pr-search`/`pr-diff` as `preset` and `team-activity`/`on-it-timestamps` as `disabled`.
12. **Restore entriq** to the backup unless every step above passed. Either way, state plainly in the review which of the three overrides are gone and what entriq was left in.

### Regression

`npm run build` and `npm test` in this worktree; specifically the existing `forge.test.ts`, `bugfix-1137-gitea-tea-api.test.ts`, `bugfix-1455-pr-create-concept.test.ts`, `doctor.test.ts`, and `spawn-worktree.test.ts`.

## For the Architect

1. **`github/pr-search.sh` and `gitlab/pr-search.sh` stay unfixed in this PR.** They carry the exact #759 bug — `gh pr list --search` with no `--state`, so post-merge `consult --type pr` fails on GitHub too. I left them alone because fixing them here duplicates upstream #1331's diff and will conflict when it lands. Say the word if you would rather carry it in the fork.
2. **`recently-merged` and `pr-list` for gitea have the same ≈17-minute cost on a 1599-PR repo.** Neither is overridden in entriq, so neither blocks this issue's acceptance. My plan bounds them with a deadline and a loud warning rather than rewriting them. Tell me if you want the real fix in scope.
3. **Porch's plan artifact path.** The phase prompt named `codev/plans/0012-hide-tmux-status-bar.md` — a pre-existing 2025 plan for an unrelated project. This is the zero-padding collision `artifacts.ts:80-104` already documents for this fork. I wrote `codev/plans/12-forgejo-gitea-forge-parity.md`, which is the canonical exact-match form `findByProjectId` prefers, so `plan_exists` resolves to this file.
