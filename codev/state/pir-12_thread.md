# Builder thread — pir-12 (Issue #12, PIR)

Forgejo/Gitea forge parity: pr-search, pr-diff, and the pr-exists hang.

## 2026-08-21 — Plan phase

Investigated live against `~/dev/entriq` (Forgejo 15.x, tea 0.14.2), as the architect
directed. The repo was already paused, so exercising it was safe; I only issued reads.

**The pr-exists "hang" is a ~17-minute loop, not a deadlock.** Forgejo's `/pulls` list
costs ≈0.65 s *per PR object* (limit=1 → 0.78 s, limit=50 → 32.8 s), entriq has 1599
PRs (`x-total-count`), and `tea_api_paged` walks all 32 pages. Killing at 25 s and at
120 s both land inside that window with nothing on stdout. Auth and connectivity were
never involved — a single issue fetch is 0.59 s.

Two things I got wrong on the way and corrected with a repro rather than argument:

- I assumed Node's `exec` timeout would not fire while a grandchild held the stdout
  pipe, which would have meant the in-process path hangs too. It does fire —
  `sh -c "sleep 60 | cat"` rejected at 3009 ms under a 3 s timeout. So under porch the
  check fails at 30 s with `output: "null"`, which reads as "no PR" instead of "could
  not answer". Different bug, still a bug, now in the plan.
- I assumed the documented caveat at `pr-exists.sh:16-20` (merged PRs report
  `head.ref == refs/pull/N/head` once the branch is deleted) made merged-PR lookup
  impossible. `head.label` keeps the original branch name, and
  `GET /pulls/{base}/{head}` matches on it — verified live, PR 3869 found by
  `pulls/main/builder/aspir-3860` in 1.19 s. That one endpoint replaces the whole scan
  for both `pr-exists` and `pr-search head:`.

**Upstream cluesmith/codev#1331** is open and unmerged with no PR in this fork. Its
review matters more than its diff: making pr-search all-states breaks
`spawn-worktree.ts:592`, which passes `in:body #N` and leans on the open-only default,
so every re-spawn for an issue with a merged PR would abort on a wrong "Found N open
PR(s)". The gitea script therefore parses `is:` qualifiers, and the spawn call site
gets an explicit `is:open`.

**Porch named the wrong plan file.** The phase prompt asked for
`codev/plans/0012-hide-tmux-status-bar.md` — an unrelated 2025 plan. That is the
zero-padding collision `artifacts.ts:80-104` already documents for this fork (issue
numbering restarted at 1 against artifacts numbered into the 1400s). I wrote
`codev/plans/12-forgejo-gitea-forge-parity.md`, the exact-match form `findByProjectId`
prefers, and confirmed `plan_exists` resolves to it. Flagged to the architect.

Two scope questions raised in the plan rather than decided alone: whether to carry
upstream's `github`/`gitlab` pr-search fix in the fork (I said no — it will conflict
when #1331 lands), and whether `recently-merged`/`pr-list`, which pay the same
17-minute cost on a big repo, belong in this issue (I said no — not overridden in
entriq, so not blocking acceptance; bounded with a deadline instead).

Plan committed, sitting at `plan-approval`.

## 2026-08-21 — Implement phase

Plan approved with both scope questions answered, then the architect folded the
`recently-merged` fix in after I reframed it: it is not a slow operation we would
be choosing to break, it is one that has been failing silently on entriq on every
`afx status` and every dashboard poll — 30s node timeout, null, empty panel,
nothing on stderr.

**What the measurements decided.** Forgejo charges `/pulls` per returned PR
object (0.78s at limit=1, 32.8s at limit=50). entriq has 1599 PRs. So
`pr-exists` cost ~17 minutes and `recently-merged` (state=closed, 48.1s/page ×
32) ~26. No page size fixes that; the answer was to stop enumerating. Both now
run in about a second.

**The discovery that made it clean.** `head.label` keeps the original branch name
after a merged PR's branch is deleted, where `head.ref` becomes
`refs/pull/N/head`. The existing script documented that caveat as unfixable. It
isn't — `GET /pulls/{base}/{head}` matches on the stored head branch, so the new
implementation is not just 900× faster, it answers a question the old one
couldn't.

**Three bugs my own code had, each caught by a test rather than by reasoning:**

1. `gitea_timeout` killed the command and left the caller blocked anyway — a
   grandchild kept the command-substitution pipe open. The timeout message
   printed at 3s and the script was still hung two minutes later. Fixed by
   giving the command a temp file instead of the pipe.
2. Then it classified timeouts by exit status (143/137 = "we killed it"), which
   a wrapper whose own `wait` takes no operand defeats — POSIX says operand-less
   `wait` always returns 0, so a process killed by SIGTERM reported success with
   an empty body, and the caller diagnosed an unreadable repository. The
   watchdog now records that it fired; nothing is inferred.
3. `--argjson` with 107 PR objects blew ARG_MAX. Only showed up at the 7-day
   window, not the 24-hour one.

**Truncation is exit status 3 with empty stdout**, per the architect's condition.
A short list and a truncated list are indistinguishable once printed, so
"nothing merged" (`[]`, status 0) and "I stopped looking" (status 3, stderr says
which bound bit) are deliberately different things. No `CODEV_SINCE_DATE` means a
7-day window, announced — never "all time", which is the 26-minute walk.

**Acceptance run.** Deleted all three overrides from `~/dev/entriq/.codev/config.json`
and drove every concept through the real dispatcher against the live Forgejo.
All pass on the bare `provider: gitea` preset, every call under 1.3s. Then
**restored the config**, because entriq runs the globally installed codev 3.3.1,
whose preset still disables pr-search/pr-diff and still carries the old scan — so
the overrides are still load-bearing there until this ships. Verified the file is
byte-identical to both my pre-test copy and the architect's 11:20 backup. The
`git status` dirt in entriq predates me (it is in the architect's backup too).

The acceptance run also exposed that `codev doctor` reported `echo` as
`issue-view`'s required executable and `case` as `pr-list`'s, so a missing `tea`
went unreported on Forgejo repos. Two `# forge-executable:` declarations, and the
test now asserts it across the whole preset.

**Flaky, pre-existing, not mine:** three tests in
`spec-1280-measurement-instrument.test.ts` time out at 60s because
`scripts/measure-prompt-surface.sh` takes ~31s per invocation on this machine and
they call it twice. Proven pre-existing by running the same test against the
unmodified main checkout, where it fails identically (77s). Left untouched.

## 2026-08-21 — Review phase

PR #19 open, body is the review file, verified byte-identical after creation.

**Governance routing.** Promoted to `lessons-critical.md`: *a truncated result is
indistinguishable from a complete one once emitted*. The hot file was at its cap of
ten, so this required displacement — "model permissions as roles/capabilities, not
booleans" moved into `lessons-learned.md` § Architecture with an expanded body and a
note saying where it came from and why.

I argued three independent arrivals at the principle. The architect corrected me
upward: five, all on 2026-08-21, all different subsystems — the render gate returning
CLEAN on a screen it had not proven empty (#4), log extraction refusing to return
arbitrary lines as a diagnosis (#13), this PR's exit-3 contract, a timed-out forge
command becoming `null` and reading as "no results" (#17), and a check that exceeded
its bound reporting as a test failure rather than a timeout (#8). One mistake, five
subsystems, one day.

`arch.md` gained four lines under Forge Concept Commands. The one the architect
singled out: **a preset-disabled concept is invisible to `forgeConfig` lookups**,
because `forgeConfig?.['x']` reads user config only and a preset `null` is not in it.
That is what silently emptied `on-it-timestamps` on every gitea repo, and it is
invisible until seen.

**Codex lane never ran.** Provider quota exhausted until 2026-08-27; two attempts
(19:06:05Z and 19:06:35Z) both refused in ~6s before any model work. Recorded as a
NOT-RUN file with `VERDICT: SKIPPED` / `CONFIDENCE: NONE`, the verbatim provider
message, and both attempt times — the same convention #2, #4 and #11 used. That file
is gitignored (`.gitignore:65`), which is exactly why the two-of-three coverage is
stated in the PR body as well.

Worth naming: the absent lane is the one that most often catches shell-quoting and
POSIX-portability defects, and this diff is five POSIX `sh` scripts, a hand-rolled
process watchdog and a pile of jq. That is the weakest possible pairing of "which lane
is missing" against "what this change is made of", and it is stated in the PR body
rather than buried.
