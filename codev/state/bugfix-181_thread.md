# bugfix-181 — CI red: unit tests import porch-driver/dist which CI never builds

## Investigate

### Reproduced
Worktree has no `packages/porch-driver/dist` (`ls` → No such file or directory). Direct import matches CI:

```
node --input-type=module -e "import('./packages/porch-driver/dist/thread.js')"
→ ERR_MODULE_NOT_FOUND Cannot find module '.../packages/porch-driver/dist/thread.js'
```

Full vitest run not used for the repro: this worktree has no local `vitest` binary. The missing module is the failure; running the suite on a tree that already has `dist/` is the condition that hid this.

### Root cause
1. `packages/codev/src/agent-farm/__tests__/helpers/porch-thread-engine.ts:1,5,6` imports `porch-driver/dist/{thread,commands,turn}.js`.
2. `.github/workflows/test.yml` unit job builds sdk, core, types, artifact-canvas (lines 31–53). It never builds `packages/porch-driver`.
3. `packages/porch-driver/.gitignore` ignores `dist/`, so a fresh CI checkout has no directory.
4. Only two consumers: `spec-146-phase-9-porch-engine.test.ts` and `spec-146-phase-9-live-harness.test.ts`, both via the helper. Sibling tests import `porch-driver/src/` and would not fail this way.
5. PR #177 (`c05b8cb88`) moved the adapter into `__tests__/helpers/` so production `dist/` has no cross-package import. The pack guard covers packed dist, not test helpers.

### Scope
Fits BUGFIX. Prescribed fix: add a `pnpm build` step for `packages/porch-driver` in the unit job, before "Copy skeleton for unit tests". Plus a workflow-parse regression test (same shape as #1502 / #107). Well under 300 LOC.

porch-driver lists `@cluesmith/t3-client` as a dependency but no source file imports it. `tsc` should not need a t3-client build.

Alternative considered: point the helper at `src/` like sibling tests. Smaller runtime coupling, but the issue names the CI step as the intended fix.

## Fix

YAML 4-line step added at `.github/workflows/test.yml:55-57` (before copy-skeleton). Regression test: `packages/codev/src/__tests__/bugfix-181-porch-driver-ci-build.test.ts`.

### Verification (architect's sequence)
1. `rm -rf packages/porch-driver/dist` — confirmed gone.
2. `npx vitest run src/agent-farm/__tests__/spec-146-phase-9-porch-engine.test.ts` — FAIL, `ERR_MODULE_NOT_FOUND` on `porch-driver/dist/thread.js`. Matches CI.
3. `pnpm --filter @cluesmith/porch-driver build` — tsc ok.
4. Re-run same file — suite loads. 2 engine tests pass. Pack test fails: `packages/codev/dist` missing, `expect(distJs.length).toBeGreaterThan(0)` got 0.
5. `spec-146-phase-9-live-harness.test.ts` — 2 passed, 1 skipped.

### Architect direction (not 1/2/3)
Ship the YAML. Skip the pack test honestly when `packages/codev/dist` is absent (`could not check: packages/codev/dist not built`). Move the real assertion into `verify-install.mjs` (package job already builds and packs codev). Keep the empty-dist reach assertion.

### Done
- YAML step at test.yml:55-57.
- `scripts/packed-dist-imports.mjs` + wired from verify-install.mjs on `cluesmith-codev-<version>.tgz`.
- Pack test skip-honest; fixture tests for empty dist / missing import / ok.
- Vitest: 3 files, 9 passed, 1 skipped (pack body, dist absent).

## PR

PR #183 https://github.com/pseudoseed/codev/pull/183
CI green on `67cfbca5c` (Tests + CLI Integration Tests).

CMAP:
- gemini: APPROVE
- claude: APPROVE
- codex: quota exhausted ("try again at 5:40 AM")
- opencode substitute: APPROVE

No REQUEST_CHANGES. Handing off at the pr gate.
