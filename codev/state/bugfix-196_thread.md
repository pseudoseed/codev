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
