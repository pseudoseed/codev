# Spec 146 — t3code contract churn, classified

Discharges **success criterion 12**: *"The 89 commits to `orchestration.ts` are classified as
breaking or non-breaking against the vendored types, with the breaking count recorded. Counting
commits is not the criterion."*

Produced by `tools/t3-codegen/classify-churn.mjs`. Raw data:
`146-contract-churn-classification.json`.

## Method

For each commit touching the pinned closure, the tool reads that commit's nine contract files,
emits JSON Schema for the eight RPC methods Codev calls, and diffs against the previous commit's
emission. It does not read commit messages and it does not count commits.

Four verdicts, and the fourth matters:

| Verdict | Meaning |
|---|---|
| `consumed-change` | The emitted schema for a method Codev calls changed. **This is the breaking count.** |
| `source-only` | Closure source changed; emitted output did not. |
| `unclassifiable` | The **pinned** Effect could not represent that commit's contracts. Not breaking, not safe — unknown. |
| `baseline` | The first commit in range; nothing to diff against. |

## Result

**Window: 2026-06-01 to 2026-08-25 (the pin), 55 commits touching the closure.**

| Verdict | Count |
|---|---|
| `consumed-change` | **21** |
| `source-only` | 32 |
| `unclassifiable` | 1 |
| `baseline` | 1 |

**The breaking count is 21 of 54 classifiable commits — 39%.** Roughly every third commit that
touches the closure changes a shape Codev consumes.

Narrower windows agree, so this is not an artefact of where the window starts:

| Since | consumed-change | source-only |
|---|---|---|
| 2026-06-01 | 21 | 32 |
| 2026-07-01 | 17 | 23 |
| 2026-08-01 | 10 | 11 |

### Which methods absorb the churn

| Method | Commits changing it |
|---|---|
| `orchestration.dispatchCommand` | 15 |
| `orchestration.subscribeThread` | 13 |
| `vcs.createWorktree` | 1 |
| `orchestration.searchThreads` | 1 |
| `vcs.status` | 1 |

The two methods `porch-driver` is built on are the two that change most. That is the integration's
central risk stated as a measurement rather than a worry.

## Three limits on this number, stated plainly

**1. The window is not the spec's window, and cannot be.** The spec cites 184 commits since
2026-02-07. The full nine-file closure did not exist until **2026-05-02**, when `vcs.ts` and
`sourceControl.ts` were added; `auth.ts` arrived 2026-04-09, `providerInstance.ts` 2026-04-29.
Before that the contract had a different shape, so "changed against the vendored types" has no
referent. 184 counts commits to files that were not yet the closure.

**2. Commits before ~2026-06-01 cannot be classified with the pinned Effect.** They fail inside
`SchemaAST` at representation time because they were written against an older Effect than
`4.0.0-beta.103`. That is a real limit of this method, not a property of those commits, and it is
reported as `unclassifiable` rather than folded into either count.

**3. `source-only` is not "safe".** This is the important one. The emitter drops checks applied on
the decoded side of a `decodeTo` transform, so all 20 schemas in
`packages/types/src/t3/generated/LOSSY.md` — every branded id in the contract — emit as
unconstrained strings. **A commit that relaxed a branded id would land in `source-only` with a
zero-byte schema diff.** So 32 `source-only` commits means "32 commits whose effect on the shapes
we consume is not visible to the emitter", not "32 harmless commits".

That is exactly why `source-hash.json` is the load-bearing drift detector and this classification
is the explainer.

## What it means for the plan

The spec assumed "a pinned commit will go stale in weeks, not years". The measurement says
something sharper: **at 39% and ~20 closure commits a month, roughly 8 commits a month change a
shape Codev consumes.** A pin is stale within days of being set, in the sense that matters.

This does not argue against the approach — it argues that the refresh procedure and the drift
test are operational tooling used constantly, not a safety net touched twice a year. Phase 1
builds them as such.

## Every consumed-change commit

| Date | Commit | Subject | Methods affected |
|---|---|---|---|
| 2026-05-03 | `52c77c1e` | feat(preview): in-app browser preview panel | orchestration.dispatchCommand |
| 2026-06-18 | `52a24c89` | Add origin-based worktree bootstrap option (#3157) | orchestration.dispatchCommand |
| 2026-06-19 | `335e0b59` | Fix PR creation from origin-based worktrees (#3218) | vcs.createWorktree |
| 2026-07-05 | `482d5623` | Load thread snapshots over HTTP before live sync (#3719) | orchestration.subscribeThread |
| 2026-07-09 | `3201e00a` | [codex] Preserve worktree metadata during branch sync (#38 | orchestration.dispatchCommand |
| 2026-07-20 | `8e3467fe` | Synchronize mobile threads with authoritative shell snapsh | orchestration.subscribeThread |
| 2026-07-22 | `32c6012d` | Sidebar v2 beta: flat thread list with a server-backed set | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-07-23 | `fbd77420` | feat: add "Auto" runtime mode — AI-reviewed approvals for  | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-07-23 | `202e5609` | feat(sidebar-v2): thread snoozing (#4311) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-07-30 | `5c9358ac` | feat(web): regenerate thread titles from sidebar (#4810) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-07-30 | `4b71a2ae` | feat(search): find threads by conversation content (#4959) | orchestration.searchThreads |
| 2026-08-04 | `da6e1a96` | feat(sidebar-v2): thread pinning for sidebar v2 (#5312) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-08-06 | `6b73b3de` | feat: paginate thread loading with user-anchored turn wind | orchestration.subscribeThread |
| 2026-08-07 | `5661c611` | feat(web): drag pinned threads into your own order (#5581) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-08-08 | `5bb8c036` | fix(server): settle no longer leaves monitors and dev serv | orchestration.dispatchCommand |
| 2026-08-08 | `6dbffa02` | feat: pick worktree or current checkout per project (#5766 | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-08-09 | `076e9048` | feat(web): project icons can be chosen manually (#5775) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-08-18 | `f21b47e5` | fix(threads): a merged PR settles its thread only once (#7 | vcs.status |
| 2026-08-24 | `7c6163c6` | fix(codex): show app access approval prompts (#8058) | orchestration.dispatchCommand, orchestration.subscribeThread |
| 2026-08-24 | `e9f50c3e` | feat(web): upload image attachments before sending (#8048) | orchestration.dispatchCommand |
| 2026-08-24 | `3c75eb11` | feat: link pull requests to threads (#8160) | orchestration.dispatchCommand, orchestration.subscribeThread |
