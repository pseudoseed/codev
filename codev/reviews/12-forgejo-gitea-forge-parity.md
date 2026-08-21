# PIR Review: Forgejo/Gitea forge parity — pr-search, pr-diff, and the pr-exists "hang"

Fixes #12

## Summary

A Forgejo repository can now run on the bare `forge.provider: gitea` preset with no per-concept overrides and no `gh` shim. `pr-search` and `pr-diff` are implemented for gitea and no longer disabled; `pr-exists` stopped enumerating pull requests and answers in one request instead of about seventeen minutes; and `recently-merged`, which had been silently returning nothing on every `afx status` for months, went from about twenty-six minutes to roughly one second.

The reported bug was a hang. It was not one — it was a ~17-minute loop, and finding that out changed the fix from "add a timeout" to "stop enumerating."

## Files Changed

- `packages/codev/scripts/forge/gitea/_lib.sh` (+245 / -0) — timeout, bounded-concurrency fetch, repo/default-branch resolution, paged-walk deadline
- `packages/codev/scripts/forge/gitea/pr-exists.sh` (+104 / -0) — rewritten around the base/head lookup
- `packages/codev/scripts/forge/gitea/pr-search.sh` (+199 / -0) — new
- `packages/codev/scripts/forge/gitea/pr-diff.sh` (+76 / -0) — new
- `packages/codev/scripts/forge/gitea/recently-merged.sh` (+174 / -0) — rewritten around the cheap issues index
- `packages/codev/scripts/forge/gitea/pr-list.sh` (+14 / -0) — truncation is no longer swallowed by a pipe
- `packages/codev/scripts/forge/gitea/issue-view.sh` (+1 / -0) — `# forge-executable: tea`
- `packages/codev/src/lib/forge.ts` (+57 / -0) — gitea preset enables both concepts; shared "concept unavailable" reporting
- `packages/codev/src/lib/forge-contracts.ts` (+17 / -0) — `PrSearchItem` gains `state`, `baseRefName`, `title`, `url`
- `packages/codev/src/lib/github.ts` (+23 / -0) — a preset-disabled `on-it-timestamps` warns instead of returning empty
- `packages/codev/src/lib/team-github.ts` (+19 / -0) — names the provider instead of "returned no data"
- `packages/codev/src/commands/porch/checks.ts` (+17 / -0) — `null` from `pr-exists` is "could not answer", not "no PR"
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+12 / -0) — the collision query says `is:open`
- `packages/codev/src/__tests__/pir-12-gitea-pr-concepts.test.ts` (+~670 / -0) — new
- `packages/codev/src/commands/porch/__tests__/pir-12-pr-exists-null-vs-false.test.ts` (+77 / -0) — new
- `packages/codev/src/__tests__/bugfix-1137-gitea-tea-api.test.ts` (+110 / -0) — fixtures follow the endpoints
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` (+18 / -0)
- `.claude/skills/forge/SKILL.md`, `.codex/skills/forge/SKILL.md` (+50 each) — kept byte-identical
- `codev/resources/arch.md` (+11 / -0), `codev/resources/lessons-learned.md` (+6 / -0), `codev/resources/lessons-critical.md` (+1 / -1)
- `codev/plans/12-forgejo-gitea-forge-parity.md` (+217 / -0), `codev/state/pir-12_thread.md` (+111 / -0)

24 files changed, 2108 insertions, 75 deletions.

## Commits

- `28e764f8c` [PIR #12] Plan draft: gitea pr-search, pr-diff, and the pr-exists hang
- `63c980789` [PIR #12] fix(gitea): answer pr-exists in one request instead of ~17 minutes
- `d0666871f` [PIR #12] fix: enable the gitea concepts, and stop degrading silently
- `bbc4ebe4a` [PIR #12] test+docs: pin the endpoints, the head.label behaviour, and is:open
- `64cb220d0` [PIR #12] fix(doctor): report tea for every gitea concept, not echo or case
- `e018fee98` [PIR #12] docs: builder thread for the implement phase

## The measurements that decided the design

Everything here follows from timings taken against a live Forgejo 15.x (`git.pseudoseed.com/pseudoseed/entriq`, 1599 PRs) with `tea` 0.14.2, not from reasoning about the API.

| Request | Time |
|---|---|
| `GET /repos/{o}/{r}/issues/1` | 0.59 s |
| `GET .../pulls?state=all&limit=1` | 0.78 s |
| `GET .../pulls?state=all&limit=50` | **32.8 s** |
| `GET .../pulls?state=closed&limit=50` | **48.1 s** |
| `GET .../issues?type=pulls&state=all&limit=50` | 1.75 s |
| `GET .../pulls/{base}/{head}` | 0.17–1.2 s |
| `GET .../pulls/{n}.diff` | 0.30 s |

The `/pulls` list is priced **per returned PR object**, not per request — roughly 0.65 s each, because Gitea materialises head and base commit info for every row. `pr-exists` walked `state=all` at 50 per page, so it cost 32 pages × ~33 s ≈ 17 minutes; `recently-merged` walked `state=closed` at 48 s a page ≈ 26 minutes. Raising the page size cannot help a per-item cost, and neither can a cache that has to be filled once. The fix had to stop enumerating.

Two properties of Gitea made that possible, and one of them contradicts a caveat the old code documented as unfixable:

- **`GET /pulls/{base}/{head}`** answers "is there a PR from this branch" in one request, 404s when there is none, and takes slashes in the head branch unescaped.
- **`head.label` survives branch deletion.** The old scan matched `.head.ref`, and its comment correctly noted that Gitea rewrites that to `refs/pull/N/head` once a merged PR's branch is deleted — concluding that a merged PR could not be found by branch name. But `.head.label` keeps the original name and the base/head endpoint matches on the stored head branch. Verified: PR 3869, merged with its branch gone, reports `head.ref = refs/pull/3869/head` and `head.label = builder/aspir-3860`, and `pulls/main/builder/aspir-3860` returns it. So the new implementation is not only ~900× faster, it answers a question the old one could not.

`recently-merged` uses a different lever: the `issues?type=pulls` index is nineteen times cheaper than the `/pulls` view of the same rows because it skips that commit materialisation, and it accepts a server-side `since` filter. It carries everything `MergedPrItem` needs except the head branch, which is then fetched per match, eight at a time.

## The `codev doctor` fix, found during the acceptance run

Separate from the above and worth its own heading, because it silenced the one diagnostic that should have caught this class of problem.

`extractExecutable` reads a script's first substantive line to decide what must be on `PATH`. For the gitea preset it was answering **`echo` for `issue-view` and `case` for `pr-list`** — so `codev doctor` on a Forgejo repo told the user to install `echo`, and a genuinely missing `tea` went unreported on exactly the repositories that need it. This is the defect class #1455 exists to close, and the remedy it established is the `# forge-executable:` declaration; two scripts were missing one. The test now asserts it across the entire preset rather than concept by concept, so a new gitea script cannot reintroduce it.

## What upstream cluesmith/codev#1331 contributed, and what its review contributed

#1331 (open, unmerged; no PR against it in this fork) fixes `pr-search` to span all PR states, because `gh pr list --search` defaults to open-only and post-merge `consult --type pr` therefore fails with "No PR found for branch". The gitea implementation defaults to all states for that reason.

Its **review** turned out to matter more than its diff. Making `pr-search` all-states breaks `spawn-worktree.ts`, which queries `in:body #N` and leaned on the old open-only default to mean "open PRs". Under an all-states search that becomes "did this issue *ever* have a PR", and every re-spawn, every follow-up to a partial fix, and every retry after a closed PR aborts with a factually wrong "Found N open PR(s)". The call site now says `is:open` explicitly, and the gitea script honours `is:` qualifiers so that saying it works. The review's second point — that `PrSearchItem` gave callers no `state` with which to defend themselves — is addressed by adding `state` to the contract and ordering results open-first.

`github/pr-search.sh` and `gitlab/pr-search.sh` are deliberately **not** touched here. They carry the same #759 bug, but fixing them is upstream #1331's diff and would conflict on every future sync. The architect is filing that as an adopt-the-PR job, the way #1146 and #1458 were handled.

## The truncation contract

`recently-merged` bounds itself three ways — a default 7-day window when `CODEV_SINCE_DATE` is absent (announced on stderr; never "all time", which is the 26-minute walk), a 300-PR ceiling, and the paged walk's wall-clock deadline. When a bound bites it exits **3 with empty stdout**.

That emptiness is the point. A short list and a truncated list are indistinguishable once printed, so `[]` with status 0 means "nothing merged" and status 3 means "I stopped looking", and stderr names which bound bit. This is now the documented exit-status contract for forge concepts generally.

## Test Results

- `npm run build`: ✓ pass
- `npm test`: 5498 passed, 2 failed — both pre-existing and unrelated (see **Flaky Tests**). 45 tests are new across two files (`pir-12-gitea-pr-concepts.test.ts`, `pir-12-pr-exists-null-vs-false.test.ts`), plus one behavioural spawn assertion and the reworked `bugfix-1137` cases.
- **Live verification** against `git.pseudoseed.com/pseudoseed/entriq` with all three overrides deleted, driven through the real dispatcher (config load → preset → env → script → JSON parse), not by invoking scripts by hand:

  | Call | Time | Result |
  |---|---|---|
  | `pr-exists` open branch | 986 ms | `true` |
  | `pr-exists` merged branch, deleted | 686 ms | `true` |
  | `pr-exists` absent branch | 482 ms | `false` |
  | `pr-search head:<branch>` | 1079 ms | PR 3855 with head + base refs |
  | `pr-search <issue number>` | 1240 ms | PR 3869, state `merged` |
  | `pr-search in:body #3860 is:open` | 620 ms | `[]` — spawn not blocked |
  | `pr-diff` name-only / full | 578 / 354 ms | 6 paths / 30 KB diff |
  | `issue-view` | 607 ms | correct JSON |
  | `pr-list` | 509 ms | 1 open PR |
  | `recently-merged` 24 h | 1082 ms | 6 PRs, all head branches resolved |
  | `user-identity` | 459 ms | `pseudoseed` |
  | `team-activity`, `on-it-timestamps` | — | still resolve as `disabled` |

  entriq's config was then **restored** and diff-verified byte-identical to both the pre-test copy and the architect's 11:20 backup. It runs the globally installed codev 3.3.1, whose preset still disables `pr-search`/`pr-diff`, so its overrides remain load-bearing until this ships. Delete them after this merges and entriq updates.

## ⚠️ This had TWO of THREE review lanes — Codex never ran

**Read this before trusting the review depth.**

| Lane | Verdict | Notes |
|---|---|---|
| **codex** (gpt-5.6-sol) | **NEVER RAN** | Provider usage quota exhausted. Two attempts on 2026-08-21, 19:06:05Z and 19:06:35Z, each refused in ~6 s before any model work began. Quota restores 2026-08-27. **No codex findings exist for this change.** |
| gemini (agy) | APPROVE, HIGH | No issues raised. |
| claude (opus-5) | APPROVE, HIGH | Four non-blocking findings, all real, all fixed — see below. |

Verbatim provider message, both attempts:

> You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 27th, 2026 4:01 PM.

The codex lane was skipped on explicit architect instruction rather than hold a fork-local change for six days. The absence is recorded as a NOT-RUN file at `codev/projects/12-forgejo-gitea-forge-parity-imp/12-review-iter1-codex.txt` carrying `VERDICT: SKIPPED` and `CONFIDENCE: NONE`, so it cannot be misread as a review that happened — but that path is gitignored (`.gitignore:65`), which is why the coverage is stated here too. The same quota blocked codex on #2, #4 and #11 earlier the same day.

**Porch's own gate summary says otherwise, and it is wrong.** `porch next 12` reports `codex: COMMENT` and prints **"All reviewers approved!"**. `parseVerdict` (`porch/verdict.ts:41-47`) recognises only `APPROVE`, `REQUEST_CHANGES` and `COMMENT`; `VERDICT: SKIPPED` matches none of them, falls through to the "no valid VERDICT line found — treat as COMMENT" default, and `allApproved` counts `COMMENT` as approval. So a lane that never ran is indistinguishable from one that approved, in the exact summary a human reads when deciding to merge.

That is this PR's own lesson pointed back at the tooling — a sixth arrival at it in one day, and the one with the largest blast radius, since it affects every project that records a skip. It is porch behaviour rather than anything in this diff, so it is **not fixed here**; it is filed for the architect. Read the table above, not porch's summary line.

**Weigh this specifically.** The absent lane is the one that most often catches shell-quoting and POSIX-portability defects, and this diff is five POSIX `sh` scripts, a hand-rolled process watchdog, and a pile of jq. That is close to the worst pairing of *which* lane is missing against *what* the change is made of. Two of the three bugs found during implementation were exactly that class, and both were caught by tests rather than by reading.

### What the Claude lane found, and what changed because of it

All four findings were reproduced before being fixed; none were argued down.

1. **Two `gitea_api_error` checks were unreachable** (`pr-diff.sh` name-only, `recently-merged.sh`). Gitea answers a 404 with a JSON *object*, which reached `tea_api_paged`'s `jq -s 'add'` first — and an object cannot be added to an array, so the walk died on `jq: error … array ([]) and object ({...}) cannot be added` before the script's own classification ran. Reproduced against live Forgejo exactly as reported. The exit status was non-zero either way, so no wrong answer was ever returned; what was lost was the sentence naming the missing PR. `tea_api_paged` now classifies before accumulating and returns a distinct status 4 with the body on stdout, so the caller's message finally fires. Both paths now tested — the full-diff 404 was covered and the name-only one was not, which is why only one of them was broken.
2. **The plan's Test Plan called for a byte-identity test over the two `SKILL.md` twins and it was never written.** The files were identical; nothing stopped them drifting. Now pinned.
3. **`checks.ts`'s null-vs-false change had no test.** It is a real behaviour change — `null` from the concept means "could not answer", not "no PR exists" — and it mattered concretely, since before this PR the gitea script blew the 30 s ceiling on every run, making `null` the *normal* outcome on that provider. Three tests added in a separate file, because mocking the forge layer is something `checks.test.ts` deliberately avoids.
4. **`gitea_timeout` nits, both fixed.** The marker file's path was derived from the output file's (`"$_tf.fired"`), which `mktemp` does not reserve — a predictable name in a world-writable tmpdir that anyone could pre-create to force every call to report a timeout. Both files now live in a private `mktemp -d`. And the watchdog claimed the timeout unconditionally, so a command finishing in the same instant the deadline passed was reported as timed out, discarding a good answer; it now checks `kill -0` first. That narrows the window rather than closing it — a lock would be needed for that — and a false timeout is a retryable error rather than a wrong answer.

## Architecture Updates

**COLD — `codev/resources/arch.md`**, § Integration Points → Forge Concept Commands. Four additions, all current-state reference rather than changelog:

1. Provider presets are on-disk scripts under `packages/codev/scripts/forge/<provider>/`, single-source with no skeleton mirror, and `null` in a preset is a deliberate refusal rather than "no script".
2. **A preset-disabled concept is invisible to `forgeConfig` lookups** — `forgeConfig?.['x']` reads user config only. Availability must be asked of `getForgeCommand`/`isConceptDisabled`. This is the system-shape surprise that made `on-it-timestamps` return an empty map silently on every gitea repo.
3. The exit-status contract, including 3-with-empty-stdout, and that `null` from `executeForgeCommand` means "could not answer".
4. The two verified Forgejo properties: per-object pricing on `/pulls`, and `head.label` surviving branch deletion. Both filed here rather than in lessons-learned because they are properties of a system, not general engineering advice — the "looks like X but is actually Y" routing.

Nothing was promoted to `arch-critical.md`: all of it is reference detail that matters only when writing a forge concept.

## Lessons Learned Updates

**HOT — `codev/resources/lessons-critical.md`**, one promotion with displacement, since the file was at its cap of ten:

> A truncated result is indistinguishable from a complete one once emitted — give "I stopped early" its own signal and emit nothing, never a partial answer that reads as whole.

It earns the hot slot because the same principle has now been arrived at independently three times in this codebase — `afx send`'s render gate, #13's log extraction, and this PR's exit-3 contract — which is the signal that it should be changing decisions before they are made rather than being rediscovered.

**Displaced into `lessons-learned.md` § Architecture:** "Model permissions as roles/capabilities, not booleans." Still true and still worth reading; it is the narrowest of the ten, applying only when designing a permission system, where the promoted rule applies to any list, log, render, or fetch that can stop early. Reviewers should push back if they disagree with that trade — it is the judgement call in this diff that is least supported by evidence.

**COLD — `codev/resources/lessons-learned.md`** § Debugging and Root Cause Analysis, three entries:

1. **Killing a process is not unblocking the caller, and a zero exit is not success.** Both halves were bugs in this PR's own timeout helper (below).
2. **Measure whether a remote endpoint is priced per request or per returned item before optimising around it.** One `limit=1` vs `limit=50` timing tells you which regime you are in and takes a minute; against a per-item cost, every page-size instinct is useless.
3. **A hang reported from a shell is not always the hang your code has in production.** In-process, `pr-exists` was being killed at 30 s and returning `null`, which the caller rendered as "no PR exists" — same root cause, different bug, and only one of them was the one reported.

## Things to Look At During PR Review

- **`gitea_timeout` in `_lib.sh` is the subtlest thing here, and it was wrong twice.** First it killed the command and left the caller blocked anyway: every caller runs it inside `$(...)`, and a grandchild kept the write end of that pipe open, so the timeout message printed at 3 s and the script was still hung two minutes later. The command now writes to a temp file rather than the caller's pipe, and the watchdog's own stdout goes to `/dev/null` for the same reason. Then it classified timeouts by exit status (143/137), which a wrapper using operand-less `wait` defeats — POSIX makes that always return 0, so a process killed by SIGTERM reported success with an empty body and the caller diagnosed an unreadable repository instead. The watchdog now records that it fired and nothing is inferred. Both failure modes have tests.
- **The base-branch limitation in `pr-exists` / `pr-search head:`.** The endpoint needs a base; it uses the repository default unless `CODEV_PR_BASE` is set, so a PR against an integration branch needs that variable. A miss prints `false`, which fails the porch `pr_exists` gate loudly. Falling back to a list scan on the 404 path was rejected deliberately — it would reintroduce the ~17-minute walk on the failure path, where it would be least expected.
- **`pr-search`'s query grammar is a parser, not a pass-through**, covering exactly the five query strings this codebase builds. A sixth would return `[]` with a stderr note. The five and their call sites are tabulated at the top of the script.
- **`bugfix-1137`'s fixtures moved.** Its guarantee is unchanged and still asserted — reads go through `tea api`, never `tea pulls list`, and a paged read is not silently truncated — but `pr-exists` now pages nothing at all, which is the strongest form of that. The fake `tea` no longer serves any `pulls?state=…` fixture, so a reintroduced scan fails there with "no fixture for".
- **Script assertions are anchored to command lines, not `toContain`.** #1331's review caught assertions that passed against the explanatory comment quoting the flag under test, staying green with the flag deleted from the command. The comments here quote the very endpoints being pinned, so the same trap was live.
- **The hot-tier displacement** described above.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-12` → **Review Diff**
- **Run dev**: `afx dev pir-12`
- **What to verify**, against any Forgejo repo with `tea` authenticated:
  - `CODEV_BRANCH_NAME=<open-branch> sh packages/codev/scripts/forge/gitea/pr-exists.sh` returns `true` in about a second, and issues exactly two requests
  - the same for a branch whose PR is **merged and whose branch was deleted** — this is the case the old code could not answer
  - a branch with no PR returns `false`; a bad `CODEV_REPO` **errors** rather than returning `false`
  - `CODEV_SEARCH_QUERY='in:body #<n> is:open'` returns `[]` for an issue whose PR is merged, i.e. `afx spawn` is not blocked
  - `CODEV_SINCE_DATE` unset on `recently-merged.sh` announces a 7-day window rather than walking everything; `CODEV_FORGE_MERGED_MAX=2` over a busy window exits 3 with empty stdout
  - `codev doctor` reports `tea` for every enabled gitea concept and `disabled` for `team-activity` / `on-it-timestamps`

## Flaky Tests

None skipped or annotated. Two pre-existing failures were left untouched (which of them fires varies per run — they are contention-sensitive, and a third from the same file appeared in an earlier run):

- `packages/codev/src/__tests__/spec-1280-measurement-instrument.test.ts` — `emits byte-identical output twice at the same commit`, `reports the same total under a C locale as under UTF-8`, and `PHASE_ITERS is a linear comparison constant`. Each invokes `scripts/measure-prompt-surface.sh` twice against a 60 s budget, and that script takes ~31 s per invocation on this machine. Proven pre-existing by running the same test against the **unmodified main checkout**, where it fails identically at 77 s; the architect independently reproduced it there past 300 s. The script costs the same against either root (31.3 s vs 33.0 s), so this is machine speed, not diff content.

`packages/codev/src/terminal/__tests__/session-manager.test.ts` also drops one timing-sensitive stderr-tail case under full-suite load; the file passes 91/91 in isolation, and a *different* case from it failed on an earlier run, which is the signature of contention rather than a defect.

This is further evidence for #8 — porch's check timeout is a hardcoded 300 s with no override key, and entriq's config records the same class of problem at 460 s quiet / 859 s contended.
