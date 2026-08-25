# Bugfix #93 builder thread

## Investigate — 2026-08-24

- No existing PR covers #93 (`gh pr list --state all --search 93` returned none); the branch starts from the porch initialization commit only.
- Reproduced at `6c412fc6d`: calling the production `writeEscapeToSession(session, false)` recorded byte codes `[27]` followed 50 ms later by `[13]` (ESC, carriage return). The existing focused suite also passes its assertion that the default sequence is ESC then Enter (14/14 tests).
- Root cause path:
  - `packages/codev/src/agent-farm/cli.ts:503-510` defines the negative `--no-enter` option. Commander therefore supplies `enter: true` by default, and `!options.enter` passes `noEnter: false` for an ordinary `afx interrupt`.
  - `packages/codev/src/agent-farm/commands/interrupt.ts:54-60` forwards that value to Tower with `escape: true`.
  - `packages/codev/src/agent-farm/servers/tower-routes.ts:1995-2002` deliberately bypasses screen/render gating and calls `writeEscapeToSession` directly.
  - `packages/codev/src/agent-farm/servers/message-write.ts:53-57` writes ESC immediately and, whenever `noEnter` is false, blindly schedules `\r` after 50 ms. Nothing on this path knows whether a dialog still has a highlighted action after ESC.
- Expected vs actual: a command operating on an unknown screen should not submit a highlighted dialog choice by default; the current default always sends the submission key. `--no-enter` is safe but opt-in.
- Scope: the classification/refusal alternative requires a new Tower gate-verdict endpoint and is architectural. The focused BUGFIX-sized repair is the issue's safe-by-construction alternative: make bare ESC the default and require explicit `--enter` for the queue-processing behavior. Update the command docs in both framework trees and replace the old default-byte-sequence regression with one pinning the safe CLI default plus explicit opt-in. This is well under 300 LOC.

## Fix — 2026-08-24

- Added positive `--enter` before the retained `--no-enter` compatibility option. Commander's positive/negative option pair now leaves `enter` undefined by default, so the existing `noEnter: !options.enter` translation sends ESC alone; only explicit `--enter` produces `noEnter: false`.
- Added `bugfix-93-interrupt-enter-default.test.ts`, which exercises the real `runAgentFarm` Commander boundary for default, opt-in, and legacy-safe flag behavior. Mutation check: temporarily removing the new `--enter` declaration made the default regression fail with `expected false to be true`; restoring it passes all 3 cases.
- Updated the delivery-path comments and both runtime framework command-doc trees to describe the safe default and the risk of opting into Enter. Historical Spec 1273 artifacts remain unchanged.
- Verification: focused interrupt suites pass (17/17); `pnpm build` passes; full `pnpm test` passes (6,067 + 167 tests, with the repository's declared skips).

## PR review — 2026-08-24

- Opened PR #141 with `Fixes #93`.
- Initial CMAP: Codex APPROVE; Claude REQUEST_CHANGES because all four agent-facing afx skill copies still described the old default; Gemini skipped on an Antigravity quota/rate-limit failure and explicitly did not review.
- Addressed Claude's actionable finding by updating root Claude/Codex afx skills and both skeleton twins: `--enter` is documented as the risky opt-in, `--no-enter` as the safe default/compatibility flag, and the queue-processing recipe now uses `--enter`. Both skill pairs remain byte-identical; the focused CLI, delivery, and documentation suites pass (40/40).
- Claude also noted, non-blockingly, that Tower's lower-level escape API still defaults to Enter for callers that omit `noEnter`; `afx refresh` intentionally uses that separate path. Kept out of this CLI-scoped BUGFIX rather than changing another command's established semantics.
- Claude's follow-up re-review APPROVED and pointed out that the exported `interrupt()` function still treated an omitted `noEnter` as Enter even though its sole production caller was safe. Added defense in depth there (`options.noEnter !== false`), corrected its header comment, and pinned both its safe default and explicit false opt-in. Focused suites now pass 41/41.
- Final review set: Codex GPT-5.6 Sol APPROVE, Claude Opus 5 APPROVE, and fallback Codex GPT-5.5 APPROVE on the final diff. Gemini could not review because every Antigravity model shared an individual quota reset (~79 hours); the configured opencode/Grok fallback was also credit-blocked, and Hermes was not installed. The GPT-5.5 run supplied the third concrete verdict rather than misreporting an unavailable lane as approval.

## PR approval — 2026-08-25

- Human approved PR #141 with all eight checks green and requested one pre-merge clarification: document that Commander's positive/negative option declaration order is load-bearing. Added the short comment directly above `--enter` / `--no-enter`; the CLI regression suite already exercises this order-sensitive default.
