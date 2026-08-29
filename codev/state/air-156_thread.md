# air-156 — Spec 146 phase 5 remainder: failure matrix and tests

Continuing `builder/task-uxln` at `5ba9ca661`. Protocol-state surface was already
on the branch; this issue is the matrix and the tests.

## Signals

Ten distinct codes, one per required row. Two "codev-agent down" rows cannot be
emitted by a dead server, so `classifyDualServiceFailure` maps them:
`CODEV_AGENT_UNREACHABLE` vs `CODEV_AGENT_UNREACHABLE_T3CODE_LIVE`.

Revoke used to collapse onto `UNKNOWN`. `HumanPairedSessionRegistry` now keeps
revoked ids and the session route emits `HUMAN_SESSION_REVOKED`.

Disagreement (`THREAD_ID_DISAGREEMENT`) is logged at startup and does not write
`status.yaml` or `global.db`.

## Tests

`packages/codev/src/agent-farm/servers/__tests__/agent-failure-matrix.test.ts`.
Mutated `THREAD_UNMANAGED` → `THREAD_HIDDEN`; that row's test failed; restored.

AIR LOC is the classifier plus the revoke distinction. Existing surface was not
rewritten.
