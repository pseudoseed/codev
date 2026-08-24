# Experiment 63: v2 dark palette

**Status**: Complete · **Date**: 2026-08-23

Issue #63. The spawn prompt named a different spec. That work is a separate PR. This directory is only the dark palette.

## Goal

**Question.** Can a dark palette for the v2 mockups keep the workspace reading (a room that holds screens) instead of collapsing into an IDE, while rust stays the loudest colour and every used pairing meets WCAG 2.2 AA?

**Hypothesis, locked before any hex was chosen.**

1. A mechanical invert of bone / chalk / ink fails the "what is the dark thing" test. Inverted bone and inverted ink land at similar lightness, so terminals no longer recede. That invert will be measured and will fail.
2. The designed relationship is a night workshop, not an inverted page. The room stays warm paper, now unlit. Terminals and the gate rail drop into a new `--well` that is darker and cooler than the page. They recede. `--ink` becomes the mark (bone-dust) and can no longer also be the well. Light mode got away with one token doing both jobs. Dark mode cannot.
3. Light 1.5px ink borders on bone are pencil lines. The same weight as a near-white stroke on a dark ground is IDE chrome. The replacement is a dusty mark, not a thicker rule. `--rule` stays 1.5px. `--ink` as a border is `#C9BFAE` range, never `#FFFFFF`.
4. `--rust #B5502A` will fail AA as 11px stamp text on the new ground. Rust must be recast, not inverted. It has to stay the highest-chroma signal on the page. Moss will also fail if left at `#5C6B4F` and must lighten without turning mint.
5. `.dim-sub` as `opacity: 0.42` on a dark ground reads as "closer to the page", not "less alive". The replacement is full opacity, grayscale, no value drop. Dead things keep their contrast and lose their chroma.

**Success.** Scored against this list:

- `tokens-dark.css` sits beside `tokens.css`. `01-site-dark.html` and `02-gate-dark.html` exist.
- A contrast artifact lists every pairing those two files actually use, with a ratio, the WCAG 2.2 AA threshold that applies, and pass/fail. No pairing used for text or UI is asserted.
- `--well` is darker than `--bone`. The invert-control well is not.
- Rust has higher chroma than ochre and moss on the dark page.
- Pattern classes still exist: stamp, grid-bg, plot, corner, stake, dim-sub, spark, needs-attn, ticket-edge, hatch.
- No new fonts.

**Failure of the hypothesis.**

- Rust cannot pass 4.5:1 on bone and remain louder than ochre.
- The only way to separate well from bone is a cool grey page (IDE).
- dim-sub still disappears into the ground once measured.
- A fifth signal colour is required.

## Approach

Write a contrast harness first. Freeze a candidate palette only after the harness scores it. Then paint the two HTML files from that freeze. The invert of the light palette is scored in the same harness as a control.

`--well` is the only new token. It is not a fifth signal. It is the job `--ink` can no longer do.

## Environment and reproduction

```
node codev/experiments/63-v2-dark-palette/src/contrast.mjs
```

Open the dark mockups:

```
open codev/research/v2-mockups/01-site-dark.html
open codev/research/v2-mockups/02-gate-dark.html
```

## Code

| File | What it is |
|---|---|
| `src/contrast.mjs` | WCAG 2.2 contrast harness. Designed palette plus invert control. |
| `artifacts/contrast.md` | Scored pairings. |
| `artifacts/contrast.json` | Same, machine readable. |
| `../../research/v2-mockups/tokens-dark.css` | The palette. |
| `../../research/v2-mockups/01-site-dark.html` | Site mockup on the new tokens. |
| `../../research/v2-mockups/02-gate-dark.html` | Gate mockup on the new tokens. |

## Results

The hypothesis holds. A night-workshop palette can keep terminals as the dark thing without inverting the page. The invert control fails the way the issue said it would.

Scored run: `artifacts/contrast.md`, timestamp `2026-08-23T21:29:19.286Z`. Zero designed pairings failed. The invert control failed 9.

| Token | Hex |
|---|---|
| bone | `#2A251E` |
| chalk | `#353027` |
| concrete | `#8A8070` |
| ink | `#EDE4D4` |
| graphite | `#C4B8A4` |
| well | `#0A0908` |
| rust | `#ED7C48` |
| rustdark | `#D26432` |
| ochre | `#D9A84C` |
| moss | `#9AAA86` |

**Hypothesis 1, confirmed.** Mechanical invert makes `--well` the invert of light ink, which is light. Invert well is not darker than invert bone. Ink on that well is 1:1. Terminals flatten. Rust is also no longer the loudest (ochre chroma 104.4 > rust 101.6).

**Hypothesis 2, confirmed.** `--well #0A0908` is darker than `--bone #2A251E` (fill contrast 1.31:1). Two near-black fills cannot hit 3:1. Distinctness is the hole plus the edge: ink border on bone 12.05:1, rust border on bone 5.48:1. The page stays warm. Not cool grey.

**Hypothesis 3, confirmed with a lighter dust than guessed.** `--rule` is still 1.5px. `--ink` landed at `#EDE4D4`, not the `#C9BFAE` range I guessed. Still not `#FFFFFF`. Borders are bone-dust on dusk paper.

**Hypothesis 4, confirmed.** Light rust `#B5502A` would fail as 11px text on this ground. Recast rust `#ED7C48` is 5.48:1 on bone, 4.73:1 on chalk, 7.18:1 on well. Chroma 119.3 > ochre 101.2 > moss 25.5. Moss had to move to `#9AAA86` (sage, not mint) to pass.

**Hypothesis 5, designed, not measured in a browser.** `.dim-sub` is `opacity: 1; filter: grayscale(1)`. Offline type uses full graphite (6.7:1 on chalk), not a 70% fade. I did not screenshot the dim lot.

Light text on rust fails (ink on rust 2.2:1). Badge glyphs and Approve drop use `--well` on rust (7.18:1).

`--well` is the only new token. Four signals still. No new fonts.

I did not open the HTML in a browser this run. Contrast is measured. Whether the page still reads as a workshop is a look, not a ratio.

### Pairings (designed)

| Pairing | Ratio | Need | |
|---|---:|---:|---|
| ink on bone | 12.05:1 | 4.5:1 | pass |
| ink on chalk | 10.38:1 | 4.5:1 | pass |
| graphite on bone | 7.77:1 | 4.5:1 | pass |
| graphite on chalk | 6.70:1 | 4.5:1 | pass |
| ink on well | 15.77:1 | 4.5:1 | pass |
| ink/85 on well | 11.38:1 | 4.5:1 | pass |
| ink/70 on well | 7.87:1 | 4.5:1 | pass |
| ink/65 on well | 6.88:1 | 4.5:1 | pass |
| rust on bone | 5.48:1 | 4.5:1 | pass |
| rust on chalk (GATE stamp) | 4.73:1 | 4.5:1 | pass |
| rust on chalk large (24:07) | 4.73:1 | 3:1 | pass |
| rust on well | 7.18:1 | 4.5:1 | pass |
| ochre on chalk | 6.02:1 | 4.5:1 | pass |
| ochre on well | 9.15:1 | 4.5:1 | pass |
| moss on bone | 6.13:1 | 4.5:1 | pass |
| moss on chalk (graphic) | 5.28:1 | 3:1 | pass |
| well on rust | 7.18:1 | 4.5:1 | pass |
| ink border on bone | 12.05:1 | 3:1 | pass |
| ink border on chalk | 10.38:1 | 3:1 | pass |
| concrete on bone | 3.91:1 | 3:1 | pass |
| rust border on chalk | 4.73:1 | 3:1 | pass |
| ochre border on chalk | 6.02:1 | 3:1 | pass |
| ink border of well on bone | 12.05:1 | 3:1 | pass |
| rust border of well on bone | 5.48:1 | 3:1 | pass |

## What worked / what didn't

Splitting `--ink` from `--well` is the whole design. Keep that split in production. Do not alias them again.

The room had to stay a dusk paper (`#2A251E`), not OLED black. A darker bone makes the hole vanish because both L values sit in the toe.

Rust as a fill wants dark type. Light type on rust is 2.2:1. I found that after painting Approve drop and scoring it.

First candidate bone `#1B1813` made rust-on-chalk fail and well-vs-bone 1.11:1. Lifted the room, not the well.

I have not looked at these pages on a phone, or next to the light mockups in one window.

## Next steps

Human look at the two HTML files next to `01-site.html` and `02-gate.html`. The question that ratios cannot answer: does it still feel like a workshop.

Theme switching (`prefers-color-scheme`, a toggle) is out of scope. The client-shell spec owns that.

If the look is accepted, `apps/v2` takes `tokens-dark.css` as the dark `:root`. Keep `--well`. Do not invert `tokens.css` in a media query.

PR #68 merged. experiment-complete approved 2026-08-23.

```
open codev/research/v2-mockups/01-site-dark.html
open codev/research/v2-mockups/02-gate-dark.html
```

