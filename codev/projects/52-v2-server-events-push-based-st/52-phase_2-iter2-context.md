### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy exited with code 1
- codex: COMMENT — Codex lane skipped — usage limit until 2026-08-27 16:01
- claude: REQUEST_CHANGES — Phase 2 meets its deliverables and criterion 12, but the snapshot seq is read at write time rather than subscribe time and the client-id scheme can collide, both of which break silently once phase 3 lands.
- opencode: REQUEST_CHANGES — Snapshot seq is read after emit-capable work, so a delta during connect shares seq with the snapshot and breaks 6b.

### Builder Response to Iteration 1
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
