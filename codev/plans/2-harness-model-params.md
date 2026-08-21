# PIR Plan: Make (harness, model) a first-class per-spawn parameter

**Issue**: #2
**Protocol**: PIR (strict)
**Branch**: `builder/pir-2`

---

## Understanding

Today an agent's identity is a *path string in workspace config*. `.codev/config.json` holds:

```json
"shell": { "architect": "…/.local/bin/claude", "builder": "…/.local/bin/claude", "shell": "bash" }
```

`getResolvedCommands()` (`utils/config.ts:240-249`) returns that string, and `getBuilderHarness()`
(`utils/config.ts:281-291`) resolves a `HarnessProvider` from `shell.builderHarness` or by
auto-detecting the command's basename. Both are **workspace-global and recomputed from config on
every spawn** — there is no per-spawn seam at all. That is why pinning Sonnet for one builder meant
hand-editing `.local/bin/claude`: the only writable surface was the path.

Three things narrow the work considerably from the issue's framing.

### Finding 1 — harness selection is solved; the *plumbing* of it is not

`utils/harness.ts` (537 lines) already has `HarnessProvider`, the three built-ins, custom-harness
config, retirement, and auto-detection. Issue #4 added `OPENCODE_PROFILE`, the opencode
`buildScriptPromptArg` hook, and `assertBuilderHarnessHasGateProfile` in `spawn()`
(`commands/spawn.ts:906-919, 977`). So acceptance criterion 3 (measured gate profile for opencode)
and criterion 4 (fail loudly on an unprofiled harness) **already ship**.

What is missing is that no *caller* can choose. `spawn()` reads config; `SpawnOptions`
(`types.ts:78-114`) has no `harness` or `model` field; `cli.ts:302-317` registers no such flag.

### Finding 2 — consult's model half already shipped, under a different name

Spec 1286 gave consult exactly this pair:

- `-m, --model <lane>` — the **lane** (gemini / codex / claude / hermes) — `cli-options.ts:31`
- `--model-id <id>` — the **provider model id**, outranking config `consult.models.<lane>` — `cli-options.ts:39`

with `validateModelId` (`lib/consult-lanes.ts:131`), `assertLaneAcceptsModelOverride`
(`consult-lanes.ts:153`) so a lane with no model selector errors instead of silently ignoring the
flag, per-lane resolution at `consult/index.ts:1286-1318`, and a `model_id` metrics column.

The issue's example `consult -m codex --model gpt-5.6-sol` is served **today** by
`consult -m codex --model-id gpt-5.6-sol`.

**This is a naming collision, and it is the one decision I want confirmed at the gate.** On consult,
`--model` already means *the lane*. Redefining it to mean the model id would break every existing
`consult -m codex` invocation, including the ones porch itself emits at `porch/next.ts:585` and
`:619`. So I plan to **keep `--model-id` on consult unchanged and add no alias**, and use `--model`
on `afx spawn`, where nothing collides. The pair is then `(-m lane, --model-id id)` for consult and
`(--harness, --model)` for spawn — consistent in meaning, different in spelling, because consult's
spelling is already taken.

Consequence: **consult and porch need no code change** for this issue. Porch-emitted consultations
already honour `consult.models.<lane>` from config, so a model *is* selectable there. I am flagging
this as a scope reduction rather than quietly dropping it.

### Finding 3 — `baseCmd` is the one seam that reaches every launch form

`startBuilderSession(config, builderId, worktreePath, baseCmd, …)`
(`commands/spawn-worktree.ts:1037-1045`) derives *every* invocation from that single string:

- `withRole` = `${baseCmd} ${roleFragment}` (:1100)
- `freshCommand` = `${withRole} ${promptArg}` (:1109)
- session-pinned fresh, and the crash-**resume** line `${baseCmd} ${resumeFragment} …` (:1125-1128)
- the session-less historical loop (:1133)

So a model flag folded into `baseCmd` propagates to the fresh launch, the pinned launch, and the
crash-resume relaunch without touching the loop builders. That also means Tower's crash-relaunch,
which re-runs the already-written `.builder-start.sh`, keeps the model for free.

The harness, however, is resolved *inside* that function via `getBuilderHarness(config.workspaceRoot)`
(:1069) — config-derived — so a per-spawn `--harness` must be passed in explicitly.

---

## Proposed Change

Five commits in one PR. The shape follows the `buildScriptPromptArg` precedent the issue's own
comment names: an optional method on `HarnessProvider`, absent by default, rather than special-casing
a harness in the caller.

### 1. Model hooks on `HarnessProvider`

Add two optional methods, mirroring the existing `buildRoleInjection` / `buildScriptRoleInjection`
dual-form convention:

```ts
/** Node argv form. Omitted means: this harness exposes no model selector. */
buildModelArgs?(modelId: string): string[];
/** Bash-script fragment form. Omitted means the same. */
buildScriptModelArg?(modelId: string): string;
```

Flags verified against the installed CLIs on this machine, not assumed:

| Harness | Version checked | Flag | Fragment |
|---|---|---|---|
| claude | (current) | `--model <model>` | `--model '<esc>'` |
| codex | codex-cli 0.148.0 | `-m, --model <MODEL>` | `--model '<esc>'` |
| opencode | 1.18.18 | `-m, --model` , format `provider/model` | `--model '<esc>'` |

All three accept `--model`, so no harness needs a divergent spelling — but the hook still exists per
harness so a future one that differs does not force a caller-side special case. Escaping goes
through the existing `shellEscapeSingleQuote`.

`MODEL_ID_RE` already permits `/` , so opencode's `provider/model` (e.g. `x-ai/grok-4.6`) validates
without loosening the pattern.

**Custom harnesses**: extend `CustomHarnessConfig` with optional `modelArgs?: string[]` and
`modelScriptFragment?: string`, expanding a new `${MODEL}` template var alongside `${ROLE_FILE}` /
`${ROLE_CONTENT}`. Absent = no model selector. `validateCustomHarnessConfig` gains matching optional
checks. Additive; existing configs are unaffected.

### 2. Fail loudly, never silently ignore

Add `assertHarnessAcceptsModel(harnessName, provider)` in `utils/harness.ts`, modelled directly on
`assertLaneAcceptsModelOverride`. If `--model` is passed and the provider defines no
`buildScriptModelArg`, abort with a message naming the harness and which harnesses do accept a model.

Reuse `validateModelId(id, '--model')` from `lib/consult-lanes.ts` rather than writing a second
regex — its `key.startsWith('-')` branch already formats CLI-flag errors correctly (it suppresses
the "in Codev config" clause). Both files are inside `packages/codev/src`, so this is an
intra-package import; I will confirm it introduces no cycle before relying on it, and inline a small
copy if it does.

The precedent that matters here is `cli-options.ts:1-13`: `--model-id` once shipped registered,
documented, unit-tested, and **completely inert**. Every new flag in this change gets an assertion
that it took effect.

### 3. One resolution point for `(harness, model, command)`

Add to `utils/config.ts`:

```ts
export interface AgentSelection {
  harnessName: string;       // explicit --harness, else detected/config
  command: string;           // the agent command, model flag NOT yet appended
  provider: HarnessProvider;
  modelId?: string;
}
export function resolveBuilderSelection(
  opts: { harness?: string; model?: string },
  workspaceRoot?: string,
): AgentSelection
```

Command resolution for an explicit `--harness X`:

1. `.codev/config.json` → `harness.<X>.command`, if set
2. else, for a built-in name, the bare binary (`opencode`, `codex`, `claude`)
3. `--harness` absent → today's `getResolvedCommands().builder` — **the config value stays the
   fallback**, as the issue requires.

Then two assertions before anything is created:

- `assertBuilderHarnessHasGateProfile` — moved to run against **this selection's** command rather
  than `getResolvedCommands(workspaceRoot).builder`. Without this move, `--harness opencode` in a
  claude-configured workspace would check the wrong command.
- **Name/command agreement**: when `--harness X` is explicit, assert
  `detectHarnessFromCommand(command) === X`. This is the subtle failure the issue is really about.
  `resolveProfile` (`gate-profiles.ts:196-201`) keys off the command *basename*, while the harness
  name would come from the flag. A `harness.X.command` pointing at a differently-named wrapper makes
  the spawn-time check and the runtime render gate disagree — spawn passes, then every `afx send` is
  held with `no-profile`. Exactly the unmessageable-builder class criterion 4 exists to prevent,
  reintroduced through a side door. Assert they agree; fail with both values named.

### 4. CLI wiring and threading

- `types.ts` `SpawnOptions`: add `harness?: string; model?: string;`
- `cli.ts:302-317`: register `--harness <name>` and `--model <id>`; forward both in the action
  (`cli.ts:352-368`) — the field-by-field mapping there is precisely where `--model-id` was dropped
  once, so a forwarding test comes with it.
- `spawn()` (`spawn.ts:940-1000`): call `resolveBuilderSelection` once, run both assertions in the
  existing pre-flight slot next to `assertBuilderHarnessNotRetired`, and pass the selection to the
  mode handlers.
- The four `startBuilderSession` call sites (`spawn.ts:483, 557, 616, 854`) pass
  `selection.command` + the model fragment instead of `commands.builder`, and hand the selection in.
- `startBuilderSession` gains **one** optional trailing parameter, `selection?: AgentSelection`,
  defaulting to today's config resolution — so `buildWorktreeLaunchScript` and any caller that does
  not care stays untouched. Inside, `baseCmd` becomes `${command} ${modelFragment}` when a model is
  set, which per Finding 3 reaches fresh, pinned, and crash-resume launches alike.

Keeping the diff additive-and-optional is deliberate: the issue flags `packages/codev` as upstream's
highest-churn area, so every new parameter is optional with today's behaviour as its default, and no
existing call site changes shape.

### 5. Persist the selection so `--resume` does not silently lose it

`spawnPir` does `const commands = getResolvedCommands();` (`spawn.ts:852`) on **every** path,
including `--resume`. So a builder spawned with `--model sonnet` and later resumed comes back on the
config default, silently, with no error — the same class of quiet wrongness this issue exists to
kill.

Fix: persist `harness` and `model` on the builder row in `upsertBuilder` (`spawn.ts:860-867`), and on
`--resume` use the stored values unless flags override. The `model_id` column in
`consult/metrics.ts:266` is the in-repo precedent for the additive-column migration.

**This is beyond the issue's literal text and is the one part I would cut first if the reviewer wants
a smaller diff.** Without it, per-spawn selection works but resume reverts. I recommend keeping it,
because a flag that silently stops applying is worse than no flag.

### 6. Docs

`--harness` / `--model` documented in the afx skill and command reference. The skill exists as four
real files (not symlinks) in two byte-identical pairs — `.claude/skills/afx/SKILL.md` +
`.codex/skills/afx/SKILL.md`, and the same two under `codev-skeleton/`. All four updated, pairs kept
identical, plus `codev-skeleton/resources/commands/agent-farm.md`. Per CLAUDE.md, a framework change
lands in both trees.

---

## Files to Change

| File | Change |
|---|---|
| `packages/codev/src/agent-farm/utils/harness.ts` | `buildModelArgs?` / `buildScriptModelArg?` on `HarnessProvider`; implement for the 3 built-ins; `modelArgs`/`modelScriptFragment` + `${MODEL}` for custom; `assertHarnessAcceptsModel`; validation |
| `packages/codev/src/agent-farm/utils/config.ts` | `AgentSelection` + `resolveBuilderSelection`; command resolution for an explicit harness |
| `packages/codev/src/agent-farm/commands/spawn.ts` | Move gate-profile assert onto the selection; add name/command agreement assert; thread selection through the 4 `startBuilderSession` call sites; persist on `upsertBuilder` |
| `packages/codev/src/agent-farm/commands/spawn-worktree.ts:1037-1109` | Optional `selection` param; fold model fragment into `baseCmd` |
| `packages/codev/src/agent-farm/types.ts:78-114` | `harness?` / `model?` on `SpawnOptions` |
| `packages/codev/src/agent-farm/cli.ts:302-368` | Register + forward the two flags |
| `packages/codev/src/agent-farm/db/` (schema) | Additive `harness` / `model` columns on the builder row |
| `.claude/skills/afx/SKILL.md`, `.codex/skills/afx/SKILL.md`, both `codev-skeleton/` twins, `codev-skeleton/resources/commands/agent-farm.md` | Flag docs |

**Not changed, with reason**: `commands/consult/*` and `commands/porch/*` — the model half already
ships there as `--model-id` (Finding 2). `gate-profiles.ts` — opencode's profile landed in #4.
Architect-side harness/model selection — the issue scopes this to spawn.

---

## Risks & Alternatives Considered

- **Risk — spawn-time and runtime disagree on the agent.** The pre-flight checks a command string;
  the render gate at runtime sees `.builder-start.sh` and re-derives via `harnessFromLaunchScript`
  (`reset/context.ts:442`, `mailbox-wiring.ts:152`). *Mitigation*: the model flag rides inside
  `baseCmd` in the generated script, so the script keeps naming the real agent binary, and the
  name/command agreement assertion (§3) blocks the one configuration that could split them.

- **Risk — merge conflict surface on upstream sync.** Accepted by the issue. *Mitigation*: every
  added parameter is optional with today's behaviour as its default; no existing signature changes
  shape; no call site is reordered. `buildWorktreeLaunchScript` is untouched.

- **Risk — a wrong model id fails late and confusingly.** *Mitigation*: `validateModelId` checks
  syntax at spawn time; existence stays the provider's call, failing loudly with no fallback, which
  is the rule spec 1286 already set.

- **Alternative rejected — redefine consult's `--model` to be the model id.** Matches the issue's
  literal example but breaks every existing `consult -m codex`, including porch's own emissions at
  `next.ts:585/619`. Rejected; raised at the gate instead.

- **Alternative rejected — bake the model into the command path** (`shell.builder: "claude --model sonnet"`).
  Works today by accident and is exactly what the issue is removing: invisible to `afx`, workspace-wide,
  and unreadable by the gate.

- **Alternative rejected — re-parse the model out of `.builder-start.sh` on resume** instead of
  persisting it. `harnessFromLaunchScript` proves script re-parsing is possible, but a regex over a
  generated shell script is a fragile source of truth for a value we control at spawn.

- **Open decision for the reviewer**: keep or cut §5 (resume persistence, the one schema change).

---

## Test Plan

**Unit**

- Each built-in harness emits its verified model flag; a harness with no `buildScriptModelArg`
  triggers `assertHarnessAcceptsModel` rather than dropping the flag.
- Custom harness `${MODEL}` expansion; `validateCustomHarnessConfig` accepts configs omitting the new
  optional fields (back-compat).
- `resolveBuilderSelection`: explicit `--harness` beats config; config remains the fallback when the
  flag is absent; unknown harness errors; retired harness still fails closed.
- Name/command disagreement (`--harness opencode` resolving a `claude`-basename command) aborts.
- Flag forwarding: every option registered on `spawnCmd` reaches `SpawnOptions` — the same test shape
  `__tests__/cli-options.test.ts` uses for consult, since that is the bug it was written for.
- Generated `.builder-start.sh` contains the model flag in the fresh, session-pinned, **and**
  crash-resume lines.
- **Byte-identity guard**: with no `--model`/`--harness`, the generated script is byte-identical to
  today's for all three harnesses. This is the main regression risk of the whole change.

**Manual (for the reviewer at the `dev-approval` gate)**

1. `afx spawn <n> --protocol air --harness claude --model sonnet` → inspect
   `.builders/<id>/.builder-start.sh` for `--model sonnet`; confirm in-session the builder reports
   Sonnet.
2. `afx send <id> "ping"` → responds `delivered`, not `held`/`no-profile`.
3. `afx spawn <n> --protocol air --harness opencode --model x-ai/grok-4.6` → launches, and
   `afx send` delivers (this is the Grok path the issue is ultimately for).
4. `afx spawn <n> --harness <unprofiled>` → refuses at spawn with no worktree, terminal, or builder
   row created.
5. `--model` against a harness with no model selector → clear error, not a silent no-op.
6. Kill a builder's process; Tower relaunches from the script → the model is still pinned.
7. `afx spawn <id> --resume` → same model (§5; if §5 is cut, this reverts to config and the plan says
   so).
8. Regression: a plain `afx spawn <n> --protocol air` with no new flags behaves exactly as before.

**Cross-check**

- `afx doctor` still reports harness config correctly.
- No existing consult or porch behaviour changes — asserted by those suites passing untouched.

---

## Decisions taken at the plan-approval gate

Both open questions were answered by the architect, who verified the consult claim
independently against `consult --help` rather than taking the plan's word for it.

1. **consult**: confirmed. `--model-id` already exists and `-m` is the lane, so the issue's
   literal syntax would break every existing `consult -m codex` including porch's emissions.
   **Not implemented.** consult and porch get no code change. Recorded on issue #2 so it is not
   refiled, and the stale consult skill docs — which never mentioned `--model-id`, and are the
   reason a shipped flag looked missing — are fixed here.
2. **§5 (resume persistence)**: **keep.** The architect hit the inverse the same day: changing the
   builder model by editing a wrapper script, then `afx spawn 4 --resume` picking the new value up.
   Once the model is a spawn parameter rather than a wrapper, resume has to remember it.

### Deviations from the plan as written, and why

- **`buildWorktreeLaunchScript` IS threaded** (the plan said untouched). Leaving worktree mode out
  would have made `--harness`/`--model` silently inert in one spawn mode — the exact failure the
  rest of the change exists to prevent. Six lines, same shape as `startBuilderSession`.
- **Two extra doc fixes** in files already being edited: the afx skill claimed "There is NO
  `--branch` flag" when `cli.ts` registers one (Spec 609), and the consult skill was missing
  `--branch`/`--base` alongside `--model-id`. Same staleness class; correcting a doc while leaving
  a known-false line in it was not defensible.

---

## Note on the artifact filename

Porch's phase prompt named `codev/plans/0002-architect-builder.md`. That file already exists: it is
the Architect-Builder Pattern plan from 2025-12-02, an unrelated historical artifact that collides
because this fork's issue numbering restarted. Writing there would have destroyed it.

This plan therefore uses `codev/plans/2-harness-model-params.md`, following the precedent PIR #4 set
with `4-opencode-builder-harness.md` and CLAUDE.md's "sequential numbering, no leading zeros".
`matchesProjectId` (`porch/artifacts.ts:63-78`) zero-strips leading digits, so `2-…` resolves for
project id `2` and the `plan_exists` check passes.

Caveat worth recording: `LocalResolver.findSpecBaseName` uses `files.find(…)` over `readdirSync`, so
with two files matching id `2` the legacy `0002-…` sorts first and wins. PIR's plan phase only checks
`plan_exists` (satisfied either way), and PIR #4 shipped through the identical collision — but a
content-reading check such as `has_phases_json` would read the wrong file.
