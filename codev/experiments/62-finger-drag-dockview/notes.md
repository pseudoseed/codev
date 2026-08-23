# Experiment 62: Can a finger drag a dockview split on a real iPad

**Status**: Complete · **Date**: 2026-08-23 · **Decision**: dockview + group-level close

61 lines across 3 files is the override cost that made dockview defensible.

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

These arms were not scored the same way. That is a limitation. It is not a footnote.

**Arm A was scored on a real iPad by the human.** Arm B has been scored in Chromium and in the live DOM only. Those are not comparable evidence. Testing A on a device and B in a desktop browser repeats, in reverse, the error this spike exists to prevent.

His observation, attributed: he tested arm A and reported gestures and selection working, with the tab-close mis-tap as the only failure. That is the strongest single data point in this spike.

What can be stated without a device:

- Arm B passes FR-22 in the live DOM: tab 88×44, close 67×44, gap 8 pt, `closeInsideTab` false. Arm A fails both clauses: sash 4 px / 24 px coarse, close nested at 0 pt.
- Arm B satisfies FR-49 by construction: close detaches, restore keeps the DOM text. Arm A's close is destructive and its own control is nested inside the most common target.
- Arm A needs a custom `defaultTabComponent` plus a raised tab bar to reach FR-22. The number is below.
- Arm B's cost is what it cannot do. Enumerated below. Not "does less."

**Unscored for arm B:** VoiceOver traversal. Dynamic Type at large sizes. Both orientations. Real-finger scroll and momentum. Safe areas on device.

No winner.

## Costs, not a winner

**Arm A, dockview 8.2.0**

- To reach FR-22 without a fork: 2 new files we own, 0 dockview files edited. A title-only `defaultTabComponent` (the published `DockviewDefaultTab` is ~45 lines and renders the close *inside* the tab). Plus a `rightHeaderActionsComponent` close, because `Tab` mounts that renderer inside `.dv-tab`, which is the drag source. A custom tab that still contains close still has gap 0. `hideClose` plus a group-level close is the documented way out. One CSS variable, `--dv-tabs-and-actions-container-height`, today 35 px. Sash size is ~5 rules in our stylesheet (4 px box + coarse `::before`).
- Per-tab close with an 8 pt gap requires changing `Tab` itself (`tab.d.ts` is 46 lines; the body lives in dockview-core). That is a fork. Not counted as "a theme tweak."
- Session teardown on close is #66. Not this library.

**Arm B, native primitives**

Lost, exactly:

- Drag a tab to an edge to split.
- Drag a pane from one group into another.
- Drag the sash to resize.
- Floating groups.
- Popout windows.
- Layout serialization (`api.toJSON` / `fromJSON`).
- Tab overflow, pinned tabs, tab groups.

What it has: a fixed two-pane grid. Buttons flip side-by-side vs stack. Close detaches. Targets are 44 pt with 8 pt gaps and are not nested.

#66 takes destructive close off this spike. Close must detach a viewer. Library-independent.

## What worked / what didn't

His words on arm A: gestures and selection working, tab-close mis-tap the only failure.

Arm B: FR-22 and detach measured in Chromium. Finger and VoiceOver on B are unscored.

## Decision (architect, 2026-08-23)

**Dockview, with hideClose and a group-level close.** Recorded. Not re-tested as a product choice.

Arm B's gaps are most of a tiling engine: no edge-split drag, no cross-group drag, no sash resize, no float, no popout, no `toJSON` layout. Sash resize is FR-7. Layout persistence is FR-9. Both MUST. Closing those gaps means writing a tiling library. That is the opposite of known, proven tooling.

Arm A fails one MUST, FR-22. The override is bounded. We take the group-level close rather than a `Tab` fork. Removing the per-tab X deletes the mis-tap hazard. That is the FR-49 case the human hit on first contact.

### Override, built and measured

Page: `http://10.10.50.186:4112/a-fr22.html`. Source: `artifacts/a-fr22-override.json` at `2026-08-23T22:13:21.528Z`.

| File | Lines | Role |
|---|---|---|
| `src/Fr22Tab.jsx` | 5 | Title only. No close. |
| `src/Fr22Close.jsx` | 13 | `rightHeaderActionsComponent`. Group-level close. |
| `src/a-fr22.css` | 43 | Tab bar height 44. Sash `::before` ±20 px. |

`defaultTabComponent` alone does not get there. It still mounts inside `.dv-tab`. Close inside that tab is still gap 0.

Sash does not need a fork. Layout hardcodes `sashWidth = 4` in dockview-core. Changing the element width would fight that. Inflating `::before` by 20 px each side makes hit travel 44. Measured: sash box still 4 px, `beforeLeft/Right` `-20px`, `hitTravel` 44.

**Known divergence.** `sashWidth` stays 4 in dockview's JS. The hit region is 44 in CSS. The `::before` inflation changes what a finger can touch, not what the library believes. Anything dockview computes from `sashWidth` (drag thresholds, snap distances, minimum pane sizes, internal hit-testing) still uses 4. Symptom to watch: a drag that feels like it starts late, or a pane that refuses to shrink past a boundary that looks wrong.

Live DOM after override:

- Tab 106×44. Close 67×44. `closeInsideTab` false. Gap 266–340 pt.
- Tab bar height 44 px.
- Sash hit 44. No dockview file edited.

### Gate, not a caveat

Dockview is unscored for VoiceOver, Dynamic Type at large sizes, both orientations, and finger scroll on device. That must be validated before the client shell ships.

## Next steps

Decision is recorded. Gate stands. Stop.
