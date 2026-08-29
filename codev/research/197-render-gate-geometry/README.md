# 197 — render-gate mirror geometry: measurements

Evidence from Issue #197, kept because **#202** (widening the fact-based geometry check past
`bottomAnchor` profiles) is its direct continuation, and re-deriving any of this costs a live
opencode session plus about twenty minutes.

Four scripts, no captured frames — the four frames that matter are already committed as
fixtures in `packages/codev/src/agent-farm/__tests__/fixtures/gate/opencode197-*.txt`, and
every script here reads them from there. All four run from a checkout:

```bash
pnpm install                                    # node-pty and tsx come from the repo install
pnpm exec tsx codev/research/197-render-gate-geometry/<script>.mts
```

## The finding these establish

Issue #197 was filed as *"the opencode render-gate profile no longer matches"*. **It matched
fine.** opencode was 1.18.18, unchanged since before the fixtures were captured, and all four
`bottomAnchor` patterns still classified six freshly captured live frames exactly as designed.

The real cause was geometry. Every shellper-backed `PtySession` is born at `defaultSessionOptions()`
— 80x24 — and nothing but a connected browser client ever calls `resize()`. Measured on the
live fleet via `GET /api/terminals`, real sessions run at **60-84 rows**. opencode's composer is
bottom-anchored, so a short mirror clips the box out of the viewport entirely, `rulePattern`
matches nothing, and the gate reports `no-composer-marker` — *"this app has no composer"* — for
a composer that is merely off-screen. That mis-signal is what sent the investigation hunting
glyphs.

## The scripts

| script | question it answers |
|---|---|
| `capture-opencode-frames.cjs` | How do I get fresh raw frames from a TUI? Drives a real opencode under node-pty and dumps the byte stream per state. **Reusable for any TUI whose gate profile needs measuring** — the output drops straight into the fixtures directory. Costs one real model turn. |
| `geometry-matrix.mts` | What does the gate say when the mirror disagrees with the agent's geometry, in each direction and both at once? |
| `height-sweep-all-profiles.mts` | Does a short mirror break every harness, or only opencode? |
| `verify-no-keystroke.mts` | Does a live turn on a mismatched mirror ever receive a recovery keystroke? Asserts on **bytes written**, and runs with **no vitest and no port-13999 suite lock**. |

`_paths.mts` resolves the repo root via `git rev-parse`, so nothing is hardcoded to the
worktree these were written in.

## What they measured

**Height sweep** — idle capture per app, mirror heights 10..40 at cols 110:

| app | result |
|---|---|
| claude | clean at every height |
| agy | clean at every height |
| codex | holds below 20 |
| **opencode** | **holds below 32** (its capture height) |

claude, codex and agy survive a short mirror because their composers sit at the cursor and
stay in view — **not because anything guarantees it. They are correct by luck.** A claude that
grew its composer downward would fail exactly as opencode did, silently, and nothing in the
gate would say so. **This is the number #202 needs:** widening the fact-based check means
deciding what a mirror/PTY disagreement should mean for those three, and this is how they
actually behave.

**Geometry matrix** — mid-turn capture, which is the safety-critical one:

```
rows <= 28   geometry-mismatch at every width measured (80..120)
rows >= 31   busy-indicator retained at cols 90..120
cols 80      geometry-mismatch at EVERY height
```

A live turn classifies `busy-indicator` at its capture geometry, but once the mirror is short
or narrow enough the reflow carries opencode's `esc interrupt` footer off the viewport and the
busy proof **vanishes**. The liveness proof is read off the very frame whose geometry is
untrusted, so whether it survives depends on how wrong the geometry happens to be — it cannot
be relied on.

That is why `heldRecoveryAction` returns **nothing** for `geometry-mismatch` rather than simply
running after the busy check. Ordering would have protected only the frames that did not need
protecting. `geometry-mismatch` used to map to `escape-screen`, so a live turn on a badly
mismatched mirror would have been sent an ESC — the one keystroke that policy exists to
withhold from a proven-live turn.

The two grounds for withholding it are **independent**, and either alone is sufficient (see the
FUTILITY / DANGER comment in `mailbox-hold-policy.ts`): no byte sent to an agent can resize
Tower's mirror, and a mismatched frame cannot prove the agent is idle. Disproving one does not
restore ESC.

## A note for whoever runs `verify-no-keystroke.mts`

Its value is that it needs **no suite lock**. It caught an incomplete fix in about a second,
while the real suite was queued behind another builder — the reordering fix looked right,
passed review reasoning, and still wrote an ESC to a live turn. Reach for it when the lock is
busy and you need to know whether a change to the gate is safe.

It carries a positive control, and that is not decoration: without it,
`expect(writes).toEqual([])` passes just as well against a harness that cannot observe a write
at all. A test that cannot fail is not evidence — the same defect as a fixture sweep over an
empty directory, or reading a skipped test as a passing one.
