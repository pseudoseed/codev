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
