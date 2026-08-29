# Phase 8 — verification, not implementation

Phase 8 (`Thread identity in status.yaml and global.db`) was built off-band by a separate
AIR builder and merged to `main` as **PR #166, `2e95d21d9`**, while this builder was in
phase 7. Project 146's own porch record never advanced past it, so porch still offers it.

Per the architect's instruction, this phase was **verified against the plan's acceptance
criteria on the branch, not re-implemented**. Every reference below was read in the working
tree at `builder/spir-146` after the merge of `c67547eef`.

## Deliverables

| Deliverable | Evidence |
|---|---|
| `status.yaml` records `threadId` at spawn; field optional, old files still load | `commands/porch/types.ts:272` (`thread_id?: string`), `commands/porch/state.ts:179` (`recordThreadId`) |
| Columns added in Phase 5, written here, no backfill | `db/index.ts:700-704` (v21 guard), `state.ts:238` (`COALESCE(excluded.thread_id, builders.thread_id)`) |
| Architect: `ADD COLUMN` + sentinels, exclusivity in code not `CHECK` | `db/thread-identity.ts` — `THREAD_ARCHITECT_SENTINEL {pid:0, port:0}`, `assertExclusiveIdentity`, `architectWriteValues` |
| Backup taken before the migration, path logged at `info` | `db/index.ts:718-740` — `threadIdentityBackupPath` → `<db>.pre-v21.bak`, `VACUUM INTO` (chosen over a byte copy because global.db is WAL) |
| Existing migration mechanism: version constant, guarded inline block, `GLOBAL_SCHEMA` convergence | `db/index.ts:144` (`GLOBAL_CURRENT_VERSION = 21`), `db/index.ts:700`, `db/schema.ts:187,221` |
| `afx spawn` writes `thread_id` to both stores and no `terminal_id` | `commands/spawn.ts:145` (`chooseSpawnPath`), `:147` (`allocateSpawnThread`), `:169` (`recordThreadId`) |
| `afx status` reports the drain count | `commands/status.ts:298` (`countPtyDrainFromBuilders`), rendered at `:373`, `:431`, `:440` |
| No in-flight builder migrated across paths | `db/thread-identity.ts` `chooseSpawnPath` returns `pty` for any row already carrying a `terminalId`; asserted by a source scan test |
| Tests | `agent-farm/__tests__/spec-146-phase-8-thread-identity.test.ts` |

## Acceptance criteria → test

Every criterion has a named test in `spec-146-phase-8-thread-identity.test.ts`:

- migration against a populated database, every row survives — `:252`
- fresh `GLOBAL_SCHEMA` vs migrated schema identical — `:262`
- restore path exercised for real (backup → migrate → restore) — `:274`
- migrated database accepts previous-release writes (additive proof) — `:297`
- dual identity rejected — `:107`
- pre-change `status.yaml` loads unchanged; new one carries `thread_id` — `:202`, `:211`
- new spawn takes the thread path; PTY builder unaffected — `:136`, `:164`, `:178`
- rollback is the spawn path, not the column — `:149`
- drain count goes to zero — `:118`
- no in-flight path migration in source — `:313`

## What is NOT claimed

The comment logged by the v21 block reads `Spec 146 Phase 5`, because the columns are
Phase 5's. Phase 8 added the backup and the sentinel/exclusivity layer into the same guarded
block. That is the merged shape on `main`; it is recorded here so the next reader does not
mistake the log line for the whole of what v21 does.

Build exit 0. Full suite run recorded in the phase-8 porch checks.
