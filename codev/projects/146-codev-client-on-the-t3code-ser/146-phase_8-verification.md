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
| Architect: `ADD COLUMN` + sentinels, exclusivity in code not `CHECK` | **MET, plan amended.** `db/thread-identity.ts` — `THREAD_ARCHITECT_SENTINEL {pid:0, port:0}`, `assertExclusiveIdentity`, `architectWriteValues`. The plan's third sentinel (`cmd` `''`) was dropped by architect ruling **#170**: the plan was wrong, not the code. See below. |
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

2. ~~**The `cmd` sentinel is not implemented.**~~ **RESOLVED — the plan was wrong, not the
   code.** Codex was right that `architectWriteValues` diverges from the plan's `cmd` `''` and
   right that `architectWriteValues` had **zero** test coverage. The architect ruled on **#170**
   that `pid`, `port` and `terminal_id` are genuinely PTY-specific and meaningless for a
   thread-backed row, but `cmd` is *how the architect was launched* and an architect restart
   reads it — blanking it discards live information. So:

   - The plan's phase_8 deliverable is amended to name two sentinels, not three, with the #170
     rationale recorded inline.
   - Five characterization tests were **added** (they did not exist) under
     `Spec 146 Phase 8 — architect sentinels (#170)`, asserting `cmd` survives on both the
     thread-backed and terminal-backed branches, that `THREAD_ARCHITECT_SENTINEL` names exactly
     `pid` and `port`, that a dual-identity architect row is refused, and that an empty `cmd` is
     preserved rather than substituted.
   - Mutation-checked: blanking `cmd` in `architectWriteValues` makes the first of those tests
     fail. The test can fail, so it is holding something.
   - **The `pid`/`port` assertions in those tests cannot fail**, and should not be read as
     coverage. `architectWriteValues` hardcodes `pid: 0, port: 0` in *both* branches
     (`db/thread-identity.ts:33-34,41-42`) and `ArchitectState` (`agent-farm/types.ts:45-55`)
     carries neither field, so `expect(written.pid).toBe(0)` passes whichever branch ran. Only
     the `cmd` assertions hold the #170 decision. Raised by the iteration-2 `claude` lane.

3. **Two acceptance criteria are simulated, not exercised. PARTIALLY ADDRESSED in iteration 2.**
   The plan asks for the migration "against a copy of a real `global.db`" and for "the
   **previous** release" to open the restored database. Raised by `codex` and independently by
   `opencode`.

   **Fixed:** the pre-v21 fixture is no longer hand-typed. `PRE_V21_ARCHITECT` and
   `PRE_V21_BUILDERS` are now **derived from the shipped `GLOBAL_SCHEMA`** by extracting each
   `CREATE TABLE` and stripping the `thread_id` column. A typed fixture is a claim about the
   schema and can drift from it — a column added to `architect` in `schema.ts` would have left
   these tests passing against a table that no longer exists in production. `stripThreadId`
   **asserts its own reach**: it throws if it removed nothing, so renaming `thread_id` breaks
   the tests by name instead of silently yielding a fixture identical to the post-migration
   shape, which would make every migration test vacuous. Mutation-checked — renaming the column
   in `schema.ts` produces `Expected a thread_id column to strip from architect`.

   **Still not met, and not fixable here:**
   - *A copy of a real `global.db`.* A test that reads `~/.agent-farm/global.db` would be
     machine-dependent and non-deterministic, and would fail in CI where no such file exists.
     Determinism is a stated requirement of this phase, so the derived-schema fixture is as
     close as a unit test can honestly get. Exercising a real database belongs in a manual
     migration rehearsal, not in the suite.
   - *The previous release opens the restored database.* The test stands in for it by issuing
     previous-release-shaped SQL on the current handle. Actually loading previous-release code
     is not something the suite can do.
   - *A thread-backed builder driven alongside a running PTY builder.* Cannot run until (1) is
     fixed; it has no production path to drive.

Two of the three stand; the third turned out to be a plan defect and is resolved above. None
is a regression: the merged code does what its own tests say. What was wrong was this
document's first draft, which read the tests as evidence for claims one step larger than they
support.

**The `claude` lane for this iteration is VOID** — it wrote to the worktree and posted a
public GitHub comment instead of reviewing. Its artifact (`146-phase_8-iter1-claude.txt`)
records the void explicitly rather than being absent, because an absent lane artifact and a
rejected one are different things porch cannot otherwise tell apart (#168).
`146-phase_8-iter1-opencode.txt` is the substitute lane.

## What is NOT claimed

The comment logged by the v21 block reads `Spec 146 Phase 5`, because the columns are
Phase 5's. Phase 8 added the backup and the sentinel/exclusivity layer into the same guarded
block. That is the merged shape on `main`; it is recorded here so the next reader does not
mistake the log line for the whole of what v21 does.

The backup path has two branches and both are now tested. The reuse branch — a second
migration attempt finding a `.pre-v21.bak` already present and leaving it alone — was untested
until the iteration-2 `claude` lane flagged it. It matters because that branch is what protects
the restore point: after a crash between the backup and the `ALTER`, a retry that refreshed the
backup would capture the half-migrated database instead of the pre-v21 state.
`reuses an existing pre-v21 backup instead of overwriting the restore point` covers it, and is
mutation-checked — forcing the `VACUUM INTO` unconditionally makes it fail.

Build exit 0. Full suite run recorded in the phase-8 porch checks.
