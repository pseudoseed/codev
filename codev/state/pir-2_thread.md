# pir-2 — Issue #2: (harness, model) as a first-class per-spawn parameter

## Plan phase (2026-08-21)

Investigated before writing. Three findings reshaped the scope:

1. **Harness selection is largely built; the plumbing is absent.** `utils/harness.ts` has the
   provider abstraction, three built-ins, custom harnesses, retirement. Issue #4 added opencode's
   gate profile and `assertBuilderHarnessHasGateProfile`. So acceptance criteria 3 and 4 already
   ship. What is missing is that no caller can *choose*: `SpawnOptions` has no field, `cli.ts`
   registers no flag, and `spawn()` reads workspace config on every path.

2. **consult's model half already shipped as `--model-id` (spec 1286).** The issue asks for
   `consult -m codex --model gpt-5.6-sol`, but `-m/--model` on consult already means the *lane*.
   Implementing the literal syntax would break every existing `consult -m codex`, including the
   ones porch emits (`porch/next.ts:585,619`). Plan keeps `--model-id`, adds no alias, and uses
   `--model` only on `afx spawn` where nothing collides. Net effect: **consult and porch need no
   code change.** Flagged to the reviewer as a scope reduction rather than dropped quietly — this
   is the one decision I want confirmed at the gate.

3. **`baseCmd` in `startBuilderSession` is the single seam** reaching fresh, session-pinned, and
   crash-resume launch forms. Folding the model flag there covers all three, and Tower's relaunch
   (which re-runs the written script) keeps the model for free. The *harness*, though, is resolved
   inside that function from config, so `--harness` must be passed in explicitly.

Verified the model flags against the installed CLIs rather than assuming: claude `--model`,
codex-cli 0.148.0 `-m/--model`, opencode 1.18.18 `-m/--model` (format `provider/model`). All three
take `--model`. `MODEL_ID_RE` already allows `/`, so `x-ai/grok-4.6` validates unchanged.

### Subtle risk I want on the record

`resolveProfile` keys off the command **basename**, while an explicit `--harness X` names the
harness directly. If `harness.X.command` points at a differently-named wrapper, the spawn-time
gate-profile check and the runtime render gate disagree: spawn passes, then every `afx send` is
held `no-profile`. That is precisely the unmessageable-builder failure criterion 4 exists to
prevent, re-entering through a side door. Plan asserts name/command agreement at spawn.

### Filename collision (resolved)

Porch's prompt named `codev/plans/0002-architect-builder.md` — which **already exists** as the
Architect-Builder Pattern plan from 2025-12-02. Writing there would have destroyed a historical
artifact. Used `codev/plans/2-harness-model-params.md` instead, following PIR #4's precedent
(`4-opencode-builder-harness.md`) and CLAUDE.md's no-leading-zeros rule. `matchesProjectId`
zero-strips, so `plan_exists` passes.

Caveat recorded in the plan: `LocalResolver` uses `files.find()` over `readdirSync`, so with two
files matching id 2 the legacy `0002-…` sorts first. Harmless for `plan_exists`, and PIR #4 shipped
through the identical collision — but a content-reading check (`has_phases_json`) would read the
wrong file.

**Status**: plan committed, `plan-approval` gate pending. Awaiting human review.
