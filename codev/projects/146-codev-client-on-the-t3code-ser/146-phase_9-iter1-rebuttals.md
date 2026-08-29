# Phase 9, iteration 1 — rebuttals

Both reviewers returned **REQUEST_CHANGES** at HIGH confidence. Nine distinct points between
them. **Seven were right and are fixed.** Two are wrong on the facts and are answered below
with the evidence, though one of them has a real concern underneath that is also fixed.

A scope change landed from the architect mid-iteration and is recorded first, because it
moves one reviewer point out of this builder's hands entirely.

## Scope change — item 5 is no longer this builder's

`builder-air-180` ran the live interrupt criterion for real: pinned checkout, pinned
`t3@0.0.36`, Node 26.4.0. The turn wrote `STARTED`, was interrupted, `SHOULD_NOT_FINISH` was
absent. Getting there exposed and fixed two things — no global `WebSocket` on Node 20, and a
4 s wait too short to establish that a turn had started, now a bounded 30 s poll.

Architect ruling: item 5 is air-180's, and this branch's phase-9 scope is **items 1 and 2
only**. `c7cd64dae` had made the same fixed-wait-to-poll change to
`spec-146-phase-9-live-harness.test.ts`; it is reverted byte-identical to `c7cd64dae^`
(`a84a15a4e`, and `git diff c7cd64dae^ -- <file>` is empty) so air-180's version, which has the
live evidence behind its number, lands without a conflict.

`spec-146-phase-9-interrupt-side-effect.test.ts` **stays**, by the same ruling. It is
deterministic and process-backed and runs in CI on every push with no server; air-180's is live
and needs one running. Complementary, not duplicative. Neither should be deleted as a copy of
the other.

---

## Accepted — codex

### 1. `launchSpawnedBuilder` does not carry the prompt or role onto the thread path

**Right, and this is the substance of the phase.** Verified before fixing: all five call sites
pass `builderPrompt` / `prompt` **only into the `startPty` closure**, never as `prompt:` on the
options object. `launchSpawnedBuilder` forwards `opts.prompt` correctly — nothing sets it. So
on the thread path `createPorchThreadEngine.create` received `prompt: undefined`, its
`if (input.prompt) await thread.beginTurn(...)` never fired, and the spawn produced a thread
that exists and has been told nothing.

The review also names why nothing caught it: `spec-146-phase-9-afx-parity.test.ts` asserts an
in-memory `launched` boolean, which is computed from the input rather than from a dispatched
turn.

`roleContent` was dropped the same way. `DriverThread.create` already accepts
`roleContent`/`roleFilePath` and `#startTurnWithRole` joins the role onto the first turn, so
the mechanism existed and the engine simply did not pass it.

Fixed in `6cb73b733`: `SpawnThreadFactory` gains `roleContent`/`roleFilePath`;
`launchSpawnedBuilder` forwards them with `prompt`; all five call sites pass their prompt and
role; the engine forwards the role to `DriverThread.create`. `.builder-role.md` is now
`BUILDER_ROLE_FILE` exported from `spawn-worktree.ts` so both paths name one file.

Four new tests in `spec-146-phase-9-porch-engine.test.ts` assert the dispatched
`thread.turn.start` payload — the prompt text, the role joined onto it, and a control proving
a prompt-less `create` starts no turn — plus two in `spec-146-phase-9-thread-backend.test.ts`:
one drives `launchSpawnedBuilder` and inspects what the factory received, the other reads
`spawn.ts` and requires every call site to carry `prompt` or `launchScript`. Mutation-checked:
removing one `prompt: builderPrompt,` fails the second.

### 2. The engine is process-local and only `afx spawn` initializes it

**Right, and deliberately not "fixed" the cheap way.** `afx interrupt`, `afx cleanup` and
`afx workspace add-architect` each reach `getThreadEngine()` in a fresh process where no engine
is registered.

Adding `ensureThreadBackendReady` to those three would swap one error for another, not fix
them: the engine holds threads in process-local `Map`s and cannot re-attach to one it did not
create, so a freshly-connected engine answers `interrupt(threadId)` with "unknown thread"
instead of "no engine". Rehydrating a `DriverThread` from a thread id is real work and belongs
with items 3 and 4, which are about surviving a restart.

What is fixed is the part that was actively misleading. `Thread engine is not registered` and
`Unknown thread <id>` were each one sentence for causes that need different answers — no server
configured, a command that reached a thread-backed row without connecting, or a thread this
process did not create. Both messages now say which. The limitation itself is recorded in
`146-phase_9-verification.md` under "What item 2 does NOT do", not left to be discovered.

### 3. Release tooling does not carry the new published dependency chain

**Right, and worse than stated.** `@cluesmith/porch-driver` and `@cluesmith/t3-client` were
non-private at `0.0.0` while every version-aligned sibling is at `3.3.1`, and neither is on the
registry — `npm view @cluesmith/porch-driver version` returns E404 while
`@cluesmith/codev-types` returns `3.3.1`. `@cluesmith/codev` **is** live on npm at 3.3.1, so
the next publish would have shipped a manifest naming a package that does not exist and every
`npm install -g @cluesmith/codev` would have failed, for every user.

Fixed across two commits, `1777b3cb0` and `a0b6e52c5`. The second exists because the first was
incomplete — see the claude section below.

### 4. Targeted tests could not be rerun in the review environment

Not a finding; noted. The suite runs here. It needs
`env -u CODEV_WORKTREE_ROOT -u CODEV_BUILDER_ID -u CODEV_ARCHITECT_NAME`, filed as **#189**.

---

## Accepted — claude

### 5. `local-install.sh` was not updated for the new dependency set

**Right, and it breaks a path that runs far more often than a release.** `pnpm pack` rewrites
`workspace:*` to the dependency's own version exactly as `pnpm publish` does, so npm resolved
the two missing packages from the registry, where neither exists. `pnpm -w run local-install`
is the step that makes a merged change visible to Tower, and it would have failed before the
Tower restart.

Both added to all four lists — pack, uninstall, `rm -rf`, install — in `a0b6e52c5`.

This was found against a tree that already had the publish fix in it. The first fix taught
`pnpm publish` and stopped.

### 6. Two release-commit `git add` lines stage 5 manifests while `bump-all.sh` writes 7

**Right.** Both manifests added to both lines. The backport-path lines are single-package and
correctly unchanged, as the review says.

### 7. The new tests assert only what the first fix touched

**Right, and this is the durable half.** The assertions no longer name porch-driver or
t3-client. They read every runtime `@cluesmith/*` dependency out of `packages/codev/package.json`,
resolve each to its `packages/<dir>` from the manifests, and assert version alignment plus
coverage in `bump-all.sh`, every `pnpm publish --filter` line, both `git add` lines, and all
four `local-install.sh` lists. Hardcoding two names is exactly what made the first fix miss
three of the five sites.

Mutation-checked: dropping the t3-client pack line from `local-install.sh`, or the porch-driver
manifest from a `git add` line, fails them.

### 8. `activeTurnId` stays non-null after a turn settles; `merged` is never updated

**Right on `activeTurnId`, fixed.** It was written as the invented `turn-${threadId}` and
cleared only by `interrupt`, so a turn that settled normally left the record claiming one was
still running. It is now the dispatched command's id, refined to the server's turn id when the
server names it, and cleared when `started.settled` resolves. It is set from `commandId`
immediately rather than after awaiting `running`, because a window where a turn IS running and
the record reads `null` spells "not named yet" the same way as "idle". A test asserts it is
non-null after `startTurn` and is not the old invented value.

**`merged` is not fixed, and that is stated rather than papered over.** It is written `false`
at create and never updated, and `removeWorktree` always reports `removed` without consulting
merge state. Nothing reads it today — `cleanup.ts` uses `isWorktreeMerged`. The
`vcs.removeWorktree` refusal response has not been observed here, and writing a refusal branch
against a shape I have not seen would be a guess presented as a fix. Recorded in the
verification doc instead.

---

## Disputed

### 9. codex: "`thread-backend.ts` permits a bootstrap credential in tracked `.codev/config.json`"

**Both halves are wrong on the facts. The concern underneath is real and is fixed.**

`.codev/config.json` is **not tracked**. It is ignored by this repo's root `.gitignore` at line
11 — `git check-ignore -v .codev/config.json` confirms it. Nothing in this repo commits a token.

The recommended destination is the wrong direction. `MachineCredentialStore`
(`agent-farm/lib/machine-credentials.ts`, spec 146 phase 7) stores credentials this host
**issues to inbound clients** — its own header states the boundary as "WHICH client machine is
talking to this host". The t3code bootstrap token is the opposite: one this workspace
**presents to a server**. Moving it there would not be reuse, it would be two unrelated things
in one store.

What is real: `CODEV_GITIGNORE_ENTRIES` — what `codev init` and `codev adopt` write into an
adopter's `.gitignore` — never listed `.codev/config.json`. This repo ignored it by hand. So an
adopter that configured `threads.bootstrapToken` would commit the credential, and phase 9 is
what made that file a place secrets live. Added, so `codev update` backfills it into existing
projects as well as new ones; only the file, not `.codev/`, because protocol and template
overrides live under that directory and are meant to be committed. A test asserts both halves.

`CODEV_T3_TOKEN` remains the way to supply the token without a file at all, and takes
precedence over it.

### 10. claude: "No test constructs `createPorchThreadEngine`"

**Wrong at the time it was written.** `spec-146-phase-9-porch-engine.test.ts` already
constructed it through the `__tests__/helpers/porch-thread-engine.ts` re-export, which is the
same function — the helper was kept as a re-export precisely so existing tests keep their
import path rather than a second copy existing. That file had two tests, `thread.create` and
`thread.turn.interrupt`, against a recording dispatcher.

The gap it points at was still real: nothing tested the *payload*. That file now has four more
tests using the same recording dispatcher.

The invalid-JSON branch of `readThreadBackendConfig` was a fair miss and now has a test: an
unparseable config throws rather than returning `null`, because "I could not read it" must not
be spelled the same way as "this workspace has no server".

`connectDispatcher` remains uncovered. It opens a real WebSocket to a real server; covering it
means either standing up a fake server or mocking the module under test into a shape that
proves nothing about the real one. Left uncovered deliberately, and said so rather than
claiming coverage.

---

## Both reviewers: phase 9 is partial

Correct, and unchanged. Per the architect's ruling at `issues/179#issuecomment-5463507323`,
phase 9 splits: implement the reachable subset, record the rest, do not tick it. After the
scope change this branch's subset is items **1 and 2**. Item 5 is air-180's. Items 3 and 4
become **runnable** once air-180's explicit-interpreter fix merges — no longer blocked, since
air-180 has run `t3 serve` and a live turn under Node 26.4.0 against the pinned checkout. Item
6 is held by the architect. Item 7 is blocked on this workspace hosting the architect. None is
ticked.

## One consequence for the human, not buried

This phase turns `@cluesmith/porch-driver` and `@cluesmith/t3-client` into **new public npm
packages** at the next release. Two new names on the public registry under the project's scope,
installable by adopters, not quietly unpublishable later. That is an outward-facing commitment
and it is the human's call at release time. It is recorded in the verification doc under its
own heading for the same reason.
