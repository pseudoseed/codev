# Experiment 74: Pull all 27 UX Pilot designs and map FR coverage

**Status**: Complete · **Date**: 2026-08-23

Issue #74. The spawn prompt named `codev/specs/74-v2-ui-pull-all-27-ux-pilot-des.md`, which does not exist. Assignment is GitHub issue 74.

## Goal

**Question.** Which of the 8 UX Pilot groups have no FR in `codev/research/codev-v2-ui-frd.md`, and which existing FRs describe a surface no design covers?

**Hypothesis, locked before any design is fetched.**

1. Five groups have no FR: Porch Site Mobile Redesign, Find Node Screen Flow, Porch Gate Interaction Design, Add Machine To Porch, Terminal Soft Keyboard.
2. Two groups already have FRs written against the extracted screens: Gate Queue Sheet (FR-43..48) and Split Terminals (FR-7, FR-21). The parent group has 0 designs.
3. Some existing FRs describe a surface no design covers: FR-5 command palette, FR-6 board view, FR-10 named layouts, FR-11 pop-out, FR-30..33 efficiency/transport, FR-34..37 security/Tailscale, FR-38 resize policy, FR-39 idempotency, FR-49 pane-close lifetime.
4. Fetching via UX Pilot `get_page_context` + `get_design includeHtml` will land 27 HTML+PNG pairs at `codev/research/v2-mockups/uxpilot/<group-slug>/<design-id>.{html,png}` without restyling.

**Success.** Scored against this list:

- 27 designs on disk as source HTML plus preview PNG. No restyle, no dark palette applied.
- `01-site.html`, `02-gate.html`, `tokens.css`, `tokens-dark.css` untouched.
- `MANIFEST.md` maps each design to group, title, and FR numbers it bears on.
- Coverage gap is written: groups with no FR, FRs with no design. That list is the deliverable.

**Failure of the hypothesis.**

- Fewer than 27 designs are fetchable, or a group listed in the issue does not exist on the page.
- A "no-FR" group already has FRs that name its surface.
- An FR listed as uncovered is visibly present in a pulled design.

## Approach

Fetch one design at a time. Write it to disk. Do not hold the HTML. Commit and push after each group. Then map FRs from titles and a skim of structure, not from restyling.

## Environment & Reproduction

Page: `https://uxpilot.ai/a/ui-design?page=SXl8jE8uNyYLwBsG6vsL` (id `SXl8jE8uNyYLwBsG6vsL`).

Intended tools: UX Pilot MCP `get_page_context`, then `get_design` with `includeHtml`. This opencode harness does not expose those tools.

HTTP fallback found, then blocked:

- Page SPA: `https://uxpilot.ai/a/ui-design?page=SXl8jE8uNyYLwBsG6vsL` (no embedded design list).
- MCP: `https://mcp.uxpilot.net/mcp` : 401, needs `Authorization: Bearer ep_<key>`.
- CRUD: `https://stream.uxpilot.ai/crud/getPage[/v2|/v3]/<id>` : 401, no token.
- Firebase anonymous signup against `uxpilot-auth` is `ADMIN_ONLY_OPERATION`.

Architect wrote `manifest.json` (27 ids, titles null). Preview PNGs are public on `storage.googleapis.com`. HTML still needs the MCP session. No further HTTP fallbacks after that instruction.

## Code

| File | What it is |
|---|---|
| `manifest.json` | 27 ids from architect:uiv2 |
| `../../research/v2-mockups/uxpilot/<slug>/<id>.png` | 27 previews |
| `../../research/v2-mockups/uxpilot/MANIFEST.md` | Group / title / FR map |
| `artifacts/coverage-gap.md` | The deliverable |

## Results

27 of 27 previews on disk. 0 of 27 HTML. Existing mockup HTML and tokens untouched.

Hypothesis 1 is disproved: none of the 7 designed groups lack an FR that names their surface. Hypothesis 2 holds. Hypothesis 3 mostly holds; FR-5 and FR-49 are visible (Find Node, pane close X). Hypothesis 4 failed on HTML.

The gap that matters is the other way: FRs with no design (FR-6, 7-desktop, 9, 10, 11, 14, 18, 37, 41-on-iPad) and designs with no FR (NUDGE, picker, LIVE PANES, OPEN IN destinations). FR-5, FR-21, FR-43 wording fights the screens.

Full table: `artifacts/coverage-gap.md`.

| Metric | Value | Notes |
|---|---|---|
| Previews on disk | 27 | Public GCS, no auth |
| HTML on disk | 0 | MCP not on this harness |
| Groups with no FR | 0 | FRD claimed 5 |
| Design inventions with no FR | 4 | NUDGE, picker, LIVE PANES, OPEN IN |
| FRs fighting a design | 3 | FR-5, FR-21, FR-43 |

## What Worked / What Didn't

Stopping for a key instead of inventing IDs. Public preview URLs. Mapping from visible headings, not from restyled HTML.

HTML fetch did not work on this harness. Five of the nine mobile-site files are near-duplicates; the group is four surfaces, not nine.

## Next Steps

FRD rev. 8 should: drop the "five groups have no FR" claim; add NUDGE / picker / LIVE PANES / OPEN IN; rewrite FR-5, FR-21, FR-43 to match the screens. HTML can wait until someone with the MCP session pulls it. No production path from this experiment.
