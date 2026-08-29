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

#### The caller was reached and carried nothing — found in review, fixed here

A production caller that reaches the thread path is not the same as a thread-backed spawn.
All five `launchSpawnedBuilder` call sites passed the generated builder prompt **only into
the `startPty` closure**, never as `prompt:` on the options object. On the thread path the
engine therefore got `prompt: undefined`, `createPorchThreadEngine.create` never called
`beginTurn`, and the result was a thread that exists and has been told nothing — a spawn that
reports success and did not spawn anything. `roleContent` was dropped the same way, even
though `DriverThread.create` already accepts `roleContent`/`roleFilePath` and joins the role
onto the first turn.

Nothing in the suite could see it. `spec-146-phase-9-afx-parity.test.ts` asserts an in-memory
`launched` boolean, which is computed from the input rather than from a dispatched turn.

Fixed:

- `SpawnThreadFactory` gains `roleContent` / `roleFilePath`; `launchSpawnedBuilder` accepts
  and forwards both plus `prompt`.
- All five call sites pass their prompt and role. The worktree spawn has no prompt by
  definition — its payload is the launch script — and already passed `launchScript`.
- `.builder-role.md` is now `BUILDER_ROLE_FILE`, exported from `spawn-worktree.ts`, so both
  paths write and name the same file rather than two spellings of it.
- `createPorchThreadEngine.create` forwards the role to `DriverThread.create`, and tracks the
  first turn like any other.

**Also in the engine:** `activeTurnId` was written as the invented `turn-${threadId}` and
cleared only by `interrupt`, so a turn that settled normally left the record claiming one was
still running. It is now the dispatched command's id, refined to the server's turn id when the
server names it, and cleared when the turn settles. It is set from `commandId` immediately
rather than after awaiting `running`, because a window where a turn IS running and the record
reads `null` spells "not named yet" the same way as "idle".

**Not fixed, and stated rather than papered over:** `ThreadRecord.merged` is written `false`
at create and never updated, and `removeWorktree` always reports `removed` without consulting
merge state. `cleanup.ts` uses `isWorktreeMerged` instead, so nothing reads it today. The
`vcs.removeWorktree` refusal response has not been observed, and inventing a refusal branch
against a shape I have not seen would be a guess.

#### What item 2 does NOT do, named rather than left to be discovered

`ensureThreadBackendReady` is called from `launchSpawnedBuilder` and nowhere else. `afx
interrupt`, `afx cleanup` and `afx workspace add-architect` each reach `getThreadEngine()` in
a **fresh process**, where no engine is registered. Raised by the codex reviewer, and it is
correct.

Calling `ensureThreadBackendReady` from those three commands would not fix them, which is why
it was not done as a quick win. The engine holds its threads in process-local `Map`s and
cannot re-attach to a thread it did not create, so a freshly-connected engine would answer
`interrupt(threadId)` with "unknown thread" instead of "no engine" — the same failure wearing
a different message. Rehydrating a `DriverThread` from a thread id is real work and belongs
with items 3 and 4, which are about surviving a restart.

What was fixed is the part that was actively misleading: both errors now say which of the
three things is true — no server configured, a command that reached a thread-backed row
without connecting, or a thread this process did not create and cannot re-attach to. A caller
could not tell those apart from `Thread engine is not registered` and `Unknown thread <id>`,
and the middle one is the only one that is a bug in this repo.

#### The bootstrap token had no gitignore rule for adopters

The codex reviewer called `.codev/config.json` "tracked" and recommended moving the token to
the phase 7 credential store. Both halves are wrong, but the concern underneath is real.

`.codev/config.json` **is** ignored in this repo (`.gitignore` line 11), so nothing here
commits a token. And `MachineCredentialStore` is the wrong home: it stores credentials this
host **issues to inbound clients** — "which client machine is talking to this host". The t3code
bootstrap token is the opposite direction, one this workspace **presents to a server**. Its
own module says so.

What is real: `CODEV_GITIGNORE_ENTRIES` — what `codev init` and `codev adopt` write into an
adopter's `.gitignore` — never listed `.codev/config.json`. This repo ignored it by hand. So
an adopter that configured `threads.bootstrapToken` would commit the credential, and phase 9
is what made that file a place secrets live.

Added to `CODEV_GITIGNORE_ENTRIES`, which means `codev update` backfills it into existing
projects as well as new ones. Only the file, not `.codev/` — protocol and template overrides
live under that directory and are meant to be committed, and a test asserts both halves.
Adding the rule does not untrack a file a project already tracks.

### Item 5 — reassigned to builder-air-180, one half kept

Item 5 is **no longer this builder's**. `builder-air-180` ran the live interrupt criterion
for real against the pinned checkout and pinned `t3@0.0.36` under Node 26.4.0: the turn wrote
`STARTED`, was interrupted, and `SHOULD_NOT_FINISH` was absent. Getting there exposed and
fixed two things — no global `WebSocket` on Node 20, and a 4 s wait too short to establish
that a turn had started, now a bounded 30 s poll.

**Reverted here:** `c7cd64dae` had made the same fixed-wait-to-poll change to
`spec-146-phase-9-live-harness.test.ts`. Restored byte-identical to `c7cd64dae^`
(`git diff c7cd64dae^ -- <file>` is empty) so air-180's version, which has the live evidence
behind its number, lands without a conflict. Architect ruling.

**Kept here:** `spec-146-phase-9-interrupt-side-effect.test.ts` — a process-backed
`ThreadEngine` whose turns are real child processes. It asserts both clauses of the criterion
(`activeTurnId: null` **and** the interrupted command's side effect absent), waits on the
child's `exit` event rather than a timer, and carries a control test showing the same turn
*does* write the marker without the interrupt. `createMemoryThreadEngine.startTurn` records a
turn id and runs nothing, so it has no side effect for an interrupt to prevent, which is why
only the first clause had ever been asserted.

**The two tests are complementary, not duplicative, and neither should be deleted as a copy
of the other.** This one is deterministic and runs in CI on every push with no server.
air-180's is live and needs one running. This one proves the seam — `interruptThread` →
`ThreadEngine.interrupt` — stops running work rather than only clearing a field. It does not
prove t3code's `thread.turn.interrupt` kills a provider's command; that is the live test's
claim, and only the live test can make it.

## Not met — recorded, not ticked

Per the architect's ruling these are not implemented here, and none is ticked.

| #179 item | Criterion | Status |
|---|---|---|
| 3 | An architect is a thread whose worktree is the workspace root | **Runnable once air-180's PR merges** |
| 4 | An architect thread survives a server restart and resumes with context | **Runnable once air-180's PR merges** |
| 5 | The interrupt criterion, both clauses, proven live | **Reassigned to air-180**, met there |
| 6 | One architect + six builders concurrently, measured | **Held by the architect** |
| 7 | The cutover runbook exercised — `/arch-save` actually run | **Blocked** |

**Items 3 and 4** were filed as blocked on #180 because no Node on this machine satisfies
t3code's `^24.13.1` (Homebrew's `node@24`/`node@25`/`node@26` all resolve to v26.4.0; nvm tops
out at v22.22.2). That is no longer a block: `builder-air-180` has run `t3 serve` under
v26.4.0 against the pinned checkout `082e6ea` and had it answer — verify matched the pin,
`ready` returned authenticated JSON, `status` reported checkout == pin — and has since run a
live turn and interrupt against it. They become **runnable** the moment air-180's
explicit-interpreter fix merges, and they stay untickable until then.

They were deliberately **not** run here by hand-setting `PATH`. The point of air-180's fix is
that these criteria run reproducibly rather than from a `PATH` someone remembered to export,
and a pass obtained the other way would not be evidence for the criterion as written.

**Item 6** is held by the architect: fleet RSS is 2.4 GB with one builder running, and this
workspace hosts the architect driving the program.

**Item 7** is blocked on the same thing it was blocked on when filed — the only architect here
is the one running the program, so `/arch-save` cannot be exercised against it.

## Tests

| File | Tests |
|---|---|
| `spec-146-phase-9-thread-backend.test.ts` | 17 — new; items 1 and 2, the packaging guards, and the spawn payload |
| `spec-146-phase-9-porch-engine.test.ts` | 7 — 4 added; the first turn, the role on it, the idle control, and `activeTurnId` |
| `spec-146-phase-9-interrupt-side-effect.test.ts` | 2 — new; the deterministic half of the interrupt criterion, with its control |
| `spec-146-phase-9-afx-parity.test.ts` | unchanged |
| `spec-146-phase-9-live-harness.test.ts` | **reverted to `c7cd64dae^`** — air-180's file |

The assertions that look like bookkeeping are the load-bearing ones. Moving the engine into
`src/` is undone by one `private: true` and nothing else in the suite would notice, so the
tests read the manifests. The dependency-set assertions do not name porch-driver or t3-client
at all — they read every runtime `@cluesmith/*` dependency out of `packages/codev/package.json`
and check each of the five places that enumerate that set by hand, because hardcoding the two
names is exactly what made the first attempt at this fix miss three of them.

Every assertion added in this phase was mutation-checked: the change it guards was reverted,
the test was watched to fail, and the change was restored.

## A note on running the suite here

The suite fails with 40 unrelated errors when `CODEV_WORKTREE_ROOT` is set in the shell —
`detectCurrentBuilderId` prefers it over `process.cwd()` and defeats the `process.chdir()`
fixtures in three test files. Filed as **#189**; the architect is spawning a bugfix builder.
Until it lands, run checks as
`env -u CODEV_WORKTREE_ROOT -u CODEV_BUILDER_ID -u CODEV_ARCHITECT_NAME <cmd>`.

## This makes two new packages public on npm — a release-time decision, not a detail

`@cluesmith/porch-driver` and `@cluesmith/t3-client` were private. This phase makes
`@cluesmith/codev` depend on both at runtime, which means the next release **publishes them
to npm as new public packages**. That is an outward-facing commitment: two new names on the
public registry, under the project's scope, that adopters can install and that cannot be
quietly unpublished later. It is the human's call at release time.

The alternative was vendoring porch-driver's surface into `packages/codev/src`, which was
rejected because it is live logic with its own tests and a second copy is how the tested
engine and the shipped one drift. That trade is recorded under item 1; the publishing
consequence is recorded here so it is not discovered at release.

## Follow-up found after the build passed — the publish path was still broken

Item 1 dropped `private: true` from `porch-driver` and `t3-client` so `@cluesmith/codev`
could depend on them. That makes them **publishable**; it does not make them **published**.

Both sat at version `0.0.0` while every version-aligned sibling is at `3.3.1`, and neither is
on the registry (`npm view @cluesmith/porch-driver version` → E404; `@cluesmith/codev-types`
→ `3.3.1`). pnpm rewrites `workspace:*` to the dependency's own version at publish time, so the
next release of `@cluesmith/codev` would have shipped declaring `"@cluesmith/porch-driver":
"0.0.0"` and `npm install -g @cluesmith/codev` would have failed with **E404** — the exact
failure the release protocol already warns about for core/sdk/types.

Fixed in six places:

- `packages/porch-driver/package.json`, `packages/t3-client/package.json` — `0.0.0` → `3.3.1`.
- `scripts/bump-all.sh` — both added to the lockstep loop, so they move with the next release.
- `codev/protocols/release/protocol.md` — both added to the lockstep list, to all three
  `pnpm publish --filter` lines, to the E404 warning, and to the backport bump note.
  `t3-client` is listed before `porch-driver` because porch-driver depends on it.
- `scripts/local-install.sh` — both added to its pack, uninstall, `rm -rf` and install lists.
  `pnpm pack` rewrites `workspace:*` exactly as `pnpm publish` does, so this path broke first
  and breaks far more often: `pnpm -w run local-install` is the step that makes a merged change
  visible to Tower, and it would have E404d before the Tower restart. Found by the claude
  reviewer, against the tree with the publish fix already in it.
- `codev/protocols/release/protocol.md` — both manifests added to the two `git add` lines of
  the release commit. `bump-all.sh` writes seven manifests and those lines staged five, so the
  release commit and tag would have disagreed with what npm received. Also found by claude.
- `spec-146-phase-9-thread-backend.test.ts` — 11 tests → 14. The assertions do not name
  porch-driver and t3-client: they read every runtime `@cluesmith/*` dependency out of
  `packages/codev/package.json`, resolve each to its `packages/<dir>`, and assert version
  alignment plus coverage in `bump-all.sh`, every `pnpm publish --filter` line, both `git add`
  lines and all four `local-install.sh` lists. Hardcoding the two names is what made the first
  fix miss three of those five sites, so the next dependency addition fails loudly instead.

**Mutation-checked, not just written:** reverting porch-driver to `0.0.0` and removing it from
`bump-all.sh` and the publish filters fails the new tests; so does dropping the t3-client pack
line from `local-install.sh` or the porch-driver manifest from a `git add` line (2 failed | 12
passed each time). Restoring passes 14. The existing manifest test already knew `workspace:*` resolves to a version at
publish time and stopped one step short of asserting that version is one that will exist.
