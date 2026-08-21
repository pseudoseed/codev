# pir-13 thread — CI concepts for the forge layer (#13)

## PLAN phase

Investigation was mostly measurement, and it overturned three premises the issue rests on.

1. **`gh run view --log-failed` does not narrow to the failing step.** On run 32518... (32515040122,
   this repo, `Tests`, branch `builder/air-14`) it returned 2528 lines / 293 KB with every line
   labelled `UNKNOWN STEP`. Job-scoped, not step-scoped. Codev has to extract on GitHub too.
2. **Forgejo 15.0.2 has no Actions log API at all.** `tea actions runs view` and `tea actions runs
   logs` both 404 against git.pseudoseed.com — they call `/actions/runs/{id}/jobs` and
   `/actions/jobs/{id}/logs`, which landed in **Forgejo 16.0** (2026-07-16). Probed every
   alternative route; the web UI log route exists but is session-only (rejects token and basic auth,
   while the API accepts the same token). So `ci-failures`/`ci-run-log` cannot work on entriq today.
3. **Forgejo 16 verified live and free** on codeberg.org (16.0.0-dev, `forgejo/forgejo` public):
   `runs/{id}/jobs` ✓, `actions/jobs/{jobId}/logs` → 200 text/plain 142 KB / 1599 lines / 1.0 s,
   `accept-ranges: bytes`, `?step=` ignored. Note the log route takes the **job id**, not the
   `task_id` that `actions/tasks` lists.

Other measured facts that shaped the design: Forgejo `actions/runs?limit=N` **ignores limit unless
`page` is present** (a bare `limit=3` returned all 6922 runs); `status=` filters server-side but
`branch=`/`event=` are ignored; PR-triggered runs report `head_branch` as `#<PR>`, not the branch,
so branch filtering needs the #12 base/head PR lookup first; run `id` and `index_in_repo` are two
valid id spaces for the same route, so the concept refuses to guess which one it was handed.

And the extraction evidence: in that GitHub log the first `Error:` line is `[artifact-canvas] Error:
host blew up` — a **passing** test's fixture string at line 1257, while the real failure is at 2471.
`Test Files … passed` appears four times before the failing summary. Every payload line is wrapped in
ANSI SGR codes, so a matcher that does not strip ANSI matches nothing. All three are pinned as tests.

Plan at `codev/plans/13-ci-forge-concepts.md`. Two open questions for the architect: a Codeberg token
(would upgrade the v16 lane from HTTP-level to full-dispatcher verification), and whether
git.pseudoseed.com is due a Forgejo 16 upgrade.

Awaiting `plan-approval`.

## IMPLEMENT phase

Plan approved 20:59Z. Six commits on `builder/pir-13`.

Shape that emerged: one shared extraction ladder (`scripts/forge/_ci-extract.sh`) and one shared
envelope/cache/window lib (`_ci-lib.sh`), with thin per-provider scripts. Both providers now fetch
**the same thing** — one job's log from `actions/jobs/{id}/logs` — so they share a cache and an
extractor. `gh run view --log-failed` is not used at all: it returned 2528 lines / 293 KB with
every line tagged UNKNOWN STEP, and the failing step NAME is available from `--json jobs` anyway.

Measured result on the live GitHub run: **293 KB of log becomes a 1.2 KB response** carrying the
assertion, the test name, the step name and the line range. Cold 2.5s, cached 1.3s.

### Things found while building that changed the code

- **`ci_fail` returning 1 aborted its own caller.** Every concept runs under `set -e`, so a
  non-zero return killed the script at that line, before the intended `exit 2` for a bad input.
  Every input error was arriving as exit 1. `ci_fail` now reports and returns 0; call sites decide
  the status.
- **Two subshell-assignment bugs.** `ci_text_json` and `gitea_ci_jobs` set globals that their
  callers read — inside `$( )`, so the values were discarded and jq got empty `--argjson`. Both now
  return their data (or write files) instead.
- **Forgejo rejects the spelling its own CLI documents.** `tea actions runs list --help` says
  `canceled`; the API answers `{"message":"unknown status: canceled"}` and accepts `cancelled`
  (2240 runs). Both providers now get `cancelled`.
- **Truncation was under-reported twice.** Stopping at exactly the limit, and hitting the page
  ceiling with no client-side filter, both reported `truncated: false`. Fixed and pinned.
- **A CLI that exits 0 with non-JSON** (an auth prompt) reached jq, died under `set -e`, and left
  nothing on stdout. Guarded.
- **The Forgejo-15 task scan needed its own, higher page ceiling.** A page of 50 tasks spans ~6
  runs, so 4 pages reached 24 runs back and reported truncation for anything older. Now 20 pages,
  with an early stop the moment the walk passes the run — a recent run costs one page.

### Verification coverage, stated precisely

- **GitHub — end to end through the real dispatcher** (config → preset → env → script → JSON parse),
  all four concepts, live against `pseudoseed/codev`. Timings in the PR body.
- **Forgejo 15.0.2 — end to end through the real dispatcher**, live against `~/dev/entriq` on the
  bare gitea preset. entriq was READ ONLY; its working tree carries an unrelated uncommitted config
  edit that predates this session (13:34 MDT).
- **Forgejo 16 — HTTP level only.** The v16 routes were verified with unauthenticated curl against
  codeberg.org, and the code path is covered by unit tests with a stubbed `tea` serving the REAL
  captured codeberg job log. It has NOT been driven through the dispatcher against a live v16
  server; that needs a Codeberg token, which the architect deferred.

Question for the gate: nothing in codev can invoke a forge concept from the command line, so a
builder reaches these four by script path. A `codev forge <concept>` entry point would fix that;
it is not in the approved plan, so I am asking rather than adding it.
