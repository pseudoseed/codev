# Experiment 74: Pull all 27 UX Pilot designs and map FR coverage

**Status**: In Progress · **Date**: 2026-08-23

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
- MCP: `https://mcp.uxpilot.net/mcp` — 401, needs `Authorization: Bearer ep_<key>`.
- CRUD: `https://stream.uxpilot.ai/crud/getPage[/v2|/v3]/<id>` — 401, no token.
- Firebase anonymous signup against `uxpilot-auth` is `ADMIN_ONLY_OPERATION`.

No UX Pilot key in process env or `.codev/config.json`. Fetch is blocked until a key or MCP lane is provided.

## Code

| File | What it is |
|---|---|
| `../../research/v2-mockups/uxpilot/` | Pulled designs, one directory per group |
| `../../research/v2-mockups/uxpilot/MANIFEST.md` | Group / title / FR map |
| `artifacts/coverage-gap.md` | The deliverable |

## Results

0 of 27 designs fetched. Hypothesis not scored. Blocked on auth.

## What Worked / What Didn't

The page HTML is a shell. The real list lives behind `stream.uxpilot.ai` and `mcp.uxpilot.net`, both gated. Guessing design IDs would invent evidence.

## Next Steps

Need one of: a UX Pilot MCP key (`ep_…`), this session wired to the uxpilot MCP, or the 27 design IDs exported another way. Then resume one-at-a-time fetch.
