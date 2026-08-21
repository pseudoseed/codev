# Render-gate fixtures (Spec 1313, Phases 2–3)

Each `*.txt` is the **raw PTY byte stream** for one composer state. `render-gate.test.ts`
pushes it through the production `RingBuffer` (`pushData` → `getAll().join('\n')`) and
classifies the reconstruction — the exact data path the live gate uses. The filename
encodes the expected verdict: `<app>-<state>.<clean|busy>.txt`.

## Provenance

- **codex-*.txt** — **real captures** from `codex` running under a PTY in this repo
  (idle, draft, menu, model-picker). This environment renders codex faithfully: the
  idle placeholder is SGR-**dim**, typed text is normal-intensity, so the classifier
  distinguishes them exactly as the spike measured (`codev/spikes/1265-poc`).
- **claude-draft.busy.txt, claude-menu.busy.txt** — **real captures** from `claude`
  (Claude Code 2.1.212) under a PTY. Typed text renders at the default foreground /
  normal intensity, which the classifier counts as occupancy → busy. Faithful.
- **claude-idle.clean.txt** — **synthesized** to match the spike's *real-claude*
  measurement (placeholder rendered **dim**, `g2a`: `dim=1`). The `claude` binary in
  this sandbox is the `ez-cli` proxy shim, which renders the *idle* placeholder
  **without** de-emphasis (default foreground, attribute-identical to typed text) — an
  environment artifact, not how real claude renders. No attribute-based classifier can
  separate a non-de-emphasized placeholder from user text (and the spike deliberately
  rejected text allowlists), so this one clean-state fixture is modeled on the
  spike-measured real-claude attributes instead of the shim's atypical output.
- **claude-picker.busy.txt** — **synthesized** claude `/model` picker (same reason
  as claude-idle: the sandbox `claude` is the shim, so no real picker to capture).
  Its highlighted row begins with the **same `❯` glyph** claude uses for the
  composer marker; model names render normal-intensity. This pins the guard that a
  picker's selection-cursor `❯` + list is classified **busy** (via the user-text
  path — the marker matches the cursor, the model names count as occupancy), never
  mistaken for an empty composer. Mirrors the real **codex-picker** capture, whose
  `› 1. …` selection cursor exercises the same path.
- **agy-idle.clean.txt, agy-draft.busy.txt, agy-trust.busy.txt** — **synthesized** to
  the **Phase 3 live measurement** of agy (Antigravity CLI 1.1.8). agy was captured
  under the spike harness (`agy-measure.cjs`), but its banner embeds the authenticated
  **account email**, so the raw capture is not committed; the fixtures reproduce the
  measured *attributes* with sanitized content. Measured facts they encode: agy's
  marker is `> ` (palette-12 bright blue), its idle mode-hint (`Accept-edits mode: …`)
  renders in **palette-8 (gray)** at normal intensity (dim=0), user-typed text is
  **default-fg**, and the per-folder trust dialog's selected `> Yes, I trust this
  folder` option is **palette-12**. So idle → clean (gray hint ignored), draft → busy
  (default-fg text counts), trust → busy (palette-12 option counts — a blind Enter
  never confirms filesystem trust). The raw measurement (with real render + per-cell
  fg attributes) is archived in the Phase 3 review.
- **opencode-*.txt** — **real captures** from `opencode` **1.18.18** (hosting Grok 4.6 via
  xAI) under a PTY at 110×32, taken for Issue #4. Five states, each committed as the raw
  byte stream the gate classifies:
  - `opencode-idle.clean.txt` — a completed turn, composer empty. The composer box is
    genuinely blank (opencode renders **no placeholder** once a session has messages), and
    the footer carries the session usage readout `8.3K (2%) · $0.01`.
  - `opencode-draft.busy.txt` — the same session with a typed, unsubmitted draft that wraps
    onto **two rows**. This is the fixture that pins why opencode needs its own region
    model: its box is bottom-anchored and grows upward, every row is prefixed with the same
    `┃`, so "the last row carrying the marker" is the *status* row and a top-down scan from
    it to the rule covers only chrome — the draft above would go unscanned and classify
    **clean**. The upward `bottomAnchor` scan is what sees it.
  - `opencode-midturn.busy.txt` — submitted, agent still generating. Compare its composer
    box with the idle fixture: they are **identical**. The two states differ only in the
    footer, which is why this profile classifies on footer signals at all.
  - `opencode-dialog.busy.txt` — a real tool-permission dialog (`△ Permission required` /
    `Allow once  Allow always  Reject`), produced by setting `{"permission":{"bash":"ask"}}`
    in the capture directory's `opencode.json` and prompting for a shell command. It
    replaces the whole composer *and* hides the footer, so it holds twice over — a blind
    Enter can never approve a shell command.
  - `opencode-boot.busy.txt` — a freshly booted TUI that has not yet run a turn. Its footer
    shows the version, not the usage readout, so the required idle indicator is absent and
    the gate holds (`no-idle-indicator`). Its composer also carries the first-run
    placeholder `Ask anything…`, rendered in RGB gray at normal intensity — not SGR-dim and
    not palette-indexed, so no existing placeholder exemption applies to it.

  **opencode uses SGR-dim nowhere.** Measured across all captured states — the five above
  plus the `/` command palette and the `@` agent picker — there are **zero dim cells on the
  whole screen**, not merely in the composer. `OPENCODE_PROFILE` therefore sets
  `treatDimAsPlaceholder: false` rather than inheriting the claude/codex convention that dim
  marks placeholder chrome. Nothing is lost by dropping it (there is no dim text to exempt),
  and keeping it would mean any dim affordance a future opencode ships — a queued-message
  preview, an inline completion — would be silently skipped and a real draft would read
  empty. agy already showed these attribute conventions do not port between TUIs.
- **wrapper-boot.busy.txt** — **synthetic** builder launch-loop screen (a born-dirty
  state with no composer marker). App-agnostic: no marker → busy under any profile.

## Classifier assumption

CLEAN requires a composer marker **and** zero normal-intensity, non-whitespace,
non-chrome cells in the composer region. Placeholder/hint text is excluded by an
**attribute** the profile names: claude/codex de-emphasize it with SGR-**dim**
(universal skip); agy uses a **foreground color** instead (palette-8), declared per
profile as `placeholderFgPalette`. Either way the exclusion is attribute-based, never
a text allowlist. A future TUI (or a shim) that renders a plain, un-de-emphasized
placeholder trips toward *busy* (fail-safe: a message is held, never misdelivered);
classifier-health telemetry (Phase 4/7) surfaces such a profile drift.

### Fixtures are swept across widths, not asserted at capture width

`render-gate.test.ts` classifies every opencode fixture at **every width from 40 to 140**,
and requires each `busy` fixture to read busy at all of them. This is not thoroughness for
its own sake — a fixture asserted only at its capture width is not a regression test.
`opencode-draft.busy.txt`, a real frame with a live two-line draft, classified **CLEAN at 43
of those 101 widths** before the region model was bounded positively on both edges: past
~100 cols the draft's own row wraps, the continuation row fails `bodyPattern`, the upward
scan accepted that as the top of the box, and the region collapsed onto the bottom pad row —
pure chrome, zero user cells, `clean`. The draft was never scanned.

Width mismatch is reachable in production, so this is not a synthetic concern:
`PtySession.resize` always resizes the gate mirror but can drop the app-side resize, and the
alt buffer does not reflow, so the mirror can sit at a geometry the app never paints at.
Note that a straightforward PTY drive at a fixed size will NOT surface this — matching
geometry is exactly the case where the box never wraps — which is why the sweep, not a live
drive, is the guard.

**Reading the sweep numbers.** A capture is clean from **its own capture width upward**, and
holds below it, where its rows genuinely wrap. Measured on real captures taken at three
widths (app and mirror matched, as in production):

| capture | idle @ own width | draft @ own width | clean across 40–140 |
|---|---|---|---|
| 80 cols | DELIVER | HOLD | 80–140 |
| 100 cols | DELIVER | HOLD | 100–140 |
| 120 cols | DELIVER | HOLD | 120–140 |
| 110 cols (`opencode-idle.clean.txt`) | DELIVER | — | 110–140 |

So "`opencode-idle.clean.txt` is clean at only 31 of 101 widths" measures the *fixture's*
capture geometry, not the profile: it is a 110-wide frame, and the 70 holding widths are all
narrower mirrors. A real builder does not sit in that state — the mirror tracks the live
geometry. The two ways to reach a genuine mismatch are both benign: a resize is *transient*
until the app repaints on SIGWINCH (the drainer retries held mail on its next tick, so it
self-clears rather than sticking), and a *dropped* resize only happens on the
`status !== 'running'` branches — a session that cannot receive mail anyway.

opencode adds a case the above cannot cover: an **empty composer does not mean an idle
agent** there, because its box renders identically mid-turn. Its profile therefore also
requires a positive **idle** signal (the footer usage readout) and rejects a **busy** one
(the footer interrupt hint). Requiring both is deliberate and directional — a busy-only
rule fails *permissive* under version drift (rename the string, nothing matches, the gate
injects into a live turn), while requiring the idle half fails toward *hold*. With both,
either string drifting produces a hold, never an injection. If a future opencode changes
either footer string, these fixtures go red and every send holds until the profile is
re-measured — the intended direction.
