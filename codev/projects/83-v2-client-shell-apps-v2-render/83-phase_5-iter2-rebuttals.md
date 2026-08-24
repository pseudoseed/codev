# Phase 5 iter 2 rebuttals — spec 83

## Codex: resume tests only prove a later node arrives

Accepted. The fixture now records the last `/v2/events` query (`since`, `stream`) and the response mode (`resumed` or `snapshot`) on `GET /__fixture/last-events`. The honoured test waits for `mode=resumed` with `since` set and `stream=s1`. The refused test waits for a reconnect that still sent `since`+`s1`, then asserts `mode=snapshot`. Both plant a `window.__v2Sentinel` and assert it plus `builder:1` after reconnect, so a wipe-on-`resumed` or a page reload fails.

## Codex: gate colour vacuous; stalled never checks ochre

Accepted. The GATE stamp's computed colour is asserted as `rgb(181, 80, 42)`. `rustHolders.length > 0` is required, then rust is still confined to `stamp-gate` / `needs-attn`. The STALLED stamp's computed colour is asserted as `rgb(192, 138, 46)`.

## Codex: idle bandwidth from Resource Timing

Rejected. Plan phase 5 and spec scenario 10 both say cold load and idle KB/s are **measured and printed, not asserted**. CDP network byte events and fixture-side byte accounting are extra infrastructure those criteria do not require. `transferSize` does not accumulate on an in-flight SSE fetch, so the printed `idle-Bps` is a floor; the review will carry the figure from the manual UX pass.

## Codex: two-page test checks only one new row

Accepted. After `builder:z` appears on both pages, a stable serialization of every `[data-kind]` node (kind, id, dark, className) is compared.

## Claude (APPROVE)

Non-blocking items overlapped the resume/rust work above and are now asserted. Idle under-report is the same rebuttal as Codex.

## Gemini (COMMENT, lane skipped) / opencode (APPROVE)

No action.
