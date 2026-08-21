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
