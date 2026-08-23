# Phase 2 rebuttal — iteration 1

Claude and opencode REQUEST_CHANGES HIGH. Gemini skipped, Codex quota-exhausted. All named defects accepted.

## Must-fix (both lanes)

- **snapshot.seq at write time.** `snapshotFrame` and `darkFrame` now take subscribe-time `seq`. Flush test asserts `snapshot.seq === 0` and in-flight `gone.seq === 1`.

## Claude, also accepted

- Monotonic `nextClient` instead of `${Date.now()}-${size}`.
- Cleanup registered immediately after subscribe; `writeSse` no-ops if `writableEnded`/`destroyed`.
- `emit` wraps each subscriber in try/catch.
- `workspacePathFromId` lives in `v2-ids.ts` with a round-trip test.
- `parseScope` drops empties and dupes; negative `since` is 400.

Not doing this phase: reaping abandoned ScopeState. Spec says buffers survive zero clients so last-client resume works. Age trim still runs on emit/resume.
