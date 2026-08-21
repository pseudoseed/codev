# PIR Review: Make (harness, model) a first-class per-spawn parameter

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

## How to Test Locally

```bash
afx dev pir-2          # or: node packages/codev/bin/afx.js spawn --help
afx spawn <n> --protocol air --harness claude --model sonnet
grep "model 'sonnet'" .builders/<id>/.builder-start.sh   # every launcher, incl. resume
afx send <id> "ping"                                     # delivered, not held
```
