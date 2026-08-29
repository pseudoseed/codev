# bugfix-151 thread

## Investigate (2026-08-29)

Two defects, both "I could not tell" spelled as a verdict.

### 1. Suite lock contention reports as CHECKS FAILED

`packages/codev/vitest-global-setup.ts` `acquireTestSuiteLock` waits on loopback port 13999 (machine-wide, #130). After 120s it throws. Vitest exits 1.

`runCheck` (`packages/codev/src/commands/porch/checks.ts:135-151`) maps every non-zero to `passed: false`. `done`/`check`/`approve` then print CHECKS FAILED.

Reproduced at the lock: occupant on a test port, 80ms wait, throws `Timed out waiting for the suite lock`. Porch has no third state on `CheckResult`.

"No test files found" is not this path. The 146 thread later tied that line to a nested worktree, not the lock wait.

### 2. porch from `packages/codev` cannot see the project

`cli()` sets `workspaceRoot = process.cwd()` (`index.ts:1358`). Other CLIs use worktree-aware `findWorkspaceRoot`. Measured from this worktree's `packages/codev`:

- `porch done 151` → `Error: Project 151 not found.` exit 1 (project exists at the worktree root)
- `porch next 151` → JSON `{ status: "error", error: "Project 151 not found..." }` **exit 0**

The silent success is `porch next`. `porch done` already exits 1, but the "not found" is still a lie.

### Scope

Fits BUGFIX. Distinct lock-busy exit (75 / EX_TEMPFAIL) + porch surfaces BLOCKED not FAILED. Walk up to `codev/projects` for workspace root. `porch next` exits 1 on `status: error`.

## Fix (2026-08-29)

- `src/lib/suite-lock.ts` — exit 75 + timeout needle
- `vitest-global-setup.ts` — `SuiteLockBusyError`, `process.exit(75)` on timeout
- `runCheck` sets `blocked` on exit 75 or the timeout needle; `check`/`done`/`approve` print CHECKS BLOCKED
- `resolvePorchWorkspaceRoot` walks to `codev/projects`; `cli()` uses it
- `porch next` exits 1 on `status: error`

Regression: `bugfix-151-lock-contention-and-cwd.test.ts` (10 tests). 14/14 with the #130 lock tests.
