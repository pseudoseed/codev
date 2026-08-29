# air-163 — Spec 146 phase 8: thread identity in status.yaml and global.db

Branched stale. Merged origin/main at e710c97d6 (phase 5). thread_id count 2 in schema.ts, ROOT_MISSING count 3.

Phase 5 already added the columns (v21) and the VACUUM INTO backup. This phase writes them.

- `ProjectState.thread_id` optional; pre-change status.yaml still loads.
- `upsertBuilder` / `setArchitect` write `thread_id`, reject both identities, never copy one onto the other.
- Thread-backed architect rows use sentinels (pid 0, port 0, cmd "").
- `afx spawn` takes the thread path when a factory is registered; rollback is `setThreadBackedSpawnsEnabled(false)` and returns to PTY immediately. Existing PTY rows stay PTY.
- `afx status` reports PTY drain.
- GLOBAL_SCHEMA builders.thread_id moved last so fresh and migrated column order match.

No v22. Do not re-add the columns.
