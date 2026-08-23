# experiment-63 thread

Soft-mode EXPERIMENT for spec 0063 (Tower dashboard improvements).

## 2026-08-23 hypothesis

Spec 0063 is still Conceived. The landing is `packages/codev/templates/tower.html`, a card grid. Recents are already one row. Five named buttons are missing. ttyd is gone. `afx start` and `afx start --remote` are gone.

Locked the hypothesis in `codev/experiments/63-tower-dashboard-improvements/notes.md` before the prototype. Production files stay untouched.

Question: can one-row + five buttons + a closeable command terminal be met on today's landing without ttyd and without restoring SSH start.

## 2026-08-23 execute + analyze

Hypothesis holds. `afx start` and `--remote` are gone. `/api/create` exists and is unused. `/api/update` is 404. One-shot PTY streamed `hello-0063` and GET reported `exitCode=7`. WebSocket sent `seq` only, no exit frame.

Production files untouched.

Recommend against implementing 0063 as written. The landing is the surface v2 replaces. SSH remote and ttyd are decisions v2 already made differently.

Prototype: `codev/experiments/63-tower-dashboard-improvements/prototype/index.html`

## 2026-08-23 provenance

Spawn-path collision, issue #65. These notes answer spec 0063 (Conceived, never built). They are not GitHub issue #63. Kept because the spec is a genuinely open question.
