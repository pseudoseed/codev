# air-127 — porch post-merge state commits look unmerged

## Implement

`isWorktreeMerged` still prefers ancestry. If that fails, `git log --name-only main..HEAD` treats the branch as merged when every path those commits touched lives under `codev/projects/` or `codev/state/`.

Log, not triple-dot tree diff: an add-then-rename into `codev/state/` still shows the original path. A later commit on main does not pin the worktree.

## PR

https://github.com/pseudoseed/codev/pull/129

CMAP: gemini=skipped (agy exit 1), codex=APPROVE, claude=COMMENT.

Addressed: rename of real work into a bookkeeping path now preserves; never-merged bookkeeping-only is documented as `removed-merged`.
