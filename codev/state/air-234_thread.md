# air-234 — Spec 146 phase 12: codev-client tiling, mobile, and the static mount

## Scope, and how it changed

The issue as spawned carried phase 12's plan (tiling, architect strip, paging, e2e) plus four
inlined items from #228. I flagged it as not fitting AIR before writing anything: three of the
four #228 items are named in that issue as **missing mechanisms rather than designs** — a
per-workspace t3 connection config Tower does not hold plus a staleness policy; a durable
asynchronous approval store and poll protocol; and `afx pair revoke` having to "work for someone
holding nothing", which is a security decision the issue poses and does not make.

The architect narrowed rather than escalating, splitting by ambiguity: **phase 12's plan plus
#228 item 1 (the static mount) only.** Items 2, 3 and 4 move to their own issue. The reasoning
was that the static mount is the highest-value unambiguous thing left, and putting it behind a
spec-and-plan cycle for three unrelated mechanisms would delay it for no gain.

I started the unambiguous half while waiting for that ruling rather than idling.

## The thing the plan did not have a source for

Criterion 4 asks each pane for "the last three agent messages" and 4b for the architect's last
one. **Nothing on the agent wire carried messages.** `thread-registry.ts` had no message field,
the snapshot had no source, and `packages/types` states "count only, never message bodies" for
the adjacent overview surface.

The only honest source is the **mailbox** (`db/mailbox.ts`) — the durable record of `afx send`
traffic, keyed by `(workspace_path, to_agent)`, retained past delivery by `pruneTerminal`. I
flagged it before building and the architect approved it with three conditions, all met:

1. **`truncated` reaches the UI**, not just the payload. A body cut at 240 chars renders with a
   `CUT` mark; `pane.test.tsx` asserts the marked and unmarked cases separately.
2. **Empty and unknown do not render alike.** `messageLog` on the snapshot mirrors `t3code`'s
   shape, and three absences get three different sentences — read, unreadable, and older-server.
   One test asserts the three texts are distinct rather than merely present.
3. **The payload cost is measured**, below.

Bodies stay on `/api/agent/v1/*`. The v2 and overview surfaces are untouched and stay count-only.

## Payload cost (#225 asked for this)

Measured against the real `~/.agent-farm/global.db`:

| Workspace | Live agents | Messages attached | Added |
|---|---|---|---|
| `codev-1455` | 4 | 6 | **2.2 KiB** |
| `entriq` | 2 | 5 | **1.7 KiB** |

The naive figure is much larger — attaching three messages to every agent that has ever received
one gives 56–81 KiB on these workspaces — but only identities present in the snapshot get
messages, and a workspace has a handful of live agents rather than 84 historical ones. The bound
is `live agents × 3 × ~360 B`, so ~22 KiB at twenty builders, against #225's 493 KiB snapshot.

## The column rule, and the CSS that gives the wrong answer

`repeat(auto-fill, minmax(340px, 1fr))` is the obvious spelling and **fails criterion 4**: four
340px columns fit in 1440 less padding, so six builders tile 4 + 2, not the 3x2 the spec names.
`auto-fill` maximises columns; the criterion wants something else.

First rule I wrote was near-square (`ceil(sqrt(count))`), which gives 3x2 at 1440 correctly. I
then looked at 1920 and it put seven panes into 3x3 — three columns of a five-column-wide screen,
with a last row holding one tile beside two tiles' worth of nothing. Changed to **fewest rows
that fit**: 6 at 1440 → 3 columns (unchanged), 7 at 1920 → 4 columns in two rows.

Both rules pass criterion 4. Only looking at the rendered page showed the difference.

## Two more things only visible by looking

- Six rows read `UNKNOWN` with **no stated cause anywhere on screen**. The tree states it once
  per machine (`sessionVisibility`); the grid had flattened machines away and lost the sentence.
  It is now stated once above the grid, deduplicated by cause.
- The architect strip carried a wall-clock timestamp that meant nothing. Removed.

## The static mount and its trust boundary

`servers/client-static.ts` mirrors `v2-static.ts` rather than generalising it, because they
differ in three ways that would all have become flags: `/v2/` injects Tower's shared key and this
must not, `/client/` sends `frame-ancestors` as a real header, and `/client/` answers a machine
list and proxies to those machines.

**The decision worth reading.** `/client/machines.json` and `/m/<id>/*` do not take Tower's
shared key. The client deliberately never receives it — that key cannot be revoked for one
machine without rotating it for all, so a page holding it would have Tower-wide access that
revoking a machine credential would not take away. The page carries per-machine revocable
credentials instead, which is the same trade `isCodevAgentRoute` already makes one prefix over.

The residual is stated in `isPublicRoute`: anyone who can reach Tower's port reads that machine
list. That is not a privilege this mount introduces — the same reachability already serves the
dashboard shell with the shared key injected into it, which reaches strictly more. The port's
exposure is the control, which is why the runbook puts `tailscale serve` in front of it rather
than binding 0.0.0.0.

Four machine-list problems answer four signals (absent / mode / unparseable / entry dropped),
because an operator who configured nothing and one whose file is mode 644 need opposite actions.

## Criterion 6 was NOT performed

"An iPad on the tailnet drives a builder to completion" is manual and I have no iPad. The runbook
is in `apps/client/README.md`, including the `tailscale serve --https=443 off` teardown. **It is
written and unexecuted, and the PR says so.** What is verified is that an 820px viewport (iPad
portrait) gets the grid rather than the paged layout and does not scroll sideways.

## Suites

All five, green: `packages/codev` unit (6,942 passed), its `vitest.e2e.config` (183), its
`vitest.cli.config` (90), `apps/client` unit (181), `apps/client` Playwright (22).

Two failures were mine and are fixed: `MESSAGE_LOG_UNREADABLE` needed a real matrix row in
`agent-failure.ts` with its own mutation-verified test, and the pager derived its bounds from the
tile list rather than the paged list, which made the last pane unreachable on a phone.

One failure was environmental: `bugfix-214-publish-scrub` fails until
`packages/artifact-canvas` is built, exactly as its own message says.

`e2e/two-machines.spec.ts` now opens `?view=tree`, because the grid is the default view and every
criterion in that file is about machine boundaries and connection bands, which only the tree
shows.
