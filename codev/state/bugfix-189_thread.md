# bugfix-189 thread

## Investigate

Reproduced the identity-path override in this session (CODEV_WORKTREE_ROOT, CODEV_BUILDER_ID, CODEV_ARCHITECT_NAME all set; CODEV_THREAD_ID unset). After `chdir(tmpdir())`, `detectCurrentBuilderId`'s identityPath is still the builder worktree, not cwd.

Root cause: tests control identity with `process.chdir()`. `detectCurrentBuilderId` (send.ts:195) prefers `CODEV_WORKTREE_ROOT` over cwd by design (#47). The harness never scrubs the runner's session identity. Not a resolution-order bug — do not change `detectCurrentBuilderId`.

Three files with the same coupling:
- `spec-1134-whoami.test.ts` (16/21 in the issue's leaked-env run)
- `bugfix-774-detect-builder-id.test.ts`
- `send.test.ts` (chdir to tmpdir, expects sender `architect`)

Architect direction: scrub the whole `CODEV_*` namespace once in `vitest-global-setup.ts`, plus a reach test that the scrub actually landed in the worker env. Proof: set the vars, run, green.

Did not re-run vitest in this worktree during investigate — no node_modules here. Causal path confirmed by executing the send.ts:195 identityPath assignment against the live session env.

Scope: harness + one isolation test. Under BUGFIX ceiling.

## Fix

Scrub the whole `CODEV_*` namespace in `scrubCodevNamespace()` (vitest-global-setup.ts). Call from globalSetup (workers inherit it on Vitest 4) and from vitest-setup.ts (re-apply per file). Keep documented harness opt-ins. Do not touch detectCurrentBuilderId.

Reach test in test-isolation.test.ts: fails when the scrub is not invoked and the runner has CODEV_WORKTREE_ROOT set; 66/66 pass across the three coupled files plus isolation with those vars set.
