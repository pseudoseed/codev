# PIR Plan: Every workspace is a named top-level node in the sidebar tree

## Understanding

Issue #272 asks for a three-level sidebar tree — **workspace → architect → builders** — covering
*every* workspace Codev knows about. Spec 250 shipped levels 2 and 3. Level 1 exists but is wrong
in two independent ways, and both were verified against the live database rather than reasoned
about.

### Verified starting state (2026-08-31, `~/.t3/dev/state.sqlite`)

```
$ sqlite3 ~/.t3/dev/state.sqlite "select project_id, title, workspace_root from projection_projects;"
afab56f9-5696-4aa7-858e-bd65444ce157|codev:/Users/chris/dev/codev-1455|/Users/chris/dev/codev-1455

$ sqlite3 ~/.t3/dev/state.sqlite \
    "select thread_id, project_id, title, coalesce(nullif(codev_role,''),'(none)') from projection_threads;"
2e2bd2c7-...|afab56f9-...|architect-lan|(none)
```

One project, titled with a prefixed absolute path. One thread, with `codev_role` empty — that
second fact is **#271**, not this issue.

### Root cause 1 — the title is a path with a prefix

`packages/codev/src/agent-farm/thread-backend.ts:913` writes the project title:

```ts
projectId = await createProject(dispatcher, journal, {
  title: `codev:${config.workspaceRoot}`,
  workspaceRoot: config.workspaceRoot,
});
```

That string is what the sidebar heading renders, and the path from title to pixel is short and has
no cleanup step in it:

- `packages/client-runtime/src/state/projectGrouping.ts:323` (fork) — a single-member group's
  `label` **is** `representative.title`, verbatim.
- `apps/web/src/sidebarProjectGrouping.ts:105` (fork) — `displayName: group.label`.
- `apps/web/src/components/Sidebar.tsx:4015` (fork) — the heading renders
  `projectDisplayNameByKey.get(projectKey) ?? "Project"`.

So the fix belongs in Codev, at the one place the string is written. No fork change is needed for
this half.

### Root cause 2 — the project row is created by the *connect*, and only for the connecting workspace

The project is created inside `initialiseThreadBackend` → the block at
`thread-backend.ts:901-940`, reached only when `ensureThreadBackendReady(<workspace>)` runs for
that specific workspace. Two consequences:

- A registered Codev workspace nobody has spawned into has no project row, so it is absent from the
  tree — indistinguishable from a workspace that does not exist.
- Tower's existing sweep does not close the gap. `tower-server.ts:825-886` enumerates workspaces
  from `architect ∪ builders` in `global.db`, **not** from `known_workspaces`. The broader list
  Codev actually keeps is `getKnownWorkspacePaths()` at
  `packages/codev/src/agent-farm/servers/tower-instances.ts:212` (`known_workspaces` ∪
  `terminal_sessions` ∪ the in-memory cache).

### Root cause 3 — an empty project draws no heading at all (fork)

Even with the project row present, the tree would still not show it. `buildCodevSidebarOrder`
(`apps/web/src/components/Sidebar.logic.ts:1054-1113`) derives project headings **from
architects**: it walks `hierarchy.architects`, keys each by `projectKeyOf`, and sets
`startsProject` on the first subtree of each project. A project with zero architect threads
contributes zero entries, so `Sidebar.tsx:3993` never emits a heading for it.

This is the part of #272 that cannot be fixed from the Codev repo. It is a fork change.

### Relationship to #271

#271 (`codev_role` arrives empty) is level **2** of the tree, and PR #274 is open against it. Its
files (`commands/workspace-add-architect.ts`, `commands/status.ts`, four test files) do not overlap
with anything below, so the two can land in either order. The consequence for verification is
stated in the Test Plan: level 1 is verifiable on its own; the full three-level shape is not
visible until #274 merges.

## Proposed Change

Three changes, in two repositories.

### A. Name the project after the workspace directory (Codev repo)

`title: displayNameForWorkspace(config.workspaceRoot)` instead of the `codev:`-prefixed path.

The name is the **shortest unique trailing path segments** across the known workspace set, minimum
one segment. `/Users/chris/dev/codev-1455` → `codev-1455`. If two known workspaces are both called
`api`, both become `backend/api` and `mobile/api` rather than two identical rows. This is a small
pure function with its own tests; it is not `basename` with a comment promising to handle
collisions later.

### B. Reconcile every known workspace into a project row (Codev repo)

A new module, `packages/codev/src/agent-farm/workspace-projection.ts`, and a Tower sweep that calls
it at startup and every 30s:

1. **Enumerate.** `getKnownWorkspacePaths()`, then drop: paths containing `/.builders/` (the filter
   `servers/v2-routes.ts:138` already applies), paths that no longer exist on disk, and paths with
   no `.codev/` directory. A stale `known_workspaces` row for a deleted checkout must not mint a
   project — the list in the live database today contains several.
2. **Group by server.** For each surviving root, `readThreadBackendConfig(root)`. Roots with no
   `threads` config are skipped — no server is named, so there is nowhere to project them.
   Remaining roots group by `(serverUrl, bootstrapToken)`.
3. **One connection per group, not one per workspace.** `createProject`
   (`packages/porch-driver/src/thread.ts:88`) needs a dispatcher, not a per-workspace engine. Doing
   this by calling `ensureThreadBackendReady` per workspace would open one live WebSocket engine
   per known workspace — roughly 30 sockets against one server, held forever — to write one row
   each.
4. **Ensure.** Read the shell snapshot once (`GET /api/orchestration/shell`, the request
   `activeProjectForWorkspace` at `thread-backend.ts:493` already makes) and compare on
   `canonicalWorkspaceKey`, the same normalisation that lookup uses. Missing → `project.create`.
   Present → leave it alone, **except** the one repair below.
5. **Repair the legacy titles, and nothing else.** If an existing project's title is exactly
   `codev:<its own workspaceRoot>`, issue `project.meta.update` with the new name. Any other title
   is left untouched, because a project a human renamed in the t3code UI must not be renamed back
   on the next sweep. `project.meta.update` is already in the vendored contract
   (`packages/types/src/t3/generated/types.d.ts:25`), so this needs a small
   `updateProjectMeta` helper in `porch-driver/src/thread.ts` and no contract change.

A failure anywhere in a group is logged and the sweep moves on. This is a background reconciler;
an unreachable server is a "not yet", not a Tower fault.

### C. Draw a heading for a project with no architects (t3code fork)

`buildCodevSidebarOrder` gains an optional `projectKeys: readonly string[]` option — the project
keys the sidebar knows about, in its own order. After the architect-derived entries, it emits
`{ kind: "empty-project", projectKey }` for every known key that no entry started.
`Sidebar.tsx` renders that entry with the **same** heading markup as `startsProject`, extracted
into one helper so the two cannot drift apart, carrying the same
`data-testid="sidebar-codev-project-heading"`.

The `!hasCodevHierarchy` early return at `Sidebar.logic.ts:1058` is left alone: with no Codev
thread anywhere in the sidebar, the flat upstream presentation stays exactly as it is. The
consequence is stated plainly — if *no* workspace has an architect, no workspace headings appear.
That is the upstream behaviour we are deliberately not changing out from under a non-Codev user.

### D. The fork-commit tail (Codev repo)

`pin.contractSource` is `fork`, so a fork HEAD ahead of `pin.commit` makes
`t3-server.mjs verify` exit `1` (`FORK_AHEAD_OF_CONTRACT`) and turns the suite red. Change C is a
fork commit, so `tools/t3-codegen/REFRESH.md` steps 3-8 are part of this work, not a follow-up:
move `pin.commit`/`commitDate`, regenerate, re-export `tools/t3-fork/patches/`, and re-run the four
evidence collectors that name a fork commit. The contract closure (`packages/contracts/src`) is not
touched by a Sidebar-only change, so the generated artifacts are expected to come out byte-identical
apart from `source-hash.json` — expected, and checked rather than assumed.

## Files to Change

### Codev repo (this worktree)

- `packages/codev/src/agent-farm/workspace-projection.ts` — **new.** Enumeration, the display-name
  function, and the reconciler. Pure core, injected I/O, so it is testable without a server.
- `packages/codev/src/agent-farm/thread-backend.ts:913` — title becomes the display name.
- `packages/porch-driver/src/thread.ts:~105` — new `updateProjectMeta(dispatcher, journal, {...})`
  emitting `project.meta.update`, alongside `createProject`.
- `packages/codev/src/agent-farm/servers/tower-server.ts:~886` — start the reconciler after
  `markBootComplete()`, and stop it on shutdown next to `threadAdoptionSweeper`.
- `packages/codev/src/agent-farm/__tests__/issue-272-workspace-projection.test.ts` — **new.**
- `packages/codev/src/agent-farm/__tests__/issue-272-project-title.test.ts` — **new.**
- `packages/types/src/t3/pin.json` — `commit` / `commitDate` move.
- `packages/types/src/t3/generated/*` — regenerated.
- `tools/t3-fork/patches/*.patch` — re-exported.
- `tools/t3-fork/FORK.md` — phase log entry for the new fork commit.
- `codev/research/250-*.json` — the four evidence runs, re-run.

### t3code fork (`/Users/chris/dev/t3code-codev`, branch `codev`)

- `apps/web/src/components/Sidebar.logic.ts:1054-1113` — `projectKeys` option, `empty-project`
  entry kind.
- `apps/web/src/components/Sidebar.tsx:3993-4020` — heading helper, rendered for both entry kinds.
- `apps/web/src/components/Sidebar.logic.test.ts` — ordering and the "every known project appears
  exactly once" property.

The fork checkout is clean at `2f64a1b0e` with one worktree and no other writer; PR #274 touches
the Codev repo only, so there is no contention for it.

## Risks & Alternatives Considered

- **Risk: the reconciler mints projects for junk paths.** `known_workspaces` today holds
  `/Users/chris/dev` (a parent directory), several deleted checkouts, and `.builders/` worktrees.
  Mitigation: the three-way filter in B.1 (no `.builders/`, must exist, must have `.codev/`), tested
  against a fixture list drawn from the real table.
- **Risk: renaming fights a human.** A sweep that enforces a computed title would undo any rename
  done in the t3code UI, every 30s, silently. Mitigation: repair only the exact legacy
  `codev:<workspaceRoot>` string. Consequence, stated rather than hidden: a project created after
  this ships and later made ambiguous by a *new* same-basename workspace does not get retro-renamed.
- **Risk: 30 sockets.** Rejected the obvious implementation (call `ensureThreadBackendReady` per
  known workspace, which already creates the project) precisely because it holds one live engine per
  workspace forever. One connection per server group instead.
- **Risk: empty headings for non-Codev projects.** In codev-hierarchy mode, change C draws a heading
  for every known project with no architects, including an upstream t3code project. Gated behind
  `hasCodevHierarchy`, so a sidebar with no Codev threads is untouched. Alternative considered and
  rejected: a `codevManaged` column on `projection_projects` — a new fork customization on the
  persistence path, adding rebase surface to solve a problem this user does not currently have.
- **Risk: the REFRESH tail (D) is long and needs a live fork server.** It is mechanical but it is
  not free. If it turns out to be blocked, the fork change cannot ship half-done — a fork commit
  without the pin move leaves the suite red — so that would be raised, not worked around.
- **Alternative rejected: derive the display name in the fork's web layer** from `workspaceRoot`
  instead of fixing the stored title. It would leave `codev:/Users/...` in the project switcher, in
  page titles, and in the database, and it puts a Codev-specific rule in upstream-shaped code.
- **Alternative rejected: create a placeholder thread per workspace** so the existing
  architect-driven heading logic finds something. It invents an agent that does not exist.

## Test Plan

### Unit (Codev repo, `pnpm -w test`)

- `displayNameForWorkspace` / the set-wide namer: `/Users/chris/dev/codev-1455` → `codev-1455`;
  two `.../api` roots → `backend/api` and `mobile/api`; a root of `/` degrades to something
  non-empty rather than throwing.
- The enumerator drops `.builders/` paths, non-existent paths, and paths with no `.codev/`, using a
  fixture list taken from the real `known_workspaces` rows.
- The reconciler, against a fake dispatcher + fake shell snapshot: creates only the missing
  projects; opens **one** connection for N workspaces sharing a server; renames a project titled
  `codev:<root>`; leaves a project titled `My Project` alone; a group whose connect throws does not
  stop the other group.
- `thread-backend.ts` create path writes the bare name — asserted against the dispatched
  `project.create` payload, not against a helper's return value.
- Each new test is confirmed to fail with the change reverted before it is trusted.

### Unit (fork, `pnpm --filter web test`)

- `buildCodevSidebarOrder` emits one `empty-project` entry per known project key with no architect,
  none for a key that already started a project, and every input thread still appears exactly once.
- The existing `Sidebar.logic.test.ts` suite stays green.

### Contract

- `node tools/t3-server/t3-server.mjs verify` exits `0` after the pin move.
- `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` green with both `T3CODE_ROOT` and
  `T3CODE_FORK_ROOT` exported.

### Manual — this is the `dev-approval` gate

This repo has no `worktree` block in `.codev/config.json`, so `afx dev` does not apply. The gate is
verified by running the fork:

1. `node tools/t3-server/t3-server.mjs start-fork` and open the web UI.
2. Confirm the pre-existing project renders as **`codev-1455`**, not
   `codev:/Users/chris/dev/codev-1455`.
3. `sqlite3 ~/.t3/dev/state.sqlite "select title, workspace_root from projection_projects;"` — one
   row per real Codev workspace, each titled with its directory name, and **no** row for a
   `.builders/` path or a deleted checkout.
4. Confirm a workspace with no agent at all appears as a heading with nothing under it.
5. Narrow the sidebar and confirm the headings stay distinguishable — the truncation complaint in
   the issue is the reason the name is a name and not a path.

Level 2 (architects under a workspace) needs **#271 / PR #274** merged. Until then step 4's heading
is the shape that is checkable, and the full `dvarr → architect/main → builder/air-12` render is
not. That is a stated limit of this verification, not a claim that it passed.
