# Experiment 38: Multi-client terminal resize policy

**Status**: Complete · **Date**: 2026-08-22

Spawn prompt named `codev/specs/0038-consult-pr-mode.md` (an already-shipped 2025 TICK). Issue #38 and porch project `38-spike-v2-ui-multi-client-termi` are the work. The spec-path collision is a template fill on the issue number.

## Goal

**Question.** Can FR-38 (two clients on one terminal must not fight over dimensions) be met additively, in a v2-owned attach wrapper that calls the existing `PtySession.resize()` with one agreed size, without editing `pty-session.ts`?

**Hypothesis, locked before any prototype.**

1. Last-writer-wins is real on current code. Two attached clients sending different sizes leave `session.info` at the later writer's cols and rows.
2. Policy 2 (ignore resize from hidden panes) fails FR-38 when both clients are visible. That is the product case: iPad and desktop both showing the same builder.
3. Policy 3 (per-viewer local cols with server-side reflow) cannot be met additively. One PTY has one size. Per-viewer reflow needs a second PTY, per-client output rewrite, or a change to what `resize()` means. All three break the fork constraint.
4. Policy 1 (follow the focused client) can be met additively. The wrapper tracks focus and visibility per viewer, picks one size, and calls existing `resize()` once.

**Success.** All of these, scored against this list, not against whatever the run produces:

- A reproduction file exists with captured `session.info` (and, if a live PTY starts, process-side size) after two sequential resizes from two clients.
- The wrapper lives under `codev/experiments/38-multi-client-resize/`. No production path is edited to make the prototype work.
- `git diff --stat -- packages/codev/src/terminal/pty-session.ts` is empty.
- Each of the three policies is scored against four cases: two visible clients, focused client disconnects, both hidden, reconnect after an iOS-style drop.
- One policy is named, or FR-38 is flagged as a requirement to renegotiate.
- The named policy's prototype passes those four cases.

**Failure of the hypothesis.**

- Last-writer-wins cannot be reproduced against current `PtySession.resize`. The FRD claim is stale.
- Policy 3 can be done without touching `PtySession` and still give two viewers different wrapped output.
- Policy 1 still fights (both claim focus, or the post-connect resize nudge bypasses the wrapper). FR-38 is not additive.

## Approach

A v2 resize broker sits in front of `PtySession.resize`. Viewers report size, visibility, and focus. The broker picks at most one size and calls the existing `resize(cols, rows)`. `pty-session.ts` is not imported by the broker. Production would pass `session.resize.bind(session)`.

**Why this seam.** `tower-websocket.ts:76-80` already forwards every resize control frame straight into `session.resize`. That is the last-writer-wins call. A v2 attach path can intercept the frame before that call. No contract change on `PtySession`.

**Policy 1, follow focused.** Apply a resize only from the focused viewer. Hidden never applies. Sole remaining viewer becomes focused. No viewers left: hold last size.

**Policy 2, ignore hidden.** Apply a resize from any visible viewer. Two visible clients still last-writer-wins. Expected to fail the two-visible case.

**Policy 3, per-viewer reflow.** Record a local size per viewer. Do not call `session.resize` with different sizes. If two visible viewers disagree, return `unsupported`. That is the additive answer: the policy cannot be finished without a second PTY or per-client rewrite.

**Measurements.**

| Case | Pass for a policy |
|---|---|
| Two visible, different sizes | PTY size equals the focused (or sole-authority) viewer. Not the last writer. |
| Focused disconnects | PTY size becomes the remaining visible viewer's size, or holds if none remain. |
| Both hidden | No `applySize` call. Last negotiated size stays. |
| iOS-style reconnect | Reconnect attaches visible and unfocused. Its post-connect nudge does not apply while another viewer is focused. Sole reconnector becomes focused. |

**Not measured here.** Live iPad Safari, WebGL context loss, xterm client-side wrap. Those need a device. This spike answers the server-side policy and the additive question.

## Environment and reproduction

Worktree has no `node_modules`. Broker tests need only Node 20:

```
node codev/experiments/38-multi-client-resize/src/run-tests.mjs
```

Last-writer-wins repro uses main's installed `packages/codev` deps. Worktree `pty-session.ts` is byte-identical to main (`diff -q` reported identical). Command that produced the artifact:

```
cd /Users/chris/dev/codev-1455/packages/codev
./node_modules/.bin/tsx \
  /Users/chris/dev/codev-1455/.builders/experiment-38/codev/experiments/38-multi-client-resize/scripts/repro-last-writer-wins.ts
```

Untouched check: `git diff --stat -- packages/codev/src/terminal/pty-session.ts` (empty).

## Code

| File | What it is |
|---|---|
| `src/v2-resize-broker.mjs` | v2-owned resize broker. Calls an injected `applySize`. Does not import `PtySession`. |
| `src/run-tests.mjs` | 13 node:assert cases for the four locked scenarios across three policies. |
| `scripts/repro-last-writer-wins.ts` | Live `PtySession` plus two attached clients. Writes the capture file. |
| `artifacts/repro-last-writer-wins.txt` | Captured last-writer-wins output. |
| `artifacts/broker-tests.txt` | Test run output. |
| `artifacts/policy-scores.md` | Score table against the pre-locked cases. |

## Results

Last-writer-wins is real. Two clients attached, A resized to 80x24, B resized to 40x12. `session.info` ended at 40x12. Live bash `stty size` printed `12 40` (rows, then cols). Source: `artifacts/repro-last-writer-wins.txt`, timestamp `2026-08-22T19:34:29.564Z`.

Broker tests: 13 passed, 0 failed. Source: `artifacts/broker-tests.txt`.

| Metric | Value | Source |
|---|---|---|
| `session.info` after A then B | 40x12 | repro artifact |
| `stty size` after B | 12 40 | repro artifact, parsed from PTY output |
| `pty-session.ts` diff | empty | `git diff --stat` |
| follow-focused, two visible | PASS (stays 80x24) | run-tests.mjs |
| ignore-hidden, two visible | FAIL FR-38 (becomes 40x12) | run-tests.mjs |
| per-viewer-reflow, two visible | `unsupported-divergent` | run-tests.mjs |

**Hypothesis 1, confirmed.** Last-writer-wins is on current code, not just in the FRD.

**Hypothesis 2, confirmed.** Ignore-hidden still fights when both clients are visible. That is the product case.

**Hypothesis 3, confirmed for the additive seam.** One `applySize` callback cannot give two viewers different wrapped output. The broker returns `unsupported-divergent`. A second PTY or per-client rewrite was not built. Those would be new infrastructure, not an additive wrapper.

**Hypothesis 4, confirmed.** Follow-the-focused-client passes all four locked cases. `pty-session.ts` was not edited.

**Chosen policy: follow the focused client.** Hidden never applies. Sole remaining viewer becomes focused. No viewers: hold last size. Reconnect attaches visible and unfocused, so the post-connect nudge cannot steal size from a still-focused peer.

**FR-38 is additive for v2-only attach.** Mixed v1+v2 attach to the same session is not. Today's `tower-websocket.ts:76-80` still calls `session.resize` directly. A v2 wrapper cannot stop a v1 client. `POST /api/terminals/:id/resize` is the same hole. That is a scope call, not a reason to edit `pty-session.ts`.

## What worked / what didn't

Follow-focused is a small state machine. The four cases fall out of focus plus visibility. No PTY contract change.

Ignore-hidden is a useful filter and the wrong policy. It only helps tabbed-away panes. Two visible devices still fight.

Per-viewer reflow is the nice UI and it is not additive. I did not try to fake it with client-side xterm wrap. That would look right until the agent drew a full-screen TUI at the PTY's real width, then the iPad would be wrong in a worse way.

The worktree has no install. Broker tests stayed zero-dep on purpose. The live PTY repro had to run against main's `packages/codev` so `@xterm/headless` and `node-pty` resolve. The file under test is the same bytes.

Not tested: real iPad Safari, WebGL context loss, two humans both sending a focus frame. Last explicit focus would still be last-writer-wins at the focus layer. Treating input as implicit focus is the cheap fix and was not coded.

## Next steps

Promote `v2-resize-broker.mjs` into a new v2 server module. New file only.

v2 attach intercepts resize frames and calls `session.resize` once, through the broker. Add a `focus` control frame. Treat `handleUserInput` from a viewer as implicit focus.

Do not edit `pty-session.ts`.

Decide mixed v1+v2 attach before any production PR: forbid it, or accept the gap until the old UI is not used on that session. Editing `tower-websocket.ts` to route v1 through the broker is a fork-constraint call, not this spike.

Issue #38 can stay open for the production follow-up. This experiment answers the policy question. Use `Refs #38` if a PR is opened for the notes alone.
