# Codev v2 — Design language (approved reference)

**Status:** Approved by the human, 2026-08-21. This is the direction v2 replicates.
**Source:** UX Pilot page `SXl8jE8uNyYLwBsG6vsL` — https://uxpilot.ai/a/ui-design?page=SXl8jE8uNyYLwBsG6vsL
**Screens:** `01-site.png` · `02-gate.png` · `03-find.png` · `04-pair.png` (committed here; the
uxpilot page is not a durable dependency)

Two earlier runs were rejected: a bare-minimum IDE treatment, and a
Linear/Vercel/PostHog pastiche. The brief that worked refused named products as targets and
built the identity from Codev's own vocabulary instead.

---

## The concept

The system's names are already architectural — **Tower** (server), **Porch** (the protocol
that runs work), **Farm** (the fleet), **Architect**, **Builder**, **Gate**, **Worktree**.
The UI is a **site** and the user is its **foreman**. Several crews work in parallel;
occasionally one downs tools and asks a question.

Sense of place, not illustration. No cartoon houses, no mascots, no wood-and-brick texture.

## Palette and type

| Token | Role |
|---|---|
| Warm paper off-white | Ground. Not grey, not pure white. |
| Near-black ink | Text, header bar, terminal grounds |
| Burnt orange | The single accent — reserved for **gates and attention**, never decoration |
| Amber | Warnings inside terminal output |
| Blueprint grid / diagonal hatch | Background texture on site and gate views |

Monospace-forward. Uppercase letterspaced micro-labels (`MACHINE LOT`, `LIVE PANES`,
`THE QUESTION`). A serif appears for the gate's question line, which is the one moment the
machine speaks in a human voice.

## Structural rules

**The hierarchy is spatial containment, not an outline.** Machine → bounded "machine lot"
with a tab label. Workspace → card inside the lot. Architect → header line on the card.
Builder → small card beneath it. **No indented text with disclosure triangles** — that is
the thing being replaced.

**Gates are a permanent left rail, not badges.** The queue shows each builder's actual
question, how long it has been held, and where it lives. Longest wait is marked.

**Every builder carries an activity sparkline.** Output volume over time, so a glance
separates working from stalled. Explicit states: `GATE`, `STUCK?`, `NO OUTPUT 6 MIN`,
`RUNNING`.

**An offline machine keeps its shape.** Subtree dimmed, lot outlined in dashes,
`RECONNECT TO RESUME` in the empty space. It does not vanish and does not error.

**The foreman voice is part of the design.** `WORK STOPS HERE UNTIL YOU RULE. NOTHING
BEHIND A GATE PROCEEDS.` · `RULING ON #1 OF 3. NEXT OPENS AUTOMATICALLY.` ·
`FOREMAN: YOU`. Terse, declarative, never chatty.

## The gate screen

The emotional centre of the app, and the best thing in the mockup.

- Held-for timer as a large numeral — the cost of the human not looking.
- `THE QUESTION` set apart in serif, quoting the builder verbatim.
- Full terminal context, with the reasoning that led to the question.
- **`WHAT HAPPENS NEXT` — both branches spelled out before the human rules.**
- **Actions named for their consequence** (`KEEP FOR AUDIT` / `APPROVE DROP`), not
  `Approve` / `Reject`.
- Optional note back to the builder.
- Worktree, branch and commit count on one metadata line.

---

## What this changes in the FRD

The mockup is ahead of the requirements in four places. These need folding back in:

| | FRD today | Mockup |
|---|---|---|
| **FR-1** | "One window shows a **tree**" | Spatial containment. The word "tree" now over-specifies an outline the design rejects. |
| **FR-4** | Node status: running / idle / needs-attention / held mail / gate-waiting | Adds an **activity sparkline** and a derived **stalled** state (`NO OUTPUT 6 MIN`), which no current agent tool shows. |
| **Gates** | Only a node status; no gate UI specified | A first-class queue rail plus a full gate view. Needs its own FR block. |
| **Gate actions** | Unspecified | Consequence-named actions and a **branch preview** before ruling. Directly serves the "never approve without an explicit human decision" rule — the human sees what each choice does. |

Also worth noting: the gate view satisfies most of Part 5's acceptance scenario on desktop.
The phone version of that path is still undrawn.

## Not yet drawn

Phone and tablet layouts (FR-19 to FR-26), which are a different composition entirely under
FR-21's no-tiling rule. Desktop tiling interactions — drag between groups, split, resize.

---

## iPad (added 2026-08-21)

iPad is the primary away-from-desk target; the phone is secondary and consolidated
(human's call). Five screens: `ipad-01-site.png` through `ipad-05-soft-keyboard.png`.

**What the iPad changes from desktop:**

- **Two panes maximum, never four.** With `SWAP PANES` and a `LAYOUT` control, and a
  fullscreen affordance per pane.
- **The gate rail collapses.** No permanent 280px rail at this width — a rust gate
  counter in the top bar opens the queue as a sheet over the content.
- **Lots run across the top**, terminal panes fill below. Containment survives the
  narrower width: `MACHINE LOT` tab, workspace plots inside, architect header, builder
  rows with stakes.
- **A soft-keyboard state.** A modifier row docks above the system keyboard carrying
  `CTRL ESC TAB ← ↑ ↓ → C-C C-D C-L PASTE` plus a dismiss key. This is FR-24's answer,
  and it is the screen the phone layout should inherit from.

**Two inventions worth keeping:**

- **`NUDGE`** on a stalled builder's pane footer. An action for a stuck agent, which
  nothing in the FRD asked for and which the stalled state (FR-42) implies the need for.
- **An architect-grouped pane** — one pane showing all builders under a single architect,
  stacked, rather than one pane per builder. A denser use of two panes than two terminals.

**Known drift, corrected on the second pass:** the first iPad attempt replaced the lots
with an indented outline and folder icons — exactly the pattern FR-1 forbids — and also
lost the blueprint grid, renamed the machines, swapped the compass mark for a house, and
rendered pane headers dark-on-dark. Restating the containment rule explicitly fixed it.
**The lesson for anyone regenerating these: the outline is the default the model falls
back to, so the containment rule has to be restated every time.**

**Still lost:** builder rows on iPad dropped the activity sparklines that FR-41 requires.
Add them when building; do not treat the mockup as complete on that point.

**Note on regeneration:** passing an existing `pageId` lets the agent *edit* screens
already on that page. The first iPad run silently overwrote the approved desktop Site and
Gate. The committed copies here are the source of truth, not the uxpilot page.
