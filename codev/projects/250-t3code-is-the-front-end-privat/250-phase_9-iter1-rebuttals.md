# Phase 9, iteration 1 — what the two lanes said and what changed

**Claude APPROVE/HIGH, opencode COMMENT/HIGH.** The lanes disagreed on severity, so the stricter
one is binding — every point from both is acted on, and one of them was a real defect neither the
tests nor the screenshots could have caught.

## 1. The grid had no in-app entry point — FIXED, and the test was complicit

> `/codev-builders` exists. Nothing in the sidebar or chrome links to it. Tests `page.goto` the
> path. A user in t3code cannot find the watch view.

The binding one. A route nobody can navigate to is a feature that does not exist, and **the test
was part of the problem**: `page.goto` proves the route renders and says nothing about whether
anyone can reach it. The sidebar has a "Builders" link now, gated on `hasCodevHierarchy` so a
workspace with no Codev agents sees nothing new — the same rule the tree follows — and the e2e
clicks it instead of typing the URL. At 390 that means opening the drawer, tapping, and closing it
again, which is the path a person actually walks.

## 2. The width was measured two ways — FIXED

> Mount uses `getBoundingClientRect` (border box). `ResizeObserver` then writes `contentRect`
> (padding already gone). `contentWidth` subtracts `PAGE_PADDING * 2` again.

Correct, and it is this project's recurring shape: two derivations of one fact. The named viewports
still landed on 3 and 4 columns, which is exactly what makes it dangerous — near a column boundary
the layout would flip after the first observe and no existing assertion would have moved. The
padding lives on an inner wrapper now, so the observed box has none and both paths report the same
number.

## 3. Orphans were dropped from the grid — FIXED

> The route takes `kind === "builder"` only. The sidebar keeps them; the watch view does not.

The phase 7 reasoning, missed one phase later. A builder whose architect was archived is still a
running agent, and a watch view that omits it hides the agent a human is most likely to be hunting
for. They tile.

## 4. The sidebar is 256px, not 232 — FIXED

> `THREAD_SIDEBAR_DEFAULT_WIDTH` is 256. Runtime is measured, so the arithmetic still works.

Every conclusion survives — 1440 open is 1184 of grid and still three columns; 1920 open is 1664 and
still four — but the unit tests were written against numbers I invented rather than read. They use
the measured ones now, and that surfaced something worth recording: **1440 with the sidebar
COLLAPSED fits four columns**, so the architect gets a tile there. That is the rule working rather
than an exception to it — the user made room for a fourth column and 4 + 3 is not ragged — and it is
the same case the architect approved when ruling on the departure from "1920 or wider".

## 5. Two things the DOM was saying that were not true — FIXED

`data-codev-architect-placement` read `"strip"` on a page with no architect at all. It reads
`"none"` there now: "no architect" is its own answer. And the header said "N builders" while N+2
tiles rendered in the multi-architect case.

## 6. `--codev-pane-body` set and consumed nowhere — FIXED

The grid published the custom property from `MIN_BODY_PX` and the panes carried a literal
`text-[13px]` — a second copy of a number `layout.ts` owns. The pane inherits the property.

## 7. The route computed the same grouping twice — FIXED

One pass, one answer.

## Not acted on, and why

**"`BuilderPane` has no props for phase and messages, so phase 10 has to change the component."**
True and intended. The architect ruled that pane content comes from `codev-agent` over the
same-origin proxy in phase 10, with the fork's contract left unextended. Adding empty props now
would be guessing the shape of data this phase cannot fetch.
