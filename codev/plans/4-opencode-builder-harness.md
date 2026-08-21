# PIR Plan: Make opencode a working builder harness

> **Revision after plan-approval (2026-08-21).** Approved with one required change:
> **make idle a positive check, not the absence of busy.** As originally drafted, the
> profile held only when `busyIndicatorPattern` matched — so if a later opencode renamed
> that footer string, nothing would match, the composer would read as idle, and the gate
> would return clean *while the agent was mid-turn*, injecting into live typing. That is
> the opposite failure direction from `REGION_END_PATTERNS`, which HOLDS when it fails to
> match; drift there makes the gate over-cautious, drift here would make it permissive.
> The fix, added below in §2: an `idleIndicatorPattern` keyed on the measured idle footer
> readout, with CLEAN requiring the idle pattern PRESENT **and** the busy pattern ABSENT,
> so either string drifting produces a hold. The rest of the plan was approved as written.

## Understanding

Issue #4 asks for two independent defects to be fixed so `opencode` can host Grok as a
builder harness in this fork:

1. **Launch is broken.** `startBuilderSession` (`packages/codev/src/agent-farm/commands/spawn-worktree.ts:1101`)
   builds the initial-prompt argument as a bare positional (`"$(cat '.../.builder-prompt.txt')"`),
   the claude/codex convention. For opencode, the positional slot is `[project]` — "path to
   start opencode in" — not a message. A builder spawned with `shell.builder: "opencode"`
   launches, tries to `cd` into the prompt text as if it were a path, fails, and exits
   immediately (matching the reported "Agent exited at your request" symptom).

2. **No render-gate profile.** `packages/codev/src/agent-farm/servers/gate-profiles.ts`'s
   `PROFILES_BY_HARNESS` only has `claude`/`codex`, so `resolveProfile`/`resolveProfileForSession`
   always return `null` for an opencode builder and every `afx send` holds forever with
   `no-profile`.

Both were verified directly against the installed CLI (`opencode 1.18.18`, confirmed via
`opencode --help`) and against real captured PTY output from a live session in this sandbox,
which already has working xAI/Grok credentials (`opencode auth list` → `xAI oauth`). Nothing
below is guessed.

### Defect 1 — confirmed root cause and fix shape

Reproduced the exact bug directly:

```
$ opencode "hello world this is a test prompt" </dev/null
Error: Failed to change directory to <cwd>/hello world this is a test prompt
```

Two candidate fixes exist and were both tested live:

- **`opencode run "<msg>"`** — this is what the *current* README (`README.md:373-388`, from
  Spec 178) documents as the escape hatch, with the comment "plain `opencode` launches the
  TUI, which hangs in a PTY session." Tested live: `opencode run "say ok"` prints the
  response and **exits** (code 0) — it is a one-shot command, not a persistent session. A
  builder launched this way would look identical to defect 1's symptom (the launch loop
  treats the exit as clean and prompts "Press Enter to relaunch") — it just never runs a
  second turn. Not viable for a builder that must stay alive for `afx send`.
- **`opencode [project] --prompt "<msg>"`** — tested live for 30s: the interactive TUI opens
  seeded with the prompt, generates and displays a real response ("Hello." from Grok 4.6),
  and settles back to a genuinely idle composer while the process stays running. This is the
  one that behaves like a builder shell should.

So the fix is `--prompt`, not `opencode run`, contradicting the current documented escape
hatch (which predates `--prompt` existing, per the "hangs" comment — plausible for an older
opencode version). The docs need correcting alongside the code, or the fix reintroduces the
same class of bug through the front door.

There is currently no per-harness hook for *how the initial prompt is passed* — only for role
injection (`buildScriptRoleInjection`). `startBuilderSession` always appends the prompt as a
bare positional (`spawn-worktree.ts:1101-1102`, reused at `:1119` for the session-aware loop).
This needs a new, harness-specific seam.

### Defect 2 — confirmed root cause and measured composer shape

Captured real opencode 1.18.18 screens with a small ad-hoc PTY driver (`pty.fork()`, 110×32 to
match the existing claude/codex/agy fixture dimensions) across four states: idle, single-line
draft, multi-line draft, and mid-turn (submitted, agent still generating). Rendered them
through a terminal emulator and cross-checked raw SGR bytes directly (not just the rendered
view). Findings, all measured:

- **Marker glyph**: `┃` (U+2503 BOX DRAWINGS HEAVY VERTICAL) at column offset 2 (two leading
  spaces) — a different glyph from claude/codex's `❯`/`›`, and also different from the `│`
  (U+2502, thin) already in `render-gate.ts`'s `IGNORE_CHARS`.
- **The composer is a variable-height, multi-row box**, not a single line:
  `[blank pad row] [0..N content rows, growing as the user types more lines] [blank spacer
  row] [fixed status row: "┃  Build · <model> [· <reasoning>]"] [rule: "╹▀▀▀▀▀▀…"]`. Every
  row of the box — including the status row — starts with the same `┃` glyph. Example capture
  (idle, full 3-content-row minimum height):
  ```
   24|   ┃
   25|   ┃
   26|   ┃
   27|   ┃  Build · Grok 4.6 xAI · high
   28|   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  ```
  and with a 2-line draft, the box grows and the status row moves down with it:
  ```
   14|   ┃
   15|   ┃  implement the widget factory
   16|   ┃  second line here too
   17|   ┃
   18|   ┃  Build · Grok 4.6 xAI · high
   19|   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  ```
  `findMarkerRow`'s "take the LAST row matching the marker" (`render-gate.ts:161-167`) — the
  algorithm claude/codex/agy all rely on, where the glyph appears on exactly one line — would
  resolve to the **status row**, not an editable row. Bounding the scan from there down to the
  rule only ever covers the status row itself, which means real draft text one or more rows
  above it (rows 15-16 in the example) is **never scanned** — a false-clean, exactly the
  failure mode the issue warns against. This is not a hypothetical: it reproduces on the very
  first multi-line draft captured.
- **The status row's text is truecolor RGB, never dim, never palette-indexed.** Raw bytes
  around "Build":
  ```
  \x1b[38;2;92;156;245mBuild\x1b[0m ... \x1b[38;2;128;128;128m·\x1b[0m ... \x1b[38;2;238;238;238mGrok 4.6\x1b[0m
  ```
  All `\x1b[38;2;r;g;bm` (24-bit SGR), confirmed with no `\x1b[2m` (dim) anywhere nearby.
  Neither of the two existing placeholder-exemption mechanisms — the universal dim check
  (`cell.isDim()`) or agy's `placeholderFgPalette` (indexed-palette match) — can exempt this
  text. It has to be excluded by row-structure, not by cell attribute.
- **Mid-turn, the composer looks identical to idle.** Captured immediately after submitting a
  message, while the transcript above was still showing "Thought: …" / running a tool call,
  the composer box was already back to its blank idle shape (blank content rows + status row +
  rule). Composer-only classification — the model claude/codex/agy all use — would read this
  as CLEAN while opencode is genuinely mid-turn, which is a direct, measured violation of
  acceptance criterion 3. The one reliable signal that differs is **below the rule, in the
  footer**: `esc interrupt` appears there only while generating (idle footer instead shows the
  worktree path and token/cost info). Example, captured mid-turn:
  ```
   29|    ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                            tab agents  ctrl+p commands
  ```
  vs. idle:
  ```
   29|    /private/tmp/.../opencode_test_wt          8.3K (2%) · $ ctrl+p      commands
  ```

I did not manage to capture a true tool-permission dialog in this sandbox (a bash tool call
went through without an approval prompt, likely because of an existing permissive
`opencode.json`/global config) — that capture is deferred to the implement phase with a
concrete recipe below (Test Plan).

Caveat on tooling: the measurements above used `pyte` (a Python terminal emulator) for quick
turnaround, since this worktree has no installed dependencies yet (`pnpm install` has not been
run). `pyte` does not model SGR-2 dim at all, so the "never dim" claim is verified directly
against the **raw escape bytes**, not pyte's interpretation. The committed fixtures and profile
must still be validated against `@xterm/headless` (the actual engine `classifyBuffer` uses) via
the project's real test suite in the implement phase — that's the authoritative check, this
plan's byte-level reading is just why the design below looks the way it does.

## Proposed Change

### 1. Fix the launch invocation (defect 1)

Add a new optional hook to `HarnessProvider` (`packages/codev/src/agent-farm/utils/harness.ts:27-136`),
alongside `buildScriptRoleInjection`:

```ts
/**
 * Optional: shell fragment for passing the initial prompt in bash script
 * generation. Defaults to a bare positional argument (claude/codex convention)
 * when omitted — every existing harness is unaffected. `promptFileReadExpr` is
 * the pre-quoted shell expression that reads the prompt file back, e.g.
 * `"$(cat '/path/.builder-prompt.txt')"`.
 */
buildScriptPromptArg?(promptFileReadExpr: string): string;
```

`OPENCODE_HARNESS` (`harness.ts:202-216`) implements it:

```ts
buildScriptPromptArg: (promptFileReadExpr) => `--prompt ${promptFileReadExpr}`,
```

`spawn-worktree.ts:1101` changes from a hardcoded `promptArg` to:

```ts
const promptFileReadExpr = `"$(cat '${promptFile}')"`;
const promptArg = harness.buildScriptPromptArg
  ? harness.buildScriptPromptArg(promptFileReadExpr)
  : promptFileReadExpr;
```

Everything downstream (`freshCommand` at `:1102`, `pinnedFresh` at `:1119`) already
consumes `promptArg` unchanged, so this is the only edit needed in that function. claude/codex/
custom harnesses keep byte-identical generated scripts (no `buildScriptPromptArg` → falls back
to the existing bare positional). `buildWorktreeLaunchScript` (`:1174-1224`, no-prompt worktree
mode) is untouched — it never carries an initial prompt.

Correct the documentation that currently tells users to configure `"builder": "opencode run"`
(`README.md:373-388`, from Spec 178): change the example to `"builder": "opencode"`, remove the
now-wrong "Include `run`... otherwise it hangs" bullet, and replace it with a short note that
the harness seeds the initial message via `--prompt` so the TUI never sits with nothing to do.
`codev/specs/178-*.md` / `codev/plans/178-*.md` / `codev/reviews/178-*.md` are historical
decision records for a closed project and are left as-is; `codev-skeleton/` has no copy of this
README section (checked — nothing to mirror there).

### 2. Give opencode its own render-gate profile (defect 2)

**`render-gate.ts` changes (small, generic, additive — zero behavior change for
claude/codex/agy):**

- Add `┃` (U+2503) to `IGNORE_CHARS` (`render-gate.ts:143`). Safe: it's the same category of
  box-drawing chrome the set already carries (`│ ─ ━ ╌ ┄ ╭ ╰ ┌ └`), and none of the existing
  claude/codex/agy fixtures use this glyph (verified by grep).
- Extend `GateProfile` (`render-gate.ts:99-120`) with three new **optional** fields:
  - `busyIndicatorPattern?: RegExp` — if any screen line matches, the verdict is forced
    not-clean before any composer logic runs. New `GateVerdict.detail` value
    `'busy-indicator'` for telemetry.
  - `idleIndicatorPattern?: RegExp` — **(required change at plan-approval)** if set, CLEAN
    additionally requires this to be PRESENT on screen. Keyed on the measured idle footer
    readout `<tokens> (<pct>%) · $<cost>`, which opencode renders only between turns; the
    mid-turn footer replaces it with the interrupt hint. New `GateVerdict.detail` value
    `'no-idle-indicator'`. This is what makes the busy check safe under version drift:
    a busy-only rule fails *permissive* (rename the string → nothing matches → inject into
    a live turn), while requiring the idle half fails toward *hold*. With both required,
    either string drifting holds. Measured against opencode **1.18.18**, in both the
    zero-cost (`9.5K (2%) · $`) and priced (`9.2K (2%) · $0.02`) forms.
  - `bottomAnchor?: { anchorPattern: RegExp; bodyPattern: RegExp; maxLookback?: number }` — an
    alternate resolution path for a composer whose one reliably-unique anchor line sits at the
    *bottom* of a variable-height box instead of the top. When set, `classifyBuffer` finds the
    LAST row matching `anchorPattern` (excluded from scanning — it's chrome, never
    attribute-tested), then scans **upward** from `anchorRow - 1` while rows match
    `bodyPattern`, stopping at the first non-matching row or after `maxLookback` rows (default
    ~20) — whichever comes first, so an unterminated scan fails toward hold
    (`no-region-end`-equivalent) rather than reading into transcript content, mirroring the
    existing "never scan an unbounded region" philosophy. The resulting row range is
    cell-scanned with the same dim/ignore/whitespace rules `classifyBuffer` already uses.
  - Both fields are `undefined` for `CLAUDE_PROFILE`/`CODEX_PROFILE`/`AGY_PROFILE`, so
    `classifyBuffer` takes the existing top-down `markerPattern`/`regionEndPatterns` path for
    them, byte-for-byte unchanged.

**`gate-profiles.ts` changes:**

```ts
export const OPENCODE_PROFILE: GateProfile = {
  app: 'opencode',
  busyIndicatorPattern: /esc\s+interrupt/,
  idleIndicatorPattern: /\(\d+%\)\s+·\s+\$/,
  bottomAnchor: {
    rulePattern: /^\s*╹▀{5,}/,
    bodyPattern: /^\s*┃/,
    maxLookback: 20,
  },
};
```

(The anchor is keyed on the composer's bottom **rule** rather than a `(Build|Plan)` mode
name, as the draft plan had it — the rule is purely structural, so a custom `--agent` name
cannot break it. The chrome/status row is then the row directly above the rule, excluded
from scanning by construction. Confirmed against all five captured states.)

Add `opencode: OPENCODE_PROFILE` to `PROFILES_BY_HARNESS` (`gate-profiles.ts:94-97`).
`resolveProfile` needs no change — it already calls `detectHarnessFromCommand`, whose
`basename.includes('opencode')` check (`harness.ts:440`) already resolves the `opencode` key.

Add an exported `hasGateProfile(command: string): boolean` (thin wrapper around
`resolveProfile({ command }) !== null`) for the spawn-time check below.

### 3. Fail loudly when a builder harness has no gate profile (acceptance criterion 4)

Mirror the existing `assertBuilderHarnessNotRetired` pattern (`config.ts:304-…`, called from
`spawn.ts:934`). Add `assertBuilderHarnessHasGateProfile(workspaceRoot?: string): void` in
`spawn.ts` (importing `hasGateProfile` from `gate-profiles.ts` — `commands/` already imports
from `servers/` elsewhere, e.g. `architect.ts`, `attach.ts`, `workspace-recover.ts`, so this is
a precedented layering, not a new one):

```ts
function assertBuilderHarnessHasGateProfile(workspaceRoot?: string): void {
  const root = workspaceRoot ?? findWorkspaceRoot();
  const builderCmd = getResolvedCommands(root).builder;
  if (!hasGateProfile(builderCmd)) {
    fatal(
      `Builder harness "${builderCmd}" has no render-gate profile, so afx send can never ` +
      `deliver to it — every message would hold forever with reason "no-profile". ` +
      `Supported builder harnesses: claude, codex, opencode. Aborting before creating any ` +
      `worktree state.`
    );
  }
}
```

Call it in `spawn()` right after `assertBuilderHarnessNotRetired(config.workspaceRoot)`
(`spawn.ts:934`), before dispatch — same "no state created before this point" property the
retirement check already has. This is intentionally harness-name-based, not opencode-specific:
it also fails closed today for a custom/unknown builder harness, which is exactly what
criterion 4 asks for. No bypass flag — matches the no-escape-hatch precedent
`assertBuilderHarnessNotRetired` already set for a fail-closed pre-flight.

### 4. Captured fixtures

Add to `packages/codev/src/agent-farm/__tests__/fixtures/gate/`, following the existing
`<app>-<state>.<clean|busy>.txt` convention exactly (raw PTY bytes, no capture tooling
committed — matching how the real claude/codex captures were done: the fixtures README
documents provenance but no capture script survives in the repo today):

- `opencode-idle.clean.txt`
- `opencode-draft.busy.txt` (typed, not submitted — proves the bottom-anchor upward scan
  actually sees draft text)
- `opencode-midturn.busy.txt` (submitted, agent still generating — proves
  `busyIndicatorPattern`; this is the state that would silently false-clean without it)
- `opencode-dialog.busy.txt` (a real tool-permission dialog — see Test Plan for the capture
  recipe, since the default config in this sandbox didn't trigger one)

All captured at 110×32 to match the existing fixture dimensions. Extend
`render-gate.test.ts`'s `profileForFixture()` (`render-gate.test.ts:51-55`) with
`if (name.startsWith('opencode')) return OPENCODE_PROFILE;` — the fixture-driven test loop
(`:79-87`) and the required-states list (`:60-77`) already iterate generically, so adding the
four filenames to that list is the only test-file change needed for the fixture suite itself.
Add synthetic branch-coverage tests (alongside the existing ones at `:97+`) for: the
`busyIndicatorPattern` override taking precedence over an otherwise-clean composer, the
bottom-anchor upward scan finding a multi-line draft, and the `maxLookback` bound firing
`no-region-end` on a torn/unterminated frame. Add unit tests for `buildScriptPromptArg` (opencode
returns the `--prompt` fragment; claude/codex/custom harnesses are unaffected — `undefined`) and
for the new `assertBuilderHarnessHasGateProfile` pre-flight (opencode/claude/codex pass; an
unknown/custom harness `fatal()`s before any worktree work).

## Files to Change

- `packages/codev/src/agent-farm/utils/harness.ts` — `HarnessProvider.buildScriptPromptArg`
  (new optional method), `OPENCODE_HARNESS` implementation.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:1101-1102` — resolve `promptArg`
  through the new harness hook instead of a hardcoded positional.
- `packages/codev/src/agent-farm/servers/render-gate.ts` — `IGNORE_CHARS` (+`┃`), `GateProfile`
  (`busyIndicatorPattern`, `bottomAnchor`), `GateVerdict.detail` (+`'busy-indicator'`),
  `classifyBuffer` (busy-indicator short-circuit + bottom-anchor resolution path).
- `packages/codev/src/agent-farm/servers/gate-profiles.ts` — `OPENCODE_PROFILE`,
  `PROFILES_BY_HARNESS` entry, `hasGateProfile` export.
- `packages/codev/src/agent-farm/commands/spawn.ts` — `assertBuilderHarnessHasGateProfile`,
  called from `spawn()` next to the existing retirement check.
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/` — four new opencode `.txt`
  fixtures + a provenance paragraph appended to the directory's `README.md`.
- `packages/codev/src/agent-farm/__tests__/render-gate.test.ts` — fixture wiring + new
  synthetic branch tests.
- `packages/codev/src/agent-farm/__tests__/harness.test.ts` — `buildScriptPromptArg` coverage.
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` — generated-script assertion
  for an opencode builder (`opencode --prompt "$(cat ...)"` shape).
- New/updated spawn pre-flight test file (wherever `assertBuilderHarnessNotRetired` is tested —
  same file, adjacent `describe` block) for `assertBuilderHarnessHasGateProfile`.
- `README.md:373-389` — correct the documented `shell.builder` example and permission note.

## Risks & Alternatives Considered

- **Risk: `bottomAnchor`'s `maxLookback` is a guessed constant (~20).** Mitigation: it only
  matters for pathologically long unsubmitted drafts; a real capture with a long multi-line
  draft during implementation should confirm 20 is comfortably above any realistic composer
  height opencode actually renders (the box appeared to have no hard cap of its own in testing,
  so this is a safety backstop, not an expected trigger).
- **Risk: the `bottomAnchor` extension adds real logic to `render-gate.ts`, not just profile
  data**, unlike agy's Phase 3 addition (`placeholderFgPalette`), which was pure data. This is
  a direct consequence of measurement: opencode's composer is structurally a different shape
  (bottom-anchored, variable height) from claude/codex's single fixed line, and the issue's own
  language anticipates this isn't purely a data problem ("Give opencode its own patterns...")
  while still demanding no loosening of the shared top-down `REGION_END_PATTERNS`. The
  alternative — forcing opencode into the existing top-down `markerPattern`/`regionEndPatterns`
  shape — was tried conceptually first and demonstrably false-cleans on a real 2-line draft (see
  Understanding); it isn't a viable alternative, not just a less-clean one.
- **~~Risk: the mid-turn `busyIndicatorPattern` is a single measured string.~~
  Resolved at plan-approval — see the revision note at the top.** The original argument
  (that this was the same exposure `REGION_END_PATTERNS` already accepts) was wrong, and
  the direction is what matters: `REGION_END_PATTERNS` failing to match HOLDS, so its
  drift is over-caution; a busy-only check failing to match falls through to composer logic
  that reads CLEAN, so its drift is permissive — the silent corruption this issue exists to
  prevent. Fixed by requiring a positive `idleIndicatorPattern`. Residual risk is now
  one-directional: if either footer string changes in a future opencode, every send to an
  opencode builder holds until the profile is re-measured. The committed fixtures go red at
  the same moment, so the drift is visible rather than silent.
  (The draft also claimed "the composer itself gives no idle/busy signal at all" — true of
  the composer box, but the footer carries *both* states, and only the busy half was used.)
- **Alternative considered: reuse `opencode run` per the current docs.** Rejected — verified
  live that it's one-shot (exits after the first response), which doesn't satisfy "a builder
  that actually runs" for more than one turn, and the docs describing it predate `--prompt`
  apparently existing.
- **Alternative considered: loosen `REGION_END_PATTERNS`** to also match opencode's rule glyph.
  Rejected per the issue's explicit instruction, and also insufficient on its own — it doesn't
  solve the multi-row marker ambiguity or the mid-turn false-clean, so it wouldn't actually
  close the gap.
- **~~Open question: could not reproduce a real tool-permission dialog.~~ Resolved during
  implementation.** The Test Plan recipe worked: `{"permission": {"bash": "ask"}}` in the
  capture directory's `opencode.json` plus a prompt requiring a shell command produced the
  real dialog, captured as `opencode-dialog.busy.txt`. It replaces the whole composer
  (no rule line to anchor on) *and* hides the footer (no idle indicator), so it holds for
  two independent reasons — a blind Enter can never approve a shell command.
- **Not in scope**: making unattended opencode builders auto-approve tool permissions
  (`--auto`, or a default `permission` block in the generated `opencode.json`). The issue's
  acceptance criteria don't mention it, and it's an orthogonal, security-relevant default
  (auto-approving arbitrary bash) that deserves its own explicit decision rather than being
  bundled in here. Existing docs already tell users to configure it themselves
  (`README.md:385-388`); left as-is.

## Test Plan

- Unit: `harness.test.ts` — `OPENCODE_HARNESS.buildScriptPromptArg` returns
  `` `--prompt "$(cat '...')"` ``; `CLAUDE_HARNESS`/`CODEX_HARNESS` have no
  `buildScriptPromptArg` (`undefined`), so their generated scripts are unaffected.
- Unit: `spawn-worktree.test.ts` — with `OPENCODE_HARNESS`, the generated `.builder-start.sh`
  contains `opencode --prompt "$(cat '.../.builder-prompt.txt')"`, not a bare positional.
- Unit: `render-gate.test.ts` — the four new committed opencode fixtures classify as their
  filename states via the existing fixture-driven loop; new synthetic tests pin the
  `busyIndicatorPattern` short-circuit, the bottom-anchor upward scan (including a multi-line
  draft), and the `maxLookback` fail-safe.
- Unit: `gate-profiles`/`resolveProfile` — `resolveProfile({ command: 'opencode' })` returns
  `OPENCODE_PROFILE`; `hasGateProfile` true for claude/codex/opencode, false for an unknown
  binary.
- Unit: the spawn pre-flight test — `assertBuilderHarnessHasGateProfile` passes for
  claude/codex/opencode, `fatal()`s (before any worktree/porch/db mutation) for a custom
  harness with no matching profile.
- Manual (dev-approval gate):
  1. Set `shell.builder: "opencode"` in `.codev/config.json` (or `--builder-cmd opencode`).
  2. `afx spawn --task "sit idle"` → confirm the builder terminal shows the opencode TUI
     actually running (not "Agent exited at your request").
  3. `afx send <builder-id> "hello"` → `delivered`, and the composer visibly receives it.
  4. Send another message while the builder is actively generating a response → `held`, not
     injected into the composer mid-stream.
  5. Configure a builder harness with no gate profile (e.g. a bare unknown custom command) →
     `afx spawn` fails loudly with the new pre-flight message, no worktree/porch state left
     behind.
  6. Capture recipe for the dialog fixture: in a throwaway worktree, set
     `{"permission": {"bash": "ask"}}` in `opencode.json`, prompt a bash-tool-requiring
     message, and confirm the resulting approval screen renders no composer marker at all (if
     so, it already classifies not-clean via the existing `no-composer-marker` path and no
     opencode-specific handling is even needed for dialogs — verify this empirically rather
     than assuming) or, if it does render inside/near the composer shape, extend the profile
     accordingly before committing the fixture.
