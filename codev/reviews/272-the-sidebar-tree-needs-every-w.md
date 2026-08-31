# PIR Review: Every workspace is a named top-level node in the sidebar tree

Fixes #272

## Summary

The sidebar tree showed one project per path string — titled `codev:/Users/chris/dev/codev-1455`
— and only for workspaces something had already been spawned into. This names each project after
its own directory and adds a Tower sweep that reconciles a project row for every workspace Codev
knows about, so a workspace nobody has started work in appears as a heading with nothing under it
rather than not appearing at all. The fork change is what makes that heading render: the tree's
project level was derived entirely from architects, so a project with none drew nothing.

## Files Changed

- `packages/codev/src/agent-farm/workspace-projection.ts` (+382 / -0) — new; the decision
- `packages/codev/src/agent-farm/workspace-projection-sweep.ts` (+144 / -0) — new; the wiring
- `packages/codev/src/agent-farm/thread-backend.ts` (+151 / -12) — leaf-name title, `readProjectRows`, `openProjectGateway`
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+37 / -0) — sweep lifecycle
- `packages/porch-driver/src/thread.ts` (+25 / -0) — `updateProjectMeta`
- `packages/codev/src/agent-farm/__tests__/issue-272-workspace-projection.test.ts` (+411 / -0) — new
- `packages/codev/src/agent-farm/__tests__/issue-272-project-title.test.ts` (+163 / -0) — new
- `packages/codev/src/__tests__/e2e/spec-250-fork-stack.ts` (+43 / -0) — seeds a project with no threads
- `packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts` (+53 / -0) — the empty-heading test
- `tools/t3-fork/issue-272-projection.mjs` (+297 / -0) — new; live verification against a fork server
- `codev/research/272-workspace-projection-evidence.json` (+90 / -0) — its recorded output
- `codev/plans/272-the-sidebar-tree-needs-every-w.md` (+251 / -0)
- `codev/state/pir-272_thread.md` (+248 / -0)

**In the fork** (`pseudoseed/t3code@codev`), commit `26b4c2dc0`: `Sidebar.logic.ts`,
`Sidebar.logic.test.ts`, `Sidebar.tsx`. Readable in `tools/t3-fork/patches/0035-*.patch` without
access to the private repository.

The pin move and regenerated contract that commit obliged shipped separately as **PR #291**, because
four builders were blocked on `criterion 8b` while `pin.json` named a fork commit that was no longer
checked out. That is why they are not in this diff.

## Commits

- `59020b24d` [PIR #272] feat: every known workspace is a project row, named after its directory
- `d07b066b1` [PIR #272] test: the rules without a server, and the wire with one
- `3c25fe8b5` [PIR #272] chore: move pin.commit, regenerate, and re-run the evidence
- `cb513dfd4` [PIR #272] test: the browser draws the empty heading, and the doc path stops shipping a username
- `8074a0317` [PIR #272] docs: the ABI mismatch that failed the gate 8 times

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass — 7499 passed / 58 skipped (388 files), plus 180 in `codev-v2`. 35 new.
- `porch check 272` under **Node 20**, the runtime porch actually uses: ✓ build 17.6s, ✓ tests 227.1s
- Fork unit tests: `Sidebar.logic.test.ts` **125 passed** (8 new)
- Fork e2e: `spec-250-hierarchy.spec.ts` **10 passed**, including the empty-workspace heading
  rendered in a browser
- Live, against a running fork server (`tools/t3-fork/issue-272-projection.mjs`): **8 of 8 claims**
  — `codev-1455` created and named; `codev:<path>` rewritten in place keeping its project id;
  `Entriq (do not rename)` untouched; `backend/api` and `mobile/api` distinguishable; nothing minted
  for a builder worktree, a deleted checkout, or a non-workspace; a second pass writes nothing
- Every new assertion was confirmed to fail with its change reverted

Manual verification at the `dev-approval` gate: build 17.6s, tests 216.7s, both green.

## Architecture Updates

Two facts routed to the **COLD** tier; neither displaced a hot entry.

- `codev/resources/arch.md` § Integration Points — a new subsection on the workspace→project
  projection: the two writers (connect path and sweep), why the sweep enumerates
  `getKnownWorkspacePaths()` rather than `architect ∪ builders`, that the project title **is** the
  sidebar heading verbatim, that it opens one connection per *server*, and which two titles it will
  rewrite.
- `codev/resources/arch.md` § Invariants & Constraints, new #10 — porch and afx run nvm **Node 20**,
  so every native module in a worktree must match ABI 115; `better-sqlite3` ships no Node-20
  prebuild for darwin/arm64, so only a from-source rebuild produces a loadable one.

Nothing was promoted to `arch-critical.md`: it is at its 10-fact cap, the hot tier already carries
the t3code-fork fact this builds on, and neither addition is worth displacing an existing entry.
The Node/ABI fact is repo-specific rather than a cross-cutting decision rule, which the
`update-arch-docs` skill routes to cold.

## Lessons Learned Updates

Two entries added to `codev/resources/lessons-learned.md` § Debugging and Root Cause Analysis,
both COLD:

- **A green in your own shell is not a green in the harness.** When a check fails for one party and
  passes for another, stop diffing the inputs and diff the *loader* — capture live process ancestry
  rather than trusting either party's belief about how it runs. And when hundreds of tests across
  dozens of unrelated files fail at once, the cause is one shared dependency, not hundreds of
  defects.
- **A repair that produced no output repaired nothing — check the artifact's mtime, not the exit
  code.** Three build commands exited 0, printed nothing, and left the binary untouched.

Nothing promoted to `lessons-critical.md`, for the same cap-and-displacement reason.

## Things to Look At During PR Review

- **`isMachineWrittenTitle` is the safety boundary of a sweep that runs every 30s.** It permits
  exactly two strings — the legacy `codev:<root>` form and the workspace's leaf name. If it were
  loosened, the sweep would start overwriting titles humans chose. The leaf-name case is deliberate
  and is what lets a project created by a spawn converge on a set-unique name.
- **`CodevSidebarEntry` gained a case that carries no thread.** Six call sites did `entry.thread`,
  including `orderedActiveThreads`, which is what shift-range-select and jump-hint labels are
  assigned from — `undefined` there is a crash one row away. `codevOrderedThreads` /
  `codevEntryThread` are the answer. An optional `thread?: T` was the alternative and is worse:
  `entry.thread.id` would keep compiling and fail at runtime on the one kind that has no thread.
- **`projectGroups`, not `projectKeys`.** The sidebar's list is *logical* projects while
  `projectKeyOf` returns a physical `environmentId:projectId`. A flat key list draws a second empty
  heading beside a group whose other member holds the architects, same name on both.
- **`readProjectRows` was split out of `activeProjectForWorkspace` rather than copied.** The old
  reader dropped `title`, so a reconciler could tell a project existed and never what it was called.
  A second copy of that request would also be a second place for the transport rules to drift —
  which is how that call skipped `assertTransportSafe` once already.

- **The fork's committed screenshots are now one case out of date, deliberately.**
  `docs/codev/spec-250/phase-7/*.png` in the fork depict the tree before this change and do not
  show the empty-workspace heading. Re-shooting them means another fork commit, which obliges the
  whole `REFRESH.md` tail again — a second pin move, regeneration, patch re-export and four
  evidence re-runs — for pictures. They still accurately depict what spec 250 delivered. The
  current render is in this branch at
  `packages/codev/test-results/spec-250-screenshots/phase-7/` (untracked), and
  `spec-250-hierarchy.spec.ts` asserts the heading's presence, position and `data-codev-project-empty`
  attribute, so the behaviour is pinned by a test rather than by an image.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-272` → **Review Diff**
- **Run the fork stack**: `node tools/t3-server/t3-server.mjs start-fork`, then from the fork's
  `apps/web`: `T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_PORT=3811 PORT=5733 npx vp dev`

What to verify:

- A project renders as `codev-1455`, not `codev:/Users/chris/dev/codev-1455`
- `sqlite3 <db> "select title, workspace_root from projection_projects;"` — one row per real Codev
  workspace, none for a `.builders/` path or a deleted checkout
- A workspace with no agent appears as a heading with nothing under it
- At a narrow width the headings stay distinguishable — the truncation complaint in the issue is
  why the name is a name and not a path

Reproduce the live check directly:

```
export T3_NODE=$HOME/.nvm/versions/node/v20.19.2/bin/node
export T3CODE_FORK_ROOT=/Users/chris/dev/t3code-codev T3_HARNESS_PORT=3809
node tools/t3-fork/issue-272-projection.mjs
```

**Run anything in this worktree with nvm Node 20 first in `PATH`.** A green under a newer Node says
nothing about what porch will do — see the thread log.

## Flaky Tests

None skipped. One documented, not skipped:

- `packages/codev/src/__tests__/e2e/spec-250-approval.spec.ts` — intermittent 30s timeout in the
  `openThread` helper waiting for a `sidebar-row-card`. Across five runs it failed at **four
  different tests** (lines 180, 213, 261, 305) and passed 6/6 once. Confirmed **not** caused by this
  change: an A/B with this branch's fixture edits reverted to HEAD still failed, at a third
  different test. Left enabled rather than skipped — skipping would remove coverage of the approval
  path to hide a timing artifact this PR did not introduce.
