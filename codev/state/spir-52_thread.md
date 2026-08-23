# spir-52 thread — v2 server events

Builder for Issue #52 / Spec 52. STRICT mode. SPIR.

## Log

### 2026-08-23 — Plan phase start

- Spec already approved on main (`approved: 2026-08-23`, PR #53). No Baked Decisions section on the issue. Spec constraints C1–C4 are the fixed shape.
- Porch landed in `plan` (specify skipped as pre-approved). Wrote `codev/plans/52-v2-server-events.md`.
- Grounded against the tree before writing:
  - `getOverview` without `activeBuilderRoleIds` returns every worktree, but also fetches PRs/issues. Hot path will call `discoverBuilders` instead.
  - `liveArchitects` is private and live-only. Use `getArchitects`.
  - No `unregisterKnownWorkspace`. Workspace `gone` is membership in an injected `listWorkspaces()`.
  - `heldSummaryForWorkspace` already applies the `not_before` eligibility the spec wants.
  - Mount point: after the `ROUTES` table, before `/api/tunnel/`.
- Four phases: projection → bus+route → sampler → idle/convergence proof.

### 2026-08-23 — Plan review iteration 1

- Gemini skipped (agy exit 1). Codex quota-exhausted until 2026-08-27. Claude + opencode REQUEST_CHANGES HIGH.
- Both caught the same silent hole: `discoverBuilders` hardcodes `spawnedByArchitect: null`; plan had no `getBuilders` join. Also: do not pause the sampler, `dark` is a handshake, subscribe-then-snapshot-then-flush.
- Fixes landed in the plan. Rebuttal agrees with every point.

### 2026-08-23 — Plan approved, entering implement

- architect:uiv2 approved under standing delegation. Recorded as 2 genuine review lanes (claude + opencode), not 4.
- Tightened Phase 1 AC: parentId must equal the architect id, not merely "not fail". 9f still cannot catch a skipped join.
- Phase 4: no silent production fixes. If a phase-3 hole surfaces, say so in the commit body.

### 2026-08-23 — Phase 1: Hierarchy projection

- Types in `packages/types/src/v2-events.ts`. Ids, status, `projectHierarchy` with injected `V2Deps`.
- `getBuilders` join is `row.worktree === discovered.worktreePath`. Test asserts parentId is the architect id, not the workspace.
- 11 tests pass (`v2-projection.test.ts`). Does not import `isIdleWaiting`.
- Commits: `0d23f69db` projection, `1cca7216b` extra assertions.

### 2026-08-23 — Phase 2: Scoped event bus and SSE route

- `v2-events.ts` ScopeBus. `v2-routes.ts` GET `/v2/events`. One `/v2/` mount in `tower-routes.ts` after ROUTES, before `/api/tunnel/`.
- Commit `e06812956`. porch done; build passed.
- Tests verified: v2-events + v2-routes 17 passed. Existing `GET /api/events` 8 passed. `git diff` on tower-routes is import + one if.
- Context refresh at phase_2 refused: opencode has no in-session clear. architect:uiv2 said continue. Push at every phase boundary from here.
- Phase 2 review: Claude + opencode REQUEST_CHANGES on snapshot seq. Fixed: pin snapshot/dark to subscribe-time seq; monotonic client ids; cleanup on subscribe.
- Next: porch done → re-review or phase 3.

### Standing orders still in force

- `afx send architect:uiv2` only (not bare architect).
- Phase 4: no silent production edits; name any phase-3 hole in the commit body.
- Phase 2 must re-apply workspace parentId fallback if scope filtering drops an architect (projection is scope-blind; scope is workspace paths so this is usually a no-op).
- Phase 3 `heldByAgent` must lowercase both sides of `to_agent`.
- Do not invent unregister. Do not pause the compare loop. dark is a handshake.
