# air-100 — afx cleanup cannot remove an orphaned builder worktree

## Implement

`afx cleanup -p 78` died with `Builder not found for project: 78` when `.builders/air-78` existed but had no `global.db` row. discoverBuilders still listed those dirs, so GET /v2/events showed them as offline builders forever.

Did not change how discoverBuilders reports row-less worktrees. That stays a recovery signal.

When no project row matches, cleanup now scans `.builders/` for a directory whose name is the project id or `{protocol}-{id}`. One match and no live builder row owns that worktree (exact path or basename): treat it as an orphan and remove it. Two matches: refuse and name both. Unmerged without `--force`: refuse. Merged, or `--force`: `git worktree remove` plus local branch delete.

The 13 orphans already on this workspace are not touched. That is the human's call.

## PR

https://github.com/pseudoseed/codev/pull/117
