# Phase 3 iter 1 rebuttals — spec 83

Lanes: gemini skipped. opencode timed out. codex REQUEST_CHANGES. claude REQUEST_CHANGES.

## Codex: unreachable hides a later mismatch

Accepted. Entering bootstrap mismatch, HTTP mismatch, or a bad frame now clears `connection === 'unreachable'`. Tests: `500` then `{}`; `503` then `400`.

## Codex: forceFresh dropped on 5xx/EOF before a snapshot

Accepted. `forceFresh` stays set until a valid live frame. A recover-fresh connection that 503s still opens the next attempt without `since`/`stream`.

## Claude: leaked SSE body on early return

Accepted. `readSseData` cancels the reader in `finally`. Non-200 responses cancel `res.body`.

## Claude: emit mutates one object

Accepted. `onState` now receives a shallow copy.

## Claude: `wait()` TDZ on sync backoff

Accepted. `onAbort` is declared before the backoff callback.

## Claude: empty bootstrap sets `connection = 'live'`

Kept. Display uses `bootstrap === 'empty'` first. `live` here means not waiting on a socket; no stream is opened.

## Opencode: forceFresh cleared on EOF because `connection === 'live'` is sticky

Accepted. `openOnce` returns `applied-eof` only when this attempt applied a valid frame. `forceFresh` clears on that, not on a leftover live connection. Test: recover-fresh then empty 200 body, next URL has no `since`/`stream`.
