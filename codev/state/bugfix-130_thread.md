# bugfix-130 builder thread

## Investigate — 2026-08-24

Reproduced with two overlapping copies of `tower-api.e2e.test.ts`: the first passed 16/16;
the second failed 4/16 (three workspace activations and the rate-limit case). Either passes
alone. `tower-api.e2e.test.ts:25,67` always requests port 14300. Because
`startTower()` only finds an available port when none is supplied
(`helpers/tower-test-utils.ts:203`), its readiness poll sees the *other run's* listener and
mistakes that for its own child. Both clients then mutate the first Tower's limiter,
workspace, and terminal state, while either teardown can remove shared resources.

The broader boundary is the Vitest command: configs do not isolate one invocation from
another. #1515 isolates each spawned Tower directory, but not fixed ports, the Vitest
parent's real `~/.agent-farm` (including `ensureLocalKey()` in `vitest-e2e-setup.ts:47`), or
paths reaching :4100. The issue explicitly permits the focused remedy chosen here: one
machine-wide, cross-process Vitest lock wired into all three package configs. A second run
waits visibly, and the kernel releases the listening-socket mutex on process exit. This avoids
changing every fixed-port contract and fits BUGFIX scope.

## Fix — 2026-08-24

Added the three-config global lock and a real two-process barrier test. Mutation-disabled lock:
waiter acquired early and the regression failed; restored lock passed. Repeated the original
parallel tower-api command: both runs passed 16/16 and the second printed the wait diagnostic.
