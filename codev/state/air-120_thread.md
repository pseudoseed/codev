# air-120 — show orphan-worktree count; remove merged non-ephemeral worktrees

## Implement

Two halves from #120, after #100/#117.

1. `afx status` prints orphan count (dirs under `.builders/` with no live builder row). `--size` adds reclaimable bytes via `du -sk`. Count is eager; `du` is not on the hot path.
2. Non-ephemeral cleanup (spir/air/pir/experiment/spec) removes the worktree when the branch is merged, or when `--force`. Unmerged stays preserved. Output names the rule.

Tests: merged non-ephemeral cleanup leaves no directory and no `git worktree list` entry.

## PR

https://github.com/pseudoseed/codev/pull/123

CMAP: gemini=skipped (agy exit 1), codex=REQUEST_CHANGES, claude=REQUEST_CHANGES.

Fixed: `--force` on unmerged no longer `git branch -D`s the ref. A failed `git worktree remove` now fatals and keeps the builder row instead of warning and manufacturing an orphan.

Left: dirty merged still fatals (row stays; user `--force`s). Merge check still uses the local default branch (pre-existing `isWorktreeMerged`). Did not rebase 20 commits behind main.
