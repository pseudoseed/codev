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
| Architect: `ADD COLUMN` + sentinels, exclusivity in code not `CHECK` | **PARTIAL.** `db/thread-identity.ts` — `assertExclusiveIdentity` and `architectWriteValues` are there, but `THREAD_ARCHITECT_SENTINEL` is `{pid:0, port:0}`: the plan names three sentinels and the code implements two. See **Not met**, below. |
| Backup taken before the migration, path logged at `info` | `db/index.ts:718-740` — `threadIdentityBackupPath` → `<db>.pre-v21.bak`, `VACUUM INTO` (chosen over a byte copy because global.db is WAL) |
| Existing migration mechanism: version constant, guarded inline block, `GLOBAL_SCHEMA` convergence | `db/index.ts:144` (`GLOBAL_CURRENT_VERSION = 21`), `db/index.ts:700`, `db/schema.ts:187,221` |
| `afx spawn` writes `thread_id` to both stores and no `terminal_id` | **NOT MET IN PRODUCTION.** The code path exists — `commands/spawn.ts:145` (`chooseSpawnPath`), `:147` (`allocateSpawnThread`), `:169` (`recordThreadId`) — but nothing in production registers a factory, so `chooseSpawnPath` returns `pty` and the branch is unreachable outside tests. See **Not met**, below. |
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

## Not met — found by the phase_8 iteration-1 `codex` lane, verified against source

Three of the rows above were written as satisfied and are not. Codex raised them; each was
checked against the file before being accepted. They are recorded here rather than corrected
in code, because the architect's instruction for this phase is **verify, do not implement**.

1. **Thread-backed spawn has no production caller.** `installThreadSpawnFactory`
   (`agent-farm/thread-runtime.ts:97`) is called only from
   `__tests__/spec-146-phase-9-afx-parity.test.ts`. With no factory registered,
   `chooseSpawnPath` returns `pty` unconditionally in production. Phase 8's tests inject a
   fake factory (`spec-146-phase-8-thread-identity.test.ts:137`), so they demonstrate the
   branch, not the integration. **Already filed: #179 item 2**, against phase 9. It is
   recorded here too because it also unmakes phase 8's acceptance criterion "a new spawn
   takes the thread path", which no issue currently says.

2. **The `cmd` sentinel is not implemented.** The plan specifies `pid` 0, `port` 0, `cmd`
   `''` for a thread-backed architect. `architectWriteValues` returns `cmd: architect.cmd`
   unchanged, and no test rejects or normalizes a non-empty command on a thread-backed row.
   The `NOT NULL` constraint is still satisfied either way, so nothing breaks; the divergence
   from the plan is unrecorded, which is the actual problem.

3. **Two acceptance criteria are simulated, not exercised.** The plan asks for the migration
   "against a copy of a real `global.db`" and for "the **previous** release" to open the
   restored database. The tests build the pre-v21 shape from `PRE_V21_ARCHITECT` /
   `PRE_V21_BUILDERS` string literals, and stand in for the previous release by issuing SQL
   that does not name `thread_id`. That proves the migration is additive at the SQL level. It
   does not prove a real database survives, and it does not run the previous release at all.
   The plan's integration case — a thread-backed builder driven alongside a running PTY
   builder — is likewise not run, and cannot be until (1) is fixed.

None of the three is a regression: the merged code does what its own tests say. What was
wrong was this document's first draft, which read the tests as evidence for claims one step
larger than they support.

## What is NOT claimed

The comment logged by the v21 block reads `Spec 146 Phase 5`, because the columns are
Phase 5's. Phase 8 added the backup and the sentinel/exclusivity layer into the same guarded
block. That is the merged shape on `main`; it is recorded here so the next reader does not
mistake the log line for the whole of what v21 does.

Build exit 0. Full suite run recorded in the phase-8 porch checks.
