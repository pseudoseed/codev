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

## ROOT_MISSING

Architect: `readStatusesFromArtifactRoot` returned [] on ENOENT for both a live
root with no projects and a worktree that no longer exists. `statSync` the root
first; missing root emits `ROOT_MISSING`. [] stays only for a root that exists
and has no `codev/projects`. Collapse to [] fails the matrix test.

## PR #161 REQUEST_CHANGES

Received the 04:23 ROOT_MISSING instruction and landed it in `3e1d5a031`
before this review comment. The comment was against a prior head.

Merged `origin/builder/spir-146` (phase 4 review fixes present: ed5bd25e7,
1e2a215a6, 759b4f507, 3564a8c4a, cf4dd980d). Revoked tombstones now expire
with the original session lifetime. Unreadable-status test skips as root.
`.gitignore` covers `opencode.json` and the `.builder-*` harness files.

Watcher miss is not a slow 2s deadline. Timeout now names one of
WATCH_FAILED / WATCHER_NEVER_ARMED / WATCHER_NEVER_FIRED / SNAPSHOT_SWALLOWED /
SNAPSHOT_STALE. Watch paths go through realpathSync so macOS FSEvents is not
aimed at the /var/folders symlink. Three full agent-farm runs after that:
3497 passed, 34 skipped, 0 failed each.
