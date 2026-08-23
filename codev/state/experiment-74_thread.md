# experiment-74 thread

2026-08-23. Soft EXPERIMENT. Issue 74, not the colliding spec path.

Hypothesis locked in `codev/experiments/74-v2-ui-pull-all-27-ux-pilot-des/notes.md` before any fetch.

Architect instruction: address `architect:uiv2`. Fetch one design at a time. Commit and push after each group. Coverage gap is the deliverable.

This harness has no UX Pilot MCP tools. HTTP fallback found and blocked.

- MCP `https://mcp.uxpilot.net/mcp` wants `ep_<key>`.
- CRUD `https://stream.uxpilot.ai/crud/getPage/v3/<id>` wants a bearer token.
- No key in env or `.codev/config.json`.

Architect wrote `manifest.json` (27 ids, titles null). HTML still needs MCP; previews are public.

Find Node group pulled (5 PNGs). Visible surface is FIND A NODE + OPEN IN, not a ⌘K palette. Bears on FR-5 and FR-2. HTML marked not-pulled.
