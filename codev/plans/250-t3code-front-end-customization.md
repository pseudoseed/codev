# Plan: t3code is the front end — private customization

**Specification**: [codev/specs/250-t3code-front-end-customization.md](../specs/250-t3code-front-end-customization.md)

## Executive Summary

The spec chose approach 2: **a fork of t3code, rebased onto upstream**, at
`github.com/pseudoseed/t3code` branch `codev`, checked out at `/Users/chris/dev/t3code-codev`.
`/Users/chris/dev/t3code` stays the read-only upstream clone at `082e6ea5`, because every piece
of spec 146 and 236 evidence was gathered against it.

That choice drives the phase order, because the work spans **two repositories** and the vendored
contract sits between them:

1. the **fork** (`/Users/chris/dev/t3code-codev`) — contract fields, migrations, projections,
   write-time invariants, the gate block and scope, sidebar, tiling, proxy;
2. **this repository** — the vendoring harness (`pin.json`, `verify`, `classify-churn`,
   `generate`), `porch-driver`, `codev-agent`, and the tests that hold both ends honest.

The vendored contract is regenerated from the fork exactly once mid-flight (phase 5), which
splits the work cleanly: everything before it changes the fork's contract, everything after it
consumes the regenerated one. The two-identity harness is built **first** (phase 1), while fork
HEAD still equals `upstreamBase`, so its own correctness is provable against a no-op diff before
any customization exists to confuse it.

### Two repositories, one PR

The fork's commits live on `pseudoseed/t3code@codev` and **cannot appear in this repository's
PR**. Three things bridge that gap, and none of them is "apply a patch to a checkout" — spec
approach 1 is rejected and stays rejected:

- `pin.json` records the fork commit, so the Codev tree names exactly what it was built against.
- `tools/t3-fork/FORK.md` records the remote, branch, checkout path, and a phase-to-commit log.
- Phase 5 exports `git format-patch upstreamBase..forkHEAD` into `tools/t3-fork/patches/` as a
  **review aid** — so a reviewer of the Codev PR can read the six changes without cloning the
  fork. It is never the mechanism by which the fork is built or rebased.

### Phase-to-criterion map

| Phase | Success criteria it closes |
|---|---|
| 1 | part of 9 (`verify` two identities, churn ranges) |
| 2 | 8, 8b |
| 3 | 11 |
| 4 | 10 |
| 5 | part of 9 (regeneration, `shape-check`) |
| 6 | prerequisite for 1–4 |
| 7 | 1, 2, 7, 11 (orphan rendering) |
| 8 | 3 |
| 9 | 5, 5b |
| 10 | 4 |
| 11 | 6, and 9 end to end |

## Phases (Machine Readable)

<!-- REQUIRED: porch parses this JSON to track phase progress. Keep it in sync when you add or remove phases; at least two phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Two-identity vendoring harness"},
    {"id": "phase_2", "title": "Thread hierarchy in the fork's contract and projection"},
    {"id": "phase_3", "title": "Hierarchy integrity refused at write time"},
    {"id": "phase_4", "title": "Porch gate block with a server-allocated revision"},
    {"id": "phase_5", "title": "Vendored contract regenerated from the fork"},
    {"id": "phase_6", "title": "Hierarchy and gate state published by porch-driver and codev-agent"},
    {"id": "phase_7", "title": "Workspace to architect to builder sidebar"},
    {"id": "phase_8", "title": "Gate rendering in t3code"},
    {"id": "phase_9", "title": "Builder tiling"},
    {"id": "phase_10", "title": "Approval from t3code over the same-origin proxy"},
    {"id": "phase_11", "title": "Acceptance run: tailnet iPad and the rebase drill"}
  ]
}
```

## Phase Breakdown

### Phase 1: Two-identity vendoring harness

**Dependencies**: None

#### Objective

Make the vendoring machinery able to hold **two** checkouts with two different meanings before
either diverges. Built first on purpose: while fork HEAD still equals `upstreamBase`, every new
assertion has a known answer, so a harness bug cannot hide inside a real customization diff.

This phase is **outward-facing**: it creates a public fork under `pseudoseed`. Flag it to the
architect before running `gh repo fork`.

#### Files to Create / Modify

Fork side (new repository state, no Codev commit):
- `github.com/pseudoseed/t3code`, branch `codev`, cloned to `/Users/chris/dev/t3code-codev`,
  branched from `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`.

This repository:
- `packages/types/src/t3/pin.json` — add `upstreamBase`, `forkRepo`, `forkBranch`; `commit`
  keeps its meaning and becomes the **fork** head once phase 5 runs.
- `tools/t3-server/t3-server.mjs` — `verify` asserts both identities.
- `tools/t3-codegen/classify-churn.mjs` — two named ranges, two checkouts.
- `tools/t3-codegen/generate.mjs` — `source-hash.json` records the upstream closure hash at
  `upstreamBase` alongside the fork's.
- `tools/t3-codegen/REFRESH.md` — the two-identity refresh procedure.
- `tools/t3-fork/FORK.md` — new. Remote, branch, checkout path, phase-to-commit log.
- `packages/codev/src/__tests__/spec-250-vendoring-identities.test.ts` — new.

#### Deliverables

- [ ] Fork created and checked out at `/Users/chris/dev/t3code-codev` on branch `codev`.
- [ ] `pin.json` carries `{ "commit": "<fork head>", "upstreamBase": "082e6ea5…" }`.
- [ ] `t3-server.mjs verify` asserts, per identity:
      - `upstreamBase`: `/Users/chris/dev/t3code` HEAD equals `upstreamBase`, tree clean;
      - fork: `/Users/chris/dev/t3code-codev` HEAD equals `commit`, tree clean, and
        `git merge-base <commit> <upstreamBase>` equals `upstreamBase`.
- [ ] Checkout roots resolve per identity — `T3CODE_ROOT` for upstream (unchanged meaning) and
      `T3CODE_FORK_ROOT` for the fork, each defaulting to its spec'd path. One variable is not
      stretched over two meanings.
- [ ] Exit `3` (**could not determine**) survives untouched and is still spelled differently from
      exit `1`: a missing fork checkout, an unreadable HEAD, or an unresolvable merge-base is `3`,
      never `1`.
- [ ] `classify-churn.mjs` takes two ranges with distinct meanings and refuses to conflate them:
      - `--upstream-movement` → `upstreamBase..origin/main` read from `/Users/chris/dev/t3code`;
      - `--fork-drift` → `upstreamBase..<fork head>` read from `/Users/chris/dev/t3code-codev`.
      Invoked with neither, it fails loudly rather than picking one.
- [ ] A zero result from `--upstream-movement` reports `NO_UPSTREAM_MOVEMENT` and exits `0`,
      distinct from the tool failing (`1`) and from it being unable to read a ref (`3`).
- [ ] `source-hash.json` grows an `upstream` section: `{ commit: upstreamBase, files: {…} }`
      hashed from the upstream closure, beside the existing fork-sourced hashes. Generation from
      the fork stops being a tautology.
- [ ] `FORK.md` and `REFRESH.md` written.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `node tools/t3-server/t3-server.mjs verify` exits `0` with both checkouts at their pins.
- [ ] Moving either checkout off its pin exits non-zero with a message naming **which** identity
      failed; deleting the fork checkout exits `3`, not `1`.
- [ ] `classify-churn --fork-drift` reports zero at this phase (fork equals upstreamBase) and
      `--upstream-movement` reports whatever upstream actually did — the two answers are visibly
      different questions.
- [ ] `pnpm -w test` green; build and typecheck pass.

#### Test Plan

- Unit: pin parsing with and without `upstreamBase`; the three exit codes as three distinct
  outcomes; range construction for both churn modes.
- Integration: throwaway git repositories standing in for both checkouts — pinned, moved, dirty,
  absent, and a fork whose merge-base is *not* `upstreamBase` (a rebase that dropped the base),
  which must fail rather than pass quietly.
- Manual: run `verify` against the real pair.

### Phase 2: Thread hierarchy in the fork's contract and projection

**Dependencies**: Phase 1

#### Objective

`role` and `parentThreadId` exist on the fork's thread record, survive a projection rebuild over
a **pre-fork** event log, and do not stop a pre-fork server opening the database.

#### Files to Create / Modify

All in `/Users/chris/dev/t3code-codev`:
- `packages/contracts/src/orchestration.ts` — `CodevThreadRole` (`architect` | `builder`),
  `role` and `parentThreadId` on `OrchestrationThreadShell`, `OrchestrationThread`, and
  `ThreadCreatedPayload`, each with a decoding default of `null`.
- `apps/server/src/persistence/Migrations/900_CodevThreadHierarchy.ts` — new.
- `apps/server/src/persistence/Migrations.ts` — register `[900, "CodevThreadHierarchy", …]`.
- `apps/server/src/orchestration/projector.ts` — read and write the columns.
- `apps/server/src/orchestration/Schemas.ts` — re-export as the file already does.
- `packages/contracts/src/orchestration.test.ts` — decode cases.
- `apps/server/src/orchestration/projector.codevHierarchy.test.ts` — new.
- `apps/server/src/persistence/Migrations/900_CodevThreadHierarchy.test.ts` — new.

#### Deliverables

- [ ] `role` is `"architect" | "builder" | null`; `null` means a thread Codev did not create.
- [ ] `parentThreadId` is a nullable `ThreadId`.
- [ ] Migration **900**, numbered far above upstream's live range (upstream's highest is 42 at
      the pin), so a rebase that lands upstream migrations 43…n cannot collide. The gap is
      asserted by a test that reads `migrationEntries` and fails if upstream reaches 900.
- [ ] The migration is `ALTER TABLE … ADD COLUMN` only. Nothing is rewritten, no table is
      recreated, no data is backfilled.
- [ ] `ThreadCreatedPayload` events already in the log decode with both fields defaulting to
      `null` — decoding **defaults**, never fails.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 8**: a populated pre-fork database opens against the customized server; the
      added columns read as `null` ("not recorded"), not as a guessed role; and a projection
      rebuilt from a pre-fork event log decodes every historical `ThreadCreatedPayload`.
- [ ] **Criterion 8b**: the server is killed partway through migration 900 and the resulting
      database still opens against the **pre-fork** server binary. Tested by killing the process,
      not by arguing that additive columns are safe.
- [ ] Fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: decode a `ThreadCreatedPayload` with no `role`/`parentThreadId`; encode round-trip;
  shell decode with the fields present and absent.
- Integration: build a pre-fork database fixture (populated by the pinned server), migrate it,
  read it; then rebuild the projection from its event log and compare thread counts and ids.
- Fault injection: `SIGKILL` the migrating process, then open the file with the pinned server.
- Regression: the migration-number gap assertion.

### Phase 3: Hierarchy integrity refused at write time

**Dependencies**: Phase 2

#### Objective

Every illegal edge is **refused by the server when it is written**, with a named signal. No
fallback rendering, because a fallback is a second correct-looking answer.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `apps/server/src/orchestration/commandInvariants.ts` — the five refusals.
- `apps/server/src/orchestration/decider.ts` — apply them on `thread.create` and on any command
  that sets `role` or `parentThreadId`.
- `apps/server/src/orchestration/Errors.ts` — `CodevHierarchyInvalid` with a reason discriminant.
- `apps/server/src/orchestration/decider.codevHierarchy.test.ts` — new.
- `apps/server/src/orchestration/commandInvariants.test.ts` — extend.

#### Deliverables

- [ ] Refused: a builder whose `parentThreadId` names an absent thread, a thread in another
      project, or itself.
- [ ] Refused: a builder parented to another **builder**, or to a `role: null` thread. The only
      legal edge is architect → builder.
- [ ] Refused: a builder with **no** `parentThreadId`.
- [ ] Refused: a thread with `role: "architect"` or `role: null` carrying a `parentThreadId`.
- [ ] Each refusal carries its own reason discriminant, so a caller can tell "no such parent"
      from "wrong parent role" — one generic error for five causes is not enough to act on.
- [ ] A parent **archived or deleted** after the fact is not retro-refused; its children become
      orphans, recorded as such, and rendered in a stated unattributed group in phase 7.
      `archivedAt` already exists, so archiving is the likelier case and is the one tested first.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 11**: each listed case is refused at write time, verified against the decider,
      not against the UI.
- [ ] Archiving an architect leaves its builders readable and marked orphaned, not dropped and
      not deleted.
- [ ] Fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: one decider test per refusal case, asserting the discriminant and not just the failure.
- Unit: legal architect → builder edge accepted; `role: null` thread with no parent accepted.
- Integration: archive a parent with live children, then read the shell snapshot.

### Phase 4: Porch gate block with a server-allocated revision

**Dependencies**: Phase 3

#### Objective

A porch gate is first-class state on the thread record, protected by a **server-allocated**
monotonic revision that survives the gate being cleared, and writable only by a credential
holding a new `codev:gate-write` scope.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `packages/contracts/src/orchestration.ts` — `CodevGate` (gate name, `requestedAt`, #128's
  structured `question` and `choices`), nullable `codevGate` on the thread record, and a
  **non-nullable** `gateRevision` defaulting to `0`. A `codev.gate.set` / `codev.gate.clear`
  command pair.
- `packages/contracts/src/auth.ts` — `AuthCodevGateWriteScope = "codev:gate-write"`.
- `apps/server/src/persistence/Migrations/901_CodevThreadGate.ts` — new.
- `apps/server/src/persistence/Migrations.ts` — register `[901, "CodevThreadGate", …]`.
- `apps/server/src/orchestration/decider.ts` + `projector.ts` — allocate and enforce the revision.
- `apps/server/src/auth/…` — grant `codev:gate-write` to exactly one credential provisioned out
  of band at server start; never issue it to a thread.
- `apps/server/src/orchestration/decider.codevGate.test.ts` — new.
- `apps/server/src/auth/CodevGateScope.test.ts` — new.

#### Deliverables

- [ ] The gate block carries gate name, requested-at, and #128's structured question with one to
      five choices, each with a label and a consequence, and at most one marked recommended.
- [ ] `gateRevision` is stored **separately from the block** and is a non-nullable high-water
      mark that only ever increases — including across a clear. Clearing is a write like any
      other and raises the mark.
- [ ] The **server** allocates `gateRevision + 1` atomically and returns it. `codev-agent` sends
      a gate write with no revision. A counter held in `codev-agent`'s memory is explicitly not
      used: it resets on restart, and a reset counter renders every later gate as *no gate
      pending*, which is a false negative exactly where a human is waiting.
- [ ] A write whose revision does not **exceed** the mark is rejected. Equal is rejected, not
      treated as idempotent. A retry of the same logical write becomes a new revision, which is
      safe because the content is identical.
- [ ] Historical rows default to `0`.
- [ ] Gate writes require `codev:gate-write`. A caller holding only `orchestration:operate` is
      refused with a **named** signal (`CODEV_GATE_SCOPE_REQUIRED`), not a generic 403 — every
      thread-driving client already holds `orchestration:operate`, so reusing it would grant
      gate-writing to every builder.
- [ ] `hasPendingApprovals` is untouched. Provider tool approvals and porch gates stay separate.
- [ ] Payload limits: an oversize or malformed gate payload is refused at the schema boundary and
      does not partially apply.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 10**: clear an approved gate, then deliver a write carrying a lower revision;
      the gate does not reappear.
- [ ] A gate replaced by a later gate on the same thread does not resurrect the first.
- [ ] Two concurrent connections writing gates receive two different revisions.
- [ ] `codev:gate-write` refusal is distinguishable from an unauthenticated 401 and from an
      ordinary scope failure.
- [ ] Fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: revision allocation is monotonic across set, clear, set; stale and equal revisions both
  rejected; historical row defaults to `0`.
- Unit: scope enforcement, with `orchestration:operate` alone and with the gate scope.
- Integration: restart the writer between two gates and confirm the mark survived.
- Adversarial: malformed payloads, six choices, an empty question, a multi-line question,
  a payload past the size cap.

### Phase 5: Vendored contract regenerated from the fork

**Dependencies**: Phase 4

#### Objective

This repository's vendored contract regenerates **from the fork** and passes `shape-check`, so
`porch-driver` and `codev-agent` can send the new fields against a contract that knows them.

#### Files to Create / Modify

This repository:
- `packages/types/src/t3/pin.json` — `commit` becomes the fork head carrying phases 2–4.
- `packages/types/src/t3/generated/*` — regenerated (`schema.json`, `schema.ts`, `types.d.ts`,
  `methods.json`, `source-hash.json`, `ATTRIBUTION.md`, `LOSSY.md`, `UNREPRESENTED.md`).
- `tools/t3-fork/patches/*.patch` — `git format-patch upstreamBase..forkHEAD`, review aid only.
- `tools/t3-fork/FORK.md` — phase-to-commit log filled in.
- `packages/codev/src/__tests__/spec-250-generated-contract.test.ts` — new.

#### Deliverables

- [ ] Regeneration runs against `/Users/chris/dev/t3code-codev`, not the upstream clone.
- [ ] The closure is unchanged — still the nine files. If the new code makes `orchestration.ts`
      import something outside the closure, the generator fails and the widening is a deliberate
      decision, not a silent follow.
- [ ] `source-hash.json` carries both the fork hashes and the upstream-at-`upstreamBase` hashes
      from phase 1.
- [ ] `shape-check.ts` is **not** relaxed. Its stated semantics — a lower bound in one direction,
      stricter in another — hold unchanged; the added fields must not turn it into a claim of
      validity it does not make.
- [ ] Patch export committed, with `FORK.md` stating plainly that it is for review and that
      patch-application is not how the fork is built or rebased.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 9, regeneration half**: the contract regenerates from the fork and
      `shape-check` is green.
- [ ] `role`, `parentThreadId`, `codevGate` and `gateRevision` are present in `schema.json` and
      typed (not `unknown`) in `types.d.ts`.
- [ ] `verify` passes both identities with the new `pin.commit`.
- [ ] `pnpm -w test` green.

#### Test Plan

- Unit: assert the four new fields resolve to real types in the generated artifacts, and that a
  round-trip payload with them passes `shapeCheck`.
- Unit: assert `source-hash.json` has both sections and that they differ.
- Regression: the existing `spec-146-t3-contract.test.ts` suite still passes unchanged.

### Phase 6: Hierarchy and gate state published by porch-driver and codev-agent

**Dependencies**: Phase 5

#### Objective

The two Codev-side producers start supplying what the fork can now hold: `porch-driver` names the
role and the parent at `thread.create`; `codev-agent` maps workspaces to projects and publishes
gate state from `status.yaml`.

#### Files to Create / Modify

This repository:
- `packages/porch-driver/src/thread.ts` — `role` and `parentThreadId` on `CreateThreadOptions`
  and on the `thread.create` payload.
- `packages/codev/src/agent-farm/servers/t3-project-map.ts` — new. Canonical workspace root to
  `projectId`, keyed the way `global.db` and the engine map already key it.
- `packages/codev/src/agent-farm/servers/t3-gate-publisher.ts` — new. Reads gate state through
  the existing `status-reader.ts` and writes `codev.gate.set` / `codev.gate.clear`.
- `packages/codev/src/agent-farm/servers/status-reader.ts` — hook for the publisher; no change to
  what it reads.
- `packages/codev/src/__tests__/spec-250-porch-driver-hierarchy.test.ts` — new.
- `packages/codev/src/agent-farm/__tests__/spec-250-gate-publisher.test.ts` — new.
- `packages/codev/src/agent-farm/__tests__/spec-250-project-map.test.ts` — new.

#### Deliverables

- [ ] An architect thread is created with `role: "architect"` and no parent; a builder thread
      with `role: "builder"` and the architect's thread id.
- [ ] A workspace with no project gets one created on first spawn. A `projectId` that no longer
      resolves is **reported as unresolvable**, not rendered as an empty workspace.
- [ ] Nothing derives a `projectId` from a path at read time: two checkouts of the same repo are
      two workspaces, and a path is not stable across machines.
- [ ] `codev-agent` is the **only** gate writer, and it holds the only `codev:gate-write`
      credential.
- [ ] `status.yaml` stays authoritative. The block is a projection of it; any disagreement is
      resolved by re-reading `status.yaml`, never the other way.
- [ ] The publisher sends **no revision**; it uses the one the server returns. On reconnect it
      republishes current state rather than replaying history.
- [ ] Gate name and #128's structured request travel intact — the gate name never goes in the
      thread **title** again.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A spawned architect and its builders land on the fork with correct roles and parents,
      accepted by phase 3's invariants.
- [ ] A gate reaching `pending` in `status.yaml` appears as a gate block within one publish
      cycle; approving it clears the block.
- [ ] Killing and restarting `codev-agent` mid-gate leaves the rendered gate matching
      `status.yaml` (spec test scenario 4).
- [ ] `pnpm -w test` green.

#### Test Plan

- Unit: `thread.create` payload shape, including that a builder without a parent is refused
  before dispatch rather than at the server.
- Unit: project-map creation, reuse, and the unresolvable case as its own signal.
- Integration: a `status.yaml` fixture walked through pending → approved → next gate, asserting
  the command sequence.
- Integration: publisher restart mid-gate; the server's mark, not the publisher's memory, decides.

### Phase 7: Workspace to architect to builder sidebar

**Dependencies**: Phase 6

#### Objective

t3code's own sidebar renders the three-level tree, several architects per project, ordinary
t3code threads untouched, and orphans in a stated group.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `apps/web/src/codev/hierarchy.ts` — new. Pure grouping: shells in, tree out.
- `apps/web/src/components/Sidebar.logic.ts` — consume it.
- `apps/web/src/components/Sidebar.tsx` — render the nesting.
- `apps/web/src/sidebarProjectGrouping.ts` — extend rather than replace.
- `apps/web/src/codev/hierarchy.test.ts` — new.
- `apps/web/src/components/Sidebar.logic.test.ts` — extend.

#### Deliverables

- [ ] Project, then each architect, then that architect's builders.
- [ ] Two architects in one project render as two subtrees, each owning its own builders.
- [ ] Threads with `role: null` keep the **existing flat presentation** in their own section.
      Nothing in the new tree claims them.
- [ ] Builders whose parent is archived or deleted render in a stated unattributed group — named
      as orphaned, not silently dropped and not re-parented to a guess.
- [ ] Grouping is a pure function with its own unit tests; the component applies what it returns.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 1**: one architect and three builders render as a tree, verified in t3code's
      own web app under Playwright, not only in a unit test.
- [ ] **Criterion 2**: two architects, each with its own builders, render as two subtrees.
- [ ] **Criterion 7**: a thread created by t3code's own UI appears where it always did.
- [ ] **Criterion 11's rendering half**: orphans appear in the unattributed group.
- [ ] Fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: one architect / three builders; two architects; mixed `role: null`; orphan; a builder
  whose parent is in another project (which phase 3 refuses at write time, so this asserts the
  renderer does not invent a fallback for a state that cannot exist).
- Playwright: the three-level tree in the running web app, per `codev/resources/testing-guide.md`.
- Visual: compare the rendered sidebar against t3code's existing sidebar, since a green test
  suite cannot detect a design that lost its chrome.

### Phase 8: Gate rendering in t3code

**Dependencies**: Phase 7

#### Objective

A builder blocked on a gate says so in t3code — which gate, its question, its choices — read
from the gate block, never from the title.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `apps/web/src/codev/GatePanel.tsx` — new.
- `apps/web/src/codev/gateState.ts` — new. Derivation from the shell, as a pure function.
- `apps/web/src/components/Sidebar.tsx` — the row badge.
- `apps/web/src/codev/gateState.test.ts`, `apps/web/src/codev/GatePanel.test.tsx` — new.

#### Deliverables

- [ ] A gated builder is visually distinct from a settled one. `starting` / `running` / `ready` /
      `settled` cannot express "blocked on a human", so the gate state is rendered as its own
      thing rather than folded into status.
- [ ] The panel shows gate name, requested-at, the question, and each choice's label and
      consequence, with the recommended one marked when there is one.
- [ ] A gate whose block is present but whose structured request is absent renders as "gate
      pending, no structured request" — a **third** state, never as "no gate" and never as an
      empty question. `porch gate` without `--request-file` is a legitimate, common case.
- [ ] No `dangerouslySetInnerHTML`. Gate text is content, not markup.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 3**: a builder stopped at `plan-approval` shows the gate name and #128's
      structured question with its choices, sourced from the gate block.
- [ ] The thread title contains no gate name anywhere in the flow.
- [ ] Fork `pnpm typecheck` and `pnpm test` green; Playwright confirms the rendered panel.

#### Test Plan

- Unit: gate present with request, gate present without request, no gate, gate cleared.
- Unit: one to five choices; a choice with no consequence; no recommendation.
- Playwright: drive a real builder to `plan-approval` and read the panel.

### Phase 9: Builder tiling

**Dependencies**: Phase 8

#### Objective

Four to six builder threads visible at once inside t3code's chrome, with the geometry ported from
`apps/client/src/responsive/layout.ts` and re-measured against t3code rather than assumed.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `apps/web/src/codev/layout.ts` — new. Ported pure functions.
- `apps/web/src/codev/BuilderGrid.tsx`, `apps/web/src/codev/BuilderPane.tsx` — new.
- `apps/web/src/routes/…` — a route that hosts the grid.
- `apps/web/src/codev/layout.test.ts` — new.

#### Deliverables

- [ ] The column rule is **"as few rows as fit"**, explicitly not "near-square", which
      `apps/client/src/responsive/layout.ts:70-82` records as considered and rejected.
- [ ] Floors: panes at least 340x240 CSS px, body text 13px or larger.
- [ ] `PAGE_PADDING`, `GRID_GAP` and the paging threshold are **re-measured against t3code's
      chrome**, which is not `apps/client`'s. The ported constants are a starting point, not an
      answer, and the measured values are recorded in the file's comments.
- [ ] A pane renders exactly four things: role-prefixed id, status, porch phase, and the last
      three messages addressed to that agent. **Not** a live transcript — six live transcripts is
      six continuous subscriptions, a different feature at a different cost. A full transcript is
      read by opening one thread full-size, which t3code already does.
- [ ] Below the paging threshold the grid pages rather than shrinks; no horizontal scroll at
      390px.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 5**: six builder threads watchable at 1440x900, panes at least 340x240 CSS px,
      body text 13px or larger, **measured from the rendered page** under Playwright.
- [ ] **Criterion 5b**: seven panes at 1920 tile **4x2, not 3x3**. This is the case that
      distinguishes the two rules — both give 3 columns at 1440x900, so criterion 5 alone cannot
      tell them apart.
- [ ] The same grid at 390px has no horizontal scroll.
- [ ] Fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: `columnsFor` across 1..8 panes at 1440, 1920 and 700, including the 7-at-1920 case as its
  own named test.
- Playwright: measure pane boxes and computed font size at 1440x900 with six panes; at 1920 with
  seven; at 390px for overflow.
- Visual: the grid beside the `apps/client` grid, to catch content that was dropped rather than
  laid out.

### Phase 10: Approval from t3code over the same-origin proxy

**Dependencies**: Phase 9

#### Objective

The gate is approved from t3code's web app, over `codev-agent`'s existing capability path,
same-origin, with no widening of `connect-src`.

#### Files to Create / Modify

In `/Users/chris/dev/t3code-codev`:
- `apps/server/src/codev/agentProxy.ts` — new. Same-origin proxy to `codev-agent`, mirroring what
  `packages/codev/src/agent-farm/servers/client-static.ts` does for `/m/<id>/`.
- `apps/server/src/codev/agentProxy.test.ts` — new.
- `apps/web/src/codev/pairing.ts`, `apps/web/src/codev/approval.ts` — new. Ported from
  `apps/client/src/gate/approval.ts`.
- `apps/web/src/codev/PairingPanel.tsx` — new. The pairing entry point.
- `apps/web/src/codev/GatePanel.tsx` — the approve action.

This repository:
- `packages/codev/src/agent-farm/__tests__/spec-250-t3code-approval.e2e.test.ts` — new.

#### Deliverables

- [ ] The web app holds **both** halves the path needs: a **machine credential** redeemed from a
      `machine-credential` pairing token, and a **`client-session`** token per session. One is
      not the other, and neither alone approves anything.
- [ ] It also holds the `codev-agent` origin and the workspace path identifying which workspace
      it is approving in.
- [ ] Both travel the existing ceremony — `afx pair issue --purpose client-session` and the
      human-session route — which already exist and are tested. t3code gains a pairing entry
      point; it does **not** gain approval authority.
- [ ] t3code's authenticated browser session is never an approval credential.
- [ ] The credential is held in per-origin browser storage. This is a **deliberate departure**
      from `apps/client`, which reads an operator-written `~/.agent-farm/client-machines.json` at
      mode 0600 that t3code's app has no equivalent of. It is strictly more exposed — an XSS on
      the page reaches it, and the proxy sees every forwarded credential — so it is scoped and
      revocable by design (`afx pair revoke <machine>`), and it is **never Tower's shared key**,
      which cannot be revoked for one machine without rotating it for all.
- [ ] The page makes no cross-origin request. `connect-src 'self'` stays closed and is asserted.
- [ ] The proxy strips hop-by-hop headers and refuses to forward an unexpected credential header,
      the way `client-static.ts` already does.
- [ ] Approval outcomes keep three states, not two: approved, refused, and **unconfirmed** — a
      server answer the client could not read. Rendering unconfirmed as a refusal sends a human to
      approve twice at the one point where a duplicate costs something.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 4**: a gate is approved from t3code and porch records the approving session id,
      machine and timestamp in `status.yaml`, over `codev-agent`'s capability path.
- [ ] A caller without a machine credential, and one without a human session, are refused
      differently — neither refusal is spelled like the other.
- [ ] `afx pair revoke <machine>` stops that browser approving, and stops nothing else.
- [ ] `pnpm -w test` green; fork `pnpm typecheck` and `pnpm test` green.

#### Test Plan

- Unit: proxy header handling, path allowlist, and the refusal for a path the table does not name.
- Unit: the four-request approval walk, including the unconfirmed branch.
- Integration: approve a real gate end to end against a live `codev-agent` and assert
  `status.yaml`.
- Adversarial: session without machine credential; machine credential from another machine;
  revoked credential; an approval replayed after revocation.

### Phase 11: Acceptance run — tailnet iPad and the rebase drill

**Dependencies**: Phase 10

#### Objective

Close the two criteria that only a run can close, and turn the rebase into a recorded procedure
rather than an event.

#### Files to Create / Modify

This repository:
- `tools/t3-server/collect-spec-250-evidence.mjs` — new, alongside the existing
  `collect-phase10-evidence.mjs`.
- `tools/t3-codegen/REFRESH.md` — the drill's result recorded against the procedure.
- `tools/t3-fork/FORK.md` — the rebase entry.
- `packages/types/src/t3/pin.json` — `upstreamBase` and `commit` advanced by the drill.
- `packages/types/src/t3/generated/*` — regenerated after the rebase.
- `codev/resources/250-acceptance-evidence.md` — new. What was run, on what, with what result.
- `codev/reviews/250-t3code-front-end-customization.md` — the review.

#### Deliverables

- [ ] The rebase drill: rebase the fork onto a later upstream commit **named in `pin.json` at the
      time the drill runs**, regenerate the contract from the fork, pass `shape-check`, and pass
      `verify` on both identities including the merge-base assertion.
- [ ] Upstream churn measured as `oldUpstreamBase..newUpstreamTarget` in the **upstream**
      checkout. This is the range that goes silent if nobody asks it, so it is the one asserted.
- [ ] A zero churn result is reported `NO_UPSTREAM_MOVEMENT` and **passes** — the pin was days old
      and `classify-churn` counts only closure-touching commits, so a legitimate zero exists. The
      tool failing, or reading the wrong ref, does not pass. Criterion 9 is satisfied by the
      procedure running and reporting one of those three outcomes, never by an unexplained zero.
- [ ] Migration numbers re-checked after the rebase: upstream must not have reached 900.
- [ ] Evidence file records the iPad run: device, network path, what was driven, what was seen.
- [ ] `apps/client` is confirmed **frozen and still green** — its tests pass, and this spec added
      no front-end features to it. Spec 146's criteria 3, 4, 4b, 5, 7 and 8 are already-met facts
      about it and are not re-verified.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 6**: the tree, the gate and the approval are reached from an iPad over the
      tailnet — no account, no cloud relay — and a builder is driven to completion.
- [ ] **Criterion 9** end to end, with the three-outcome churn report recorded.
- [ ] All eleven criteria (1, 2, 3, 4, 5, 5b, 6, 7, 8, 8b, 9, 10, 11) have a named test or a
      recorded run.
- [ ] `pnpm -w test` green.

#### Test Plan

- Manual, recorded: the iPad run over the tailnet, start to finish, with the evidence collector
  capturing what it can.
- Procedural: the rebase drill executed against `REFRESH.md`, with the doc corrected wherever the
  run diverged from it.
- Regression: the full suite in both trees, plus `apps/client`'s.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Churn detection goes blind** — a single range compares our tree to itself and reports no churn forever | High | High | Phase 1 splits it into two named ranges over two checkouts; phase 11 asserts the upstream range against a known-moved upstream |
| **`T3CODE_ROOT` stretched over two meanings** — one variable, six consumers, and `verify` against the upstream clone fails once `pin.commit` names the fork | High | High | Explicit per identity: `T3CODE_ROOT` stays upstream, `T3CODE_FORK_ROOT` is the fork, each with its own assertions |
| **Rebase-time migration collision** — upstream adds a migration in our number range | Medium | High | Ours start at 900, far above upstream's 42; a test reads `migrationEntries` and fails if upstream approaches |
| **Stale gate write recreates an approved gate** | Medium | High | Server-allocated high-water mark that survives the clear; criterion 10 delivers a stale revision after approval |
| **`codev-agent` restart resets a client-side counter** and silently renders every later gate as "none pending" | Medium | High | The counter is the server's, never the publisher's. Phase 4 makes this the mechanism, phase 6 asserts it across a restart |
| The generator's source-hash becomes a tautology once generation is fork-sourced | High | Medium | Phase 1 hashes the upstream closure at `upstreamBase` alongside the fork's |
| **Creating a public fork is outward-facing** and cannot be undone quietly | Certain | Low | Flagged to the architect before `gh repo fork` in phase 1; the spec bakes the destination |
| The fork's commits cannot appear in this repository's PR, leaving a reviewer with no diff | High | Medium | `pin.commit` names it, `FORK.md` logs it, phase 5 exports patches as a review aid |
| The fork becomes unmergeable | Medium | High | Keep the diff narrow: two record fields, one gate block, one scope, sidebar, tiling, proxy. No refactors of upstream code |
| Upstream security fix reaches us late — we now fork a server that executes shell commands | Medium | High | Criterion 9's cadence gets an owner and a maximum interval after the first rebase is measured |
| Building and testing the fork is a large `pnpm` install on Node ^24.13.1 | Medium | Medium | Fork install is done once in phase 1, before any phase depends on it; the Node advisory already recorded in the harness stands |
| `apps/client` and t3code drift into two half-maintained clients | High | Low | `apps/client` is frozen — it keeps passing its tests and receives fixes; new front-end features land only in t3code |

## Documentation Updates

- `tools/t3-codegen/REFRESH.md` — the two-identity refresh and the rebase procedure (phases 1
  and 11).
- `tools/t3-fork/FORK.md` — new: remote, branch, checkout path, phase-to-commit log, and the
  statement that the exported patches are a review aid, not the build mechanism.
- `codev/resources/250-acceptance-evidence.md` — new: the criterion 6 and 9 runs.
- `codev/reviews/250-t3code-front-end-customization.md` — the review, at the end.
- `CLAUDE.md` and `AGENTS.md` — **only if** the fork becomes a requirement for working in this
  repo. Byte-identical if touched.
- `codev/resources/arch.md` / `arch-critical.md` and `lessons-learned.md` /
  `lessons-critical.md` — routed by tier at review time, not pre-committed here. Candidate facts:
  the two-identity vendoring rule, and that porch gate state is a projection of `status.yaml`
  with `status.yaml` authoritative.
