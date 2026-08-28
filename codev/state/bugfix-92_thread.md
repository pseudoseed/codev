# Bugfix #92 builder thread

## 2026-08-25 — investigate

Reproduced on `3dd90284a` with the real mailbox DB/orchestrator and injected terminal edges. Two held rows were classified repeatedly for 30 seconds, one as `busy/user-text` and one as `busy/no-region-end`. After 20 drainer ticks both rows remained `held`, no PTY write occurred, and the only effect was one owner notice per row. The existing focused delivery tests also pass while explicitly encoding that a busy row stays held.

Root cause is in `packages/codev/src/agent-farm/servers/mailbox-delivery.ts`:

- `deliverAgentMail` (around lines 388–401) persists every not-clean verdict and returns without writing.
- `MailboxDrainer.tick` (around lines 637–682) only retries the same gate and runs visibility passes.
- `recordStreak` (around lines 795–819) emits telemetry for only `no-profile`, `no-region-end`, and `no-composer-marker`; it never changes terminal state. It excludes `user-text` and `geometry-mismatch` entirely.
- `escalateOverdue` and `noticeOverdue` are explicitly visibility-only. The live owner-notice binding in `mailbox-wiring.ts` refuses architect-addressed rows, so an architect's stuck mail cannot even produce an owner notice.

Therefore a static abandoned/unreadable screen has no producer that can change the gate verdict: the idle agent will not type, the gated mailbox path correctly refuses to write, and the drainer has no recovery write edge. `hold_detail` added by #91 diagnoses the deadlock but is not consumed by any recovery policy.

Architect context confirms the production incident is broader than leftover text: `no-region-end` required manual `afx interrupt <id> --no-enter`, and the fleet has also observed `busy-indicator`, `no-composer-marker`, and `geometry-mismatch`. The fix must never auto-clear `busy-indicator` (a live turn), must cover terminally unreadable states rather than only `user-text`, and must label a terminal hold as stuck instead of presenting it like a transient hold.

This fits BUGFIX scope. The focused plan is to add a bounded, once-per-episode drainer recovery after the existing starvation age: Ctrl+C for `user-text`; ESC for terminally unreadable `no-region-end`, `no-composer-marker`, and `geometry-mismatch`; never auto-recover `busy-indicator`, `no-profile`, or `no-live-pty`. The next gated tick remains the only delivery authority. Inbox/remedy text will explicitly call unresolved terminal holds `STUCK` and name the relevant manual command. Expected implementation plus regression coverage is under 300 LOC and stays inside the existing mailbox delivery/wiring seam.

## 2026-08-25 — fix

Implemented the bounded recovery policy. The drainer now requires the same recoverable detail, live session instance, output-byte count, and geometry to remain unchanged for the full starvation window (default: the existing three-times-escalation owner-notice window). It then sends exactly one control byte per stable-screen episode: Ctrl+C for `user-text`, ESC for `no-region-end`, `no-composer-marker`, or `geometry-mismatch`. Any screen output, resize, session replacement, or detail change resets the safety window. `busy-indicator` and other ambiguous/external holds are never touched. Recovery does not deliver the row; a subsequent pass must still classify the composer CLEAN.

Added explicit `STUCK` wording and the `afx interrupt <id> --no-enter` fallback to the owner notice and `afx inbox` guidance. Regression coverage models the production `no-region-end` incident, proves screen motion resets the timer, proves recovery alone leaves the message held, proves the next clean gate delivers it, covers all control-byte mappings, and proves a sustained `busy-indicator` is never interrupted.

Verification so far: focused mailbox suites 63/63; TypeScript compile clean; root build clean; full repository tests 6,082 passed / 48 skipped plus v2 167/167.
