# task-dUsB thread

## 2026-08-27 — proof spike start

Ad-hoc proof spike for issue #146. `porch next` cannot auto-detect a numbered project because this is a task builder, so there is no porch state machine attached. Scope is evidence only: a live t3code headless server, one thread, multi-turn/external file mutation, a real >=10-minute idle gate, reaper semantics, and WebSocket sequence replay. t3code source remains read-only.

## 2026-08-28 — live proof complete

All three required seams are proven. The primary thread settled twice around an external shell mutation; the agent saw the unique file value on turn 2. The gate pause lasted 2,160,041ms. The real reaper stopped that Codex provider after 2,094,232ms idle, and the next turn on the same t3 thread restarted Codex. Review caught that the original turn-3 prompt echoed its expected context values, so it was not valid context evidence. A corrected follow-up restarted t3 against the same retained data/thread and, without the answer in its prompt or using tools, recalled the pre-reap filename `proof-external.txt` at sequence 151. A second WebSocket was dropped at sequence 45; reconnect with `afterSequence: 45` replayed the control connection's exact event IDs for sequences 46–54, including `activeTurnId: null`. A corrected six-thread barrier rerun asserted all six `activeTurnId`s were non-null simultaneously; all settled successfully at about 1.24GiB RSS. Report: `codev/research/146-t3code-porch-execution-proof.md`.

## 2026-08-28 — consultation corrections

Gemini skipped on quota. Codex and Claude both caught a genuine false-positive: the first post-reap prompt supplied its expected context tokens. The report no longer uses that echo as evidence. A corrected same-thread follow-up after the actual reap and a t3 server restart asked for a pre-reap filename absent from the prompt and got `PRE_REAP_FILENAME_proof-external.txt`. Other corrections: pinned t3 0.0.35, required `reaperObserved` for the default proof, labeled short runs smoke-only, softened unobserved shell/exact-output claims, identified source checkout mismatch, and added a strict all-six-active barrier rerun.
