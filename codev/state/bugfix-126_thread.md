# Builder thread — bugfix-126

## Investigate

- Reproduced against the installed implementation with a temporary Git repository and a row-less
  `builder/bugfix-126` worktree. After committing an unmerged `wip.txt`, calling the orphan removal
  path with `force=true` removed the worktree and also removed the local branch
  (`worktreeExists=false`, `branchSurvived=false`).
- Root cause: `cleanupOrphan` calls `removeOrphanWorktree` without `deleteBranch` at
  `packages/codev/src/agent-farm/commands/cleanup.ts:500`. The callee already computes merge state
  at line 311, but line 322 defaults branch deletion to true. In contrast, the live-row
  non-ephemeral path passes `{ deleteBranch: merged }` at line 230.
- All production callers were traced. Ephemeral builder cleanup has a separate explicit branch
  deletion path; `removeOrphanWorktree` serves row-less or non-ephemeral cleanup. Therefore the
  focused fix is to make its already-computed `merged` value govern branch deletion and remove the
  caller-controlled option. Expected scope is a few lines plus one regression assertion, well below
  BUGFIX's 300 LOC ceiling and with no architectural impact.

## Fix

- Made `removeOrphanWorktree` use its internally computed merge state as the sole branch-deletion
  decision and removed the redundant caller option.
- Strengthened the row-less orphan `--force` test to assert that the worktree disappears while its
  unmerged branch remains recoverable.
- Mutation-checked the regression assertion: restoring the pre-fix unconditional branch deletion
  produced the expected single failure (`expected '' to contain 'builder/air-78'`); restoring the
  fix returns the targeted test file to green.
- Validation passed: targeted regression file (18/18), root build, and the full test suite via
  `porch check bugfix-126` (build 15.4s; tests 256.9s).
