# bugfix-47 builder thread

## Investigate — 2026-08-24

- The prompt names `codev/specs/47-afx-send-builder-message-route.md`, but that file is absent on both this branch and `origin/main`. BUGFIX normally uses the issue as source of truth, and issue #47 contains the full requirements.
- Checked existing work first. PR #80 is already merged and is an ancestor of this branch. It added `from_agent_name` / `requested_to` provenance but deliberately did not fix routing.
- The leading resolver hypothesis is disproven by existing data and tests: with a canonical builder sender, `resolveTarget('architect', ...)` reads `spawned_by_architect` and routes to the owning architect; explicit `architect:<name>` rejects a builder mismatch.
- Reproduced the remaining defect in this live builder session. `afx whoami --json` from the worktree reports `builder-bugfix-47` owned by `uiv2`; after only `cd /Users/chris/dev/codev-1455`, the same session reports architect `uiv2`. The builder inherited `CODEV_ARCHITECT_NAME=uiv2`, while no stable builder identity is exported.
- Root cause: `detectCurrentBuilderId()` in `packages/codev/src/agent-farm/commands/send.ts:111-116` derives builder identity solely from `process.cwd()` and returns `null` outside `.builders/<id>`. `send()` at lines 308-332 then labels the sender `architect` (and records the inherited architect name). Tower receives sender kind `architect`, so `tower-messages.ts:358-373` intentionally applies the non-builder main-first rule. Thus the resolver is correct for the false identity it receives.
- Spawn seam: `startBuilderSession()` writes `.builder-start.sh` but exports only harness-provided env (`spawn-worktree.ts:1092-1108`); it neither exports a stable builder id/worktree root nor removes inherited `CODEV_ARCHITECT_NAME`.
- Scope fits BUGFIX: export a stable builder-session identity at launch, teach sender/workspace detection to use and verify it when cwd moves, and add a regression test covering worktree → workspace-root `cd`. Expected focused change well under 300 LOC, no routing/schema redesign.

## Fix — 2026-08-24

- `startBuilderSession()` now exports `CODEV_BUILDER_ID` and `CODEV_WORKTREE_ROOT` into every generated builder launch script. Resume/relaunch paths share that script, so the identity persists across the terminal lifecycle.
- `detectCurrentBuilderId()` prefers that session identity over cwd and verifies the id + worktree against workspace-scoped `global.db`; incomplete, malformed, stale, or mismatched values fail loud. Cwd inference remains the compatibility path for older launch scripts.
- `detectWorkspaceRoot()` uses the same stable worktree when the builder variables are present, preventing a `cd` into another directory/workspace from pairing the correct builder id with the wrong workspace.
- Regression coverage connects both seams: generated launch-script exports, plus a multi-architect routing test that changes cwd to the workspace root and asserts bare `architect` reaches `uiv2` (not `main`) and explicit `architect:main` is rejected.
- Targeted tests: 111 passed. Package build passed. Full `@cluesmith/codev` suite: 313 files passed / 3 skipped, 6067 tests passed / 48 skipped; v2: 14 files, 167 tests passed. No flaky failures.
- Real built-CLI check from the workspace root, with the new launch variables, reports `{type:"builder", name:"builder-bugfix-47", architect:"uiv2"}` instead of reclassifying the session as an architect.
