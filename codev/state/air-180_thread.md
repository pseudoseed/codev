# AIR 180 builder thread

## Implement — 2026-08-29

The issue's proposed `>=24` gate was invalidated before coding: every Homebrew `node@24`/`25`/`26` opt path on this machine resolves to Node 26.4.0, outside t3code's declared `^24.13.1` range. I first measured the real path on isolated port 38180. `t3@latest` (then 0.0.36) started, answered, reported the pinned checkout, and stopped cleanly under Node 26.4.0. The durable details are in the comment on issue #180.

Architect corrected the design from a semver gate to an empirical readiness gate. The harness now requires explicit `T3_NODE`, invokes that absolute interpreter through npm and forces it to the front of the child PATH for the package-bin shebang hop. `engines.node` is recorded as advisory. Missing interpreter, failed server start, and an answering server whose checkout moved from the pin emit `NO_INTERPRETER`, `SERVER_START_FAILED`, and `SERVER_COMMIT_MISMATCH` respectively.

The CLI is pinned as `0.0.36` beside commit `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`. Cold-start evidence was regenerated twice with real dispatches under Node 26.4.0; both passed and released the port. Enabling the Phase 9 live test exposed two previously hidden harness-test assumptions: Node 20 lacks global WebSocket, and four seconds was too short for a provider turn to start. Using the existing `ws` dependency and a bounded 30-second poll let the actual interrupt criterion pass: 2 passed, 1 expected companion test skipped.

Architect challenged the initial summary's phrase "expected companion skipped." That companion was `records why the live engine run could not check`; Vitest skipped it merely because `canRunLive` was true, so the summary had no independently asserted reason. I removed that conditional skip: the renamed readiness test now always asserts either both resolved prerequisites or the exact checkout/interpreter signal. A live run should therefore have no skipped companion.

The 30-second STARTED bound previously threw a generic `could not check:` error. It did fail rather than pass, but the state was not named separately enough. Timeout now throws `COULD_NOT_TELL: START_TIMEOUT` and states that the interrupt criterion was not evaluated; the real behavioral failure remains the separate assertion that `SHOULD_NOT_FINISH` exists after interruption.

Full-suite note: running `pnpm test` in the builder environment reproduced the known #189 baseline exactly (40 failures across send/whoami/detect-builder-id due leaked `CODEV_WORKTREE_ROOT`; 6,463 passed). A clean-environment rerun then could not acquire the global suite lock because the bugfix-189 builder was actively running its own suite on port 13999. Build and focused tests are green; final full-suite retry waits for that live producer to release the lock.

CI-shape verification used `T3_NODE` unset and `T3CODE_ROOT` pointed at a nonexistent checkout. The Phase 9 file exited 0 with 2 tests passed and the live criterion skipped. Output named both the unverifiable checkout and `NO_INTERPRETER`; the always-run readiness test asserted the checkout reason. `COULD_NOT_TELL: START_TIMEOUT` is only reachable after both prerequisites resolve and the live test body runs.
