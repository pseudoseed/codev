# bugfix-102 thread

## Investigate (2026-08-24)

Reproduced from `/tmp` (no project, so no state mutation):

- `porch --help` → usage, exit 0
- `porch done --help` → `Error: Cannot determine project ID`, exit 1 (executes `done`)
- `porch status --help` → same error (executes `status`)
- `porch next --help` → treats `--help` as a project id (`Project --help not found`)

Did not run `porch done --help` from this worktree: auto-detect would advance bugfix-102.

Root cause: `cli()` in `packages/codev/src/commands/porch/index.ts`. `--version`/`-v` is handled before dispatch. `--help`/`-h` is only handled in the switch `default` (first token is `--help` or unknown). Every named subcommand ignores `--help` in `rest` and dispatches. `done` then runs checks and advances; that is the hang in the original report (`porch done bugfix-97 --help` actually ran `done` against a live project).

Scope: pre-dispatch `--help`/`-h` print usage exit 0. Fits BUGFIX.

## Fix (2026-08-24)

`cli()` now treats `--help`/`-h` anywhere in argv before the switch. Usage extracted to `printUsage()`. Test: `issue-102-help-before-dispatch.test.ts`. Confirmed the test fails without the early return (`process.exit(1)` from dispatched `done`) and passes with it. Build + full test suite green via `porch done`.

## PR (2026-08-24)

PR #135: https://github.com/pseudoseed/codev/pull/135

CMAP:
- gemini: SKIPPED (agy exit 1, quota). Not a review.
- opencode (fallback): APPROVE
- codex: COMMENT (branch 2 commits behind main; unrelated thread log only; no code change requested)
- claude: APPROVE

No REQUEST_CHANGES. Handing to architect:uiv2 at the pr gate.
