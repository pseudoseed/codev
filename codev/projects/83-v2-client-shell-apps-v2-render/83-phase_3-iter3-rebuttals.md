# Phase 3 iter 3 rebuttals — spec 83

Lanes: gemini skipped. codex REQUEST_CHANGES. claude timed out. opencode consult CLI failed; review written against disk.

## Codex: forceFresh stays set after a valid recovery snapshot then a read error

Accepted. `openOnce` returns `applied-retry` when a frame was applied before the body throws. `streamLoop` clears `forceFresh` on that. Test: recover-fresh snapshot then `c.error`, next URL has `since`/`stream`.
