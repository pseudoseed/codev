# bugfix-113 thread

Investigate (2026-08-24).

Reproduced. `porch check 83` from this worktree fails `pr_exists` in 0.6s. Same command from main passes only because `findStatusPath` hits `.builders/air-106`, whose unrelated merged PR #132 satisfies the check.

Project 83 is still in `review`. `pr` is approved. PR #104 is MERGED. `verify-approval` is pending. The builder never ran `porch done` after the pr gate, so verify was never entered.

`porch approve 83 verify-approval` runs checks for `state.phase` (review), not for the phase that owns the gate. Review's first check is `pr_exists`, which asks `git branch --show-current` in whichever worktree owns the status.yaml. After merge that is almost never `builder/spir-83`.

The issue's "open vs all states" guess is stale. `github/pr-exists.sh` already accepts OPEN or MERGED (#568). Against `CODEV_BRANCH_NAME=builder/spir-83` it returns true. The lookup key is the wrong branch, and the post-merge gate should not be running that check at all.

Verify phase has no checks. Scope is small: approve the named gate's phase checks, and if verify-approval is requested while still in review with `pr` already approved, enter verify first so the existing auto-advance can reach `verified`.

Fix: `approve()` enters verify when verify-approval is requested from review with `pr` already approved. Review's `pr_exists` no longer runs. Regression test fails without the block (process.exit from `false` pr_exists) and passes with it.
