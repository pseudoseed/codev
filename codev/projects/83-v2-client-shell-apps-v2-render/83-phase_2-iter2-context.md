### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy exited with code 1
- codex: REQUEST_CHANGES — Core validation and reducer behavior is strong, but dark-state persistence and mismatch previews violate explicit phase requirements.
- claude: REQUEST_CHANGES — Reducer and validator are complete and well tested (47 passing, clean typecheck), but `gone` clears dark entries against D5, and `DarkEntry.at` is a permanently empty placeholder that phase 4 depends on.
- opencode: APPROVE — Phase 2 validator and reducer implement the D1 table; 47 tests cover the listed scenarios.

### Builder Response to Iteration 1
# Phase 2 iter 1 rebuttals — spec 83

Lanes: gemini skipped. opencode APPROVE. codex REQUEST_CHANGES. claude REQUEST_CHANGES.

## Codex / Claude: `gone` deletes `darkPaths`

Accepted. `gone` now only deletes from `nodes`. Dark survives every delta; only a snapshot replaces `darkPaths`. Added a regression test.

## Codex: preview is 120 UTF-16 units, not 120 UTF-8 bytes

Accepted. `escapePreview` now takes the first 120 bytes of `TextEncoder().encode(s)` and hex-escapes non-ASCII. Test covers `€`.

## Codex / Claude: `DarkEntry.at` is always empty

Accepted. `applyFrame(state, raw, now?)` takes an ISO timestamp (default `new Date().toISOString()`). Dark stores that. Tests inject a fixed `now`.

## Claude: dead branch in `applyFrame`

Accepted. Both arms called `enterMismatch`; collapsed to one.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
