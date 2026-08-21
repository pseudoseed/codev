# PIR Review: Make (harness, model) a first-class per-spawn parameter

Fixes #2

**Issue**: #2
**Branch**: `builder/pir-2`
**Protocol**: PIR (strict)

## Summary

`afx spawn` gains `--harness <name>` and `--model <id>`. The pair resolves into the harness's
own argv rather than being baked into a command path in `.codev/config.json`, which was the only
way to pin a model before this — and it applied to every agent in the workspace and was invisible
to `afx`, `porch`, and `consult`.

Two-thirds of the issue's scope turned out to be already done, and saying so was most of the value
of the plan phase:

- **Harness selection and gate profiles** shipped in #4 (`OPENCODE_PROFILE`,
  `assertBuilderHarnessHasGateProfile`, `buildScriptPromptArg`). Acceptance criteria 3 and 4 were
  already satisfied.
- **The consult half** shipped in spec 1286 as `--model-id`. See below.

What was genuinely missing was that no caller could *choose*: `SpawnOptions` had no field,
`cli.ts` registered no flag, and every spawn path recomputed the agent from workspace config.

## The issue asked for something that already shipped

The issue's example is `consult -m codex --model gpt-5.6-sol`. That capability exists today as:

```
consult -m codex --model-id gpt-5.6-sol --type integration pr 17
```

On `consult`, `-m/--model` already means the **lane** (gemini / codex / claude / hermes);
`--model-id` is the provider model id, outranking config `consult.models.<lane>`. It ships with
`validateModelId` for syntax, `assertLaneAcceptsModelOverride` so a selector-less lane errors
rather than silently ignoring the flag, and a `model_id` metrics column.

Implementing the issue's literal syntax would have **redefined a shipped flag**, breaking every
existing `consult -m codex` invocation — including the ones porch emits itself at
`porch/next.ts:585` and `:619`.

**Decision (architect-confirmed, independently verified against `consult --help`): `consult` and
`porch` get no code change.** The pair is `(-m lane, --model-id id)` on consult and
`(--harness, --model)` on `afx spawn`, where nothing collides. Recorded on issue #2 so it is not
refiled.

### The doc bug that caused it

`--model-id` appeared in **none** of the four `consult` skill copies. A shipped flag that no doc
mentions is, for practical purposes, a flag that does not exist — which is exactly how this issue
came to ask for it. Fixed in all four copies (`.claude`/`.codex` × ours/skeleton, kept
byte-identical), along with two other registered-but-undocumented flags (`--branch`, `--base`) and
a note that `-m` selects the lane while `--model-id` selects the model.

Also corrected in the `afx` skill: it claimed "**There is NO** `-t`, `--title`, `--name`, or
`--branch` **flag**" when `cli.ts` has registered `--branch <name>` since Spec 609.

## Design

Follows the `buildScriptPromptArg` precedent from #4 — a small optional method on
`HarnessProvider` rather than special-casing a harness at the call site.

- `buildModelArgs?` / `buildScriptModelArg?`, in the dual argv/script form the file already uses.
  Flags verified against the installed CLIs, not assumed: claude `--model`, codex-cli 0.148.0
  `-m, --model`, opencode 1.18.18 `-m, --model` (`provider/model` form). `MODEL_ID_RE` already
  permits `/`, so `x-ai/grok-4.6` validates unchanged.
- **Absence of the hook is meaningful**: it declares "no model selector", and
  `assertHarnessAcceptsModel` turns that into a loud error. Modelled directly on
  `assertLaneAcceptsModelOverride`, and for the same reason — `--model-id` once shipped
  registered, documented, unit-tested and **completely inert**.
- `resolveBuilderSelection` resolves the pair once, above the mode dispatch, so the gate-profile
  pre-flight judges the command that will actually launch rather than the workspace default.
- The model folds into `baseCmd` **once**, so it reaches the fresh, session-pinned and
  crash-resume launch forms alike.

## The v18 migration and its NULL semantics

`builders` gains two additive, nullable columns: `harness`, `model`.

- **Additive and nullable, no data rewrite.** `NULL` means "not recorded" — every row written
  before this existed, and any spawn that named no model. That is the honest value, and it is what
  makes `selectionForResume` fall back to today's behaviour rather than invent a pair.
- **PRAGMA-gated**, mirroring v16/v17, *not* a blanket `try/catch`. A blanket catch would let a
  real ALTER failure be recorded as "migrated" — and since `upsertBuilder`'s INSERT now names both
  columns, every subsequent builder write would then fail against a table missing them.
- `GLOBAL_CURRENT_VERSION` bumped to 18. Missing that bump is a silent trap: `ensureGlobalDatabase`
  seeds `1..GLOBAL_CURRENT_VERSION` and **returns early** on a fresh install, so a fresh db would
  report v17 and re-run the block on its next open. Nothing breaks loudly, which is why it needed
  catching. A test now pins the constant to the highest migration block.
- `upsertBuilder` uses `COALESCE` on both columns so a later status-only upsert cannot wipe the
  pair recorded at spawn.

Verified on a real database: a fresh install carries both columns and records 18; a simulated
pre-v18 database gains both columns on next open with legacy rows preserved as `NULL`.

## Why resume persistence is in scope

Every spawn path recomputes its agent from config — `--resume` included. Harmless while the agent
*was* the config value; once the pair is per-spawn, a resume would silently drop it and relaunch on
the workspace default, with no error and no warning.

The architect hit the inverse the same day: changing the builder model by editing a wrapper script,
then `afx spawn 4 --resume` picking the new value up. A flag that quietly stops applying is worse
than no flag, so the pair is persisted and read back, with an explicit flag on the resume command
still winning.

## Three defects found after the first green run

Two were mine, and only one was caught by a test I wrote.

1. **A regression I introduced**, caught by the existing #4 gate-profile suite.
   `assertHarnessCommandAgrees` fired on *inferred* harness names, not just explicit ones. An
   unrecognized builder command has always fallen back to the claude harness, and those tests
   depend on `my-custom-agent` reaching the gate-profile check — so the assertion rejected three
   long-standing valid configs.

2. **A null model crashing resume**, found while writing the resume test.
   `resolveBuilderSelection` treats "a model was requested" as `!== undefined`, so a raw `null`
   would be validated as a model id and throw.

3. **An Issue #1338 retirement bypass (`c88d5b862`) — found by re-reading my own diff, not by any
   test.** For an inferred harness I derived the name via `detectHarnessFromCommand` and handed it
   to `resolveHarness` as an *explicit* name. Those take different branches: the explicit path
   consults custom harnesses, the auto-detect path deliberately does not. So `shell.builder:
   "gemini --yolo"` plus a custom `gemini` harness would have resolved that custom provider and
   **launched a retired CLI**, where `getBuilderHarness` throws. #1338 killed that path on purpose.
   Now delegates with the same call shape `getBuilderHarness` uses; pinned in both directions
   (auto-detected `gemini` stays retired, explicit custom `gemini` still resolves).

## Files Changed

```
.claude/skills/afx/SKILL.md                        |   6 +-
 .claude/skills/consult/SKILL.md                    |  18 +-
 .codex/skills/afx/SKILL.md                         |   6 +-
 .codex/skills/consult/SKILL.md                     |  18 +-
 codev-skeleton/.claude/skills/afx/SKILL.md         |   6 +-
 codev-skeleton/.claude/skills/consult/SKILL.md     |  18 +-
 codev-skeleton/.codex/skills/afx/SKILL.md          |   6 +-
 codev-skeleton/.codex/skills/consult/SKILL.md      |  18 +-
 codev-skeleton/resources/commands/agent-farm.md    |   2 +
 codev/plans/2-harness-model-params.md              | 349 +++++++++++++++++++++
 .../2-make-harness-model-a-first-cla/status.yaml   |  22 ++
 codev/resources/arch.md                            |  36 +++
 codev/resources/lessons-learned.md                 |  42 +++
 codev/reviews/2-harness-model-params.md            | 220 +++++++++++++
 codev/state/pir-2_thread.md                        | 141 +++++++++
 .../src/agent-farm/__tests__/harness-model.test.ts | 120 +++++++
 .../agent-farm/__tests__/issue-2-migration.test.ts | 142 +++++++++
 .../__tests__/send-architect-identity.test.ts      |   7 +-
 .../agent-farm/__tests__/spawn-cli-flags.test.ts   |  49 +++
 .../__tests__/spawn-model-selection.test.ts        | 256 +++++++++++++++
 .../__tests__/spawn-resume-selection.test.ts       |  98 ++++++
 .../agent-farm/__tests__/spawn-worktree.test.ts    |  86 +++++
 packages/codev/src/agent-farm/cli.ts               |   4 +
 .../src/agent-farm/commands/spawn-worktree.ts      |  41 ++-
 packages/codev/src/agent-farm/commands/spawn.ts    | 175 ++++++++---
 packages/codev/src/agent-farm/db/index.ts          |  23 +-
 packages/codev/src/agent-farm/db/schema.ts         |   5 +
 packages/codev/src/agent-farm/db/types.ts          |   4 +
 packages/codev/src/agent-farm/state.ts             |  12 +-
 packages/codev/src/agent-farm/types.ts             |  11 +
 packages/codev/src/agent-farm/utils/config.ts      | 168 +++++++++-
 packages/codev/src/agent-farm/utils/harness.ts     | 148 +++++++++
 .../__tests__/issue-2-artifact-collision.test.ts   |  93 ++++++
 packages/codev/src/commands/porch/artifacts.ts     |  76 ++++-
 34 files changed, 2352 insertions(+), 74 deletions(-)
```

## Commits

- `615b7389e` [PIR #2] fix(porch): resolve artifacts by exact project id before zero-stripped
- `1e1464bab` [PIR #2] docs: review artifact, arch and lessons updates
- `b5c5134c9` [PIR #2] docs: builder thread for the implement phase
- `c88d5b862` [PIR #2] fix: keep auto-detected retired harnesses retired (Issue #1338)
- `885f1cb69` [PIR #2] fix: tolerate a raw null model when recovering a pair on resume
- `61acbab35` [PIR #2] fix: only enforce harness/command agreement for an EXPLICIT --harness
- `b0fbb54a6` [PIR #2] docs: document --harness/--model, and fix the stale docs that caused this issue
- `024257cce` [PIR #2] chore: drop now-unused getResolvedCommands/getBuilderHarness imports
- `e7e468a88` [PIR #2] fix: bump GLOBAL_CURRENT_VERSION so a fresh install records v18
- `815bbb89e` [PIR #2] test: cover per-spawn (harness, model) selection
- `3eeb8b204` [PIR #2] feat: (harness, model) as a per-spawn parameter
- `273a6cc56` [PIR #2] Plan draft

## Test Results

`npm test` — **5443 passed, 0 failed, 48 skipped, exit 0** (~305s). Independently re-run by the
architect on this branch: 5443 passed, 0 failed, 315.7s.

New coverage (five suites), weighted toward the two properties that matter:

- **A bad pair creates NO state** — driven through the real `spawn()` against a real temp
  workspace, including that the gate-profile check judges the *selection's* command.
- **Byte-identity** — with neither flag, the generated launch script is identical to before
  (uuid normalised). This threads a new parameter through the repo's highest-churn file.

Also verified against the real `afx` binary rather than only through tests: all four fail-closed
paths refuse with `.builders` never created; the generated `.builder-start.sh` carries
`claude --model 'sonnet'` in every launcher **including** `codev_launch_resume`; the builder row
persisted `harness=claude, model=sonnet`.

## ⚠️ `porch.checks.tests.skip` is set workspace-wide — issue #8 must remove it

porch's check timeout is a hardcoded 300s (`porch/checks.ts` `DEFAULT_TIMEOUT_MS`) and this repo's
suite takes ~305s, so `porch done` **times out on a green suite**. There is no `timeout` key in the
`porch.checks` override, so the only way past was `{"porch":{"checks":{"tests":{"skip":true}}}}`.

That lives in the workspace-root `.codev/config.json`, which **every builder worktree symlinks**.
It is not scoped to this project: porch currently skips the tests check for every future builder in
this workspace. It is set right now, deliberately, and **issue #8 must remove it** once the timeout
is configurable.

I initially described this as "local-only" because it is untracked and stays out of the PR. That
understated it — I checked git tracking but not that the path was a symlink to the workspace root.

## ⚠️ This had TWO of THREE review lanes — Codex never ran

| Lane | Verdict | Notes |
|---|---|---|
| **codex** (gpt-5.6-sol) | **NEVER RAN** | Provider usage quota exhausted; retried twice earlier on 2026-08-21 by the architect, and again by this lane. Restores 2026-08-27. **No codex findings exist for this change.** |
| gemini (agy) | APPROVE, HIGH | No issues raised. |
| claude | REQUEST_CHANGES, HIGH | Blocking findings all addressed — see below. |

The codex lane was skipped on explicit human instruction rather than block a fork-local change
for six days. The absence is recorded as a NOT-RUN file at
`codev/projects/2-make-harness-model-a-first-cla/2-review-iter1-codex.txt`, carrying
`VERDICT: SKIPPED` and `CONFIDENCE: NONE` so it cannot be misread as a review that happened.

Weigh this as **two-lane coverage on a change that touches shared porch artifact resolution and
a shared database migration**, with one independent verifier absent.

### What the Claude lane caught, and what changed because of it

All four blocking/minor findings were real and are fixed — none argued down:

1. **The `artifacts.ts` change was invisible in this review.** Correct: I committed the resolver
   fix *after* writing the review, and the Deviations section didn't mention it. It is now
   documented with its blast radius stated (see Deviations below). This was the most valuable
   finding — a reviewer reading the PR would not have known shared porch resolution changed.
2. **Missing `Fixes #2` and the template-required `## Files Changed` / `## Commits` sections.**
   Added.
3. **`assertHarnessAcceptsModel` never listed model-capable CUSTOM harnesses** in its error
   message — it resolved alternatives via `getBuiltinHarness`, so a user whose own config
   declared a model-capable harness was told only built-ins were available. A real message bug;
   the accepting set is now computed by the caller, which is the only scope that knows the custom
   harnesses. Pinned by a test.
4. **The byte-identity test covered claude only** (the plan said all three), and the launcher
   loop's `if (body !== undefined)` meant a launcher regex that stopped matching would silently
   skip its own assertion — a test that passes by not looking. Both fixed: byte-identity now runs
   across claude/codex/opencode, and each launcher must exist before its content is asserted.

Gemini's lane returned APPROVE with no issues.

### One operational note for whoever tests this manually

This workspace's `shell.builder` is the wrapper `/Users/chris/dev/codev-1455/.local/bin/claude`.
By design (step 2 of `resolveHarnessCommand`), `--harness claude` resolves *that path* so a pinned
absolute path survives. If the wrapper itself already appends `--model`, a manual test will
produce **two** `--model` flags. That is the pre-existing wrapper hack this issue exists to
replace, not a defect in the new code — but it will look like one.

## Architecture Updates

Routed to **COLD** (`codev/resources/arch.md`, Agent Farm Internals → new "Per-Spawn Agent
Selection: `(harness, model)`"). Added: the `AgentSelection` shape and where it resolves; the two
optional `HarnessProvider` model hooks and why their *absence* is meaningful; the single
`baseCmd` fold point that makes the model survive crash-resume; command resolution order for an
explicit `--harness`; the two no-bypass pre-flights; the inferred-vs-explicit distinction and why
the inferred branch must preserve `getBuilderHarness`'s call shape (#1338); and the v18 columns
with their NULL semantics.

**Not routed to HOT.** `arch-critical.md` is at its 10-fact cap. This is reference detail about
one subsystem's spawn path, not a cross-cutting invariant needed at decision time, so it does not
earn a displacement. The existing hot fact about worktrees and `afx` already covers what a reader
must know before touching spawn.

## Lessons Learned Updates

Routed to **COLD** (`codev/resources/lessons-learned.md`). Four entries:

- **Architecture** — an absent optional hook should mean "unsupported" and be *asserted*, not
  silently no-op'd. The `--model-id` inert-flag history is the worked example.
- **Architecture** — resolution helpers can differ by *branch*, not just by result. Deriving an
  argument yourself and passing it in looks equivalent and can silently switch branches; preserve
  an existing resolver's call shape. This is the #1338 bypass, generalised.
- **Testing** — "no output and 0% CPU" is not evidence of a hung test run under a buffered
  single-fork runner; `%CPU` is a lifetime average and an I/O-bound suite legitimately reads near
  zero. I killed the suite repeatedly on this reasoning and it cost far more than waiting once.
- **Testing** — add a new migration's version to the constant a *fresh* install seeds, and pin
  that constant to the highest migration block in a test.

**Not routed to HOT.** `lessons-critical.md` is at its 10-lesson cap, and its existing entries
("Verify reviewer/plan claims against the actual file before acting", "'It compiled' is not 'it
works'") already carry the decision-time shape of these. None earns a displacement.

## Things to Look At During PR Review

1. **`assertHarnessCommandAgrees`** (`utils/config.ts`) — the explicit-vs-inferred distinction.
   Wrong once; the #4 suite caught it.
2. **The inferred branch of `resolveBuilderSelection`** — it delegates with `getBuilderHarness`'s
   call shape specifically so auto-detected retirement cannot be shadowed by a custom harness.
3. **The byte-identity test** (`spawn-worktree.test.ts`) — the guard that a no-flag spawn is
   unchanged.

## Deviations from the approved plan

- **`buildWorktreeLaunchScript` IS threaded** (the plan said untouched). Leaving worktree mode out
  would have made both flags silently inert in one spawn mode — the failure the rest of the change
  exists to prevent. Six lines, same shape as `startBuilderSession`.
- **Two extra doc fixes** in files already being edited (the false `--branch` claim, and consult's
  missing `--branch`/`--base`). Correcting a doc while leaving a known-false line in it was not
  defensible.
- **`packages/codev/src/commands/porch/artifacts.ts` — an out-of-plan change to SHARED porch
  artifact resolution.** Not in the plan's Files to Change; added mid-review-phase when the plan's
  own filename-collision caveat came true and blocked this project's review checks.

  **Blast radius: this changes how EVERY project in EVERY workspace resolves its spec, plan,
  review and project directory — not just id 2.** `matchesProjectId` zero-strips both sides, so
  id `2` matched both `2-foo.md` and the legacy `0002-architect-builder-tick-001.md`, and
  `Array.find` picked whichever readdir yielded first. `matchesProjectIdExact` + `findByProjectId`
  prefer the canonical no-leading-zeros form (CLAUDE.md's convention) and fall back to the
  zero-stripped match, so genuinely zero-padded legacy projects still resolve. All 11 find-by-id
  sites route through the one helper.

  Renaming the two colliding legacy files was considered and **rejected by the architect**: they
  are upstream artifacts, renaming forks someone else's historical record into permanent
  divergence that every upstream sync must carry, and it fixes one id at a time while the fork's
  restarted numbering guarantees the collision recurs on 3, 5, 7 and onward. The scope creep was
  accepted explicitly because the alternative was this project blocked behind a separate PR.

## How to Test Locally

```bash
afx dev pir-2          # or: node packages/codev/bin/afx.js spawn --help
afx spawn <n> --protocol air --harness claude --model sonnet
grep "model 'sonnet'" .builders/<id>/.builder-start.sh   # every launcher, incl. resume
afx send <id> "ping"                                     # delivered, not held
```
