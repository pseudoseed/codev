# experiment-38 thread

Spawned soft EXPERIMENT for issue #38 (v2 UI multi-client terminal resize).

The builder prompt named `codev/specs/0038-consult-pr-mode.md`. That spec is a 2025 TICK that already shipped. Porch title and GitHub #38 are the v2 resize spike. Following the issue.

## Hypothesis

Locked in `codev/experiments/38-multi-client-resize/notes.md` before any prototype.

Claim: FR-38 is additive via follow-the-focused-client. Ignore-hidden is not enough (both-visible is the product). Per-viewer reflow is not additive.

## Design

Broker in the experiment tree, callback into `session.resize`. Three policies as named functions. Policy 2 expected to fail two-visible. Policy 3 returns `unsupported` when viewers disagree.

Seam is `tower-websocket.ts:76-80`, not `pty-session.ts:567`. The bug is last-writer-wins because every client frame calls `resize` directly.

## Execute

Last-writer-wins reproduced. `session.info` 80x24 then 40x12. Live `stty size` printed `12 40`. Artifact: `codev/experiments/38-multi-client-resize/artifacts/repro-last-writer-wins.txt`.

Broker: 13/13. follow-focused passes the four locked cases. ignore-hidden fails two-visible and iOS reconnect. per-viewer-reflow returns `unsupported-divergent`.

`pty-session.ts` untouched (`git diff --stat` empty; worktree byte-identical to main).

## Analyze

Chosen policy: follow the focused client. FR-38 is additive for v2-only attach. Mixed v1+v2 on the same session still fights because `tower-websocket.ts:76-80` calls `resize` directly.

Notes complete at `codev/experiments/38-multi-client-resize/notes.md`.

Human approved experiment-complete. `porch approve` then `porch done`. Protocol complete.

#40 already landed on origin/main via PR #42, so the PR base is main. Diff vs main is this experiment only.
