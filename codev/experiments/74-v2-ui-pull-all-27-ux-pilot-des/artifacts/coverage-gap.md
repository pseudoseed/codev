# Coverage gap, 27 UX Pilot designs vs FRD rev. 7

**Date:** 2026-08-23
**Evidence:** preview PNGs at `codev/research/v2-mockups/uxpilot/` plus titles inferred from those previews. HTML was not pulled (no uxpilot MCP on this harness). Existing `01-site.html` / `02-gate.html` were not used as stand-ins for the 27.

The FRD (Part 6b) said five groups carry no requirements. That is the claim under test.

## Groups

| Group | Designs | FR that names the surface | FRD said |
|---|---:|---|---|
| Porch Site Mobile Redesign | 9 | FR-1, 3, 4, 12, 13, 15, 19, 21, 41, 42 | no FR |
| Find Node Screen Flow | 5 | FR-5, FR-2 | no FR |
| Porch Gate Interaction Design | 5 | FR-43..48, FR-26 | no FR |
| Add Machine To Porch | 5 | FR-16, FR-17, FR-12 | no FR |
| Group with Porch - Terminal Soft Keyboard | 1 | FR-24 | no FR |
| Group with Porch - Gate Queue Sheet | 1 | FR-43, FR-44, FR-48 | covered (desktop queue) |
| Group with Porch - Split Terminals | 1 | FR-7 (tablet), FR-49 | covered (tiling) |
| Design a bespoke control surfa (parent) | 0 | none | none |

**Groups with no FR:** none of the 7 that have designs.

The FRD's "five groups have no requirements" meant the FRs were written while looking at 2 extracted screens, not that those surfaces are unnamed. Every designed group already has an FR that describes what it shows.

## What the designs add that no FR names

These are visible in the previews and absent from the FRD.

| Invention | Where | Why it matters |
|---|---|---|
| `NUDGE` on a stalled pane | Split Terminals | FR-42 defines stalled. It does not define an action. |
| Hierarchy **picker sheet** (machine / workspace / architect / builder) | Site Mobile `GnWkqflXk3dHyEAyMkCe` | FR-21 says the tree is a drawer. The design refuses the outline. |
| `LIVE PANES` as a bottom sheet | Site Mobile `jClfsPTbpz9rne4YAGBh` | FR-21 says bottom tab bar or segmented control. |
| `OPEN IN` destinations (this pane / new pane / left / right / replace) | Find Node `fNx6eGEgyV2GDY4ASzod`, Site Mobile `pcuGTxWBv4S195IB7nXO` | FR-2 says selecting a node opens its view. It does not say the human picks which pane. |
| LEFT PANE / RIGHT PANE on a **phone** OPEN IN | Site Mobile `pcuGTxWBv4S195IB7nXO` | Fights FR-21 (no tile below 768). Either the sheet is wrong or FR-21 needs a "reopen an existing iPad split" clause. |
| Phone gate queue is a `GATES N` chip, not a rail | Gate Interaction, Gate Queue Sheet | FR-43 says persistent queue. It does not say the rail collapses. |
| `FOREMAN: YOU` / `WORK STOPS HERE` voice | Site Mobile, Gate Interaction | Recorded in `design-language.md`, not in an FR. |

## FRs that describe a surface no design covers

Scored against the 27 previews. Desktop `01-site.html` / `02-gate.html` are outside this set.

### Visual surfaces with no design in the 27

| FR | What it asks for | In the 27? |
|---|---|---|
| FR-6 | Board view over builders/issues | No. LATER. |
| FR-7 desktop half | Drag panes between groups, four-pane tile | No. Tablet two-pane exists. Desktop drag does not. |
| FR-9 | Layouts persist across reload | No screen for this. |
| FR-10 | Named saved layouts | No. |
| FR-11 | Pop-out panes | No. LATER. |
| FR-14 | start / stop / spawn / send / cleanup from the UI | No chrome for these actions. |
| FR-18 | LAN discovery without typing an address | No. LATER. Form wants a typed address. |
| FR-37 | Detect a tailnet and offer MagicDNS | Copy on Add Machine mentions tailnet. No detector UI. |
| FR-41 on iPad | Sparkline on every builder | Present on phone site. Absent on Split Terminals. Already noted in `design-language.md`. |

### Not a visual surface (no design expected)

FR-27 terminal fidelity, FR-28 reconnect, FR-29 server-side buffer, FR-30 no poll, FR-31 scoped subscriptions, FR-32 control vs PTY sockets, FR-33 backgrounded tab, FR-34 RPC scopes, FR-35 session revoke, FR-38 resize policy, FR-39 idempotency, FR-40 canvas renderer.

These can stay FRs. They are not coverage gaps in the mockup set.

## FRs whose wording fights a design

| FR | FRD text | Design |
|---|---|---|
| FR-5 | "A global command palette (⌘K)" | FIND A NODE search sheet. Same job, different chrome. |
| FR-21 | "tree reachable as a drawer" | Picker sheet. A drawer tree is the outline FR-1 forbids. |
| FR-21 | "does not tile" below 768 | Phone OPEN IN still offers LEFT / RIGHT pane. |
| FR-43 | Persistent queue | On phone/iPad the rail is a chip + sheet, not a permanent column. |

## Hypothesis score

Locked in `notes.md` before any preview was opened.

1. Five groups have no FR. **Disproved.** Zero designed groups are unnamed.
2. Gate Queue and Split already have FRs; parent has 0 designs. **Holds.**
3. Listed uncovered FRs. **Mostly holds**, except FR-5 (Find Node covers the job) and FR-49 (close X is on Split Terminals).
4. 27 HTML+PNG via MCP. **Failed on HTML.** 27 PNGs landed from public GCS. HTML marked not-pulled.

The list that matters: **no group is missing an FR. Several FRs are missing a design. The designs invent NUDGE, a picker, LIVE PANES, and OPEN IN destinations, which the FRD does not name. FR-5, FR-21, and FR-43 need their wording changed to match the screens.**
