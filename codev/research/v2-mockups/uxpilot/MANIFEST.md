# UX Pilot designs, page `SXl8jE8uNyYLwBsG6vsL`

Source: `https://uxpilot.ai/a/ui-design?page=SXl8jE8uNyYLwBsG6vsL`
IDs from `codev/experiments/74-v2-ui-pull-all-27-ux-pilot-des/manifest.json` (written by architect:uiv2).
Titles in that file are null. Titles below are the visible screen heading from the preview PNG.

**HTML is pulled.** All 27 designs are on disk beside their previews as `<group-slug>/<design-id>.html`,
pulled by `architect:uiv2` through the uxpilot MCP (no builder harness has it). The
"not pulled" cells in the tables below are stale; the files exist.

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
| Design a bespoke control surfa (parent) | none | 0 | none |

---

## Find Node Screen Flow

Phone. Search a node, then pick where it opens. Bears on **FR-5** (jump to node by name; the design is a Find sheet, not a ⌘K palette) and **FR-2** (selecting a node opens its view; OPEN IN names the destination pane).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `cL4RvRXLrWQEGFt7ugmi` | FIND A NODE, empty search | `find-node-screen-flow/cL4RvRXLrWQEGFt7ugmi.png` | not pulled | FR-5 |
| `nwrrq0r5q6FUBL9HgGad` | FIND A NODE, results | `find-node-screen-flow/nwrrq0r5q6FUBL9HgGad.png` | not pulled | FR-5, FR-2 |
| `fNx6eGEgyV2GDY4ASzod` | OPEN IN, pane picker | `find-node-screen-flow/fNx6eGEgyV2GDY4ASzod.png` | not pulled | FR-2 |
| `D3UEUmQeN43goRsYxUaJ` | FIND A NODE, empty state | `find-node-screen-flow/D3UEUmQeN43goRsYxUaJ.png` | not pulled | FR-5 |
| `CsPhgzxbCUWacaa4xcfW` | FIND A NODE, no results | `find-node-screen-flow/CsPhgzxbCUWacaa4xcfW.png` | not pulled | FR-5 |

---

## Group with Porch - Gate Queue Sheet

iPad. Gate rail collapsed to a rust `GATES 3` chip; queue opens as a sheet. Bears on **FR-43** (persistent queue with question, hold time, location, longest wait marked), **FR-44** (question + where it lives), **FR-48** (next gate implied by the list). Tablet composition, **FR-19**, **FR-20**, **FR-21** (sheet over content, not a 280px rail).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `YjOhy7S3Pz06oilXMo6R` | GATES 3, queue sheet | `gate-queue-sheet/YjOhy7S3Pz06oilXMo6R.png` | not pulled | FR-43, FR-44, FR-48, FR-19, FR-20, FR-21 |

---

## Porch Gate Interaction Design

Phone. One gate view in five states (scroll position and note-field focus), not five different screens. This is the phone composition of **FR-43..48**. Also **FR-26** (KEEP FOR AUDIT / APPROVE DROP sit in the lower third) and **FR-19/20** (375-class phone).

The FRD listed this group as having no requirements. That is wrong if FRs name surfaces, FR-43..48 already describe this view. What they lack is a phone-composition clause (queue is a `GATES N` chip, not a permanent rail).

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `3sOUJgaqK6CgFX4eb1Sb` | Gate, question, branches, both actions | `porch-gate-interaction-design/3sOUJgaqK6CgFX4eb1Sb.png` | not pulled | FR-43, FR-44, FR-45, FR-46, FR-47, FR-48, FR-26, FR-19, FR-20 |
| `c6PfQn1i22G2IcFejzaZ` | Gate, KEEP FOR AUDIT highlighted | `porch-gate-interaction-design/c6PfQn1i22G2IcFejzaZ.png` | not pulled | FR-44, FR-45, FR-46, FR-26 |
| `wtSunFZw8rCeadZpqDW8` | Gate, APPROVE DROP highlighted | `porch-gate-interaction-design/wtSunFZw8rCeadZpqDW8.png` | not pulled | FR-44, FR-45, FR-46, FR-26 |
| `cI0vQS8yxrTmLcD5gokz` | Gate, note field focused | `porch-gate-interaction-design/cI0vQS8yxrTmLcD5gokz.png` | not pulled | FR-47, FR-25 |
| `EdGJMIYxdc5nlaj5fyxX` | Gate, note typed | `porch-gate-interaction-design/EdGJMIYxdc5nlaj5fyxX.png` | not pulled | FR-47, FR-25 |

---

## Add Machine To Porch

Phone pairing flow. This is **FR-16** (one-time token, no long-lived secret) and **FR-17** (QR so a phone can join by scanning). Also **FR-12** (environment name + address). Copy on the form names LAN vs tailnet, which is **FR-36**'s exposure warning, not a designed Tailscale detector (**FR-37** is still undesigned).

The FRD listed this group as having no requirements. Wrong, FR-16 and FR-17 are this flow.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `HOt71AQtECabPPgK5ZNK` | Site, ADD MACHINE empty farm | `add-machine-to-porch/HOt71AQtECabPPgK5ZNK.png` | not pulled | FR-12, FR-16, FR-15 |
| `qwYWc6topSJn0NbcLFQA` | ADD A MACHINE, address + token | `add-machine-to-porch/qwYWc6topSJn0NbcLFQA.png` | not pulled | FR-12, FR-16, FR-36 |
| `51b1CgYzLv0iRRqgh4G3` | QR PAIRING sheet | `add-machine-to-porch/51b1CgYzLv0iRRqgh4G3.png` | not pulled | FR-17 |
| `F9qlq0WzIomyZX3y7L6G` | PAIRING, waiting on token | `add-machine-to-porch/F9qlq0WzIomyZX3y7L6G.png` | not pulled | FR-16 |
| `cKttggjpN8Xa2xL5RXD7` | CONNECTED | `add-machine-to-porch/cKttggjpN8Xa2xL5RXD7.png` | not pulled | FR-12, FR-16 |

---

## Group with Porch - Terminal Soft Keyboard

iPad. Modifier row above the system keyboard. This is **FR-24**. Also **FR-22** (44pt-class keys) and **FR-23** (row sits above the home indicator / keyboard).

The FRD listed this group as having no requirements. Wrong, FR-24 is this screen.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `TiCebhzPvbU1AeCZqj5z` | Soft keyboard, CTRL ESC TAB arrows | `terminal-soft-keyboard/TiCebhzPvbU1AeCZqj5z.png` | not pulled | FR-24, FR-22, FR-23 |

---

## Group with Porch - Split Terminals

iPad. Two panes, `SWAP PANES` + `LAYOUT`. This is **FR-7**'s tablet clause (two-pane tile, not four). **FR-21** does not apply, this is 1024-class, not below 768. Also **FR-8** (hidden pane stays alive is implied by swap), **FR-19**, **FR-42** (`NUDGE` on a stalled pane, an action the FRD never named). Close X on a pane is **FR-49** (detach, do not kill).

`design-language.md` already notes sparklines (**FR-41**) are missing on iPad builder rows. Visible here too.

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `GyhcwHplwDsZ0ENiyTnI` | Split terminals, two panes + NUDGE | `split-terminals/GyhcwHplwDsZ0ENiyTnI.png` | not pulled | FR-7, FR-8, FR-19, FR-42, FR-49 |

---

## Porch Site Mobile Redesign

Phone site. Nine files, four surfaces, one-machine lot, two-machine lot with an offline machine, a hierarchy picker sheet, an OPEN IN sheet, a LIVE PANES sheet. Several files are near-duplicates of the two-machine lot.

This is **FR-1** (containment, not an outline), **FR-3**, **FR-4**, **FR-12**, **FR-13**, **FR-15**, **FR-19**, **FR-21**, **FR-41**, **FR-42**. Sparklines are present on the phone site (they are missing on the iPad split).

The FRD listed this group as having no requirements. Wrong if FRs name surfaces. One composition clash stands: FR-21 said the tree is a drawer, the design uses a picker sheet, and FR-21 was rewritten (FRD rev. 8).

**⚠️ The group name is misleading and it caused a false finding.** Despite "Mobile Redesign", measured pixel widths are:

| Width | Count | Designs |
|---|---:|---|
| 1440 | 7 | `9GvvtY66cZ9o588S1ZG6`, `alggCr6fYS7YFpxmiGWt`, `da25kSWpzRdJUZGp4dFB`, `GnWkqflXk3dHyEAyMkCe`, `JVQ55vBl3KuTQK6MKEnn`, `lxhbQ26SZ1QzUt8vTpUK`, `pcuGTxWBv4S195IB7nXO` |
| 1024 | 1 | `PXL1ch4T5kjMO4LYGdN9` (iPad portrait) |
| **375** | **1** | **`jClfsPTbpz9rne4YAGBh`** — the only actual phone screen |

An earlier revision of this manifest reported that `OPEN IN` offers LEFT PANE / RIGHT PANE **on a phone**, fighting FR-21's no-tile-below-768px rule. **That was wrong.** `pcuGTxWBv4S195IB7nXO` is 1440x1024, so FR-21 does not govern it. FRD rev. 9 retracts the conflict.

The one genuine phone design is a single-column card stack with a segmented control and a hamburger. It satisfies FR-21 as written.

**Measure a design before scoring it against a breakpoint requirement. Group names are not viewports.**

| ID | Title (from preview) | Preview | HTML | FRs |
|---|---|---|---|---|
| `PXL1ch4T5kjMO4LYGdN9` | Site, one machine lot | `porch-site-mobile-redesign/PXL1ch4T5kjMO4LYGdN9.png` | not pulled | FR-1, FR-3, FR-4, FR-12, FR-19, FR-21, FR-41 |
| `lxhbQ26SZ1QzUt8vTpUK` | Site, two machines, one offline | `porch-site-mobile-redesign/lxhbQ26SZ1QzUt8vTpUK.png` | not pulled | FR-1, FR-13, FR-15, FR-4, FR-41, FR-42 |
| `GnWkqflXk3dHyEAyMkCe` | Picker, machine/workspace/architect/builder | `porch-site-mobile-redesign/GnWkqflXk3dHyEAyMkCe.png` | not pulled | FR-1, FR-2, FR-21 |
| `9GvvtY66cZ9o588S1ZG6` | Site, two machines (near-duplicate) | `porch-site-mobile-redesign/9GvvtY66cZ9o588S1ZG6.png` | not pulled | FR-1, FR-13, FR-15 |
| `pcuGTxWBv4S195IB7nXO` | OPEN IN, left/right/replace | `porch-site-mobile-redesign/pcuGTxWBv4S195IB7nXO.png` | not pulled | FR-2, FR-7, FR-21 |
| `JVQ55vBl3KuTQK6MKEnn` | Site, two machines (near-duplicate) | `porch-site-mobile-redesign/JVQ55vBl3KuTQK6MKEnn.png` | not pulled | FR-1, FR-13, FR-15 |
| `da25kSWpzRdJUZGp4dFB` | Site, two machines (near-duplicate) | `porch-site-mobile-redesign/da25kSWpzRdJUZGp4dFB.png` | not pulled | FR-1, FR-13, FR-15 |
| `alggCr6fYS7YFpxmiGWt` | Site, two machines (near-duplicate) | `porch-site-mobile-redesign/alggCr6fYS7YFpxmiGWt.png` | not pulled | FR-1, FR-13, FR-15 |
| `jClfsPTbpz9rne4YAGBh` | LIVE PANES sheet | `porch-site-mobile-redesign/jClfsPTbpz9rne4YAGBh.png` | not pulled | FR-8, FR-21, FR-2 |

---

## Design a bespoke control surfa (parent)

0 designs. No files. Not a coverage gap; it is a container.

---

# Measured lineage (all 27, in generation order)

**Everything above this line predates the HTML pull and infers viewport from previews. This
section measures.** Where the two disagree, this one is right. The group names are not
viewports and the group order is not the design order.

`useCase` is the generation prompt's target and is wrong on 14 of 27 designs — every one of
them says `desktop (1440x1024)` including the 1024x1366 iPad screens. **Measured `dimensions`
is the only trustworthy width.** Class below is derived from measured width: phone ≤430,
tablet ≤1024, desktop above.

## Two design families, and which one governs

The page holds **two incompatible visual languages**, not one evolving design. Measured from
the pulled HTML — font stack, body ground, and chevron count:

| | Family A — "porch" | Family B — "IDE" |
|---|---|---|
| Display / sans / mono | Fraunces / Space Grotesk / IBM Plex Mono | — / Inter / JetBrains Mono |
| Body ground | `#EDE8DE` throughout | `#0B0D0F` dark or `#F5F1E8` light, inconsistent |
| Hierarchy | nested lots and plots, **0 chevrons** | left sidebar tree, **10–16 chevrons** |
| Designs | 11 | 16 |
| Generated | 00:11–00:24, **and 01:37** | 00:30–01:19 |

**Family A governs. This is a decision, recorded so it can be overridden.**

Three reasons, in order of weight:

1. **The three most recent designs in the page are Family A** — the iPad trio at 01:37
   (`GyhcwHplwDsZ0ENiyTnI`, `YjOhy7S3Pz06oilXMo6R`, `TiCebhzPvbU1AeCZqj5z`). Family B's last
   member is the 01:19 phone. The page returned to A after exploring B.
2. **Every shipped artifact is Family A**: `tokens.css`, `tokens-dark.css`, `01-site.html`,
   `02-gate.html`. Provenance measured, not assumed — Jaccard token overlap of each local file
   against all 27 pulled designs:

   | Local file | Best match | Overlap | Runner-up |
   |---|---|---:|---:|
   | `01-site.html` | `lxhbQ26SZ1QzUt8vTpUK` (00:22) | **0.830** | 0.385 |
   | `02-gate.html` | `c6PfQn1i22G2IcFejzaZ` (00:23) | **0.863** | 0.409 |

   Both are unambiguous. The extractions are faithful and neither is an invention.
3. **The iPad is the MUST-tier target** (FR-7 tiling was promoted from SHOULD to MUST at FRD
   rev. 6), and all three iPad screens are Family A.

Family B stays in the repo. It is recorded exploration, not dead weight: `alggCr6fYS7YFpxmiGWt`
(00:58, the last Family B desktop Site) is the strongest argument on record for a conventional
tree sidebar over containment, and FR-1 rejects it deliberately rather than by omission.

**Do not mix families.** A Family B screen rendered with `tokens.css` is neither design.

## Two build traps in every one of the 27 files

1. **Tailwind arrives from `cdn.tailwindcss.com` and Font Awesome from cdnjs.** These are
   mockup scaffolding. The v2 client is React 19 + Vite; do not add a CDN script tag to it.
2. **Family A mockups load Space Grotesk. `tokens.css` ships IBM Plex Sans** — the swap
   landed in PR #51 and the mockups were never regenerated. `tokens.css` wins; the HTML is
   stale on that one line.

## The table

| # | Time | ID | Title | Measured | Class | Family | Group |
|--:|---|---|---|---|---|---|---|
| 1 | 00:11 | `PXL1ch4T5kjMO4LYGdN9` | Porch - Site | 1024x1366 | tablet | **A** | `porch-site-mobile-redesign` |
| 2 | 00:12 | `3sOUJgaqK6CgFX4eb1Sb` | Porch - Gate | 1024x1366 | tablet | **A** | `porch-gate-interaction-design` |
| 3 | 00:12 | `cL4RvRXLrWQEGFt7ugmi` | Porch - Find Node | 1440x1024 | desktop | **A** | `find-node-screen-flow` |
| 4 | 00:12 | `HOt71AQtECabPPgK5ZNK` | Porch - Add Machine | 1440x1091 | desktop | **A** | `add-machine-to-porch` |
| 5 | 00:22 | `lxhbQ26SZ1QzUt8vTpUK` | Porch - Site | 1440x1092 | desktop | **A** | `porch-site-mobile-redesign` |
| 6 | 00:23 | `c6PfQn1i22G2IcFejzaZ` | Porch - Gate | 1440x1125 | desktop | **A** | `porch-gate-interaction-design` |
| 7 | 00:23 | `nwrrq0r5q6FUBL9HgGad` | Porch - Find Node | 1440x1024 | desktop | **A** | `find-node-screen-flow` |
| 8 | 00:24 | `qwYWc6topSJn0NbcLFQA` | Porch - Add Machine | 1440x1091 | desktop | **A** | `add-machine-to-porch` |
| 9 | 00:30 | `GnWkqflXk3dHyEAyMkCe` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 10 | 00:31 | `wtSunFZw8rCeadZpqDW8` | Porch - Gate | 1440x1024 | desktop | B | `porch-gate-interaction-design` |
| 11 | 00:31 | `fNx6eGEgyV2GDY4ASzod` | Porch - Find Node | 1440x1024 | desktop | B | `find-node-screen-flow` |
| 12 | 00:31 | `51b1CgYzLv0iRRqgh4G3` | Porch - Add Machine | 1440x1024 | desktop | B | `add-machine-to-porch` |
| 13 | 00:39 | `9GvvtY66cZ9o588S1ZG6` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 14 | 00:47 | `pcuGTxWBv4S195IB7nXO` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 15 | 00:52 | `JVQ55vBl3KuTQK6MKEnn` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 16 | 00:55 | `da25kSWpzRdJUZGp4dFB` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 17 | 00:58 | `alggCr6fYS7YFpxmiGWt` | Porch - Site | 1440x1024 | desktop | B | `porch-site-mobile-redesign` |
| 18 | 01:00 | `cI0vQS8yxrTmLcD5gokz` | Porch - Gate | 1440x1024 | desktop | B | `porch-gate-interaction-design` |
| 19 | 01:00 | `D3UEUmQeN43goRsYxUaJ` | Porch - Find Node | 1440x1024 | desktop | B | `find-node-screen-flow` |
| 20 | 01:00 | `F9qlq0WzIomyZX3y7L6G` | Porch - Add Machine | 1440x1024 | desktop | B | `add-machine-to-porch` |
| 21 | 01:19 | `jClfsPTbpz9rne4YAGBh` | Porch - Dashboard Overview | 375x1122 | phone | B | `porch-site-mobile-redesign` |
| 22 | 01:19 | `EdGJMIYxdc5nlaj5fyxX` | Porch - Pending Gates | 375x892 | phone | B | `porch-gate-interaction-design` |
| 23 | 01:19 | `CsPhgzxbCUWacaa4xcfW` | Porch - Node Search | 375x840 | phone | B | `find-node-screen-flow` |
| 24 | 01:19 | `cKttggjpN8Xa2xL5RXD7` | Porch - Add Machine 2 | 375x1466 | phone | B | `add-machine-to-porch` |
| 25 | 01:37 | `GyhcwHplwDsZ0ENiyTnI` | Porch - Split Terminals | 1024x1366 | tablet | **A** | `split-terminals` |
| 26 | 01:37 | `YjOhy7S3Pz06oilXMo6R` | Porch - Gate Queue Sheet | 1024x1366 | tablet | **A** | `gate-queue-sheet` |
| 27 | 01:37 | `TiCebhzPvbU1AeCZqj5z` | Porch - Terminal Soft Keyboard | 1024x1366 | tablet | **A** | `terminal-soft-keyboard` |

Family A rows, in generation order: `PXL1ch4T5kjMO4LYGdN9`, `3sOUJgaqK6CgFX4eb1Sb`,
`cL4RvRXLrWQEGFt7ugmi`, `HOt71AQtECabPPgK5ZNK`, `lxhbQ26SZ1QzUt8vTpUK`,
`c6PfQn1i22G2IcFejzaZ`, `nwrrq0r5q6FUBL9HgGad`, `qwYWc6topSJn0NbcLFQA`,
`GyhcwHplwDsZ0ENiyTnI`, `YjOhy7S3Pz06oilXMo6R`, `TiCebhzPvbU1AeCZqj5z`.

## Corrections to the group summaries above

| Group | Said | Measured |
|---|---|---|
| Find Node Screen Flow | "Phone" | 4 desktop 1440, 1 phone 375 |
| Porch Gate Interaction Design | "Phone" | 1 tablet 1024x1366, 3 desktop 1440, 1 phone 375 |
| Add Machine To Porch | — | 4 desktop 1440, 1 phone 375 |
| Porch Site Mobile Redesign | — | 1 tablet 1024x1366, 7 desktop 1440, 1 phone 375 |
| The three `Group with Porch - *` singles | "iPad" | correct, all 1024x1366 |

Any FR clause scored against a group's assumed viewport needs rescoring against this table.
That error has already produced one phantom finding (FRD rev. 8, retracted at rev. 9).
