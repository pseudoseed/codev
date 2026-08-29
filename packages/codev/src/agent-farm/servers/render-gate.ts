/**
 * Render-empty gate (Spec 1313, Phase 2) — the sole authority that answers
 * "is this screen a clean, empty prompt?".
 *
 * A message body is only ever written to a prompt this gate proves empty, so
 * corruption is eliminated by construction: a message can never fuse with a
 * draft because it is never delivered while one exists. The classifier is a direct
 * port of the G-lite classifier validated against the real claude/codex TUIs in
 * spike 1265 (`codev/spikes/1265-poc/exp-g2-glite-prod-path.mjs`).
 *
 * WHAT it reads (Spec 1313 render-gate round 2 — capped-ring reconciliation): the gate
 * classifies a rendered terminal SCREEN via the sync core {@link classifyBuffer}. In
 * PRODUCTION that screen is the session's persistent bounded mirror (`SessionScreen`,
 * terminal layer): one long-lived `@xterm/headless` Terminal fed the session's output
 * incrementally — from birth on the live path — whose current viewport IS the live screen. The gate originally
 * REBUILT the screen every check by replaying the whole output ring
 * (`ringBuffer.getAll().join('\n')`) through a throwaway Terminal — but #1205 capped the ring's
 * newline-free `partial` at 2 MiB (`trimPartial` halves to ~1 MiB), and a claude/codex
 * alt-screen frame (`\x1b[?1049h`) is exactly one giant newline-free partial. So once a busy
 * long-lived agent's frame crossed the cap, the gate was handed a TORN front — dropping the
 * composer marker (→ false `no-composer-marker`) or the composer's lower rule (→ the region
 * spills into status chrome → false `user-text`) — and held its mail PERMANENTLY. That is the
 * over-ceiling delivery outage the whole-ring render was meant to eliminate, resurrected one
 * layer down for exactly the busiest agents. A bounded terminal mirror needs only the live byte
 * stream, not the whole ring, so the cap is irrelevant, the live-ring tear is gone, each classify is
 * O(viewport) rather than O(ring size), and the whole-render era's unbounded-`partial` OOM risk
 * (#1047: one classify allocating a multi-hundred-MB string) is closed. The whole-ring
 * {@link classifyScreen} entry survives for the fixture suite and any transient one-shot
 * classify; it shares the SAME classifier core, so the two paths can never diverge.
 *
 * Caveat — adopt/reconnect seed: after a Tower restart the mirror is seeded from a bounded replay
 * tail (`capRingSeed`, 1 MiB), not the live-from-birth stream, so a long-lived alt-screen frame can
 * be born torn on adopt. That classifies not-clean → the gate HOLDS (fail-safe, never a misdelivery)
 * and self-heals on the next repaint/viewer nudge. Pre-existing (the pre-round-2 whole-ring gate saw
 * the same capped seed), not a round-2 regression; tracked as #1361.
 *
 * Classifier (fail-toward-not-clean): CLEAN requires
 *   (a) a recognized composer marker on the screen, AND
 *   (b) a positively-bounded composer region (a rule/status line BELOW the
 *       marker — never a scan to the screen bottom), AND
 *   (c) zero normal-intensity (non-dim), non-whitespace, non-chrome cells in that
 *       region — with one measured exemption: claude's suggested-command *ghost* cursor
 *       cell (an inverse, non-dim char at the cursor followed by a non-empty dim run), which
 *       is composer chrome, not typed text (see `isGhostCursorCell`), AND
 *   (d) for a profile that declares them (Issue #4, opencode): its mid-turn
 *       `busyIndicatorPattern` ABSENT and its `idleIndicatorPattern` PRESENT. Some TUIs
 *       render an identical composer whether idle or mid-turn, so composer emptiness is
 *       not evidence of idleness there; idleness must be positively proven, and drift in
 *       either string then holds rather than injecting into a live turn.
 * Region resolution has two models: the original top-down `markerPattern` +
 * `regionEndPatterns`, and `bottomAnchor` for a box anchored at its bottom rule that grows
 * upward (opencode) — see `GateProfile.bottomAnchor` for why the top-down model
 * false-cleans there.
 * The placeholder-vs-user-text distinction is an SGR attribute — both TUIs
 * render rotating placeholder/hint text DIM while typed text is normal-intensity
 * (measured, spike g2) — so no placeholder allowlist is needed. Anything
 * unrecognized (no marker, no region boundary, a menu, a picker, a draft, a
 * wrapper/boot screen, or a mirror that has not yet repainted a coherent frame) → NOT clean →
 * the message stays held. There is no force path.
 *
 * Cost (spike g2, @xterm/headless 6.0.0): classifying a rendered viewport is sub-millisecond
 * (bounded rows × cols, independent of history); the mirror pays a normal terminal-emulator
 * parse per output chunk — the cost any emulator pays for the byte stream — amortised across
 * the session instead of spent in a per-check whole-history burst.
 */

// `@xterm/headless` resolves to its CommonJS entry (no `exports` map, no
// `type: module`), and its named exports are not statically analyzable, so a
// native-node ESM `import { Terminal }` throws "Named export 'Terminal' not
// found" when the compiled dist runs under node (production; masked under vitest
// by vite's CJS interop). Default-import the module object — the codebase's
// convention for CJS deps (cf. `import Database from 'better-sqlite3'`).
import xtermHeadless from '@xterm/headless';
// Type-only: erased at compile time, so it adds no runtime import (the named
// runtime binding is unavailable — see above); the .d.ts still provides the type.
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless;

// Buffer cell/line types derived from the public Terminal type rather than imported by
// name: `@xterm/headless`'s `IBufferCell`/`IBufferLine` are declared without `export`
// inside its ambient module, so a named `import type` is not guaranteed to resolve —
// deriving via the exported `Terminal` surface is import-stable.
type BufferCell = ReturnType<HeadlessTerminal['buffer']['active']['getNullCell']>;
type BufferLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;

/**
 * A one-shot replay-string snapshot for the TRANSIENT {@link classifyScreen} path.
 * `replay` is a rendered byte stream (e.g. a `ringBuffer.getAll().join('\n')` or a test
 * fixture); `cols`/`rows` size the throwaway headless terminal to match the captured
 * session so wrapping reconstructs identically. Production no longer builds this from the
 * (capped) ring — it reads the session's persistent {@link SessionScreen} mirror instead
 * (see the module header); this shape survives for the fixture suite and any transient
 * one-shot classify.
 */
export interface RingSnapshot {
  replay: string;
  cols: number;
  rows: number;
}

/**
 * A per-app classifier profile (instances + `resolveProfile` live in
 * `gate-profiles.ts`). Marker + region bounds are per-app data by design
 * (spike constraint 9): a TUI layout change is a profile drift, never a silent
 * misdelivery — an unmatched marker defaults to NOT clean.
 */
export interface GateProfile {
  /** App identity this profile classifies (e.g. 'claude', 'codex'). */
  app: string;
  /**
   * Matches the composer prompt marker at the START of the input row. Required
   * for the top-down region model (claude/codex/agy); a profile that resolves its
   * region via {@link bottomAnchor} instead leaves it unset.
   */
  markerPattern?: RegExp;
  /**
   * A line matching any of these ENDS the composer region (the rule/status lines
   * rendered directly below the input). Scanning stops there so status chrome
   * below the composer is never counted as user text. Paired with
   * {@link markerPattern}; unset for a {@link bottomAnchor} profile.
   */
  regionEndPatterns?: RegExp[];
  /**
   * Optional per-app BUSY signal: a screen line that proves the agent is
   * mid-turn. When any line matches, the verdict is not-clean before any composer
   * logic runs. Needed by an app whose composer looks identical idle and mid-turn
   * (opencode), where composer emptiness alone is not evidence of idleness.
   *
   * A busy pattern on its own is NOT sufficient — it fails permissive if the app
   * renames the string. It must be paired with {@link idleIndicatorPattern}, which
   * fails toward hold. See the two-sided rule on that field.
   */
  busyIndicatorPattern?: RegExp;
  /**
   * Optional per-app IDLE signal: a FOOTER line that positively proves the agent is
   * between turns. When set, CLEAN additionally requires this pattern to be PRESENT
   * — the absence of a busy signal is never enough on its own.
   *
   * Matched only against rows BELOW the composer, never the whole screen: the transcript
   * above the composer is agent-authored, so a screen-wide match would let a reply that
   * happened to print the footer's shape (`… (85%) · $12`) vouch for the agent's own
   * idleness. App chrome below the composer cannot be forged by model output.
   *
   * This is the direction that matters. {@link busyIndicatorPattern} fails
   * PERMISSIVE under app drift: rename the busy string and nothing matches, the
   * composer reads empty, and the gate injects into a live turn. This pattern fails
   * toward HOLD: rename the idle string and nothing matches, so the gate holds. With
   * both required, EITHER string drifting produces a hold rather than a corrupting
   * injection — the same fail-safe direction `regionEndPatterns` already has.
   */
  idleIndicatorPattern?: RegExp;
  /**
   * Optional alternate region model for a composer that is anchored at its BOTTOM
   * and grows UPWARD, which the {@link markerPattern} + {@link regionEndPatterns}
   * top-down model cannot express.
   *
   * opencode renders a multi-row box whose bottom edge is fixed (a rule line) and
   * whose content rows extend upward as the draft grows. Every row of the box —
   * content rows and the chrome status row alike — starts with the same glyph, so
   * "the last row carrying the marker" resolves to the *status* row and a top-down
   * scan from there covers only chrome, never the draft text sitting above it. That
   * is a measured false-clean on any draft (see the fixtures), which is why this app
   * gets its own region model rather than a loosened shared pattern.
   *
   * Resolution: find the LAST row matching `rulePattern` (the box's bottom edge).
   * The row directly above it is the app's chrome/status row — excluded from
   * scanning by construction, since it always carries normal-intensity text. From
   * there scan UPWARD while rows match `bodyPattern`, stopping at a row that matches
   * `topEdgePattern`; the region is every row so collected.
   *
   * The region is bounded POSITIVELY on both edges — a row must be *proven outside* the
   * box (`topEdgePattern`) to end the scan. "Failed `bodyPattern`" is NOT proof of an
   * upper bound and must never be treated as one: a row also fails it when it is a
   * wrapped continuation, a torn repaint, or chrome the app draws differently, and
   * accepting those as the top edge silently truncates the region toward the box's
   * bottom pad row — which is guaranteed-ignorable chrome, so the composer reads EMPTY
   * with a real draft sitting unscanned above it. That was a live false-CLEAN on a real
   * captured draft at 43 of 101 terminal widths (CMAP, 2026-08-21). A row that is
   * neither in-box nor a proven top edge now HOLDS.
   *
   * `minContentRows` is the second half of the same defence: the app has a minimum box
   * height, so a shorter region is a torn frame rather than an empty composer. Together
   * they make truncation fail toward hold instead of toward clean.
   */
  bottomAnchor?: {
    /** The rule line closing the bottom of the composer box. */
    rulePattern: RegExp;
    /** Every row belonging to the composer box matches this. */
    bodyPattern: RegExp;
    /**
     * A row PROVABLY outside the box, ending the upward scan (measured: the app leaves a
     * blank row between the transcript and the composer). Required — without a positive
     * upper bound the region cannot be trusted.
     */
    topEdgePattern: RegExp;
    /**
     * Fewest content rows the app ever renders inside the box. A region shorter than this
     * is a torn/partial frame, not an empty composer, and holds.
     */
    minContentRows: number;
    /** Upward-scan bound; an unterminated scan holds. Defaults to {@link DEFAULT_MAX_LOOKBACK}. */
    maxLookback?: number;
    /**
     * Set when the app is MEASURED to leave its final viewport row blank in every state.
     * Enables the rows-direction geometry check (Issue #197).
     *
     * A bottom-anchored composer occupies the frame's LAST rows, so a mirror shorter than
     * the height the app paints at clips the whole box away. The emulator clamps every
     * write addressed past the viewport onto the final row, so that row — blank in every
     * healthy frame — fills with overlapping garbage. That is the signal: it is a
     * structural consequence of clamping, not a text match on the app's content.
     *
     * This is MEASURED BEHAVIOUR, NOT A GUARANTEE. opencode 1.18.18 leaves row N-1 blank
     * across every captured state (idle, draft, mid-turn, dialog, boot, both pickers), but
     * nothing stops a future release from painting there. That is why it is declared
     * per-profile rather than assumed for all bottom-anchored apps, and why the fixture
     * suite classifies the committed captures: if opencode ever fills its last row, the
     * idle fixture flips clean → busy and CI says so, instead of every send silently
     * holding in production.
     */
    finalRowAlwaysBlank?: boolean;
  };
  /**
   * Whether SGR-dim marks placeholder/hint chrome for this app (default `true` — the
   * claude/codex measurement).
   *
   * Explicit rather than inherited, because it is an app-specific rendering fact and the
   * cost of assuming it wrongly is a false-CLEAN: any dim text a TUI draws in its composer
   * would be skipped as a "placeholder" and a real draft would read empty. agy already
   * showed these attribute conventions do not port between TUIs (it needed
   * {@link placeholderFgPalette} because its hint is a color, not dim). A profile must
   * therefore have MEASURED its app's dim usage before leaving this on.
   */
  treatDimAsPlaceholder?: boolean;
  /**
   * Optional per-app placeholder signal: a 16-color palette index whose cells are
   * treated as placeholder/hint chrome (ignored), NOT user text. This is the
   * color-attribute analogue of the universal dim-placeholder skip. claude/codex
   * de-emphasize their placeholder with SGR-dim (handled universally); agy instead
   * renders its idle mode-hint in palette-8 (gray) while user-typed text is
   * default-fg — measured, Spec 1313 Phase 3 — so agy sets this to 8. Left unset,
   * only the dim rule applies (claude/codex behavior is unchanged).
   */
  placeholderFgPalette?: number;
}

/** The gate's verdict. `reason` is the mailbox why-held reason when not clean. */
export interface GateVerdict {
  clean: boolean;
  /** Present only when not clean — the busy-line hold reason. */
  reason?: 'busy';
  /**
   * Internal classification detail (telemetry/debugging only — NOT a delivery
   * reason). `no-composer-marker` = wrapper/boot/picker/unknown screen (or a torn
   * replay that dropped the marker); `no-region-end` = a marker with no rule/status
   * line beneath it to bound the composer (a partial/mid-repaint frame) — held
   * rather than scanning into status chrome; `busy-indicator` = the profile's
   * mid-turn signal is on screen; `no-idle-indicator` = the profile requires a
   * positive idle signal and it is absent (a boot screen, a dialog that hides the
   * footer, or profile drift); `geometry-mismatch` = a composer row is a wrapped
   * continuation, so the mirror's width disagrees with the width the app painted at and
   * no row boundary is trustworthy; `user-text` = a draft or menu occupies the composer;
   * `empty` = clean.
   */
  detail:
    | 'no-composer-marker'
    | 'no-region-end'
    | 'busy-indicator'
    | 'no-idle-indicator'
    | 'geometry-mismatch'
    | 'user-text'
    | 'empty';
}

/**
 * Box-drawing / prompt chrome that is never "user text". The composer marker
 * glyphs (❯ ›) live here too; the marker cell is additionally skipped by
 * position so a profile whose marker is not listed still never self-trips.
 *
 * `┃` (U+2503 HEAVY VERTICAL) is opencode's composer-box edge — the heavy sibling
 * of the `│` already here — and prefixes every row of its box, including the rows
 * the bottom-anchor scan reads.
 */
const IGNORE_CHARS = new Set(['❯', '›', '│', '┃', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

/**
 * Default upward-scan bound for {@link GateProfile.bottomAnchor}. Measured
 * composer boxes are 3–5 rows; 20 is a backstop for a pathologically long draft,
 * not an expected trigger, and exceeding it holds rather than reading upward into
 * transcript content.
 */
const DEFAULT_MAX_LOOKBACK = 20;

/** All-whitespace (incl. NBSP and other Unicode spaces) → ignorable. */
const WHITESPACE = /^\s+$/u;

/**
 * First column of USER content in a bottom-anchored composer row: everything up to and
 * including the box's leading edge glyph is chrome, everything after it is the user's.
 *
 * Positional, not character-class based. The shared {@link IGNORE_CHARS} set cannot serve
 * here: it would also discard a *draft* composed of box-drawing glyphs (a pasted tree or
 * table), which reads as an empty composer and delivers a message onto it. Rows reaching
 * this have already matched the profile's `bodyPattern`, so a leading glyph exists.
 */
function boxContentColumn(line: string): number {
  const glyph = line.search(/\S/);
  return glyph === -1 ? 0 : glyph + 1;
}

/** Rendered viewport lines, right-trimmed — the same extraction the spike asserts on. */
function screenLines(term: HeadlessTerminal, rows: number): string[] {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return lines;
}

/** Last row index whose text starts with the profile's composer marker, or -1. */
function findMarkerRow(lines: string[], markerPattern: RegExp): number {
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markerPattern.test(lines[i])) markerRow = i;
  }
  return markerRow;
}

/**
 * First region-ending row after the marker (the rule/status line beneath the
 * composer), or -1 when none is found. -1 means the composer has no proven lower
 * bound (a partial/mid-repaint frame, or a torn replay) — the caller MUST hold, not
 * scan to the screen bottom: scanning further counts status chrome below the
 * composer as user text (the old bug) OR, if that chrome renders empty/dim, returns
 * a false CLEAN. A missing boundary is indeterminate, and indeterminate is not-clean.
 */
function findRegionEnd(lines: string[], markerRow: number, endPatterns: RegExp[]): number {
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (endPatterns.some((p) => p.test(lines[i]))) return i;
  }
  return -1;
}

/** The composer row span to cell-scan: `[from, to)`, plus the marker row when one exists. */
interface ComposerRegion {
  from: number;
  to: number;
  /** Row whose column-0 cell is the marker glyph, skipped by position. -1 when not applicable. */
  markerRow: number;
  /**
   * First row BELOW the composer and its bottom chrome — where an app's status footer
   * renders. {@link GateProfile.idleIndicatorPattern} is matched only from here down, so
   * transcript output cannot satisfy it: everything the agent prints is ABOVE the composer,
   * so a reply that happened to contain the footer's shape (`… (85%) · $12`) can never be
   * mistaken for the real footer.
   */
  footerFrom: number;
}

/**
 * Resolve the composer region for a {@link GateProfile.bottomAnchor} profile — a box
 * anchored at its bottom rule and growing upward (opencode). Returns the row span to
 * scan, or a `detail` explaining why the frame is indeterminate (→ the caller holds).
 *
 * The row directly above the rule is the app's chrome/status row and is excluded from
 * the returned span: it always carries normal-intensity text, so scanning it would
 * classify every frame `user-text`.
 */
function resolveBottomAnchorRegion(
  lines: string[],
  anchor: NonNullable<GateProfile['bottomAnchor']>,
): ComposerRegion | { detail: 'no-composer-marker' | 'no-region-end' } {
  let ruleRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (anchor.rulePattern.test(lines[i])) ruleRow = i;
  }
  // No rule line: a dialog that replaced the composer, a boot/wrapper screen, or a
  // torn frame. Never clean.
  if (ruleRow === -1) return { detail: 'no-composer-marker' };

  // The chrome/status row must sit directly above the rule. When it does not, the
  // frame is not the measured composer shape — hold rather than guess at bounds.
  const chromeRow = ruleRow - 1;
  if (chromeRow < 0 || !anchor.bodyPattern.test(lines[chromeRow])) {
    return { detail: 'no-composer-marker' };
  }

  const maxLookback = anchor.maxLookback ?? DEFAULT_MAX_LOOKBACK;
  let from = chromeRow; // walked upward below; ends at the topmost content row
  let bounded = false;
  for (let scanned = 0; scanned < maxLookback; scanned++) {
    const candidate = from - 1;
    // Ran off the top of the viewport without meeting the top edge: no proven upper
    // bound (a torn or mid-repaint frame) — indeterminate, so hold.
    if (candidate < 0) break;
    // The ONLY accepted proof that the box has ended.
    if (anchor.topEdgePattern.test(lines[candidate])) { bounded = true; break; }
    // Neither in-box nor a proven top edge: a wrapped continuation row, a torn repaint,
    // or unrecognized chrome. The region's extent is unknowable here, and guessing it
    // truncates toward clean, so hold.
    if (!anchor.bodyPattern.test(lines[candidate])) return { detail: 'no-region-end' };
    from = candidate;
  }
  // Exhausted the lookback with every row still inside the box: unterminated.
  if (!bounded) return { detail: 'no-region-end' };

  // A box shorter than the app ever renders is a torn frame, not an empty composer.
  if (chromeRow - from < anchor.minContentRows) return { detail: 'no-region-end' };

  return { from, to: chromeRow, markerRow: -1, footerFrom: ruleRow + 1 };
}

/**
 * Resolve the composer region for any profile: the bottom-anchored model when the
 * profile declares one, else the original top-down marker + region-end model, whose
 * behavior for claude/codex/agy is unchanged.
 */
function resolveRegion(
  lines: string[],
  profile: GateProfile,
): ComposerRegion | { detail: 'no-composer-marker' | 'no-region-end' } {
  if (profile.bottomAnchor) return resolveBottomAnchorRegion(lines, profile.bottomAnchor);

  // A profile with neither region model cannot bound a composer at all. Unreachable
  // for the shipped profiles (the types make one of the two mandatory in practice);
  // treated as indeterminate rather than scanned, per fail-toward-hold.
  if (!profile.markerPattern || !profile.regionEndPatterns) {
    return { detail: 'no-composer-marker' };
  }

  const markerRow = findMarkerRow(lines, profile.markerPattern);
  if (markerRow === -1) {
    // No composer marker: a wrapper/boot screen, a full-screen picker with no marker, a
    // mirror that has not yet repainted a coherent frame, or an unrenderable snapshot.
    // Never clean — the safe direction.
    return { detail: 'no-composer-marker' };
  }

  const endRow = findRegionEnd(lines, markerRow, profile.regionEndPatterns);
  if (endRow === -1) {
    // A marker with no rule/status line beneath it: a partial/mid-repaint frame. The
    // composer has no proven lower bound, so hold rather than scan into the status chrome
    // below it (which would either miscount chrome as user text or, if it renders
    // empty/dim, return a false CLEAN).
    return { detail: 'no-region-end' };
  }
  return { from: markerRow, to: endRow, markerRow, footerFrom: endRow + 1 };
}

/**
 * Ghost-suggestion cursor cell (Spec 1313 render-gate hardening — false-`busy` on an idle
 * claude composer). When claude's own last reply mentioned a runnable command it paints
 * that command into the otherwise-empty composer as a *suggested-command ghost*, and the
 * ghost's first character doubles as the software block cursor: it is rendered SGR-7
 * INVERSE at normal intensity while the rest of the ghost is SGR-2 dim
 * (`❯ ␛[7m a ␛[27m␛[2mfx cleanup …␛[22m`, measured live — captured as
 * `claude-ghost-suggestion-empty.replay.bin`). The universal dim rule already skips the
 * ghost body, but the lone inverse cursor cell was counted as user text → the composer
 * classified `user-text`/`busy` FOREVER while genuinely empty, so mail to an idle
 * (unattended) agent was never delivered (fail-safe becomes fail-forever for an idle
 * recipient — the exact agent `afx send` exists to wake).
 *
 * This exempts exactly that cell: the cell at the headless buffer's cursor position,
 * rendered inverse at normal intensity, whose following run on the same row is dim or
 * empty (the measured ghost tail). It is deliberately NARROW — NOT the blanket inverse
 * skip the finding warns against — and does not false-clean a real draft:
 *   - measured, claude renders the block cursor inverse only on the trailing WHITESPACE
 *     past a real draft (already skipped as whitespace) and never inverse-renders typed
 *     characters, so a real draft's typed cells are non-inverse and still counted;
 *   - an inverse *selection* over real multi-char text fails the dim-tail test (its
 *     following cells are non-dim) and, even if it passed, only this one cell is skipped
 *     while every other selected cell keeps the verdict `busy`.
 * A lone inverse cursor cell with NO dim tail (a 1-char draft with the cursor sitting on its
 * only char, empty composer otherwise) is NOT exempted — it stays `busy` — because the
 * exemption requires positive ghost evidence (≥1 dim suggestion-body cell). That closes the
 * false-clean an empty-tail exemption would have opened, honoring the no-new-corruption-vector
 * / fail-toward-hold invariant (Codex CMAP, 2026-08-06). Real ghosts always carry a multi-char
 * dim command body (the captured fixture's tail is 23 dim cells), so nothing real is lost.
 */
function isGhostCursorCell(
  line: BufferLine,
  row: number,
  col: number,
  cols: number,
  cursorRow: number,
  cursorCol: number,
  cell: BufferCell,
  probe: BufferCell,
): boolean {
  if (row !== cursorRow || col !== cursorCol) return false;
  if (!cell.isInverse()) return false; // typed text is never inverse-rendered; only the software cursor is
  // Require POSITIVE ghost evidence: at least one dim, non-whitespace, non-chrome cell must
  // follow on this row (the SGR-2 suggestion body), and EVERY following such cell must be dim.
  // An empty / whitespace-only tail is NOT a ghost — it is a 1-char draft with the cursor on
  // its only char, which must stay `busy` (fail-toward-hold; a lone inverse cell is not proof
  // of a ghost). Any non-dim text to the right ⇒ real content, also not a ghost.
  let sawDimTail = false;
  for (let c = col + 1; c < cols; c++) {
    line.getCell(c, probe);
    const ch = probe.getChars();
    if (!ch || WHITESPACE.test(ch) || IGNORE_CHARS.has(ch)) continue;
    if (!probe.isDim()) return false;
    sawDimTail = true;
  }
  return sawDimTail;
}

/**
 * The classifier CORE (Spec 1313 render-gate round 2): classify an already-rendered
 * headless buffer against a profile. Synchronous — it only READS the live buffer, it never
 * parses — so it is shared, unchanged, by BOTH gate paths: the production persistent-mirror
 * gate (`SessionScreen.read()` → this) and the transient {@link classifyScreen} (write a
 * replay into a throwaway term → this). One classifier core means the two paths can never
 * disagree about what "empty" means.
 *
 * Precondition: the caller has already parsed all input into `term` (the mirror flushes in
 * `read()`; `classifyScreen` awaits its `write`). Having no `await`, a single call is atomic
 * against concurrent feeds — nothing can mutate the buffer mid-scan.
 *
 * Returns `{ clean: true, detail: 'empty' }` only when a composer marker is present and the
 * composer region carries zero normal-intensity user cells; otherwise
 * `{ clean: false, reason: 'busy', … }`.
 */
export function classifyBuffer(
  term: HeadlessTerminal,
  cols: number,
  rows: number,
  profile: GateProfile
): GateVerdict {
  const buf = term.buffer.active;
  const lines = screenLines(term, rows);

  // ROWS-direction geometry check (Issue #197), before every other signal.
  //
  // The cols-direction check further down catches a mirror NARROWER than the app. This
  // catches a mirror SHORTER than it, which for a bottom-anchored composer is the more
  // destructive of the two: the box lives in the frame's last rows, so a short viewport
  // clips it away completely. `rulePattern` then matches nothing and the gate reports
  // `no-composer-marker` — which reads as "this app has no composer", i.e. profile drift,
  // and is how Issue #197 came to be filed as a glyph-drift bug. It was a geometry bug.
  //
  // Ordered FIRST deliberately. When the mirror's height disagrees with the app's, every
  // row boundary on the screen is untrustworthy, so no other signal read off this frame
  // deserves to name the verdict — same reasoning the cols check already documents. The
  // outcome is a hold either way; what changes is that the reason points at the mirror
  // instead of at the profile.
  //
  // See `finalRowAlwaysBlank` for why a non-blank final row is the signal, and for the
  // measured-not-guaranteed caveat. `screenLines` already trimEnd()s, so `=== ''` is exact.
  if (profile.bottomAnchor?.finalRowAlwaysBlank && rows > 0 && lines[rows - 1] !== '') {
    return { clean: false, reason: 'busy', detail: 'geometry-mismatch' };
  }

  // A profile-declared mid-turn signal settles the verdict before any composer logic:
  // an app whose composer looks the same idle and mid-turn (opencode) would otherwise
  // read as an empty prompt while it is generating.
  if (profile.busyIndicatorPattern) {
    const pattern = profile.busyIndicatorPattern;
    if (lines.some((line) => pattern.test(line))) {
      return { clean: false, reason: 'busy', detail: 'busy-indicator' };
    }
  }

  const region = resolveRegion(lines, profile);
  if ('detail' in region) return { clean: false, reason: 'busy', detail: region.detail };
  const { from: regionFrom, to: regionTo, markerRow } = region;

  // An empty span would fall through the cell loop below and reach CLEAN on
  // `userCells === 0` — a verdict reached without examining a single cell. "Zero cells
  // examined" is indeterminate, not empty, so it is rejected here rather than left to the
  // counter. Unreachable via the top-down model (its region always contains the marker
  // row); a second line of defence for region models that can collapse.
  if (regionTo <= regionFrom) return { clean: false, reason: 'busy', detail: 'no-region-end' };

  // ...and where a profile declares one, idleness must be POSITIVELY proven, not inferred
  // from the busy signal's absence. Scoped to the FOOTER (below the composer), because the
  // transcript above it is agent-authored: a reply containing the footer's shape must not
  // be able to vouch for the agent's own idleness. Runs after region resolution so the
  // footer's start is known; a frame with no resolvable composer has already been held.
  if (profile.idleIndicatorPattern) {
    const pattern = profile.idleIndicatorPattern;
    const footer = lines.slice(region.footerFrom);
    if (!footer.some((line) => pattern.test(line))) {
      return { clean: false, reason: 'busy', detail: 'no-idle-indicator' };
    }
  }

  const top = buf.viewportY;

  // Geometry check (bottom-anchored profiles). A row inside the composer box is a WRAPPED
  // continuation only when the mirror's width disagrees with the width the app painted at
  // — `PtySession.resize` always resizes the gate mirror but can drop the app-side resize
  // (`return false`), and the alt buffer does not reflow, so that disagreement can persist
  // indefinitely. Every row boundary on such a screen is untrustworthy: the app's own rows
  // no longer line up with the mirror's. Checked across the box, its rule, and the rule's
  // continuation, so an overflowing rule is caught too.
  //
  // The rule row is deliberately included even though a SHORT box can survive narrowing
  // intact (an empty composer has nothing long enough to wrap, so only the full-width rule
  // spills). That frame is still proof the app painted wider than the mirror, and the
  // moment the user types a line long enough to wrap, the region breaks. So the cost is
  // accepted knowingly: while the mirror's geometry is wrong, an idle-LOOKING opencode
  // composer holds its mail rather than being trusted. A hold is visible (mailbox-delivery
  // `recordStreak` escalates a sustained one) and self-heals on the next correct repaint;
  // trusting a misread composer is not visible and does not heal.
  if (profile.bottomAnchor) {
    for (let row = regionFrom; row <= region.footerFrom && row < rows; row++) {
      if (buf.getLine(top + row)?.isWrapped) {
        return { clean: false, reason: 'busy', detail: 'geometry-mismatch' };
      }
    }
  }

  const cell = buf.getNullCell();
  const probe = buf.getNullCell(); // scratch cell for the ghost-tail look-ahead (never clobbers `cell`)
  // Cursor position is viewport-relative (matching `row`, which indexes from `viewportY`).
  const cursorRow = buf.cursorY;
  const cursorCol = buf.cursorX;
  let userCells = 0;

  for (let row = regionFrom; row < regionTo; row++) {
    const line = buf.getLine(top + row);
    if (!line) continue;
    // A bottom-anchored box marks its chrome by POSITION: the row's leading glyph is the
    // box edge and everything after it is the user's. Counting content positionally rather
    // than by character class is what stops a draft made only of box-drawing glyphs
    // (a pasted tree or table) from reading as chrome and classifying empty.
    const contentFrom = profile.bottomAnchor ? boxContentColumn(lines[row]) : 0;
    for (let col = contentFrom; col < cols; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (!ch) continue;
      if (profile.bottomAnchor) {
        // Only a plain space or tab is empty here. `\s` would also swallow NBSP and
        // U+3000, which a paste can carry and which are real content, not padding.
        if (ch === ' ' || ch === '\t') continue;
      } else if (WHITESPACE.test(ch) || IGNORE_CHARS.has(ch)) {
        continue;
      }
      if (row === markerRow && col === 0) continue; // the marker glyph itself
      // Dim is placeholder chrome only where the app was MEASURED to use it that way.
      if (cell.isDim() && (profile.treatDimAsPlaceholder ?? true)) continue;
      if (
        profile.placeholderFgPalette !== undefined &&
        cell.isFgPalette() &&
        cell.getFgColor() === profile.placeholderFgPalette
      ) {
        continue; // per-app placeholder color: agy renders its idle hint in palette-8 (gray)
      }
      if (isGhostCursorCell(line, row, col, cols, cursorRow, cursorCol, cell, probe)) {
        continue; // claude's suggested-command ghost cursor cell (see isGhostCursorCell)
      }
      userCells++;
    }
  }

  return userCells === 0
    ? { clean: true, detail: 'empty' }
    : { clean: false, reason: 'busy', detail: 'user-text' };
}

/**
 * Classify a one-shot replay snapshot by rendering it into a THROWAWAY headless terminal
 * (Spec 1313). The transient path — the fixture suite and any caller holding a replay string
 * rather than a live mirror. Production instead classifies the session's persistent
 * {@link SessionScreen} directly via {@link classifyBuffer} (see the module header). Async
 * because the headless terminal parses its input on a write callback; the shared
 * {@link classifyBuffer} then does the actual classification.
 */
export async function classifyScreen(snapshot: RingSnapshot, profile: GateProfile): Promise<GateVerdict> {
  const { cols, rows } = snapshot;
  // A throwaway terminal for this single classify. scrollback 2000 is ample for a
  // whole-replay render; the gate reads only the viewport, so the value never changes the
  // verdict (the persistent mirror uses a much smaller one for the same reason).
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  try {
    await new Promise<void>((resolve) => term.write(snapshot.replay, resolve));
    return classifyBuffer(term, cols, rows, profile);
  } finally {
    term.dispose();
  }
}
