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

## 2026-08-31 — implement phase

Plan approved at full scope. Both repos plus the REFRESH tail.

### Codev repo

`workspace-projection.ts` is the decision, `workspace-projection-sweep.ts` is the
wiring, and the split is deliberate: the first imports nothing heavier than the
workspace key helper, so every rule in it is testable without a database, a
filesystem or a server.

Three things I changed my mind about while writing it:

1. **The issue's diagnosis is slightly off, and it matters for where the fix
   goes.** The project is not created on first thread creation — it is created by
   `initialiseThreadBackend`, the thread-backend connect, and only for the
   workspace being connected. Same symptom, different location.
2. **`isLegacyCodevTitle` became `isMachineWrittenTitle`.** The connect path
   writes the LEAF name; it knows one workspace and cannot see a collision with
   another. If the sweep only rewrote the `codev:` form, a project created by a
   spawn would sit on an ambiguous `api` forever while its sibling also read
   `api`. So a leaf name is recognised as machine-written too, and deepening it to
   `backend/api` is a refinement of the same name rather than the loss of somebody
   else's choice.
3. **`readProjectRows` had to be split out of `activeProjectForWorkspace`.** The
   old reader kept `id` and `workspaceRoot` and dropped `title` — a reconciler
   reading that list can tell a project exists and can never tell what it is
   called, so every legacy title would have survived every sweep in silence.

### Fork

`CodevSidebarEntry` gained an `empty-project` case, and that is what made the
change bigger than it looks: six existing call sites did `entry.thread`, including
`orderedActiveThreads`, which is the list shift-range-select and the jump-hint
labels are assigned from. `undefined` in that list is a crash one row away rather
than a wrong row. `codevOrderedThreads` / `codevEntryThread` are the answer,
exported rather than inlined. An optional `thread?: T` field was the alternative
and is worse: `entry.thread.id` would keep compiling and fail at runtime on the
one kind that has no thread.

The option is `projectGroups`, not `projectKeys`. The sidebar's project list is
LOGICAL projects while `projectKeyOf` returns the physical
`environmentId:projectId` — a flat key list draws a second empty heading beside a
group whose other member holds the architects, same name on both.

### REFRESH tail

- `pin.commit` → `26b4c2dc09f0fe2f6798e9b781df6722603b5bfe`, regenerated. Output is
  byte-identical apart from the sha, which is what a Sidebar-only commit should
  produce — checked rather than assumed. 0 unrepresented.
- Patches re-exported: 35 now, one more than before.
- Evidence re-run: criterion 8b passed, hierarchy wire 8/8, rebase drill (still 3
  conflicting files, the same 3), upstream movement, `collect --check` exit 0.

### Notes for whoever runs this next

- **Ports.** `3799` is held by the MAIN workspace's harness server, started by
  another session. `T3_HARNESS_PORT=3809` is what I used; the harness refuses to
  kill what it cannot prove it owns, and that is correct.
- **`T3_NODE`** must point at a Node 22 binary —
  `~/.nvm/versions/node/v22.22.2/bin/node`. Without it every server-starting tool
  exits 3 with `NO_INTERPRETER`, which reads like a failure and is not one.
- **The parked file.** `/Users/chris/dev/t3code-codev/tools/lan-serve.mjs` is
  untracked and `verify` refuses a dirty checkout. Same as air-271: parked to the
  scratchpad with its sha256 recorded, restored byte-identical afterwards. Do not
  delete it — it is what the iPad reaches the app through.
- **Tower runs the globally installed package.** The live `~/.t3/dev` projection
  will not change from this branch until `pnpm -w run local-install` and a Tower
  restart, and a Tower restart kills every builder session. So the gate evidence
  is a live run against the harness fork server
  (`tools/t3-fork/issue-272-projection.mjs`), not a Tower restart.
