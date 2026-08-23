# Experiment 62: Can a finger drag a dockview split on a real iPad

**Status**: Complete (arm A device-scored; arm B built and DOM-scored) · **Date**: 2026-08-23

Spawn prompt named `codev/specs/0062-secure-remote-access.md` (already shipped, then `--remote` was removed in spec 99). Issue #62 and porch project `62-spike-v2-ui-can-a-finger-drag-` are the work. Same template-fill collision as experiments 38 and 39.

## Goal

**Question.** Can a person drag a split in dockview, on a real iPad, with a finger?

Not "does dockview load on a tablet." Not "does it work with a trackpad or a mouse." Touch.

The FRD (`codev/research/codev-v2-ui-frd.md` rev. 6) promoted FR-7's tablet clause from SHOULD to MUST on 2026-08-23. This spike is now a gate. If touch cannot drag a split, FR-7 is renegotiated. It is not quietly downgraded.

**Hypothesis, locked before any prototype.**

1. Dockview **8.2.0** (latest on npm at lock time, registry `2026-08-23`) ships a pointer-events drag backend. Docs say `dndStrategy: 'auto'` uses HTML5 for mouse and pointer events for touch and pen, with a ~250 ms long-press-then-drag. That backend is in the installed package, not only in marketing copy.
2. Sash resize by finger works. GitHub issue #268 (touch resize) closed 2023-06-21. The reporter of still-open #696 said resize already worked on tablet in 2024.
3. Cross-group panel drag and edge-split by finger work via the documented long-press gesture. Issues #696 (touch drag, open since 2024-08-26) and #930 (mobile support, open since 2025-05-18) are stale relative to 8.2.0.
4. Stock sash and tab-close targets fail FR-22. FR-22 wants ≥ 44 pt with ≥ 8 pt separation. Default IDE chrome is smaller than that. This is independent of whether drag works.
5. A hardware keyboard attached does not change any finger-drag score. The keyboard is for typing. It is not a substitute for the finger.

**Success.** All of these, scored against this list, not against whatever the run produces:

- Each issue gesture is marked first-try, retries (count), or impossible, with a written blow-by-blow of what happened. Not "it worked."
- Gestures, finger first, then the same list with a hardware keyboard attached:
  1. Split a pane horizontally by dragging a tab to an edge.
  2. Split a pane vertically by dragging a tab to an edge.
  3. Drag a pane from one group into another.
  4. Resize a split by dragging the sash (horizontal and vertical, scored separately).
- FR-22 is measured on the live page: sash hit box, tab close button, gap between adjacent close buttons. Pass or fail against 44 pt / 8 pt. Source of the numbers is a DOM measurement, not an eyeball.
- Experiment code lives under `codev/experiments/62-finger-drag-dockview/`. `git diff --stat -- apps/web` is empty.
- Playwright WebKit is not cited as evidence for any gesture.
- One of the three issue outcomes is named:
  1. It works. FR-7 tablet stays MUST. Dockview is adopted. Tiling gets specified for tablet.
  2. It half-works. The failing gestures are named. The decision is whether a reduced tablet tiling model still satisfies MUST.
  3. It does not work. FR-7 is renegotiated. Options are listed. One is not picked alone.

**Failure of the hypothesis.**

- The pointer backend is not in 8.2.0. The docs describe a feature the package does not ship.
- Sash resize fails on a real iPad. H2 is wrong.
- Every H3 gesture fails. Outcome 3. FR-7 is renegotiated.
- Stock CSS already meets FR-22. H4 is wrong. That is not a product failure.

**Not a failure.** The iPad is not in this builder's hands. Reaching the device step means stopping and asking, the same as #39. Desktop mouse and Playwright do not stand in.

## Approach

A throwaway Vite + React page loads dockview 8.2.0 with `dndStrategy: 'auto'` (the default we would ship). Four named panes start already tiled, so a sash and a cross-group drop exist before anyone drags.

The page binds on the LAN. The human opens it in iPad Safari and scores each gesture on the page itself.

**Why this version.** 8.2.0 is current on npm. The FRD's "touch and mobile ready" warning is from a Jan 2025 HN thread against an older release. Scoring an old build would answer the wrong question.

**Why not Playwright.** The issue forbids it. WebKit in Playwright misses touch, momentum, and safe-area, which is the subject.

**Why not `apps/web`.** Additive only. A throwaway page. No production path.

**Why not a different library yet.** Outcome 3 is when we bring alternatives. Running two libraries before the iPad speaks is argument, not evidence.

**Alternatives if outcome 3** (listed now so they are not invented after a fail):

| Option | What it is | What it costs FR-7 |
|---|---|---|
| Different tiling library | Something with a proven iPad drag story | Same MUST, new spike |
| Split menu | Button or long-press picks split direction. No sash drag | Tiling without drag. MUST is met only if "tiles" is allowed to mean this |
| Long-press target picker | Long-press a pane, tap where it should go | Same as above, for move rather than split |
| Keyboard-only tiling on iPad | Hardware keyboard required to tile | Fails the usual-has-keyboard-but-still-touch case the issue named |

**Measurements.**

| Gate | Pass |
|---|---|
| Pointer backend in 8.2.0 | Installed `dockview-core` contains the pointer strategy and the ~250 ms long-press. File and symbol named. |
| FR-22 sash | Live hit box ≥ 44 pt on the axis of travel. |
| FR-22 tab close | Live box ≥ 44×44 pt, ≥ 8 pt from the next close. |
| Gesture N, finger | Human score + one-line what happened. |
| Gesture N, keyboard attached | Same list, scored separately. |

Builder can do the package probe and the CSS/DOM sizes alone. Gestures need the device. Stop there.

## Environment and reproduction

Locked before the page was written:

- `dockview-react@8.2.0` from npm (v8 split React bindings out of `dockview`; also pulls `dockview` and `dockview-core@8.2.0`)
- React 18, Vite 6
- Port **4112** (4110 is already held by experiment 39)
- LAN `10.10.50.186` (verified `ifconfig` 2026-08-23). Do not restart Tower.

```bash
cd codev/experiments/62-finger-drag-dockview
npm install
npm run dev
```

iPad Safari: `http://10.10.50.186:4112/`

Untouched check:

```bash
git diff --stat -- apps/web
```

## Code

| File | What it is |
|---|---|
| `src/main.jsx` | Vite entry. |
| `src/App.jsx` | Dockview 8.2.0 page, 2×2 start layout, on-page score sheet. |
| `src/measure.js` | DOM probe for sash and tab-close sizes. |
| `b.html` `src/b.css` `src/b.js` | Arm B. No library. Grid split, sibling close, native scroll. |
| `scripts/probe-package.mjs` | Grep the installed package for the pointer backend. |
| `artifacts/` | Probe output and (later) device scores. |

## Results

Criteria were not rewritten. Gestures are still being scored on the device.

### FAILURE: FR-22 separation, tab vs close

Recorded as a failure, not a note. First scored device result. 2026-08-23, real iPad, first contact.

He tried to tap a tab and closed it. The X sits inside the tab's hit area.

**Gap between the tab's hit region and the X's hit region: 0 pt.**

The close button is a child of `.dv-tab`. The two targets are nested, not adjacent. There is no dead zone to miss. Source: `artifacts/tab-x-gap.json` (live DOM, four tabs, every one `closeInsideTab: true`, `gapTabHitToCloseHitPt: 0`). Same number next to the sash: sash **4 px / 24 px coarse**, tab-X gap **0 pt**.

The locked FR-22 row asked for the gap between adjacent close buttons. That was the wrong pair. The pair that failed on a finger is tab (select / drag) vs close.

This is not cosmetic.

- Close is destructive. In v2 it tears down a pane and the terminal. FR-8 keeps a hidden pane's process. A closed pane is gone, and so is the builder session.
- It is next to the most common action on the surface: hitting the tab.
- It happened on the first real finger, not after hunting.

FR-22 now fails on both clauses, independently:

| Clause | Stock dockview 8.2.0 | Source |
|---|---|---|
| Size | Sash 4 px, 24 px with coarse inflate. Tab bar 35 px. Close 27×27 on the measured page. Floor is 44 pt. | `artifacts/css-sizes.md`, `artifacts/tab-x-gap.json` |
| Separation | 0 pt between tab hit and X hit | `artifacts/tab-x-gap.json` |

His words otherwise: "things are working quite well so far." Gestures on touch are largely working. Touch targets are not. Those are different findings. The second one decides adoption. A gesture can be learned. A destructive mis-tap cannot.

Stock chrome was not restyled. The question is what dockview does as shipped.

### CSS override estimate (not applied)

Sash size is a few rules: `.dv-sash` width/height and the coarse `::before` inflate. The layout reads the element, so CSS can make the hit box 44 pt without a fork. That is the whole sash surface, every split.

Tab vs X cannot be fixed with padding. The X is inside the tab. Bigger padding still leaves it inside. `pointer-events: none` on the tab would kill drag.

The documented fix is a custom `defaultTabComponent`: title is the drag handle, an 8 pt dead zone, close is its own 44×44 control. Plus `--dv-tabs-and-actions-container-height` raised from 35. A 35 px bar cannot hold 44 + 8 + 44.

That is the default chrome of every pane, not an edge widget. One React tab component and one height variable. Not a one-line theme tweak. Not a reason to restyle this spike.

| Gate | Result | Evidence |
|---|---|---|
| Pointer backend in 8.2.0 (H1) | **Pass** | `dockview-core@8.2.0` ships `dnd/pointer/pointerDragSource.d.ts` (`touchInitiationDelay` default 250ms) and `dnd/backend.d.ts` (`pointerBackend`). Probe: `artifacts/package-probe.json`. |
| FR-22 sash size (H4) | **Fail** | 4 px / 24 px coarse. Floor 44 pt. `artifacts/css-sizes.md`. |
| FR-22 tab-X separation (H4) | **Fail** | **0 pt.** First iPad contact closed a tab instead of selecting it. `artifacts/tab-x-gap.json`. |
| Gesture 1–5, finger | **Pass** | Human, device finished: "Gestures: working quite well. Split, drag, resize all usable by finger." "Everything else worked." One failure only, the nested X, recorded above. |
| Text selection and copy inside a pane | **Pass** | Human: "Text selection and copy INSIDE a pane: WORKS." This was the biggest risk on the widened list. |
| Gesture 1–5, keyboard attached | **Not separately scored** | He did not call this out. Not treated as a fail. |
| VoiceOver, Dynamic Type, both orientations, momentum scroll | **Not separately scored** | Covered only by "everything else worked." Not named. |
| Arm B FR-22 size + separation | **Pass** | Live DOM, Chromium 1024×768. Tab 88.3×44, close 66.9×44, gap 8 pt, `closeInsideTab: false`. `artifacts/arm-b-targets.json`. |
| Arm B selection (Chromium) | **Pass** | `user-select: text`. Range select of the `<pre>` contained `DOM`. Close hides the pane, node stays, restore keeps the text. `artifacts/arm-b-behavior.json`. |
| Arm B split | **Menu only** | Side-by-side / stack buttons. No drag-to-rearrange. By design. |
| Arm B VoiceOver, Dynamic Type at large sizes, both orientations, finger scroll | **Not run** | Needs the iPad. CSS uses `font-size: 100%` and rem, and `env(safe-area-inset-*)`. Computed insets are 0 on this desktop. |
| `apps/web` untouched | **Pass** | `git diff --stat -- apps/web` empty. |

**v8 package split, verified.** `dockview@8.2.0` is a thin re-export of `dockview-core` and has no `DockviewReact`. React bindings are `dockview-react@8.2.0`. The page uses that. The FRD's "React bindings" line is stale against v8 names. The pointer backend lives in core either way.

**Open upstream issues are not a verdict.** #696 (touch drag, 2024) and #930 (mobile, 2025) are still open. The 8.2.0 types describe the feature those issues asked for. The iPad decided.

## Verdict

**Arm A, dockview 8.2.0, real iPad.** Gestures and selection pass. Touch targets fail FR-22 on both clauses: size (sash 4 px, 24 px coarse) and separation (X nested inside the tab, 0 pt).

Do not read the target failure as "dockview failed." Selection and copy work. That was the biggest risk we were carrying.

Do not soften the target failure because the gestures passed. A learned gesture is not a destructive mis-tap.

**Arm B is built.** URL: `http://10.10.50.186:4112/b.html`. No UI library. CSS grid, native scroll, DOM text, sibling close.

FR-22 passes on the live DOM. Selection works in Chromium. Close detaches. Finger, VoiceOver, Dynamic Type, and both orientations are not scored. That is not a pass.

The bake-off row "both fail → the web layer cannot meet the bar" is still unevidenced. B has not been on the iPad.

## Costs, not a winner

No pick.

| | Dockview (A), iPad | Native primitives (B), DOM + Chromium |
|---|---|---|
| Gestures (split, drag, resize) | Pass on device | No drag-to-rearrange. Side/stack buttons only. That is the price of B, not a miss. |
| Selection and copy in a pane | Pass on device | Pass in Chromium on a `<pre>`. Not scored on the iPad. |
| FR-22 size | Fail. 4 px / 24 px sash. Custom CSS on every sash, or accept it. | Pass. Every control ≥ 44×44. `artifacts/arm-b-targets.json`. |
| FR-22 separation | Fail. 0 pt. Needs a custom `defaultTabComponent` and a tab bar taller than 35. Nested X cannot be padded apart. | Pass. Tab and close are siblings. Gap 8 pt. |
| What you give up | Stock close is a mis-tap. Session teardown is #66, not this library. | Drag-to-rearrange, edge-split, sash resize, dockview serialization. |

#66 takes the destructive-close question off this spike. Close must detach a viewer, never destroy a session. Library-independent. This spike surfaced it. It is not this spike's to solve.

## What worked / what didn't

Worked: finger split, drag, resize. Selection and copy inside a pane. Pointer backend in 8.2.0.

Did not work: FR-22, both clauses. First contact closed a tab.

Arm B page exists. FR-22 and Chromium selection pass. Finger and VoiceOver on B are not scored.

## Next steps

Architect picks on the cost table.

Arm B on a real iPad is still the missing device run if the "both fail → leave the web" row must be filled.

Production path for A, if chosen: custom tab plus taller bar. Do not restyle this spike to pretend stock dockview passes.

`apps/web` stays untouched.
