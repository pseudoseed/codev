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
