# PIR Review: Make opencode a working builder harness

Fixes #4

> **Two caveats up front, both detailed below:** this is a **breaking change** for anyone on a
> custom builder harness, and it merged with **two of three review lanes — the Codex reviewer
> never ran** (quota exhausted; skipped on explicit human instruction).

## Summary

`opencode` could be configured as a builder harness but was unusable: it exited immediately
on launch, and even had it run, every `afx send` to it would have been held forever with
reason `no-profile`. This PR fixes the launch invocation (its positional slot is a *project
path*, not a message — it takes `--prompt`), gives it a render-gate profile measured from
real captured frames of opencode 1.18.18, and makes `afx spawn` fail loudly when a builder
harness has no gate profile instead of producing a builder that runs but can never be
messaged. It is the prerequisite for #2 (per-spawn `--model`).

## Files Changed

**Implementation** (5 files, +494 / −30):

- `packages/codev/src/agent-farm/servers/render-gate.ts` (+333 / −26)
- `packages/codev/src/agent-farm/servers/gate-profiles.ts` (+84 / −3)
- `packages/codev/src/agent-farm/commands/spawn.ts` (+43 / −0)
- `packages/codev/src/agent-farm/utils/harness.ts` (+26 / −0)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+8 / −1)

**Tests and fixtures** (11 files, +574 / −3):

- `packages/codev/src/agent-farm/__tests__/render-gate.test.ts` (+270 / −3)
- `packages/codev/src/agent-farm/__tests__/spawn-gate-profile.test.ts` (+141 / −0, new)
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` (+46 / −0)
- `packages/codev/src/agent-farm/__tests__/harness.test.ts` (+31 / −0)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/README.md` (+81 / −0)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/opencode-{idle,draft,midturn,dialog,boot}.*.txt`
  (5 new captures, one line each — raw PTY byte streams, 9.8–30 KB)

**Docs and protocol artifacts** (5 files, +832 / −8):

- `codev/reviews/4-opencode-builder-harness.md` (+284 / −0, new — this file)
- `codev/plans/4-opencode-builder-harness.md` (+419 / −0, new)
- `codev/resources/arch.md` (+49 / −0)
- `codev/resources/lessons-learned.md` (+33 / −0)
- `README.md` (+17 / −8)
- `codev/projects/4-make-opencode-a-working-builde/status.yaml` (+30 / −0, porch state)

**21 files, +1900 / −41.**

## Commits

- `b77d9cef3` [PIR #4] Plan draft
- `571f344a4` [PIR #4] Fix opencode launch and add a measured render-gate profile
- `21a7b359f` [PIR #4] Add spawn gate-profile preflight test; record post-approval plan revision
- `593177a84` [PIR #4] Close two false-CLEAN paths found by CMAP review
- `3a9ad84a1` [PIR #4] Bound the composer region positively; sweep fixtures across widths
- `0e27ffdb5` [PIR #4] Document the geometry-check availability trade-off
- `242b1daca` [PIR #4] Record the measured width behaviour; tighten the idle sweep assertion

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass — 5327 passed, 48 skipped, 0 failed (~40 new)
- Verified against the compiled `dist`, not just source: all five committed captures classify
  correctly through the production classifier, and the real generated `.builder-start.sh`
  launches opencode to an idle composer under a PTY (no immediate exit).
- Live captures at 80/100/120 columns with app and mirror matched — idle delivers, draft holds
  at each.
- Not verified from inside the worktree (spawning is architect-side): a real `afx spawn` with
  `shell.builder: "opencode"`, a live `afx send` returning `delivered`, and a send mid-turn
  returning `held`. Their components were verified as above; the end-to-end run belongs to the
  reviewer at the dev-approval gate.

---

## ⚠️ BREAKING CHANGE

**`afx spawn` now refuses a builder harness with no render-gate profile, with no bypass flag.**

Previously such a spawn succeeded and produced a builder that ran, looked healthy in every
listing, and silently held every message forever (`no-profile`). It now aborts before any
worktree, terminal, or db state is created.

This affects **anyone running a custom builder harness** whose command basename is not
`claude`, `codex`, or `opencode` (`agy` also resolves). For them this converts a
degraded-but-spawnable setup into "cannot spawn at all". That is deliberate and consistent
with the fail-closed precedent `assertBuilderHarnessNotRetired` set, but it is a real
upgrade-time break rather than a no-op, and the fix is to measure a profile for the harness —
not to add an escape hatch. Architects are unaffected; they take no gated mail.

**One such recipe was documented in this repo**, and CMAP caught that this PR would have
shipped the contradiction: `README.md` offered a custom `gemini` harness as the escape hatch
for users retaining enterprise/API-key Gemini CLI access, with `shell.builder: "gemini --yolo"`
+ `builderHarness: "gemini"`. That spawn now aborts. The README section is updated here to
scope the recipe to `architectHarness` and state plainly that gemini-as-builder is no longer
spawnable, and `spawn-gate-profile.test.ts` pins that exact config as rejected so the docs and
the pre-flight cannot drift apart again.

---

## The false-CLEAN that review caught, and why it matters

This is the most valuable thing in this PR and it should not live only in a thread log.

A render-gate false-CLEAN is not a cosmetic bug: `afx send` writes a message body onto a
screen the gate has certified as an empty prompt. A wrong CLEAN injects text into a live
turn or on top of a human's draft. A wrong BUSY only holds mail, which is recoverable. So
every failure mode must fail toward hold — and this one failed the other way.

**Before** (at commit `593177a84`), the committed `opencode-draft.busy.txt` fixture — a *real*
capture with a live two-line draft sitting in the composer — classified **CLEAN at 43 of 101
terminal widths**, ranges **50–79 and 87–99**. Mechanism: past ~100 cols the draft's own row
wraps; the continuation row fails `bodyPattern`; the upward scan accepted "failed
`bodyPattern`" as proof of the box's top edge; the region collapsed onto the box's bottom pad
row, which is guaranteed-ignorable chrome. Zero user cells counted, verdict `empty`, and the
draft on the rows above was never scanned.

**After**: **0 of 101**. Reproduced identically through `SessionScreen.feed` (the production
persistent mirror) and a fresh `Terminal` per width, so the render path was never the
variable.

The root error was treating a *negative* (a row that failed `bodyPattern`) as a *positive*
bound. A row also fails it when it is a wrapped continuation, a torn repaint, or chrome the
app draws differently — and every one of those truncates the region toward clean. The region
is now bounded positively on both edges: only `topEdgePattern` ends the upward scan, anything
else holds, and a region shorter than the measured minimum box height (3 rows) is a torn
frame rather than an empty composer. A wrapped row anywhere in the box holds outright
(`geometry-mismatch`).

Width mismatch is reachable in production: `PtySession.resize` (`pty-session.ts:567`) always
resizes the gate mirror but can drop the app-side resize, and the alt buffer does not reflow.

Three narrower false-CLEANs were closed alongside it, all confirmed against the classifier:

- A draft made only of box-drawing glyphs (a pasted tree or table) read as chrome, because
  `IGNORE_CHARS` is a character class. Bottom-anchored content is now counted **positionally**
  — past the row's leading box glyph — so the paste counts.
- A draft of NBSP or U+3000 read as padding, because `WHITESPACE` is `/^\s+$/u`.
- Dim composer text read as placeholder (see below).

Two earlier false-CLEANs, found by the first review pass and fixed in `593177a84`: the idle
indicator was matched screen-wide, so an agent printing the footer's shape (`coverage (85%) ·
$5`) could forge its own idle proof; and a zero-row region reached CLEAN without examining a
single cell.

### Process note on how this was nearly lost

The finding was briefly retracted after a sweep appeared to show the draft fixture never
classifying CLEAN. That sweep had measured the working tree *mid-edit*, with the fix already
applied. An A/B of the old and new region models over identical rendered buffers settled it —
the reported numbers were the fixed model's, and a checkout of `593177a84` into a detached
worktree then reproduced 43/101 with the exact width ranges. **Reproduce a reported finding
against a pinned commit, never a working tree.**

A live-PTY review that drove the real binary and found no false-CLEAN was *consistent*, not
contradictory: matching geometry is precisely the case where the box never wraps. That is
why a width sweep, not a live drive, had to be the regression guard.

## The idle sweep's width numbers are an artifact, not a cost

`opencode-idle.clean.txt` is clean at only 31 of 101 swept widths, which looks like an
availability regression. It is not. A capture is clean **from its own capture width upward**
and holds below it, where its rows genuinely wrap. Measured on real captures taken at three
widths with app and mirror matched, as in production:

| capture | idle @ own width | draft @ own width | clean across 40–140 |
|---|---|---|---|
| 80 cols | DELIVER | HOLD | 80–140 |
| 100 cols | DELIVER | HOLD | 100–140 |
| 120 cols | DELIVER | HOLD | 120–140 |
| 110 cols (the fixture) | DELIVER | — | 110–140 |

So the number measures the *fixture's* capture geometry, not the profile. A real builder does
not sit in the mismatched state — the mirror tracks the live geometry. Both routes to a
genuine mismatch are benign: a resize is **transient** until the app repaints on SIGWINCH, and
the mailbox drainer retries held rows on its next tick so it self-clears rather than sticking;
a **dropped** resize only happens on the `status !== 'running'` branches, where the session
cannot receive mail anyway.

## The dim measurement

`OPENCODE_PROFILE` sets `treatDimAsPlaceholder: false` rather than inheriting the
claude/codex convention that SGR-dim marks placeholder chrome. This was **measured, not
assumed**: across all seven captured opencode states — idle, draft, mid-turn, permission
dialog, fresh boot, the `/` command palette, and the `@` agent picker — there are **zero dim
cells on the whole screen**, not merely in the composer.

Nothing is lost by dropping the exemption today (there is no dim text to exempt), and keeping
it would mean any dim affordance a future opencode ships — a queued-message preview, an
inline completion — is silently skipped and a real draft reads empty. agy already established
that these attribute conventions do not port between TUIs; it needed `placeholderFgPalette`
because its hint is a foreground color rather than dim. opencode had inherited the assumption
without the measurement, which review correctly flagged.

## ⚠️ This merged with TWO of THREE review lanes — Codex never ran

**Read this before trusting the review depth.** This change touches core Tower
message-delivery code, where the failure mode is silent corruption of a live agent's input.
It did **not** get the full 3-way review that code normally gets.

| Lane | Result |
|---|---|
| **codex** (gpt-5.6-sol) | **NEVER RAN** — provider usage quota exhausted; retried twice (≈08:00 and ≈14:50 UTC, 2026-08-21). Quota restores 2026-08-27. **No codex findings exist for this change.** |
| gemini (agy) | APPROVE, HIGH |
| claude | REQUEST_CHANGES, HIGH → blocking finding fixed (the README/pre-flight contradiction above) |

The Codex lane was **skipped on explicit human instruction** on 2026-08-21, rather than block
a fork-local change for six days. The absence is recorded as a NOT-RUN file at
`codev/projects/4-make-opencode-a-working-builde/4-review-iter1-codex.txt`, which carries
`VERDICT: SKIPPED` so it cannot be misread as a review that happened. Weigh this as **two-lane
coverage on a security-adjacent path, with the strongest independent verifier absent.**

What the two lanes that did run actually contributed: Claude ran at every pass and was
substantive throughout — it found the transcript-forgery and zero-row false-CLEANs during
implementation, and caught the README/pre-flight contradiction on the final pass. Gemini was
unauthenticated during the mid-implementation passes (skipped non-blockingly) but ran on the
final review. The width-dependent false-CLEAN — the most serious one — came from a separate
adversarial pass, not from a standard lane. The architect independently swept all committed
fixtures across widths 40–140 against both the pre-fix and post-fix region models.

Every blocking finding raised was reproduced and fixed rather than argued down; one was
briefly retracted on a bad measurement and then re-confirmed against a pinned commit (see the
process note above).

## Architecture Updates

Routed to **COLD** (`codev/resources/arch.md`, §7 Message Delivery) — reference detail about
one subsystem, not a always-injected cross-cutting invariant. Added: opencode's profile and
its two structural departures (a bottom-anchored region model, and a two-sided busy/idle
footer rule because its composer renders identically idle and mid-turn), the
`treatDimAsPlaceholder` opt-out, and the spawn-time gate-profile pre-flight.

Not routed to HOT: `arch-critical.md` is at its 10-fact cap, and its existing mailbox fact
("Any new message writer routes through the mailbox+gate — never write a PTY directly")
already carries the invariant that matters at decision time. Adding a per-app profile detail
would not have earned a displacement.

## Lessons Learned Updates

Routed to **COLD** (`codev/resources/lessons-learned.md`) — these are recipes and
reproduction discipline, not decision-time rules, and `lessons-critical.md` is at its 10-item
cap with an entry ("Verify reviewer/plan claims against the actual file before acting") that
already covers the general shape. Added:

- **Testing**: a fixture asserted only at its capture geometry is not a regression test —
  sweep the dimension that can vary.
- **Debugging**: reproduce a reported finding against a *pinned commit*, never a working tree
  mid-edit; and two reviews disagreeing may both be right if they exercised different
  conditions.
- **Architecture**: do not port a rendering-attribute convention between TUIs without
  measuring the second one.

## Things to Look At During PR Review

- **`resolveBottomAnchorRegion` row arithmetic** (`render-gate.ts`). This is where the bug
  lived and where a regression would hurt most. The invariant: only `topEdgePattern` may end
  the upward scan; every other exit holds.
- **The `isWrapped` window includes the rule row and its continuation.** That is deliberate
  and slightly stricter than strictly necessary — a short empty box survives narrowing intact,
  and only the full-width rule spills. Rationale is in the code comment; it is a knowing
  availability-for-correctness trade, so it is worth a second opinion.
- **`treatDimAsPlaceholder` defaults to `true`** to keep claude/codex/agy byte-identical. If
  you would rather the default were fail-safe (`false`, forcing every profile to opt in after
  measuring), say so — I chose compatibility, and that is arguable.
- **The breaking change above.**
- Pre-existing, untouched, noted for someone else: `spawn-worktree.ts` interpolates
  `'${promptFile}'` into the generated script without `shellEscapeSingleQuote`, so a worktree
  path containing an apostrophe breaks the script. Out of scope here.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-4` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-4`
- **What to verify**:
  1. Set `shell.builder: "opencode"`, then `afx spawn --task "sit idle"` → the builder terminal
     shows a running opencode TUI, not "Agent exited at your request".
  2. `afx send <builder-id> "hello"` → `delivered`, and the composer visibly receives it.
  3. Send again while it is generating → `held`, not injected mid-stream.
  4. Set `shell.builder` to an unknown custom command → `afx spawn` aborts with the
     no-gate-profile message and leaves no worktree or porch state behind.
  5. `npx vitest run src/agent-farm/__tests__/render-gate.test.ts` — the width sweeps are the
     guard that would have caught the main bug.

**Two `held` results during step 2 are expected, not defects:**

- **Before the first turn finishes.** The idle indicator is the session usage readout, which
  opencode only renders *after* a completed turn. A freshly spawned builder therefore holds
  (`no-idle-indicator`) until its `--prompt` turn returns. Wait for the reply, then send.
- **If the builder's viewport is showing this repo's own gate source.** `busyIndicatorPattern`
  is matched screen-wide, so an opencode builder displaying `gate-profiles.ts`,
  `render-gate.test.ts`, or the fixtures reads its own `esc interrupt` string and holds
  (`busy-indicator`) until that scrolls off. The screen-wide match is deliberate — it only ever
  over-holds — but it makes this repo a confusing place to demo the feature.

## Flaky Tests

None skipped. No pre-existing unrelated failures encountered.
