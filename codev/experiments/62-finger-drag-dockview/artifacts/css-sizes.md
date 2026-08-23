# Stock dockview 8.2.0 target sizes (stylesheet, not live DOM)

Source: `node_modules/dockview/dist/styles/dockview.css` (same file copied into `dockview-react`). Read 2026-08-23 after `npm install`.

## Sash

| Rule | Value | Lines |
|---|---|---|
| Horizontal sash box | `width: 4px` | 1380-1382 |
| Vertical sash box | `height: 4px` | 1403-1405 |
| Coarse-pointer `::before` inflate | 10px each side | 1449-1466 |

On a touch device (`pointer: coarse`), the hit box on the travel axis is 4 + 10 + 10 = **24px**. FR-22 wants **44pt**. CSS already fails. Live DOM on the iPad still has to confirm the media query matches.

## Tab close

| Rule | Value | Lines |
|---|---|---|
| `.dv-default-tab-action` padding | `4px` | 157-158 |
| Coarse-pointer padding | `8px` | 173-176 |
| `--dv-tab-close-icon-size` | `inherit` on abyss; `8px` on some themes | 1519, 2079 |

The action is an icon plus padding. Even at 8px padding around a 16px icon the box is about 32px. Live measure on the device is the score.

## Tab vs close: separation

The close control is a child of the tab. There is no gap between two hit regions. The X's box sits inside the tab's box.

Live geometry, Chromium 1024×768 against the spike, `hasTouch: true` (`artifacts/tab-x-gap.json`, 2026-08-23T21:20:10.815Z):

| Box | Size | Notes |
|---|---|---|
| Tab (Architect, inactive) | 102.2 × 35 | `--dv-tabs-and-actions-container-height: 35px` |
| Close X | 27 × 27 | Inside the tab. `closeInsideTab: true` |
| Gap, tab hit to X hit | **0 pt** | Nested targets. Not adjacent. |
| Visual gap, title text to X | 4 px | `.dv-default-tab-content { margin-right: 4px }`. Text gap, not a hit-region gap. |

A 35 px tab bar cannot hold a 44 pt handle, an 8 pt dead zone, and a 44 pt close (44+8+44 = 96). That is structural.

This is not a gesture score. It is why a finger aiming at a tab hits Close.
