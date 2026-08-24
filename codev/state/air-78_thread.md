# air-78 — Debounce the fs.watch wake path in v2-sampler

Issue #78. AIR protocol, strict mode. Architect: uiv2.

## Shape

Leading-plus-trailing with a max-wait cap, watch path only.

- `V2_WATCH_DEBOUNCE_MS = 50` — same window as `codev-config-watcher`. Long enough to swallow a create/rename clump, short enough that the trailing walk after a spawn burst is 50ms.
- `V2_WATCH_MAX_WAIT_MS = 200` — under a `pnpm install` the events never stop, so a trailing-only debounce would defer the walk for the whole install. Cap at 200ms so the tree still moves 5 times/sec. 200ms + 50ms is still well under spec 52 criterion 2 (500ms).

Tick, the 100ms compare loop, and `not_before` still call `compare()` directly.

## Status

Implement committed (`3ec95ce6d`). 27/27 `v2-sampler` tests green, including the spec 52 suite plus burst / max-wait / tick-not-debounced / 500ms-cap cases. Build check passed. PR phase.
