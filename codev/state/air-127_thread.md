# air-127 — porch post-merge state commits look unmerged

## Implement

`isWorktreeMerged` still prefers ancestry. If that fails, a content check treats the branch as merged when every path unique since the merge-base lives under `codev/projects/` or `codev/state/`.

Triple-dot diff so a later commit on main does not pin the worktree. Real unmerged files still return `preserved-unmerged`.
