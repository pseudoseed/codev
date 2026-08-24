# bugfix-113 thread

Investigate (2026-08-24).

Reproduced. `porch check 83` from this worktree fails `pr_exists` in 0.6s. Same command from main passes only because `findStatusPath` hits `.builders/air-106`, whose unrelated merged PR #132 satisfies the check.

Project 83 is still in `review`. `pr` is approved. PR #104 is MERGED. `verify-approval` is pending. The builder never ran `porch done` after the pr gate, so verify was never entered.

`porch approve 83 verify-approval` runs checks for `state.phase` (review), not for the phase that owns the gate. Review's first check is `pr_exists`, which asks `git branch --show-current` in whichever worktree owns the status.yaml. After merge that is almost never `builder/spir-83`.

The issue title's premise is wrong. `pr_exists` already uses `--state all`, so a merged PR matches (#568 / #16 / upstream #1331). The real cause is the `--head` argument: `git branch --show-current` runs in whichever worktree `findStatusPath` returns, and after merge that is almost never the PR head. The search is for the wrong head, not the wrong state. Against `CODEV_BRANCH_NAME=builder/spir-83` the script returns true.

Verify phase has no checks. Scope is small: approve the named gate's phase checks, and if verify-approval is requested while still in review with `pr` already approved, enter verify first so the existing auto-advance can reach `verified`.

Fix: `approve()` enters verify when verify-approval is requested from review with `pr` already approved. Review's `pr_exists` no longer runs. Regression test fails without the block (process.exit from `false` pr_exists) and passes with it.

PR #137: https://github.com/pseudoseed/codev/pull/137

CMAP: gemini skipped (agy exit 1, quota). Substitute opencode=APPROVE. codex=COMMENT (branch trails main by a docs merge, no code change). claude=APPROVE. No REQUEST_CHANGES.

Claude noted a residual: `porch done` / `porch check` still fail review's `pr_exists` after merge when cwd is not the PR head. Left as a follow-up; this bugfix unblocks verify-approval.
