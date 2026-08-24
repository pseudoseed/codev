# bugfix-109 thread

Architect contact: uiv2 (`afx send architect:uiv2`).

## Investigate (2026-08-24)

Reproduced both failures in this workspace, same moment:

```
afx status          builder-bugfix-109  implementing  init
porch status 109    Project 109 not found. Run 'porch init'
porch status bugfix-109   PHASE: investigate
status.yaml         phase: investigate
```

AIR #106 answers to `porch status 106`. BUGFIX 102/113/109 do not answer to the bare number.

### Root cause 1 — frozen spawn snapshot

`afx spawn` writes `status: 'implementing', phase: 'init'` into global.db and never updates those columns:

- `packages/codev/src/agent-farm/commands/spawn.ts:541, 620, 682, 938`

`afx status` prints those columns verbatim:

- `packages/codev/src/agent-farm/commands/status.ts:198-199` (`renderBuilders`)
- same values in `--json` at `:247-248`

Live phase already lives in each worktree `codev/projects/<id>-*/status.yaml`. Tower overview already parses it (`parseStatusYaml` / `discoverBuilders` in `overview.ts`). Dashboard is not this bug. `afx status` is the one surface that still reads the spawn snapshot.

`complete` is already a legal builder status (`types.ts:10`, schema CHECK, `getStatusColor` already paints it green). Nothing ever writes it.

### Root cause 2 — porch ID match is prefix-literal

`findProjectInDir` (`state.ts:267`) matches `name === id || name.startsWith(id + '-')`.

BUGFIX dirs are `bugfix-109-…`. Query `109` looks for `109` or `109-…` and misses. Error at `index.ts:255` always says "not found / porch init", no alias, no suggestion.

Spawn keeps BUGFIX porch ids as `<prefix>-<N>` on purpose (`spawn.ts:880-890`, "historical, kept untouched"). Do not rename them.

### Item 3 (notify on complete)

`advanceProtocolPhase` sets `phase: verified` and commits `protocol complete` (`index.ts:693-701`, `next.ts:364-367`). No architect notify. `notify.ts` only wakes the builder after a gate approval; architect-bound gate pings were removed on purpose (gates need a human). Protocol-complete is a different event: cleanup trigger.

### Scope

Fits BUGFIX. Overlay at read time; do not sync state.db. Accept bare numbers as an alias (or unique "did you mean"). Notify on protocol complete via existing `notifyTerminal('architect', …)`.

Do not: rename BUGFIX porch ids, keep a second status/phase write path, restore gate-to-architect pings.

## Fix (2026-08-24)

Read-time overlay: `porch-overlay.ts` reads worktree status.yaml; `afx status` maps it on load. `verified`/`complete` → status `complete`. No state.db write.

Bare number: `findStatusPath('109')` resolves a unique `bugfix-109`. Ambiguous aliases return null and `projectNotFoundMessage` says "Did you mean".

Protocol complete calls `notifyProtocolComplete` → `afx send architect`.

Regression: `bugfix-109-status.test.ts` fails without the overlay map (`implementing` vs `complete`) and passes with it. 115 targeted tests green. Porch check: build 15.8s, tests 349.6s.

## PR

https://github.com/pseudoseed/codev/pull/136

CMAP r1: gemini skipped (agy quota). Codex+Claude REQUEST_CHANGES: overlay took first status.yaml (0087 complete). Fixed: match builder porch id.

CMAP r2: opencode APPROVE. Codex REQUEST_CHANGES on task/protocol spawn ids — out of issue scope, rebutted. Claude REQUEST_CHANGES: alias reached porch init. Fixed: `findStatusPath(..., { alias: false })` on init.

Live check on this worktree (290 project dirs): overlay reports `pr/pr`, not 0087 `complete`.
