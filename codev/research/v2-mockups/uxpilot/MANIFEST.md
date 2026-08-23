# UX Pilot designs — page `SXl8jE8uNyYLwBsG6vsL`

Source: `https://uxpilot.ai/a/ui-design?page=SXl8jE8uNyYLwBsG6vsL`
IDs from `codev/experiments/74-v2-ui-pull-all-27-ux-pilot-des/manifest.json` (written by architect:uiv2).
Titles in that file are null. Titles below are the visible screen heading from the preview PNG.

**HTML is not pulled.** This harness has no uxpilot MCP. Do not invent markup. Previews only.

Existing extracted files (`01-site.html`, `02-gate.html`, `tokens.css`, `tokens-dark.css`) are untouched.

| Group | Slug | Designs | HTML |
|---|---|---:|---|
| Find Node Screen Flow | `find-node-screen-flow` | 5 | not pulled |
| Porch Gate Interaction Design | `porch-gate-interaction-design` | 5 | not pulled |
| Add Machine To Porch | `add-machine-to-porch` | 5 | not pulled |
| Porch Site Mobile Redesign | `porch-site-mobile-redesign` | 9 | not pulled |
| Group with Porch - Gate Queue Sheet | `gate-queue-sheet` | 1 | not pulled |
| Group with Porch - Split Terminals | `split-terminals` | 1 | not pulled |
| Group with Porch - Terminal Soft Keyboard | `terminal-soft-keyboard` | 1 | not pulled |
| Design a bespoke control surfa (parent) | — | 0 | — |

---

## Find Node Screen Flow

Phone. Search a node, then pick where it opens. Bears on **FR-5** (jump to node by name; the design is a Find sheet, not a ⌘K palette) and **FR-2** (selecting a node opens its view; OPEN IN names the destination pane).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `cL4RvRXLrWQEGFt7ugmi` | FIND A NODE — empty search | `find-node-screen-flow/cL4RvRXLrWQEGFt7ugmi.png` | not pulled | FR-5 |
| `nwrrq0r5q6FUBL9HgGad` | FIND A NODE — results | `find-node-screen-flow/nwrrq0r5q6FUBL9HgGad.png` | not pulled | FR-5, FR-2 |
| `fNx6eGEgyV2GDY4ASzod` | OPEN IN — pane picker | `find-node-screen-flow/fNx6eGEgyV2GDY4ASzod.png` | not pulled | FR-2 |
| `D3UEUmQeN43goRsYxUaJ` | FIND A NODE — empty state | `find-node-screen-flow/D3UEUmQeN43goRsYxUaJ.png` | not pulled | FR-5 |
| `CsPhgzxbCUWacaa4xcfW` | FIND A NODE — no results | `find-node-screen-flow/CsPhgzxbCUWacaa4xcfW.png` | not pulled | FR-5 |

---

## Group with Porch - Gate Queue Sheet

iPad. Gate rail collapsed to a rust `GATES 3` chip; queue opens as a sheet. Bears on **FR-43** (persistent queue with question, hold time, location, longest wait marked), **FR-44** (question + where it lives), **FR-48** (next gate implied by the list). Tablet composition: **FR-19**, **FR-20**, **FR-21** (sheet over content, not a 280px rail).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `YjOhy7S3Pz06oilXMo6R` | GATES 3 — queue sheet | `gate-queue-sheet/YjOhy7S3Pz06oilXMo6R.png` | not pulled | FR-43, FR-44, FR-48, FR-19, FR-20, FR-21 |

---

## Porch Gate Interaction Design

Phone. One gate view in five states (scroll position and note-field focus), not five different screens. This is the phone composition of **FR-43..48**. Also **FR-26** (KEEP FOR AUDIT / APPROVE DROP sit in the lower third) and **FR-19/20** (375-class phone).

The FRD listed this group as having no requirements. That is wrong if FRs name surfaces: FR-43..48 already describe this view. What they lack is a phone-composition clause (queue is a `GATES N` chip, not a permanent rail).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `3sOUJgaqK6CgFX4eb1Sb` | Gate — question, branches, both actions | `porch-gate-interaction-design/3sOUJgaqK6CgFX4eb1Sb.png` | not pulled | FR-43, FR-44, FR-45, FR-46, FR-47, FR-48, FR-26, FR-19, FR-20 |
| `c6PfQn1i22G2IcFejzaZ` | Gate — KEEP FOR AUDIT highlighted | `porch-gate-interaction-design/c6PfQn1i22G2IcFejzaZ.png` | not pulled | FR-44, FR-45, FR-46, FR-26 |
| `wtSunFZw8rCeadZpqDW8` | Gate — APPROVE DROP highlighted | `porch-gate-interaction-design/wtSunFZw8rCeadZpqDW8.png` | not pulled | FR-44, FR-45, FR-46, FR-26 |
| `cI0vQS8yxrTmLcD5gokz` | Gate — note field focused | `porch-gate-interaction-design/cI0vQS8yxrTmLcD5gokz.png` | not pulled | FR-47, FR-25 |
| `EdGJMIYxdc5nlaj5fyxX` | Gate — note typed | `porch-gate-interaction-design/EdGJMIYxdc5nlaj5fyxX.png` | not pulled | FR-47, FR-25 |

---

## Add Machine To Porch

Phone pairing flow. This is **FR-16** (one-time token, no long-lived secret) and **FR-17** (QR so a phone can join by scanning). Also **FR-12** (environment name + address). Copy on the form names LAN vs tailnet, which is **FR-36**'s exposure warning, not a designed Tailscale detector (**FR-37** is still undesigned).

The FRD listed this group as having no requirements. Wrong: FR-16 and FR-17 are this flow.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `HOt71AQtECabPPgK5ZNK` | Site — ADD MACHINE empty farm | `add-machine-to-porch/HOt71AQtECabPPgK5ZNK.png` | not pulled | FR-12, FR-16, FR-15 |
| `qwYWc6topSJn0NbcLFQA` | ADD A MACHINE — address + token | `add-machine-to-porch/qwYWc6topSJn0NbcLFQA.png` | not pulled | FR-12, FR-16, FR-36 |
| `51b1CgYzLv0iRRqgh4G3` | QR PAIRING sheet | `add-machine-to-porch/51b1CgYzLv0iRRqgh4G3.png` | not pulled | FR-17 |
| `F9qlq0WzIomyZX3y7L6G` | PAIRING — waiting on token | `add-machine-to-porch/F9qlq0WzIomyZX3y7L6G.png` | not pulled | FR-16 |
| `cKttggjpN8Xa2xL5RXD7` | CONNECTED | `add-machine-to-porch/cKttggjpN8Xa2xL5RXD7.png` | not pulled | FR-12, FR-16 |

---

## Group with Porch - Terminal Soft Keyboard

iPad. Modifier row above the system keyboard. This is **FR-24**. Also **FR-22** (44pt-class keys) and **FR-23** (row sits above the home indicator / keyboard).

The FRD listed this group as having no requirements. Wrong: FR-24 is this screen.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `TiCebhzPvbU1AeCZqj5z` | Soft keyboard — CTRL ESC TAB arrows | `terminal-soft-keyboard/TiCebhzPvbU1AeCZqj5z.png` | not pulled | FR-24, FR-22, FR-23 |

---

## Group with Porch - Split Terminals

iPad. Two panes, `SWAP PANES` + `LAYOUT`. This is **FR-7**'s tablet clause (two-pane tile, not four). **FR-21** does not apply: this is 1024-class, not below 768. Also **FR-8** (hidden pane stays alive is implied by swap), **FR-19**, **FR-42** (`NUDGE` on a stalled pane — an action the FRD never named). Close X on a pane is **FR-49** (detach, do not kill).

`design-language.md` already notes sparklines (**FR-41**) are missing on iPad builder rows. Visible here too.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `GyhcwHplwDsZ0ENiyTnI` | Split terminals — two panes + NUDGE | `split-terminals/GyhcwHplwDsZ0ENiyTnI.png` | not pulled | FR-7, FR-8, FR-19, FR-42, FR-49 |
