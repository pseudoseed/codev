# Device scores, 2026-08-23

Human finished testing. Words below are his. DOM sizes are from `tab-x-gap.json` and `css-sizes.md`, not from a Measure targets tap.

## Arm A, dockview 8.2.0

| Item | Score | Words / number |
|---|---|---|
| Split, drag, resize by finger | Pass | "Gestures: working quite well. Split, drag, resize all usable by finger." |
| Text selection and copy inside a pane | Pass | "Text selection and copy INSIDE a pane: WORKS." |
| Tab tap vs close | Fail | "One failure only: tapped a tab and closed it." Gap **0 pt**. |
| Everything else he tried | Pass | "Everything else worked." |
| Sash size | Fail | 4 px / 24 px coarse. Floor 44 pt. |
| Tab-X separation | Fail | 0 pt. Nested. |

## Arm B, native primitives

Page: `http://10.10.50.186:4112/b.html`

| Item | Score | Source |
|---|---|---|
| FR-22 size | Pass | Tab 88.3×44, close 66.9×44. `artifacts/arm-b-targets.json` |
| FR-22 separation | Pass | Gap 8 pt. `closeInsideTab: false`. Same file. |
| Selection in Chromium | Pass | `user-select: text`. `artifacts/arm-b-behavior.json` |
| Close | Detach | Pane hidden, node stays, restore keeps text. |
| Split | Menu | Side / stack buttons. No drag. |
| Finger, VoiceOver, Dynamic Type, orientations | Not run | Needs the iPad. |
