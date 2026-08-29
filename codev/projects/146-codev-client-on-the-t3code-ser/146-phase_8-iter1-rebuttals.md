# Spec 146, Phase 8, iteration 1 — responses to the review

Verdicts: **codex REQUEST_CHANGES, claude COMMENT.** Nothing is disputed on the
facts. Every finding from both lanes was checked against the file before being
accepted, and all of them held.

Phase 8's code is not this branch's work: it landed off-band on `main` as PR #166
(`2e95d21d9`) while this builder was in phase 7, and the architect's instruction
for this phase is **verify, do not implement**. So the corrections below are to the
verification document, its test coverage, and the issue tracker — not to merged
production behaviour. Where a lane asked for a production change, the reason it was
not made is stated rather than skipped.

## Accepted

### 1. The verification document claimed more than its evidence supported — codex

Codex's three findings are the reason this document exists in its current form. The
first draft read the tests as evidence for claims one step larger than they support,
and marked three rows satisfied that are not:

- **Thread-backed spawn has no production caller.** `installThreadSpawnFactory`
  (`agent-farm/thread-runtime.ts:97`) is called only from
  `__tests__/spec-146-phase-9-afx-parity.test.ts`. With no factory registered,
  `chooseSpawnPath` returns `pty` unconditionally, so the thread branch in
  `launchSpawnedBuilder` (`agent-farm/commands/spawn.ts:145-156`) is unreachable in
  production. Phase 8's own test injects a fake factory
  (`spec-146-phase-8-thread-identity.test.ts:137`), which demonstrates the branch,
  not the integration.
- **The `cmd` sentinel is absent.** Covered in full below.
- **Two acceptance criteria are simulated.** The migration tests build the pre-v21
  shape from `PRE_V21_ARCHITECT` / `PRE_V21_BUILDERS` literals rather than a copy of
  a real `global.db`, and stand in for "the previous release" by issuing SQL that
  omits `thread_id`. That is an SQL-level additivity proof. It is not a real
  database surviving, and the previous release is never run. The plan's integration
  case — a thread-backed builder driven alongside a running PTY builder — is
  likewise unrun, and **cannot** run until the first finding is fixed.

**Corrected** in `146-phase_8-verification.md`: the three rows are marked
`NOT MET IN PRODUCTION` / not met in the deliverables table, and a **Not met**
section states each with its file reference. The document now claims exactly what
its evidence carries.

### 2. The sentinel row was one step generous — claude

Claude sharpened codex's second finding, and the sharpening changes the count.
`ArchitectState` (`agent-farm/types.ts:45-55`) has no `pid` and no `port` — it
carries `name`, `cmd`, `startedAt`, `terminalId`, `threadId`, `sessionId`. So
`architectWriteValues` writes `0`/`0` in **both** branches, exactly as it did before
phase 8. `THREAD_ARCHITECT_SENTINEL` being `{pid: 0, port: 0}` is therefore not two
of three sentinels implemented; it is a constant that changes nothing. `cmd` was the
only one of the three that could have distinguished a thread-backed row, and it is
passed through unchanged.

Zero of three, not two of three. **Corrected**: the row no longer says `PARTIAL`, it
says which half is met (exclusivity, in production) and that no sentinel
discriminates.

**The `cmd` sentinel was deliberately not implemented here.** Codex asked for a test
that rejects or normalizes a non-empty command on a thread-backed architect; that
test would require changing merged production behaviour, and blanking `cmd` discards
the command an architect restart reads. Nothing currently breaks — `NOT NULL` is
satisfied either way, and discrimination runs off `thread_id`/`terminal_id`, which
is exercised and works. Whether to blank it or amend the plan belongs with whoever
wires the production engine, which is the same decision as finding 1.

What *was* missing and is now supplied: **any test at all.** `architectWriteValues`
and `THREAD_ARCHITECT_SENTINEL` had **zero** coverage — a grep for either name
across the repo returned nothing. Added a four-test
`Spec 146 Phase 8 — architect write values` block to
`spec-146-phase-8-thread-identity.test.ts`:

- thread-backed row writes the pid/port sentinel, clears `terminal_id`;
- terminal-backed row keeps `terminal_id`, clears `thread_id`;
- an architect carrying both identities throws `DualIdentityError`;
- a characterization test pinning `cmd` **un**blanked and pid/port identical across
  both branches, commented as a divergence from the plan rather than as intended
  behaviour.

The fourth is the one that matters for this finding: the gap can no longer close or
widen silently, and a future reader meets the divergence in an assertion instead of
inferring it from an absence. File now passes 21 tests, up from 17.

### 3. An unmet criterion living only in a project doc is untracked — claude

Correct by this project's own rule that issues are the source of truth. #179 recorded
the root cause (item 2: `installThreadSpawnFactory` has no production caller) but
named only phase 9's consequences.

**Filed** as a comment on #179
(`github.com/pseudoseed/codev/issues/179#issuecomment-5463236855`), naming both
phase-8 consequences: the unmet "a new spawn takes the thread path" criterion plus
the two criteria blocked behind it, and the sentinel decision that needs to be made
alongside the engine wiring. Both `Not met` entries in the verification document now
point at it.

### 4. Citation ambiguity — claude

The deliverables table used the bare name `state.ts` for two different files in
adjacent rows. In a document whose entire product is a citation trail, that is a
real defect. **Fixed**: `commands/porch/state.ts` and `agent-farm/state.ts` are now
written out in full, and the `recordThreadId` line number corrected from 179 to 177.

## Not accepted as a change here

Codex's third finding asks for the migration to run against a copy of a real
`global.db` and for the previous release to open the restored database. Both are
conceded as unmet above and are recorded as such. Neither is fixed in this phase:
the first needs a real database that this worktree does not have and must not
fabricate, and the second is circular with finding 1 — a previous release opening
the migrated database proves the additive property, but the integration it is meant
to guard (a thread-backed builder alongside a running PTY builder) cannot run at all
while production has no factory. Fixing them in the wrong order would produce more
simulation, not more evidence.

## What is met, and the first draft undersold

Worth stating because the corrections above are all in one direction. Claude checked
the live write path independently: `assertExclusiveIdentity` and
`architectWriteValues` are wired into `setArchitect` (`agent-farm/state.ts:132`),
`setArchitectByName` (`:166`) and `upsertBuilder` (`:205`, `:210`) — so "a row
carrying both a `terminal_id` and a `thread_id` is rejected" holds in production, not
only in tests. `upsertBuilder` is stronger than the plan asked: it re-checks the
*merged* result against the existing row, so an update that adds `thread_id` to a row
already holding `terminal_id` is caught, which a `COALESCE`-only implementation would
let through.

Both lanes also independently confirmed every citation in the document resolves —
all 13 test line numbers land on the named `it(...)`, and `db/schema.ts:187,221`
declares `thread_id` **last** in both tables with a comment saying why, which is the
property the fresh-vs-migrated convergence test depends on.

## Evidence

- `spec-146-phase-8-thread-identity.test.ts`: **21 passed**, up from 17.
- Build exit 0; full suite green in the phase-8 porch checks
  (`✓ build`, `✓ tests`, 6,621 passed / 50 skipped / 0 failed).
- No production source changed in this iteration. The diff is the verification
  document, the phase-8 test file, and a comment on #179.
