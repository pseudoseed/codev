# pir-272 — thread

## 2026-08-31 — plan phase

Issue #272: the sidebar tree needs every workspace as a named top-level node.

### What I verified rather than assumed

Read the live projection database (`~/.t3/dev/state.sqlite`). One project row,
titled `codev:/Users/chris/dev/codev-1455`. One thread, `codev_role` empty.
That second fact is #271, not mine — PR #274 is open on it.

Traced the title from write to pixel and it is a straight line with no cleanup
step in it:

- codev repo, `thread-backend.ts:913` writes `codev:${workspaceRoot}`
- fork, `projectGrouping.ts:323` — a single-member group's label IS the title
- fork, `sidebarProjectGrouping.ts:105` — displayName = label
- fork, `Sidebar.tsx:4015` — the heading renders displayName

So half of #272 is a one-line write in this repo. No fork change for the title.

### The part that surprised me

The project is NOT created on first thread creation, as the issue says. It is
created by `initialiseThreadBackend` when `ensureThreadBackendReady` runs for
that specific workspace (`thread-backend.ts:901-940`). The practical symptom is
the same; the fix location is not.

And Tower's existing sweep (`tower-server.ts:825`) enumerates workspaces from
`architect ∪ builders`, not from `known_workspaces`. `getKnownWorkspacePaths()`
(`tower-instances.ts:212`) is the wider list.

### The part that makes this two repos

`buildCodevSidebarOrder` (`Sidebar.logic.ts:1054`) derives project headings from
ARCHITECTS — it walks `hierarchy.architects` and sets `startsProject` on the
first subtree per project. A project with zero architects contributes zero
entries, so creating the project row alone would change nothing on screen. Level 1
of the tree cannot be fixed from the Codev repo.

### Cost I did not expect to be in scope

`pin.contractSource` is `fork`, so any fork commit puts HEAD ahead of
`pin.commit` and `t3-server.mjs verify` exits 1. REFRESH.md steps 3-8 (pin move,
regenerate, re-export patches, re-run four evidence collectors) are therefore
part of this work, not a follow-up.

### Design calls made in the plan

- Name = shortest unique trailing path segments across the known set, not bare
  basename. Two `.../api` workspaces must not render as two identical rows.
- One connection per SERVER, not per workspace. The obvious implementation —
  call `ensureThreadBackendReady` per known workspace, which already creates the
  project — holds one live engine socket per workspace forever, ~30 against one
  server.
- Rename only the exact legacy `codev:<workspaceRoot>` string. A sweep that
  enforces a computed title would undo a human's rename every 30s, silently.
- Filter the enumeration three ways: no `.builders/`, must exist, must have
  `.codev/`. The real `known_workspaces` table holds `/Users/chris/dev` and
  several deleted checkouts.

### Coordination

Fork checkout is clean at `2f64a1b0e`, one worktree, no other writer. PR #274
(air-271) touches the Codev repo only — `workspace-add-architect.ts`,
`status.ts`, four tests — none of which I touch. No contention either way.

Plan committed, `plan-approval` gate pending.
