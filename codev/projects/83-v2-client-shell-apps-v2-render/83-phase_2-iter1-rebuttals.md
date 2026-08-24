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
