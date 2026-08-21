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

## Implement phase (2026-08-21)

Plan approved; architect answered both gate questions. consult confirmed out of scope (they
verified `--model-id` against `consult --help` themselves rather than taking my word). §5 resume
persistence confirmed in — they'd hit the inverse the same day, changing the builder model via a
wrapper script and having `afx spawn 4 --resume` pick it up.

### Shape

- `HarnessProvider` gained optional `buildModelArgs` / `buildScriptModelArg`, per the
  `buildScriptPromptArg` precedent the architect named. Absence means "no model selector", and
  `assertHarnessAcceptsModel` makes that loud.
- `resolveBuilderSelection` resolves the pair once, above the mode dispatch, so the gate-profile
  preflight judges the command that will actually launch. Reused `validateModelId` from
  consult-lanes rather than writing a second regex (checked: no import cycle, and its `fail()`
  throws rather than exiting, which matters because Tower imports config.ts).
- The model folds into `baseCmd` once, so it reaches fresh, session-pinned, and crash-resume forms.

### Two deviations from the plan, both deliberate

1. **`buildWorktreeLaunchScript` IS threaded** (plan said untouched). Leaving worktree mode out
   would make the flags silently inert in one spawn mode — the exact failure the change exists to
   prevent. Six lines.
2. **Two extra doc fixes** in files I was already editing: the afx skill claimed "There is NO
   `--branch` flag" when `cli.ts` registers one (Spec 609); the consult skill was missing
   `--branch`/`--base` as well as `--model-id`.

### Bug caught by running it, not by tests

The unit tests passed, but running the real CLI showed a fresh `global.db` reporting
`max(_migrations.version) = 17`. `ensureGlobalDatabase` seeds `1..GLOBAL_CURRENT_VERSION` and
**returns early** on a fresh install, so forgetting to bump that constant leaves v18 unrecorded.
Nothing breaks loudly — the columns still arrive via GLOBAL_SCHEMA — which is precisely why it
needed catching. Bumped to 18 and added a test that pins the constant to the highest migration
block, so the next migration can't skip the bump silently.

Good reminder that "tests pass" is not "it works": four fail-closed paths, the generated launch
script, and the persisted row were all verified against the real `afx` binary in a temp workspace.

### Verified end-to-end (real binary, temp workspace)

- invalid model id / unknown harness / retired harness / unprofiled harness → all refuse, `.builders`
  never created
- valid `--model sonnet` → passes both preflights, fails later for an unrelated reason
- generated `.builder-start.sh` carries `claude --model 'sonnet'` in every launcher **including**
  `codev_launch_resume`
- builder row persisted `harness=claude, model=sonnet`

### Three more defects found after the first green run

1. **Regression I introduced, caught by the existing Issue #4 suite.**
   `assertHarnessCommandAgrees` fired on *inferred* harness names, not just explicit ones. An
   unrecognized builder command has always fallen back to the claude harness, and the gate-profile
   tests depend on `my-custom-agent` reaching the gate-profile check — so my assertion rejected
   three long-standing valid configs. Only an explicit `--harness` is a promise; `AgentSelection`
   now carries `explicit`.

2. **Null model on resume.** Found while writing the resume test. `resolveBuilderSelection` treats
   "a model was requested" as `!== undefined`, so a raw `null` (the column value for a builder
   spawned with a harness but no model) would be validated as a model id and throw on resume.

3. **Auto-detected retirement could be shadowed — found by re-reading my own code, not by a test.**
   For an inferred harness I was deriving the name via `detectHarnessFromCommand` and handing it to
   `resolveHarness` as an *explicit* name. Those take different branches: the explicit path consults
   custom harnesses, the auto-detect path deliberately does not (Issue #1338). So `shell.builder:
   "gemini --yolo"` plus a custom `gemini` harness would have resolved that custom provider and
   launched a retired CLI, where `getBuilderHarness` throws. Now delegates with the same call shape
   `getBuilderHarness` uses. Pinned in both directions.

Two of the three were mine, and only one was caught by a test I wrote. The other two came from the
existing suite and from re-reading the diff — which is the argument for doing both.

### Test-suite note — I was wrong about a hang

I spent a while convinced the full suite was wedged: no output, and `ps` showing 0% CPU. Both
signals were misleading. `ps` `%CPU` is a **lifetime average**, so a long-running process reads
near zero; and with `singleFork: true` plus no TTY, vitest emits nothing until the whole run
finishes. I killed every run before it could finish and read that as a hang.

It is not a hang. `src/__tests__` simply takes **276 seconds** — 59 files, 1152 tests, all passing.
Full-suite total is roughly 5-6 minutes: agent-farm 3270 (25s), porch+consult 658 (8s), terminal
356 (28s), src 1152 (276s).

Confirmed: a single `npm test` run gives **5443 passed | 48 skipped, exit 0, 305s**.

Lesson worth keeping, and I misread the same signal twice. Under a buffered single-fork runner,
neither "no output" nor "0% CPU" is evidence of a hang. Worse, low CPU is what a HEALTHY run of
this suite looks like — these tests shell out to git/gh constantly, so vitest reported 485s of
test time while burning almost no CPU. The only reliable move was to let it finish.
