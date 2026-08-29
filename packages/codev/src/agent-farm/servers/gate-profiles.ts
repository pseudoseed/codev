/**
 * Render-gate classifier profiles (Spec 1313, Phase 2).
 *
 * A profile tells {@link classifyScreen} how to find and bound a given app's
 * composer. Profiles are per-app *data* by design (spike constraint 9): a TUI
 * layout change is a profile drift the smoke suite catches, never a silent
 * misdelivery — an unmatched marker classifies NOT clean.
 *
 * Measured apps have a profile: claude, codex (spike g2), agy (Spec 1313
 * Phase 3 measurement — its own marker `> ` and a color-keyed placeholder rule,
 * because agy renders its idle hint in palette-8 gray, not SGR-dim), and opencode
 * (Issue #4 — a bottom-anchored composer plus a two-sided busy/idle footer rule).
 * Everything else — gemini, an unknown binary, or a launch we can't identify —
 * resolves to `null`, and the caller holds the message with reason `no-profile`.
 * This is the strict app-identity table the spike mandates (constraint 10): we
 * deliberately do NOT reuse `resolveHarness`, whose claude fallback would make an
 * agy terminal masquerade as claude and receive claude's (wrong) profile — a
 * correctness bug, since agy's screens classify by an entirely different rule.
 */

import { basename } from 'node:path';
import { detectHarnessFromCommand } from '../utils/harness.js';
import type { GateProfile } from './render-gate.js';

/**
 * Marker family shared by the measured TUIs: both render a `❯`/`›` prompt glyph
 * at the start of the composer input row. Kept in one place but referenced
 * per-profile so a future app whose marker diverges gets its own pattern without
 * disturbing the others.
 */
const COMPOSER_MARKER = /^[❯›]/;

/**
 * Lines that END the composer region — the rule line claude draws beneath its
 * input (`─────`) and the status line codex draws (model / reasoning / cwd, e.g.
 * `  gpt-5.6-sol   high: …   ~/repo`). Scanning stops at the first such line so
 * status chrome below the composer is never miscounted as user text. Both
 * patterns are carried by both profiles (harmless: a claude screen has no
 * `gpt|high:|~/` status line, a codex screen has no long rule line under input),
 * exactly as the validated spike classifier applied them.
 *
 * Load-bearing since the Spec 1313 render-gate hardening: when NONE of these matches
 * below the marker, the gate now HOLDS (`no-region-end`) rather than scanning to the
 * screen bottom — so this list is the sole lower-bound signal, and it is FAIL-SAFE but
 * DRIFT-FRAGILE. The rule pattern requires the line to *start* with `─/━/╌/┄`; a claude
 * reversion to a rounded box (`╰────╯`, note `╰`/`└` are ignorable glyphs but NOT in
 * this class) or an indented rule would stop matching and hold every send to that app.
 * That is the safe direction (never a false-clean), and a sustained hold now escalates
 * to liveness telemetry (mailbox-delivery `recordStreak`), but broaden this list ONLY
 * from a real capture — a too-loose pattern that matches draft content is a false-clean.
 */
const REGION_END_PATTERNS = [/^[─━╌┄]{5,}/, /^\s{2,}(gpt|high:|~\/)/];

/** claude composer profile (marker ❯, dim placeholder — measured, spike g2). */
export const CLAUDE_PROFILE: GateProfile = {
  app: 'claude',
  markerPattern: COMPOSER_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
};

/** codex composer profile (marker ›, dim placeholder — measured, spike g2). */
export const CODEX_PROFILE: GateProfile = {
  app: 'codex',
  markerPattern: COMPOSER_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
};

/**
 * agy (Antigravity CLI 1.1.8) composer marker: a `> ` prompt glyph at the input
 * row start — a different glyph from claude/codex's `❯`/`›`, so its own pattern.
 * (Measured, Spec 1313 Phase 3; the marker cell renders palette-12 bright-blue.)
 */
const AGY_MARKER = /^> /;

/**
 * agy composer profile (Spec 1313 Phase 3 — net-new measurement). agy breaks the
 * dim-placeholder assumption: its idle mode-hint (`Accept-edits mode: …`) renders
 * at NORMAL intensity but in **palette-8 (gray)**, while user-typed text is
 * default-fg — so the placeholder signal is a foreground COLOR, not SGR-dim
 * (`placeholderFgPalette: 8`). Consequences, all measured: idle → clean (the
 * gray hint is ignored), draft → busy (default-fg text counted), and the
 * per-folder trust dialog → busy (its selected `> Yes, I trust this folder`
 * option is palette-12, counted) — so a blind Enter never confirms filesystem
 * trust. Region bounds reuse the shared rule-line/status patterns (agy brackets
 * its composer with `─────` rules, like claude).
 */
export const AGY_PROFILE: GateProfile = {
  app: 'agy',
  markerPattern: AGY_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
  placeholderFgPalette: 8,
};

/**
 * opencode composer profile (Issue #4 — net-new measurement against **opencode
 * 1.18.18**; both indicator strings below were read off real captured frames from
 * that version, committed under `__tests__/fixtures/gate/opencode-*.txt`).
 *
 * opencode breaks the top-down region model outright. Its composer is a multi-row box
 * with a FIXED BOTTOM (a `╹▀▀▀…` rule) that grows UPWARD as the draft gets longer, and
 * every row of the box — content rows and the chrome status row alike — is prefixed with
 * the same `┃` glyph. "Last row carrying the marker" therefore resolves to the *status*
 * row, and a top-down scan from there to the rule covers only that chrome row while the
 * draft sits above it, unscanned: a measured false-clean on any draft at all (compare
 * `opencode-draft.busy.txt`, whose text occupies the two rows above the status row). So
 * it gets `bottomAnchor` — its own region model — rather than a loosened shared pattern.
 *
 * It also breaks the assumption that an empty composer means an idle agent: mid-turn,
 * the composer box is byte-identical to idle (compare `opencode-midturn.busy.txt` with
 * `opencode-idle.clean.txt` — the boxes match; only the footer differs). The two states
 * are distinguishable ONLY in the footer below the rule, and BOTH halves are used:
 *   - busy: the interrupt hint `esc interrupt`, rendered only while generating.
 *   - idle: the session usage readout `<tokens> (<pct>%) · $<cost>`, rendered only
 *     between turns. Measured in both its zero-cost (`9.5K (2%) · $`) and priced
 *     (`9.2K (2%) · $0.02`) forms, hence the trailing `\$` with nothing required after it.
 * Requiring the idle half to be PRESENT is what makes this safe under version drift: if
 * xAI renames the interrupt hint, the busy pattern stops matching but the idle pattern
 * does too, so the gate holds instead of injecting into a live turn. Neither string alone
 * would give that.
 *
 * Consequences, all measured against committed fixtures: idle → clean (the box is
 * genuinely empty — opencode renders no placeholder once a session has messages);
 * draft → busy (default-fg RGB text in the upward-scanned rows); mid-turn → busy
 * (`busy-indicator`); the tool-permission dialog → busy, for two independent reasons
 * (it replaces the whole composer, so there is no rule line to anchor on, AND it hides
 * the footer, so no idle indicator) — a blind Enter can never approve a shell command;
 * and a freshly-booted TUI that has not yet run a turn → busy, because the usage readout
 * only appears after the first turn (`no-idle-indicator`).
 *
 * Issue #197 re-measured all four `bottomAnchor` patterns against fresh live captures from
 * the same binary and found ZERO drift — the glyphs below are still exactly what opencode
 * paints. The holds that prompted that re-measurement were caused by the gate mirror being
 * SHORTER than the height opencode paints at, which clips this bottom-anchored box out of
 * the viewport entirely and makes `rulePattern` match nothing. See `finalRowAlwaysBlank`.
 *
 * Known wart, not a bug: `busyIndicatorPattern` is matched against the WHOLE screen, while
 * `idleIndicatorPattern` is scoped to the footer. That asymmetry is deliberate — a stray
 * busy match only ever HOLDS — but it means an opencode builder viewing this very file (or
 * the gate fixtures) holds its mail until `esc interrupt` scrolls out of the viewport.
 * Recognise it as a self-reference, not a delivery outage.
 */
export const OPENCODE_PROFILE: GateProfile = {
  app: 'opencode',
  busyIndicatorPattern: /esc\s+interrupt/,
  idleIndicatorPattern: /\(\d+%\)\s+·\s+\$/,
  bottomAnchor: {
    rulePattern: /^\s*╹▀{5,}/,
    bodyPattern: /^\s*┃/,
    // Measured: the box is always preceded by a blank row separating it from the
    // transcript — in every captured state, including with a `/` or `@` picker open.
    topEdgePattern: /^\s*$/,
    // Measured floor: the smallest box opencode renders is [pad][content][pad] above the
    // status row — 3 rows, in the idle and boot captures alike. A draft only grows it.
    minContentRows: 3,
    maxLookback: 20,
    // Measured across every captured state (idle, draft, mid-turn, dialog, boot, both
    // pickers, and the Issue #197 live re-captures): opencode never paints its final
    // viewport row. That makes a non-blank final row proof the app painted TALLER than the
    // mirror — see `finalRowAlwaysBlank`. Behaviour, not a guarantee; the fixture suite is
    // what makes a change to it loud.
    finalRowAlwaysBlank: true,
  },
  // Measured: opencode uses SGR-dim NOWHERE — zero dim cells across all seven captured
  // states (idle, draft, mid-turn, dialog, boot, and the `/` and `@` pickers), whole
  // screen, not just the composer. So the claude/codex dim-is-placeholder convention is
  // not inherited here: nothing would be exempted by it except, one day, a dim affordance
  // opencode has not shipped yet — which would be a silent false-CLEAN.
  treatDimAsPlaceholder: false,
};

/** Registry keyed by the harness name `detectHarnessFromCommand` returns. */
const PROFILES_BY_HARNESS: Record<string, GateProfile> = {
  claude: CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
  opencode: OPENCODE_PROFILE,
};

/**
 * The identity signals a caller extracts from a live session. A `PtySession`
 * satisfies this structurally via its `command` / `launchArgs` getters (the
 * Spec 1313 identity seam); tests pass a plain object.
 *
 * `label` is intentionally not used for matching: for a builder it is the
 * builder id (e.g. `spir-1313`), for an architect the architect name — neither
 * names the agent. The authoritative signal is the launch `command`.
 */
export interface AppIdentity {
  command: string;
  args?: string[];
  label?: string;
}

/**
 * Map a session's identity to its classifier profile, or `null` when the app is
 * unknown/unmeasured (→ caller holds with `no-profile`).
 *
 * Resolution is strict: the launch `command`'s basename must match a measured
 * agent. agy is matched directly (its binary is `agy`/`antigravity`), because the
 * shared {@link detectHarnessFromCommand} does not recognize it and we will not
 * extend that resolver — its claude fallback is exactly the misidentification the
 * gate must avoid (constraint 10). claude/codex resolve via that helper. Wrapped
 * launches — a builder run through `.builder-start.sh` whose `command` is the
 * shell, not the agent — resolve to `null` here; the delivery wiring (Phase 4)
 * supplies the resolved agent command for those (it already reads the launch
 * script to identify the harness, as `afx refresh` does). Fail-safe by
 * construction: an unresolved identity is held and surfaced, never guessed.
 */
export function resolveProfile(identity: AppIdentity): GateProfile | null {
  const base = basename(identity.command).toLowerCase();
  if (base.includes('agy') || base.includes('antigravity')) return AGY_PROFILE;
  const harness = detectHarnessFromCommand(identity.command);
  if (harness && harness in PROFILES_BY_HARNESS) return PROFILES_BY_HARNESS[harness];
  return null;
}

/**
 * Whether `command` resolves to a measured classifier profile — i.e. whether `afx send`
 * could ever deliver to an agent launched with it (Issue #4, acceptance criterion 4).
 *
 * Exists so the spawn pre-flight can refuse a builder harness the gate cannot classify,
 * instead of creating a worktree, a terminal and a builder row for an agent that would
 * hold every message forever with reason `no-profile` — an unmessageable builder that
 * looks healthy. Deliberately the SAME strict identity table `resolveProfile` uses, so
 * the pre-flight can never disagree with the runtime gate about what is deliverable.
 */
export function hasGateProfile(command: string): boolean {
  return resolveProfile({ command }) !== null;
}
