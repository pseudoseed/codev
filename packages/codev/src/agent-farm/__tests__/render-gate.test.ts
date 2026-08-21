/**
 * Render-empty gate (Spec 1313, Phase 2) — classifier + profile tests.
 *
 * The fixture suite classifies REAL captured byte streams from claude 2.1.212 and
 * codex (captured under a PTY the same way the spike measured them; see
 * `codev/spikes/1265-poc/exp-g2-glite-prod-path.mjs`). Each fixture is the raw
 * PTY output for one screen state; the test pushes it through the production
 * `RingBuffer` and classifies the reconstruction — the exact
 * `ringBuffer.getAll().join('\n')` data path the live gate uses. Filenames encode
 * the expected verdict: `<app>-<state>.<clean|busy>.txt`.
 *
 * Synthetic ANSI cases pin the individual classifier branches deterministically;
 * `resolveProfile` cases pin the strict, fail-safe app-identity mapping.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import { classifyScreen, classifyBuffer } from '../servers/render-gate.js';
import type { RingSnapshot, GateProfile } from '../servers/render-gate.js';
import {
  CLAUDE_PROFILE,
  CODEX_PROFILE,
  AGY_PROFILE,
  OPENCODE_PROFILE,
  resolveProfile,
  hasGateProfile,
} from '../servers/gate-profiles.js';

const COLS = 110;
const ROWS = 32;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const INV = '\x1b[7m'; // SGR-7 inverse (claude's software block cursor over the ghost's first char)
const INV_OFF = '\x1b[27m'; // SGR-27 inverse off
const PAL8 = '\x1b[38;5;8m'; // agy's placeholder gray
const PAL12 = '\x1b[38;5;12m'; // agy's marker / selected-option bright blue
const FG = '\x1b[39m'; // reset foreground to default

/** Production data path: raw PTY bytes → RingBuffer.pushData → getAll().join('\n'). */
function snapshotFromRaw(raw: string, cols = COLS, rows = ROWS): RingSnapshot {
  const ring = new RingBuffer(1000);
  ring.pushData(raw);
  return { replay: ring.getAll().join('\n'), cols, rows };
}

/** Build a raw \r\n-terminated screen from lines. */
function screen(...lines: string[]): string {
  return lines.map((l) => l + '\r\n').join('');
}

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gate', import.meta.url));

function profileForFixture(name: string): GateProfile {
  if (name.startsWith('codex')) return CODEX_PROFILE;
  if (name.startsWith('agy')) return AGY_PROFILE;
  if (name.startsWith('opencode')) return OPENCODE_PROFILE;
  return CLAUDE_PROFILE; // claude-* and the marker-less wrapper/boot fixture
}

describe('render-gate — real captured fixtures (Spec 1313)', () => {
  const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();

  it('the required states are all captured (claude+codex idle/draft/menu/picker, agy idle/draft/trust, wrapper/boot)', () => {
    for (const required of [
      'claude-idle.clean',
      'claude-draft.busy',
      'claude-menu.busy',
      'claude-picker.busy',
      'codex-idle.clean',
      'codex-draft.busy',
      'codex-menu.busy',
      'codex-picker.busy',
      'agy-idle.clean',
      'agy-draft.busy',
      'agy-trust.busy',
      'opencode-idle.clean',
      'opencode-draft.busy',
      'opencode-midturn.busy',
      'opencode-dialog.busy',
      'opencode-boot.busy',
      'wrapper-boot.busy',
    ]) {
      expect(fixtures.some((f) => f.startsWith(required))).toBe(true);
    }
  });

  for (const name of fixtures) {
    const expectClean = name.includes('.clean.');
    it(`${name} → ${expectClean ? 'clean' : 'busy'}`, async () => {
      const raw = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
      const verdict = await classifyScreen(snapshotFromRaw(raw), profileForFixture(name));
      expect(verdict.clean).toBe(expectClean);
      if (!expectClean) expect(verdict.reason).toBe('busy');
    });
  }

  it('a marker-less screen is busy under BOTH profiles (wrapper/boot is app-agnostic)', async () => {
    const raw = readFileSync(`${FIXTURE_DIR}/wrapper-boot.busy.txt`, 'utf8');
    const snap = snapshotFromRaw(raw);
    expect((await classifyScreen(snap, CLAUDE_PROFILE)).detail).toBe('no-composer-marker');
    expect((await classifyScreen(snap, CODEX_PROFILE)).clean).toBe(false);
  });
});

describe('render-gate — synthetic branch coverage (Spec 1313)', () => {
  it('marker + dim placeholder only → clean', async () => {
    const snap = snapshotFromRaw(screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, '──────────────────────'));
    expect(await classifyScreen(snap, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });

  it('marker + normal-intensity user text → busy (user-text)', async () => {
    const snap = snapshotFromRaw(screen(`❯ ${RESET}deploy the hotfix to prod`, '──────'));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.reason).toBe('busy');
    expect(v.detail).toBe('user-text');
  });

  it('a single normal char among dim placeholder flips clean → busy', async () => {
    const clean = snapshotFromRaw(screen(`❯ ${DIM}placeholder text here${RESET}`, '──────'));
    const dirty = snapshotFromRaw(screen(`❯ ${DIM}placeholder ${RESET}x${DIM} here${RESET}`, '──────'));
    expect((await classifyScreen(clean, CLAUDE_PROFILE)).clean).toBe(true);
    expect((await classifyScreen(dirty, CLAUDE_PROFILE)).clean).toBe(false);
  });

  it('codex-style bold/colored marker + dim placeholder → clean; region ends at the status line', async () => {
    const snap = snapshotFromRaw(screen(
      `${BOLD}›${RESET} ${DIM}Explain this codebase${RESET}`,
      '  gpt-5.6-sol   high: on   ~/repo',
      'this normal text is BELOW the status line and must NOT count',
    ));
    expect((await classifyScreen(snap, CODEX_PROFILE)).clean).toBe(true);
  });

  it('no composer marker → busy (no-composer-marker), never a false clean', async () => {
    const snap = snapshotFromRaw(screen('builder@host:~/repo$ ', 'Press Enter to relaunch'));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('no-composer-marker');
  });

  it('marker + NO region-end boundary, only dim/empty below → busy (no-region-end; closes a latent false-CLEAN)', async () => {
    // Spec 1313 D1 hardening. Previously an unbounded region scanned to lines.length;
    // with only dim/empty rows below (no rule/status line to bound the composer) it
    // counted 0 user cells and returned CLEAN — a false-clean on a partial/mid-repaint
    // frame. Now a missing lower bound is indeterminate ⇒ hold. (Marker + dim below,
    // NO `─────` rule.)
    const snap = snapshotFromRaw(screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, `${DIM}dim tail, no rule line${RESET}`));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('no-region-end');
  });

  it('agy: `> ` marker + palette-8 (gray) hint → clean; default-fg draft → busy', async () => {
    // agy de-emphasizes its idle hint with a FOREGROUND COLOR (palette-8), not
    // SGR-dim — so the placeholder rule is color-keyed for agy (placeholderFgPalette).
    const idle = snapshotFromRaw(screen(`${PAL12}>${FG} ${PAL8}Accept-edits mode: file edits auto-approved${FG}`, '──────'));
    const draft = snapshotFromRaw(screen(`${PAL12}>${FG} review the mailbox change`, '──────'));
    expect((await classifyScreen(idle, AGY_PROFILE)).clean).toBe(true);
    expect((await classifyScreen(draft, AGY_PROFILE)).clean).toBe(false);
  });

  it('agy: only palette-8 is placeholder — a non-gray (palette-12) option still counts (trust-dialog guard)', async () => {
    // The trust dialog's selected `> Yes, I trust this folder` renders palette-12,
    // NOT gray — so it must count as occupancy (busy), else a blind Enter would
    // confirm a filesystem-trust decision. Pins that the color rule ignores ONLY
    // the profile's placeholder palette, not every non-default color. A rule line
    // bounds the region so the color-counting branch runs and palette-12 is the sole
    // occupancy signal. (Dual protection: a real dialog with NO rule below fails safe
    // the OTHER way — via the no-region-end guard — also busy, never a blind confirm.)
    const trust = snapshotFromRaw(screen(`${PAL12}>${FG} ${PAL12}Yes, I trust this folder${FG}`, '──────'));
    const v = await classifyScreen(trust, AGY_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('an empty replay is busy (a session with no output is not a verified-empty prompt)', async () => {
    expect((await classifyScreen(snapshotFromRaw(''), CLAUDE_PROFILE)).clean).toBe(false);
  });
});

/**
 * opencode's two structural departures (Issue #4), pinned synthetically so each branch
 * is exercised deterministically. The real captures live in the fixture suite above;
 * these isolate the individual rules.
 */
describe('render-gate — opencode: bottom-anchored composer + two-sided busy/idle rule (Issue #4)', () => {
  const RULE = '  ╹' + '▀'.repeat(100);
  const STATUS = '  ┃  Build · Grok 4.6 xAI · high';
  const IDLE_FOOTER = '   /tmp/wt                                     8.3K (2%) · $0.01  ctrl+p commands';
  const BUSY_FOOTER = '   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                              tab agents  ctrl+p commands';

  /**
   * A composer box in the measured opencode shape: a BLANK row separating it from the
   * transcript (the profile's `topEdgePattern`), a top pad row, the content rows, a bottom
   * pad row, the status row, and the rule. With no content the box is still 3 rows tall —
   * `[pad][empty][pad]` — which is the measured minimum and what `minContentRows` pins.
   */
  const composer = (...content: string[]) => [
    '',
    '  ┃',
    ...(content.length ? content : ['']).map((c) => (c ? `  ┃  ${c}` : '  ┃')),
    '  ┃',
    STATUS,
    RULE,
  ];

  it('idle: empty box + the usage readout → clean', async () => {
    const snap = snapshotFromRaw(screen(...composer(), IDLE_FOOTER));
    expect(await classifyScreen(snap, OPENCODE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });

  it('a draft ABOVE the status row is seen — the case the top-down model false-cleans', async () => {
    // Every row of opencode's box starts with `┃`, so "last row carrying the marker"
    // is the STATUS row and a top-down scan from it to the rule covers only chrome,
    // never the draft sitting above. The upward scan is what makes this busy.
    const snap = snapshotFromRaw(screen(...composer('refactor the widget factory'), IDLE_FOOTER));
    expect(await classifyScreen(snap, OPENCODE_PROFILE)).toMatchObject({ clean: false, detail: 'user-text' });
  });

  it('a multi-row draft is seen on every row, not just the one nearest the status row', async () => {
    const snap = snapshotFromRaw(screen(...composer('first line of the draft', 'second line too'), IDLE_FOOTER));
    expect((await classifyScreen(snap, OPENCODE_PROFILE)).clean).toBe(false);
    // ...and the row furthest from the anchor is genuinely scanned, not incidentally
    // caught by the nearer one: with ONLY the far row occupied it must still be busy.
    const farOnly = snapshotFromRaw(screen(...composer('far from the anchor', '', ''), IDLE_FOOTER));
    expect((await classifyScreen(farOnly, OPENCODE_PROFILE)).clean).toBe(false);
  });

  it('mid-turn: the composer box is byte-identical to idle, and ONLY the busy footer holds it', async () => {
    const box = composer();
    // Same box, different footer — the whole reason this profile needs footer signals.
    const idle = snapshotFromRaw(screen(...box, IDLE_FOOTER));
    const busy = snapshotFromRaw(screen(...box, BUSY_FOOTER));
    expect((await classifyScreen(idle, OPENCODE_PROFILE)).clean).toBe(true);
    expect(await classifyScreen(busy, OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'busy-indicator',
    });
  });

  it('idleness must be PROVEN, not inferred: busy-string drift holds instead of injecting', async () => {
    // The regression guard for the whole design. Simulate a future opencode renaming
    // its interrupt hint: the busy pattern no longer matches, the composer still reads
    // empty — under a busy-only rule that is a false CLEAN into a live turn. The
    // required idle indicator is absent while generating, so it holds instead.
    const drifted = '   ⬝⬝⬝⬝⬝⬝⬝⬝  esc cancel                                 tab agents  ctrl+p commands';
    const snap = snapshotFromRaw(screen(...composer(), drifted));
    expect(await classifyScreen(snap, OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-idle-indicator',
    });
  });

  it('the agent cannot forge its own idle proof from the transcript', async () => {
    // The idle indicator is read from the FOOTER only. Everything the agent prints lands
    // above the composer, so a reply that happens to contain the footer's shape must not
    // count. Here the busy hint is ALSO drifted, so the transcript line is the only thing
    // that could satisfy the idle check — and it must not.
    const snap = snapshotFromRaw(screen(
      '     Coverage rose to (85%) · $12 saved per run.',
      ...composer(),
      '   ⬝⬝⬝⬝⬝⬝⬝⬝  esc cancel                              tab agents  ctrl+p commands',
    ));
    expect(await classifyScreen(snap, OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-idle-indicator',
    });
  });

  it('the usage readout is matched in both its zero-cost and priced forms', async () => {
    const zeroCost = '   /tmp/wt                                       9.5K (2%) · $  ctrl+p commands';
    const priced = '   /tmp/wt                                     12.1K (3%) · $0.42  ctrl+p commands';
    for (const footer of [zeroCost, priced]) {
      expect((await classifyScreen(snapshotFromRaw(screen(...composer(), footer)), OPENCODE_PROFILE)).clean)
        .toBe(true);
    }
  });

  it('the permission dialog is held TWICE OVER — it hides the footer AND removes the rule', async () => {
    // A blind Enter here would approve a shell command, so this state gets belt and
    // braces. As captured, the dialog replaces the whole composer AND the footer, so
    // the idle check fires first...
    const dialogRows = [
      '  ┃',
      '  ┃  △ Permission required',
      '  ┃  $ echo hello',
      '  ┃   Allow once   Allow always   Reject',
      '  ┃',
    ];
    // ...so there is no rule line to anchor a composer region on, and it holds there —
    // with or without a footer.
    expect(await classifyScreen(snapshotFromRaw(screen(...dialogRows)), OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-composer-marker',
    });
    expect(
      await classifyScreen(snapshotFromRaw(screen(...dialogRows, IDLE_FOOTER)), OPENCODE_PROFILE),
    ).toMatchObject({ clean: false, detail: 'no-composer-marker' });
    // ...and independently, a variant that KEPT the composer chrome (so a region resolves)
    // but still hid the footer is caught by the idle check instead. Either guard alone
    // holds this state.
    expect(
      await classifyScreen(snapshotFromRaw(screen(...composer('△ Permission required'))), OPENCODE_PROFILE),
    ).toMatchObject({ clean: false, detail: 'no-idle-indicator' });
  });

  it('a rule with no box row above it (torn frame) → busy', async () => {
    const torn = screen('   some transcript text', RULE, IDLE_FOOTER);
    expect(await classifyScreen(snapshotFromRaw(torn), OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-composer-marker',
    });
  });

  it('an upward scan that never terminates within maxLookback holds rather than reading upward', async () => {
    // Every row a box row: the scan can never prove an upper bound, so it must hold
    // instead of walking into transcript content above.
    const unbounded = screen(...Array.from({ length: 29 }, () => '  ┃  x'), STATUS, RULE, IDLE_FOOTER);
    expect(await classifyScreen(snapshotFromRaw(unbounded), OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-region-end',
    });
  });

  it('a box of only box-drawing glyphs is a draft, not chrome', async () => {
    // A pasted tree/table is made entirely of characters IGNORE_CHARS discards, so a
    // character-class rule reads the composer as empty and delivers onto the draft. The
    // bottom-anchored model counts content POSITIONALLY — past the row's leading box
    // glyph — so the paste counts. (CMAP, 2026-08-21.)
    const snap = snapshotFromRaw(screen(...composer('├── src', '│   └── index.ts'), IDLE_FOOTER));
    expect((await classifyScreen(snap, OPENCODE_PROFILE)).clean).toBe(false);
  });

  it('a draft of non-ASCII spaces is a draft, not padding', async () => {
    // `\s` matches NBSP and U+3000, so a pasted run of them is invisible to a
    // whitespace-class rule while sitting in the composer as real content.
    for (const space of [' ', '　']) {
      const snap = snapshotFromRaw(screen(...composer(space.repeat(6)), IDLE_FOOTER));
      expect((await classifyScreen(snap, OPENCODE_PROFILE)).clean).toBe(false);
    }
  });

  it('dim text in the composer counts — opencode was measured to use no dim at all', async () => {
    // The claude/codex "dim means placeholder" convention is NOT inherited here: zero dim
    // cells were measured across all seven captured opencode states. Any dim affordance a
    // future version adds would otherwise be a silent false-CLEAN.
    const snap = snapshotFromRaw(screen(...composer(`${DIM}refactor the widget factory${RESET}`), IDLE_FOOTER));
    expect((await classifyScreen(snap, OPENCODE_PROFILE)).clean).toBe(false);
  });

  it('a box with NO content rows is a torn frame, not an empty composer', async () => {
    // Regression guard (CMAP, 2026-08-21): chrome + rule + footer painted but the content
    // rows not yet repainted collapses the region to zero rows. The cell loop then examines
    // nothing, and "zero cells examined" must not read as "zero user cells found" — that is
    // a CLEAN verdict reached without looking at a single cell, and the torn/partial-repaint
    // frames the module header documents are exactly how it gets reached. Every measured
    // opencode box has >= 3 content rows, so no legitimate state is lost by holding here.
    const torn = screen('', STATUS, RULE, IDLE_FOOTER);
    expect(await classifyScreen(snapshotFromRaw(torn), OPENCODE_PROFILE)).toMatchObject({
      clean: false,
      detail: 'no-region-end',
    });
  });

  it('the status row is chrome: its normal-intensity RGB text never counts as a draft', async () => {
    // `Build · Grok 4.6 xAI · high` is truecolor and never dim, so neither the
    // universal dim skip nor a palette rule can exempt it — it is excluded by being
    // the anchor row. Were it scanned, EVERY frame would classify busy.
    const snap = snapshotFromRaw(screen(...composer(), IDLE_FOOTER));
    expect((await classifyScreen(snap, OPENCODE_PROFILE)).clean).toBe(true);
  });
});

/**
 * Width sweep over the committed opencode captures (Issue #4, CMAP 2026-08-21).
 *
 * A fixture asserted only at its capture width is not a regression test. `opencode-draft`
 * — a real frame with a live two-line draft — classified CLEAN at 43 of these 101 widths
 * before the region model was bounded positively: past ~100 cols the draft's own row wraps,
 * the continuation row fails `bodyPattern`, the upward scan accepted that as the top of the
 * box, and the region collapsed onto the bottom pad row, which is pure chrome. Zero user
 * cells, CLEAN, draft never scanned.
 *
 * Width mismatch is reachable in production: `PtySession.resize` always resizes the gate
 * mirror but can drop the app-side resize, and the alt buffer does not reflow — so the
 * mirror can sit indefinitely at a geometry the app never paints at.
 *
 * These sweeps are the guard. A `busy` fixture must classify busy at EVERY width; there is
 * no width at which a screen with a draft, a live turn, or a dialog may read as an empty
 * prompt.
 */
describe('render-gate — opencode fixtures across terminal widths (Issue #4)', () => {
  const FROM = 40;
  const TO = 140;

  for (const name of ['opencode-draft.busy.txt', 'opencode-midturn.busy.txt', 'opencode-dialog.busy.txt', 'opencode-boot.busy.txt']) {
    it(`${name} classifies busy at EVERY width ${FROM}–${TO}`, async () => {
      const raw = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
      const cleanAt: number[] = [];
      for (let cols = FROM; cols <= TO; cols++) {
        const v = await classifyScreen({ replay: raw, cols, rows: 32 }, OPENCODE_PROFILE);
        if (v.clean) cleanAt.push(cols);
      }
      expect(cleanAt).toEqual([]);
    });
  }

  it('opencode-idle.clean.txt is clean at its capture width, and never wrongly clean elsewhere', async () => {
    // The idle capture is a 110-wide frame. At its own width it must deliver; at narrower
    // widths its rows wrap, which IS a genuine geometry mismatch, and holding there is
    // correct rather than a limitation — in production the mirror matches the app's width.
    const raw = readFileSync(`${FIXTURE_DIR}/opencode-idle.clean.txt`, 'utf8');
    expect((await classifyScreen({ replay: raw, cols: 110, rows: 32 }, OPENCODE_PROFILE)).clean).toBe(true);
    for (let cols = FROM; cols < 110; cols++) {
      const v = await classifyScreen({ replay: raw, cols, rows: 32 }, OPENCODE_PROFILE);
      expect(v.clean, `cols=${cols} must not be clean when the frame wraps`).toBe(false);
    }
  });
});

describe('render-gate — whole-ring render at any size (Spec 1313 D2 + over-ceiling removal)', () => {
  it('renders a realistic large (~4MB) ring WHOLE within a CI-aware budget', async () => {
    // The D2 fix renders the whole coherent ring (no 1MB tail slice). Build ~4MB of
    // newline-free filler so it lands in the ring's unbounded `partial` (the claude
    // full-screen-TUI shape, #1047) rather than being truncated by the 1000-line cap;
    // a busy composer tail follows. The whole ring renders (no slice, no size cap) — the
    // real steady-state path (largest real capture ≈ 3MB).
    const filler = 'x'.repeat(4 * 1024 * 1024);
    const raw = filler + '\r\n' + screen('❯ occupied prompt tail', '──────');
    const snap = snapshotFromRaw(raw);
    expect(snap.replay.length).toBeGreaterThan(4 * 1024 * 1024);

    // Warm up (JIT + first-parse), then assert the MIN over several runs. The min
    // strips GC/scheduling outliers, approximating the classifier's steady-state
    // compute cost. (Spike: 67ms @4MB; this env under vitest ~90ms.)
    await classifyScreen(snap, CLAUDE_PROFILE); // warm-up (discarded)
    let best = Infinity;
    let verdict;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      verdict = await classifyScreen(snap, CLAUDE_PROFILE);
      best = Math.min(best, performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`[render-gate] whole-render @${Math.round(snap.replay.length / 1024)}KB best-of-5 = ${best.toFixed(1)}ms`);
    expect(verdict?.clean).toBe(false); // the tail is a busy prompt
    // CI-aware bound: locally a tight-but-safe bound (the real steady-state signal);
    // on shared/loaded GitHub runners only a catastrophic-regression ceiling (an order
    // of magnitude below an O(n²) blow-up at 4MB). Retuned from the old 1MB seed-cap
    // bound now that the whole ring renders. See review doc "Flaky Tests".
    const budgetMs = process.env.CI ? 800 : 250;
    expect(best).toBeLessThan(budgetMs);
  });

  it('renders a ring ABOVE the old over-ceiling WHOLE and classifies its empty composer CLEAN', async () => {
    // The removed `over-ceiling` hold used to reject any ring past a fixed 8M-unit size
    // UNRENDERED → a permanent delivery outage for the busiest agents (a live ~14M-unit
    // empty-composer terminal was stuck until relaunch). Now the whole ring renders at any
    // size: a >8M-unit #1047 basin (newline-free filler in the partial — the claude
    // alt-screen shape) that ENDS in a clean empty composer classifies CLEAN and delivers.
    // Deliberately past the old ceiling — this is exactly the regression the change fixes.
    const filler = 'x'.repeat(9 * 1024 * 1024);
    const raw = filler + '\r\n' + screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, '──────────────────────');
    const snap = snapshotFromRaw(raw);
    expect(snap.replay.length).toBeGreaterThan(8 * 1024 * 1024); // past the removed 8M ceiling
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(true);
    expect(v.detail).toBe('empty');
  });
});

describe('render-gate — real >1MB captures render WHOLE (Spec 1313 D2 root fix)', () => {
  // Real claude ring captures (gzipped; cols×rows as captured). The false-`busy` was
  // a capReplay slice artifact: the WHOLE render classifies CLEAN, but the old 1MB
  // tail slice tore the alt-screen frame → BUSY. Source: codev/spir-1313-captures.
  const load = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');
  const CAP_1MB = 1024 * 1024;

  for (const { file, cols, rows } of [
    { file: 'claude-bgtask-empty.replay.bin.gz', cols: 139, rows: 65 }, // field "monitor→busy" ring (region-spill)
    { file: 'claude-bigring-empty.replay.bin.gz', cols: 139, rows: 65 }, // field "empty held; ↑↓ delivers" ring (marker-loss)
  ]) {
    it(`${file}: WHOLE → CLEAN, but a 1MB tail slice → BUSY (proves the fix, not a big-ring rubber-stamp)`, async () => {
      const whole = load(file);
      expect(whole.length).toBeGreaterThan(CAP_1MB);
      // The fix: the real gate renders the whole ring → CLEAN. Regression guard — this
      // fails if any tail cap ≤ the ring size is reintroduced.
      expect((await classifyScreen({ replay: whole, cols, rows }, CLAUDE_PROFILE)).clean).toBe(true);
      // Honesty: the OLD 1MB-cap slice genuinely tears (marker/rule lost) → BUSY, so
      // the fixture exercises the artifact rather than just being a clean big ring.
      const oldCapSlice = whole.slice(whole.length - CAP_1MB);
      expect((await classifyScreen({ replay: oldCapSlice, cols, rows }, CLAUDE_PROFILE)).clean).toBe(false);
    });
  }

  it('claude-justover-cap (1.07MB): CLEAN whole AND under a 1MB slice (negative control — the fix does NOT blindly clean big rings)', async () => {
    const whole = load('claude-justover-cap.replay.bin.gz');
    expect(whole.length).toBeGreaterThan(CAP_1MB);
    expect((await classifyScreen({ replay: whole, cols: 139, rows: 65 }, CLAUDE_PROFILE)).clean).toBe(true);
    expect((await classifyScreen({ replay: whole.slice(whole.length - CAP_1MB), cols: 139, rows: 65 }, CLAUDE_PROFILE)).clean).toBe(true);
  });

  it('claude-smallring-idle (6KB, 139×63): CLEAN (small-ring idle baseline — no regression)', async () => {
    const whole = load('claude-smallring-idle.replay.bin.gz');
    expect((await classifyScreen({ replay: whole, cols: 139, rows: 63 }, CLAUDE_PROFILE)).clean).toBe(true);
  });
});

describe('render-gate — PRODUCTION data path: capped ring TEARS, persistent mirror does NOT (Spec 1313 round 2)', () => {
  // The merge-blocker this round fixes. The whole-capture tests above feed classifyScreen the raw
  // capture DIRECTLY, which masks #1205: in production the gate saw the capture only AFTER it went
  // through a RingBuffer whose 2 MiB partial cap TORE the newline-free alt-screen frame. This suite
  // drives the real production data path — the same chunked dual-feed PtySession.onPtyData does
  // (ring + mirror together) — and asserts the split: the capped ring reconstruction classifies
  // BUSY (the resurrected outage), while the persistent bounded mirror classifies CLEAN (the fix).
  // Architect field repro of the tear: bgtask 2,794,991→1,680,872 chars via the ring; bigring
  // 2,991,283→1,877,164. Both empty-composer idle screens, so the TRUTH is CLEAN.
  const loadGz = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');
  const CHUNK = 64 * 1024; // PTY output arrives in chunks; 64 KiB matches the architect's repro feed

  for (const { file, cols, rows } of [
    { file: 'claude-bgtask-empty.replay.bin.gz', cols: 139, rows: 65 },
    { file: 'claude-bigring-empty.replay.bin.gz', cols: 139, rows: 65 },
  ]) {
    it(`${file}: real default RingBuffer → BUSY (torn), persistent mirror → CLEAN (proves the round-2 fix)`, async () => {
      const capture = loadGz(file);
      expect(capture.length).toBeGreaterThan(2 * 1024 * 1024); // crosses the #1205 partial cap

      // Feed the capture through BOTH objects exactly as PtySession.onPtyData does: chunked, with
      // the ring and the mirror fed the SAME bytes in lockstep. This is the real production path,
      // not the direct classifyScreen feed the whole-capture tests use.
      const ring = new RingBuffer(1000); // DEFAULT 2 MiB partial cap — the production config
      const screen = new SessionScreen(cols, rows);
      for (let i = 0; i < capture.length; i += CHUNK) {
        const chunk = capture.slice(i, i + CHUNK);
        ring.pushData(chunk);
        screen.feed(chunk);
      }

      // The capped ring genuinely tears (partial trimmed below the whole frame) → the OLD whole-ring
      // gate goes BUSY. This is the regression guard: it fails if #1205's cap is ever reverted OR if
      // the fixture stops crossing the cap.
      expect(ring.getAll().join('\n').length).toBeLessThan(capture.length); // front dropped by the trim
      const ringVerdict = await classifyScreen({ replay: ring.getAll().join('\n'), cols, rows }, CLAUDE_PROFILE);
      expect(ringVerdict.clean).toBe(false);

      // The persistent mirror folded the same bytes into a BOUNDED screen whose viewport is the real
      // current screen → CLEAN. This is the fix: the delivery outage is gone for the busiest agents.
      const { term } = await screen.read();
      expect(classifyBuffer(term, cols, rows, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
      screen.dispose();
    });
  }
});

describe('render-gate — claude suggested-command ghost (Spec 1313 render-gate hardening)', () => {
  // Live-found 2026-08-06 (PR #1330 architect integration test). An IDLE claude composer
  // paints a *suggested-command ghost* when the agent's own last reply mentioned a runnable
  // command. The ghost's first character doubles as the software block cursor: rendered SGR-7
  // INVERSE at normal intensity while the rest of the ghost is SGR-2 dim
  // (`❯ ␛[7ma␛[27m␛[2mfx cleanup…␛[22m`). The universal dim rule skipped the ghost body but
  // COUNTED the lone inverse cursor cell → `user-text`/`busy` FOREVER while the composer was
  // genuinely empty, so mail to an idle (unattended) agent was never delivered. classifyScreen
  // now exempts exactly that cell (inverse + non-dim + at the cursor + dim/empty tail).
  const loadGz = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');

  it('the real captured ghost ring (claude 2.1.220, 139×63) → CLEAN (pre-fix was busy/user-text with 1 counted cell)', async () => {
    // Captured live from a stuck main-architect terminal whose mail held on `busy` while the
    // composer was visibly empty (held mailbox row a21b6c64). The only would-be-counted cell is
    // the inverse block cursor over the ghost's first char; every other ghost cell is dim. The
    // whole ring renders (0.09 MB — nowhere near any size concern); the fix is the cursor-cell
    // exemption, not a slice change.
    const whole = loadGz('claude-ghost-suggestion-empty.replay.bin.gz');
    const v = await classifyScreen({ replay: whole, cols: 139, rows: 63 }, CLAUDE_PROFILE);
    expect(v).toMatchObject({ clean: true, detail: 'empty' });
  });

  // The exemption keys off the headless cursor cell, so these synthetic cases must leave the
  // cursor ON the composer marker row — `screen()` alone parks it on the line below. A trailing
  // CUP (`ESC[row;colH`, 1-based) parks it precisely; it rides through the RingBuffer as the
  // partial, exactly as the production `getAll().join('\n')` path would carry it.
  const withCursor = (row: number, col: number, ...lines: string[]) =>
    snapshotFromRaw(screen(...lines) + `\x1b[${row};${col}H`);

  it('the ghost signature (inverse non-dim cursor char + dim tail) → clean', async () => {
    const snap = withCursor(1, 3, `❯ ${INV}a${INV_OFF}${DIM}fx cleanup -p task-VdfD${RESET}`, '──────────');
    expect(await classifyScreen(snap, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });

  it('an inverse cursor char with REAL (non-dim) text following → busy (no new corruption vector; NOT a blanket inverse skip)', async () => {
    // The cursor sits (inverse) on the first char of a real multi-char draft. The dim-tail test
    // fails — the following text is normal-intensity — so the cell is NOT exempted and every
    // draft cell counts. This is the guard the finding demands: the exemption cannot false-clean
    // a real draft, and an inverse selection over real text keeps every other cell counted.
    const snap = withCursor(1, 3, `❯ ${INV}d${INV_OFF}eploy the hotfix`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('an inverse non-dim cursor char with an EMPTY tail → busy (a lone inverse cell is not a ghost)', async () => {
    // Codex CMAP (2026-08-06): the exemption must require POSITIVE ghost evidence — at least one
    // dim suggestion-body cell after the cursor. A 1-char draft with the cursor parked on its
    // only char renders as a lone inverse cell with an empty tail; without the positive-evidence
    // rule it would false-clean (the documented "residual" was actually a spec violation —
    // no-new-corruption-vector / fail-toward-hold). An empty tail now stays busy. Genuine ghosts
    // always carry a multi-char dim command body (the real fixture's tail is 23 dim cells).
    const snap = withCursor(1, 3, `❯ ${INV}x${INV_OFF}`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('a real draft with the inverse block cursor on trailing whitespace → busy (claude never inverse-renders typed text)', async () => {
    // Models claude's ACTUAL real-draft rendering (measured live, task-vdfd draft "dfsd"): typed
    // characters are non-inverse and the inverse block cursor rests on the empty cell past them.
    // The whitespace cursor cell is skipped as whitespace (the exemption never even evaluates);
    // the typed cells count → busy. The sole accepted residual is a 1-char draft with the cursor
    // relocated onto its only char — documented in the review's Technical Debt.
    const snap = withCursor(1, 14, `❯ deploy prod${INV} ${INV_OFF}`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('cross-app: a codex-style ghost of the same signature → clean (the exemption is profile-agnostic)', async () => {
    // Measured live (task-shxz), codex renders its OWN suggestion ghost ("Write tests for
    // @filename") WHOLLY dim — already clean via the dim rule, never hit by this bug. But the
    // exemption is generic, so were codex to adopt claude's inverse-cursor rendering it is handled
    // identically. Pins that generality without committing a live builder capture.
    const snap = withCursor(1, 3, `${BOLD}›${RESET} ${INV}W${INV_OFF}${DIM}rite tests for @filename${RESET}`, '  gpt-5.6-sol   high: on   ~/repo');
    expect(await classifyScreen(snap, CODEX_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });
});

describe('resolveProfile — strict, fail-safe app identity (Spec 1313)', () => {
  it('a claude launch resolves to the claude profile', () => {
    expect(resolveProfile({ command: 'claude', args: ['--dangerously-skip-permissions'] })?.app).toBe('claude');
  });

  it('a full-path codex launch resolves to the codex profile', () => {
    expect(resolveProfile({ command: '/home/u/.nvm/bin/codex', args: ['-c', 'foo=bar'] })?.app).toBe('codex');
  });

  it('agy resolves to the agy profile — NOT claude (Phase 3 measured; constraint 10: no claude fallback)', () => {
    expect(resolveProfile({ command: 'agy' })?.app).toBe('agy');
    expect(resolveProfile({ command: '/usr/local/bin/antigravity', label: 'main' })?.app).toBe('agy');
  });

  it('a wrapped builder launch (bash .builder-start.sh) resolves to null (fail-safe, deferred to Phase 4)', () => {
    expect(resolveProfile({ command: 'bash', args: ['.builder-start.sh'], label: 'spir-1313' })).toBeNull();
  });

  it('opencode resolves to the opencode profile (Issue #4 — measured against 1.18.18)', () => {
    expect(resolveProfile({ command: 'opencode' })?.app).toBe('opencode');
    expect(resolveProfile({ command: '/opt/homebrew/bin/opencode', label: 'pir-4' })?.app).toBe('opencode');
  });

  it('an unmeasured harness (gemini) still resolves to null (no profile)', () => {
    expect(resolveProfile({ command: 'gemini' })).toBeNull();
  });

  it('hasGateProfile mirrors resolveProfile exactly — the spawn pre-flight and the gate agree', () => {
    for (const cmd of ['claude', 'codex', 'opencode', 'agy', '/opt/homebrew/bin/opencode']) {
      expect(hasGateProfile(cmd)).toBe(true);
    }
    for (const cmd of ['gemini', 'my-custom-agent', 'bash', '']) {
      expect(hasGateProfile(cmd)).toBe(false);
    }
  });
});
