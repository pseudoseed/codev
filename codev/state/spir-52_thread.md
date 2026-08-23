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
