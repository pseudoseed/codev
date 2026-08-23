# experiment-74 thread

2026-08-23. Soft EXPERIMENT. Issue 74, not the colliding spec path.

Hypothesis locked in `codev/experiments/74-v2-ui-pull-all-27-ux-pilot-des/notes.md` before any fetch.

Architect instruction: address `architect:uiv2`. Fetch one design at a time. Commit and push after each group. Coverage gap is the deliverable.

This harness has no UX Pilot MCP tools. HTTP fallback found and blocked.

- MCP `https://mcp.uxpilot.net/mcp` wants `ep_<key>`.
- CRUD `https://stream.uxpilot.ai/crud/getPage/v3/<id>` wants a bearer token.
- No key in env or `.codev/config.json`.

Architect wrote `manifest.json` (27 ids, titles null). HTML still needs MCP; previews are public.

All 27 previews pulled, one group per commit, pushed. HTML not pulled.

Coverage gap: 0 groups lack an FR. FRD claim of five uncovered groups is disproved. Real gap is undesigned FRs (board, desktop tile, persist, spawn chrome, Tailscale detect) and undesigned inventions (NUDGE, picker, LIVE PANES, OPEN IN). FR-5 / FR-21 / FR-43 wording fights the screens.

Deliverable: `codev/experiments/74-v2-ui-pull-all-27-ux-pilot-des/artifacts/coverage-gap.md`.
