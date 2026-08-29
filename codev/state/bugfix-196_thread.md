# bugfix-196 — `afx send --interrupt` sends Ctrl+C to every harness

## INVESTIGATE (2026-08-29)

### Reproduction

Symptom evidence is in the issue: Ctrl+C delivered to `builder-bugfix-189` (opencode) at
16:59:52, shellper gone by 17:00:22. Code-level reproduction is deterministic — both write
sites take no harness input at all:

- `servers/tower-routes.ts:1785` — delayed `--interrupt`: `live.write('\x03')`
- `servers/tower-routes.ts:2111` — immediate `--interrupt`: `session.write('\x03')`

Neither reads the session's `command`, `cwd`, or launch script. Every `--interrupt` to every
agent gets the same byte.

Corroboration that ESC is opencode's own interrupt: `servers/gate-profiles.ts`
`OPENCODE_PROFILE.busyIndicatorPattern = /esc\s+interrupt/` — that string is read off real
captured opencode 1.18.18 frames. opencode advertises ESC, not Ctrl+C.

### Root cause

There is no per-harness record of what byte safely interrupts a turn. `utils/harness.ts`
carries every other per-harness fact (`supportsContextReset`, model args, prompt arg,
session/resume behaviour) but nothing about interrupt semantics, so callers hardcode `\x03`.

### Third site, same class

`servers/mailbox-hold-policy.ts:22` `heldRecoveryKeystroke()` returns `\x03` for the
`cancel-draft` recovery, written by `mailbox-wiring.ts:436` `recoverHeld()` — also with no
harness check. This one fires **automatically** after the #92 starvation window, with no
operator in the loop. Same fatal byte, worse trigger. In scope: the issue says a second
hardcoded `\x03` anywhere else reintroduces the bug.

### Fix shape

1. `interruptSignal: 'esc' | 'ctrl-c'` as a **required** field on `HarnessProvider`
   (claude/codex → `ctrl-c`, opencode → `esc`). Required, so a new builtin cannot omit it.
2. Custom harnesses: optional config field, default `esc` (fail-safe — an unknown app must
   never default into the fatal byte).
3. One resolver in `harness.ts`; session→harness resolution in `mailbox-wiring.ts` mirroring
   `resolveProfileForSession` (command basename, then `.builder-start.sh`), unresolved → `esc`.
4. Both tower-routes sites and `recoverHeld` derive the byte. Downgrade, not refuse: ESC ends
   the turn on all three harnesses, so the operator's intent still lands.
5. CLI help text for `--interrupt` stops claiming "Ctrl+C".

Well under 300 LOC. Fits BUGFIX.

### Constraints from the architect

- Do not touch `commands/spawn.ts` / `commands/spawn-worktree.ts` (spir-146 has uncommitted
  changes there). Nothing in the fix shape needs them.
- `lsof -i :13999` before any full suite; spir-146 has priority on the lock. Never pgrep/pkill
  on a pattern that could match an agent's prompt text.

## FIX (2026-08-29)

Written, not yet executed — the architect froze all vitest runs and process spawns at 17:43
and extended it to spawns at 17:45 while spir-146 re-runs. Code and tests are committed
unverified; build/test checks run when cleared.

### What changed

`utils/harness.ts` — the table.
- `InterruptSignal = 'esc' | 'ctrl-c'` and `INTERRUPT_BYTES`, the only place `\x03`/`\x1b`
  are spelled.
- `interruptSignal` is a **required** field on `HarnessProvider`. A new builtin that omits it
  is a compile error, not a silent `ctrl-c` default.
- claude/codex `ctrl-c`; opencode `esc`.
- Custom harnesses: optional config field, validated, defaulting to `esc`.
- `interruptSignalForHarness` / `interruptByteForHarness`. Deliberately narrower than
  `resolveHarness`: unknown, retired or custom-undeclared all yield `esc`, never claude's
  `ctrl-c` fallback.

`servers/mailbox-wiring.ts` — session→signal.
- `resolveHarnessForSession` mirrors `resolveProfileForSession` (command basename, then
  `.builder-start.sh`), so the interrupt table and the gate table cannot disagree about what
  app a terminal is. Defensive on empty `command`/`cwd` — a reconnected row can carry
  `command: ''`.
- `writeHeldRecovery(session, action)` is now the single place the #92 auto-recovery puts a
  control byte on a PTY.

Three write sites now derive: `tower-routes.ts` immediate `--interrupt`, `tower-routes.ts`
delayed `--interrupt`, and `recoverHeld`. Downgrade, not refuse — ESC ends the turn on all
three harnesses, so the operator's intent still lands. The response and both log lines now
name the signal actually sent.

Operator-facing text corrected in both trees (the issue's "the operator learns by losing a
session"): CLI help, `types.ts`, `codev/resources/*`, `codev-skeleton/resources/*`, and the
afx/arch-save skills under `.claude/` and `.codex/` in both trees.

### The auto-recovery path (architect scope addition, 17:47)

Found independently during INVESTIGATE, already fixed when the instruction arrived.
`heldRecoveryAction('user-text') → 'cancel-draft' → '\x03'` fires **automatically** after the
starvation window with nobody in the loop. air-197 has established opencode's holds are a real
rows-geometry clipping problem, so `user-text` holds on opencode are reachable, not theoretical.
Tower could kill an opencode builder by itself.

On an `esc` harness the recovery now sends ESC. That may not clear the draft, so the row stays
held for a human — the correct trade against quitting the agent and losing its conversation.
The starvation notice says so rather than promising Ctrl+C.

### File boundaries honoured

- `commands/spawn.ts` / `spawn-worktree.ts`: untouched (spir-146).
- `gate-profiles.ts` / `render-gate.ts`: untouched (air-197). Test 3 iterates
  `BUILTIN_HARNESSES` and filters through the already-exported `hasGateProfile()`, so it reads
  the gate registry without editing that file. An earlier `export PROFILES_BY_HARNESS` edit was
  reverted for this reason.

### Tests

`__tests__/bugfix-196-interrupt-signal.test.ts` — the table, both resolvers, custom-harness
config, the recovery policy, and the automatic path asserted on **bytes written**.

`__tests__/tower-routes.test.ts` — the live `/api/send` interrupt path, also on bytes written:
Ctrl+C for claude and codex; never Ctrl+C for opencode or an unidentifiable command; the
delayed path obeys the same table; the response reports the signal sent. `gateSession` gained
an optional `command` argument (default `'claude'`, so every existing caller is unchanged).

Test 3 is the coverage guard: every entry in `BUILTIN_HARNESSES`, and every gate-classifiable
harness, must carry a signal. Deliberately resolved through `getBuiltinHarness` rather than
`interruptSignalForHarness` — the latter fails safe to `esc`, which would make a missing entry
look present.

## FIX round 2 (2026-08-29) — the question the architect would not ship past

The architect asked, before accepting the fix: on opencode, what actually clears a draft?
ESC ends a turn; it does not clear typed text. If nothing clears it, `cancel-draft` is
unrecoverable on opencode and must say so rather than retrying a keystroke that cannot work.

### Answered from the shipped binary

`/opt/homebrew/Cellar/opencode/1.18.18/bin/opencode` — the exact version the gate profiles
were measured against — carries its default keybind table in the bundle. Read out of it:

```
leader:                     "ctrl+x"
app_exit:                   "ctrl+c,ctrl+d,<leader>q"
input_clear:                "ctrl+c"
input_delete_to_line_start: "ctrl+u"
session_interrupt:          "escape"
```

**Ctrl+C is bound to both `app_exit` and `input_clear`.** That overlap is the root cause, and
it is in opencode's own defaults, not in ours — which is why the byte looks like a draft-clear
right up until the composer is empty and it quits instead. Grepping every default binding
containing `ctrl+u` returns exactly one: `input_delete_to_line_start`. It can quit nothing.

### What changed

`clearDraftKey` is a second **required** per-harness fact beside `interruptSignal`.
claude/codex `ctrl-c`; opencode `ctrl-u` (`\x15`); unknown/retired/custom-undeclared `none`.

Clearing a draft and ending a turn are different intents and no longer share a table entry.
Round 1 conflated them; that was wrong, and it only looked right because one byte happens to
do both on two of the three harnesses.

`heldRecoveryKeystroke` returns `string | null`. `'none'` yields null, **nothing is written**,
and `recoverHeld` logs `UNRECOVERABLE HOLD` with its own notification naming the agent, then
latches so it cannot spin. A rejected PTY write is `failed` and stays retryable — transient and
unrecoverable are now different facts too.

### The answer was in between the two branches offered

Neither "a byte clears it" nor "nothing does". `ctrl+u` deletes to line **start**, so it clears
the common single-line leftover draft and cannot clear a multi-row one.

### Residual 1 — recorded, not fixed

A `ctrl+u` on an already-empty line emits no output, so the drainer's change token does not
move and the attempt latches inert. The architect's instruction: do not fix it, but do not let
it collapse into one boolean either, because residual 2's fix has to branch on it.

`recoveryState.attempted: boolean` became `phase: RecoveryPhase`:

| phase | meaning |
|---|---|
| `not-attempted` | window has not elapsed; will fire |
| `written` | keystroke went out and the screen then changed |
| `written-inert` | keystroke went out and the screen did **not** change at all |
| `unrecoverable` | no safe byte exists; the screen was never touched |

`written-inert` is derived by sampling the output token at the moment the keystroke goes out
and comparing on the next pass, so it means exactly one thing. `DeliveryPorts.recoverHeld` now
returns `HeldRecoveryOutcome` (`'written' | 'unrecoverable' | 'failed'`) instead of a boolean
that was covering two different facts; a legacy boolean still reads as written/failed, so no
other implementer changed. Behaviour is unchanged — this is bookkeeping.

`MailboxDrainer.recoveryPhaseFor(workspacePath, toAgent)` exposes it read-only. Without an
accessor the phase is private and unassertable, and would have rotted into a comment.

### Residual 2 — filed by the architect as its own issue

`mailbox-delivery`'s liveness telemetry deliberately excludes `user-text` ("a human
legitimately at the line — must not false-alarm"). So a `user-text` hold that recovery fails to
clear starves with **no alarm on any harness**, not just opencode. The `UNRECOVERABLE HOLD`
notice covers only the no-byte case; attempted-and-did-not-work is still silent. Closing it
needs a second-stage escalation in the drainer's streak state machine and revisits #92's
`user-text` exclusion — beyond a bugfix ceiling.

### Verification

Regression proven both directions: reintroducing the hardcoded `\x03` at all three write sites
fails exactly 6 tests; restoring the fix goes green. Typecheck clean on every touched file
(the pre-existing `TowerClient` errors are an unbuilt-dependency artifact, in files untouched
here). 35/35 on the new file, 148/148 across the three targeted files.

## FIX round 3 — what `--interrupt` is actually for

The architect challenged the round-2 result: after it, on opencode `afx interrupt` sent ESC,
`afx send --interrupt` sent ESC, and only the *machine's* auto-recovery could clear a draft
(Ctrl+U). The operator had no way to clear an opencode composer while Tower did. Backwards.

### Established from source, because the sources disagree by era

| source | what `--interrupt` meant |
|---|---|
| Spec 0020 (origin) | "Send Ctrl+C first to ensure prompt is ready" — the mitigation for the "Vim trap", i.e. a **running process** to escape |
| Spec 1273 | gave "end the turn" its own command (`afx interrupt`, ESC) and recorded `--interrupt` as "a different signal… not what was verified to unwedge a builder mid-turn" |
| Issue #21 | adopted it as the remedy for an **abandoned composer**, because Ctrl+C clears typed text where ESC does not |

So the contract is *make the prompt ready for this message*, and that genuinely decomposes into
**both** halves. They were never separated because one byte did both on the only harnesses that
existed. Routing to `clearDraftKey` alone would also have been wrong: on a mid-turn opencode,
Ctrl+U clears nothing and the message lands inside a live turn.

`promptReadySequence()` derives both from the same table and deduplicates:

| harness | bytes |
|---|---|
| claude, codex | `Ctrl+C` — one write, byte-identical to pre-fix |
| opencode | `ESC` then `Ctrl+U` |
| unidentifiable | `ESC` alone; no guessed clear byte |

### A regression I introduced, found by self-review

Round 1's `heldRemedy()` rewrite deleted the clause #21 asserts on verbatim —
`'afx interrupt' sends ESC, which does not` — the line #21's header says cost five manual
interventions. Found by reading my own diff, before the suite reported it. Fixed rather than
relaxed: the clause is *more* true now, since ESC clears typed text on no harness at all.

### Dead exports removed

`interruptByteForHarness` and `interruptSignalForSession` became test-only once
`promptReadySequence` took over their call sites. Removed rather than kept — a registered,
documented, inert export is the failure mode this codebase already warns about in
`assertHarnessAcceptsModel`. Tests repointed at the live API, so the coverage survives.

## The suite failures — full attribution

Three separate causes, none of them the fix:

| files / tests | cause | resolution |
|---|---|---|
| 3 / 40 | #189 `CODEV_*` env leak (worktree spawned from stale main) | merged `origin/main` |
| 19 / 39 | unbuilt tree | `pnpm build` |
| 1 / 1 | my `heldRemedy` regression | fixed |

**23 files / 120 tests, no residue.** Post-build: `6553 passed | 48 skipped`, **zero test failures**.

### Four build artifacts, five error messages

The unbuilt-tree group needed `packages/codev/skeleton/`, `packages/codev/dist/`, and
`packages/porch-driver/dist/` — a sibling package `pnpm build` in `packages/codev` does not
produce. One root cause reported five ways:

| message | verdict |
|---|---|
| `Cannot find module '…/packages/codev/dist/terminal/shellper-main.js'` | honest |
| `Cannot find module '…/porch-driver/dist/thread.js'` | honest |
| `Roles directory not found in .codev/roles/, codev/roles/, or embedded skeleton` | misleading |
| `Skeleton directory not found. Package may be corrupted.` | wrong |
| `Unknown review type "pr" in porch.consultation.modelsByType` | wrong subsystem |

The last one cost the most: it names a config file that is **correct**, and a reader follows it
there and stays. `listReviewTypes()` unions protocol names across all four resolver tiers but
resolves each `protocol.json` by precedence, so an empty tier 4 silently shrinks the known
review-type set to whatever the test fixture declares. Filed to #204.

`dist/terminal/shellper-main.js` mtime was **12:13:35** — the build I ran *after* the failing
suite, so it was never present. spir-146 disproved "a concurrent build deleted it" for its own
run with the same kind of evidence pointing the other way. Same missing file, opposite
mechanism, indistinguishable symptom (`Invalid shellper info JSON` after a silent poll timeout).
Filed to #200.

Root cause of all of it on my side: **I ran the suite before building.** Porch's own check order
is `regression_test, build, tests`; running by hand out of order is what hid it.
