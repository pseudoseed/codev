# Phase 9 — partial: three items implemented, four recorded unmet

Phase 9 (`Architect threads and afx command parity`) was built off-band by an AIR builder
and merged to `main` as **PR #177** (`c05b8cb88`, `ffbeb123d`), which is an ancestor of this
branch. That builder filed **#179** against its own work: seven deliverables and acceptance
criteria unmet.

The architect ruled that phase 9 is **not** phase 8 — phase 8's off-band PR met its criteria,
so verify-and-record was the whole job; phase 9's did not, so phase 9 splits. Implement the
reachable subset (**#179 items 1, 2, 5**), record the rest as unmet and do not tick them.
Ruling: `issues/179#issuecomment-5463507323`.

## Implemented here

### Item 1 — a production path to a real engine

**Was:** `createPorchThreadEngine` existed only at
`agent-farm/__tests__/helpers/porch-thread-engine.ts`, importing porch-driver by a relative
path into its gitignored `dist/`. `@cluesmith/codev` packs from `packages/codev`, so that
import cannot survive packing; `porch-driver` was `private: true` and absent from this
package's dependencies. "The only engine reachable in production is none" was accurate.

**Now:** `agent-farm/porch-thread-engine.ts`, importing `@cluesmith/porch-driver/thread`.

**Publishing was chosen over vendoring, and the reason is the phase-1 precedent's limit.**
Phase 1 vendored the t3code *contract* — a small, stable set of types with no behaviour. This
is live logic (threads, turns, the dispatch journal) that has its own tests; a vendored second
copy is how the tested engine and the shipped one drift apart. Publishing cost two manifest
edits: `porch-driver` and its own dependency `@cluesmith/t3-client` both drop `private: true`.
Both were required — a published package cannot depend on a private one, because `workspace:*`
resolves to a version at publish time and a private package is never published. The filing
named only `porch-driver`; `t3-client` is a consequence found by following the dependency.

The test helper stays as a re-export so existing tests keep their import path, rather than a
second copy.

**Verified from the built `dist`, not from source:** after `npm run build` (exit 0),
`dist/agent-farm/porch-thread-engine.js` imports `@cluesmith/porch-driver/thread` by package
name, `packages/porch-driver/dist/*.js` is built by codev's own build step, and the module
loads under `node`.

### Item 2 — a production caller

**Was:** `installThreadSpawnFactory` had no caller outside
`spec-146-phase-9-afx-parity.test.ts`, so `chooseSpawnPath` returned `pty` unconditionally.

**Now:** `agent-farm/thread-backend.ts` reads a `threads` block from `.codev/config.json`
(or `CODEV_T3_URL` / `CODEV_T3_TOKEN`), connects, registers the engine and installs the
factory. `launchSpawnedBuilder` calls it **before** `chooseSpawnPath`, which is the one place
the decision is made and so covers all five spawn call sites.

Thread-backed spawning stays **opt-in**: a workspace with no server configured is byte-for-byte
unchanged and returns `pty`. The architect's requirement was reachable, not default.

**"Configured and unreachable" is not "not configured".** The first returns `pty` silently;
the second throws, naming the server. A half-filled `threads` block throws too. This is the
project's standing rule that "I could not tell" must never be spelled the same way as "no",
applied at the one seam where a silent PTY fallback would look like a successful spawn.

**Verified from the built `dist`:** `chooseSpawnPath()` returns `pty`, and `thread` after
`installThreadSpawnFactory()` — run against `packages/codev/dist`, not the TypeScript source.

### Item 5 — the second half of the interrupt assertion

The plan states the criterion as two clauses: `activeTurnId: null` **and** the interrupted
command's side effect absent. Only the first was asserted, because
`createMemoryThreadEngine.startTurn` records a turn id and runs nothing — there is no side
effect for an interrupt to prevent.

Two changes:

1. `spec-146-phase-9-interrupt-side-effect.test.ts` — a process-backed `ThreadEngine` whose
   turns are real child processes. It asserts both clauses, waits on the child's `exit` event
   rather than a timer, and carries a **control test** showing the same turn *does* write the
   marker without the interrupt. The assertion can fail, so it is holding something.
2. The live-harness test's fixed `4000` ms wait is replaced by a **poll**. A fixed wait cannot
   be right here, and both failure modes were observed by running it:
   - at 4 s the provider has not started the command, so the test aborts `could not check`;
   - at 90 s the `sleep 30` has already elapsed, so `SHOULD_NOT_FINISH` is written before the
     interrupt fires and the test fails **against a working interrupt**.
   It now polls for `STARTED` and interrupts the moment it lands, and asserts
   `activeTurnId: null` as well as the absent marker.

The deterministic test proves the seam — `interruptThread` → `ThreadEngine.interrupt` — stops
running work rather than only clearing a field, and it runs in CI with no server. It does
**not** prove t3code's `thread.turn.interrupt` kills a provider's command; that is the live
test's claim, and the live test skips loudly rather than passing quietly when it cannot check.

## Not met — recorded, not ticked

Per the architect's ruling these are not implemented here, and none is ticked.

| #179 item | Criterion | Status |
|---|---|---|
| 3 | An architect is a thread whose worktree is the workspace root | **Waiting on #180**, not blocked |
| 4 | An architect thread survives a server restart and resumes with context | **Waiting on #180**, not blocked |
| 6 | One architect + six builders concurrently, measured | **Held by the architect** |
| 7 | The cutover runbook exercised — `/arch-save` actually run | **Blocked** |

**Items 3 and 4** were filed as blocked on #180 because no Node on this machine satisfies
t3code's `^24.13.1` (Homebrew's `node@24`/`node@25`/`node@26` all resolve to v26.4.0; nvm tops
out at v22.22.2). `builder-air-180` has since measured that `t3 serve` **does** start and answer
under v26.4.0 against the pinned checkout `082e6ea` — verify matched the pin, `ready` returned
authenticated JSON, `status` reported checkout == pin. That is serve evidence, not
`--version` evidence. So these are a short wait for air-180's explicit-interpreter fix, not a
permanent block. They were deliberately **not** run here by hand-setting `PATH`: the point of
that fix is that these criteria run reproducibly rather than from a `PATH` someone remembered
to export.

**Item 6** is held by the architect: fleet RSS is 2.4 GB with one builder running, and this
workspace hosts the architect driving the program.

**Item 7** is blocked on the same thing it was blocked on when filed — the only architect here
is the one running the program, so `/arch-save` cannot be exercised against it.

## Tests

| File | Tests |
|---|---|
| `spec-146-phase-9-thread-backend.test.ts` | 11 — new; items 1 and 2, including the manifest guards |
| `spec-146-phase-9-interrupt-side-effect.test.ts` | 2 — new; item 5, with its control |
| `spec-146-phase-9-afx-parity.test.ts` | unchanged |
| `spec-146-phase-9-live-harness.test.ts` | poll replaces the fixed wait |

The manifest assertions are deliberate. Moving the engine into `src/` is undone by one
`private: true` and nothing else in the suite would notice, so the test asserts the manifests
directly rather than only the file's location.

## A note on running the suite here

The suite fails with 40 unrelated errors when `CODEV_WORKTREE_ROOT` is set in the shell —
`detectCurrentBuilderId` prefers it over `process.cwd()` and defeats the `process.chdir()`
fixtures in three test files. Filed as **#189**; the architect is spawning a bugfix builder.
Until it lands, run checks as
`env -u CODEV_WORKTREE_ROOT -u CODEV_BUILDER_ID -u CODEV_ARCHITECT_NAME <cmd>`.
