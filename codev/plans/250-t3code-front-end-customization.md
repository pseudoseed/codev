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

### The added columns do not go through upstream's migrator

Plan review round 1 found this and I verified it in
`node_modules/.pnpm/effect@4.0.0-beta.103/.../unstable/sql/Migrator.js`. Upstream's migrator is a
**watermark**, not a set difference:

```js
const latestMigration = sql`SELECT migration_id, name, created_at FROM ${sql(table)} ORDER BY migration_id DESC`  // :78
if (currentId <= latestMigrationId) { continue; }                                                                 // :121
```

So any id we register becomes `MAX(migration_id)`. A high number — the first draft of this plan
said 900, reasoning that a big gap avoids collision — sets the watermark to 901, and **every
upstream migration that arrives later (043, 044, …) is silently skipped** while the migrator logs
that the schema is current. The mitigation inverted its own goal: it converted a loud collision
into silent schema divergence, at exactly the moment the plan calls routine. Tail numbering
(043, 044) is no better; it collides on the next upstream bump and needs a per-rebase rewrite of
recorded rows in `effect_sql_migrations`, on a database whose only backup is the owner's.

**So Codev's columns never enter `migrationEntries`.** They are applied at server start by a
guarded, idempotent `PRAGMA table_info` + `ALTER TABLE … ADD COLUMN`, which never reads or writes
`effect_sql_migrations` and leaves the watermark exactly where upstream put it.

**The guard is upstream's own idiom, not an invention.** Verified: upstream already adds nullable
columns exactly this way. `042_ProjectionThreadLinkedPullRequest.ts` in full —

```ts
const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
if (!columns.some((column) => column.name === "linked_pull_request_json")) {
  yield* sql`ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT`;
}
```

`033_ProjectionThreadsSettled.ts`, `034`, `035`, `039`, `040`, `021`, `022` and `032` all do the
same. So our column applier is that code verbatim; the only difference is **where it is invoked
from** — a layer sequenced after `MigrationsLive` (`Migrations.ts:173`) rather than an entry in
`migrationEntries`.

That narrows the deviation to one question: registry membership. **Ruled by the architect on
2026-08-30 — stay out of the numbered registry, and this supersedes the spec's risk row.** The
reasoning, recorded because it is not the obvious answer: a number we occupy is a number upstream
will eventually want, and that collision is silent. Two entries claiming `043` means one is
skipped and its column never appears, which reads at runtime as "not recorded" rather than as a
failed migration. The spec's own mitigation — "number ours far above upstream's range" — is
obsolete for the same reason: a high number is still inside upstream's sequence and still collides
once they reach it. A separate layer cannot collide at all.

**The cost is real and is recorded rather than argued away:** our column addition never appears in
upstream's migration history, so someone debugging a schema question reads `migrationEntries` and
`effect_sql_migrations` and does not see ours. Mitigated by logging it once at start-up under a
named signal, so "our columns were added" is observable somewhere rather than only inferrable from
the schema itself.

### Two repositories, one PR

The fork's commits live on `pseudoseed/t3code@codev` and **cannot appear in this repository's
PR**. Three things bridge that gap, and none of them is "apply a patch to a checkout" — spec
approach 1 is rejected and stays rejected:

- `pin.json` records the fork commit, so the Codev tree names exactly what it was built against.
- `tools/t3-fork/FORK.md` records the remote, branch, checkout path, and a phase-to-commit log.
- Phase 5 exports `git format-patch upstreamBase..forkHEAD` into `tools/t3-fork/patches/` as a
  **review aid** — so a reviewer of the Codev PR can read the six changes without cloning the
  fork. It is never the mechanism by which the fork is built or rebased.

### The browser harness lives in this repository, not the fork

Criteria 1, 2, 3, 5, 5b and 7 are all "verified in t3code's own web app", and 5 and 5b are
measurements — pane boxes in CSS px, computed font size — that only a real browser produces.

**t3code has no browser test tooling at all.** Verified rather than assumed: no `playwright`
anywhere in its `package.json` files, and `apps/web`'s entire test script is
`vp test run --passWithNoTests --project unit` with `@effect/vitest` as its only test dependency.
The first draft of this plan named Playwright verification in three phases without checking that.

This repository already has `@playwright/test ^1.58.0` in `packages/codev`, `apps/client`,
`apps/v2` and `packages/artifact-canvas`. So the measurement harness lives **here**, driving the
fork's dev server over HTTP, rather than being added to the fork. Two reasons, in order: it keeps
the fork diff narrow, which the spec names as the mitigation for unmergeability; and the criteria
belong to Codev, so the tests that close them belong in Codev's tree where they run in Codev's CI.

The cost is that these tests need a running fork — `pnpm dev:web` plus a server and a seeded
project — so they are gated on that being up and **report a skip as a skip**, never as a pass.

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
- `tools/t3-server/t3-server.mjs` — **`verify`, `acquire`, `start` and `status`**, not `verify`
  alone. See the deliverable below: leaving `acquire` on `pin.commit` is destructive.
- `tools/t3-codegen/classify-churn.mjs` — two named ranges, two checkouts.
- `tools/t3-codegen/generate.mjs` — **the root switch is the load-bearing edit**: `:51` reads
  `T3CODE_ROOT` and `:78` refuses when `git rev-parse HEAD` there does not equal `pin.commit`.
  Since `pin.commit` becomes the fork head, generation must read the **fork** root. Plus
  `source-hash.json` records the upstream closure hash at `upstreamBase` alongside the fork's.
- `tools/t3-server/smoke.mjs` (`:177`), `tools/t3-codegen/transform-blindness-probe.mjs` (`:29`),
  `packages/t3-client/live/integration.mjs` (`:77-79`, `:213`, `:219`) — the other
  `T3CODE_ROOT` readers, each assigned to an identity deliberately.
- `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` (`:43`, `:143`, `:322-338`) — the
  seventh reader, and the suite phase 1 breaks (see deliverables).
- `codev/research/146-harness-coldstart-evidence.json` — re-collected, because editing
  `t3-server.mjs` invalidates it.
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
- [ ] **All seven `T3CODE_ROOT` readers are assigned, not three.** Verified by grep, not assumed:

      | Reader | Identity | Why |
      |---|---|---|
      | `tools/t3-server/t3-server.mjs:38` | both | it is the verifier |
      | `tools/t3-codegen/generate.mjs:51,78` | **fork** | generation is fork-sourced from phase 5 |
      | `tools/t3-codegen/classify-churn.mjs:38` | both | one per range |
      | `tools/t3-codegen/transform-blindness-probe.mjs:29` | fork | it probes what we emit |
      | `tools/t3-server/smoke.mjs:177` | upstream | keeps the spec-146 evidence reproducible |
      | `packages/t3-client/live/integration.mjs:77,213,219` | upstream | spec 146 / #241 live tests, meaning unchanged |
      | `packages/codev/src/__tests__/spec-146-t3-contract.test.ts:43` | upstream | asserts the upstream harness |

- [ ] **The cold-start evidence is re-collected.** `spec-146-t3-contract.test.ts:254` fails if
      `codev/research/146-harness-coldstart-evidence.json` is older than `t3-server.mjs` or
      `smoke.mjs`, and this phase edits `t3-server.mjs`. That test is doing its job — it exists
      so a harness change cannot ride on stale evidence — so the evidence is regenerated against
      a live pinned server, not the assertion loosened:

      ```
      export T3_NODE=/absolute/path/to/node
      "$T3_NODE" tools/t3-server/smoke.mjs --runs 2 > codev/research/146-harness-coldstart-evidence.json
      ```

      Needs a live server at the pinned commit. Planned as a step, not discovered as a failure.
- [ ] **`acquire`, `start` and `status` are pinned to `upstreamBase`, not to `pin.commit`.**
      Review round 1 caught this and it is the one item here that can destroy something.
      `acquire()` does `gitIn(t3Root, 'checkout', '--detach', pin.commit)` (`t3-server.mjs:94`)
      against `T3CODE_ROOT` — the read-only upstream clone. Once phase 5 moves `pin.commit` to the
      fork head, that line tries to check a **fork** SHA out into the **upstream** clone, and
      `start` (`:389`) and `status` (`:663`) compare against `pin.commit` the same way. Both
      `tools/t3-server/smoke.mjs:156` and `packages/t3-client/live/integration.mjs:196` call
      `acquire`, so this fires from an ordinary test run, not only from a deliberate invocation.
      The upstream clone exists precisely to stay reproducible at `upstreamBase`; rewiring only
      `verify` would leave the one verb that *writes* to it still pointing at the fork.
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
- [ ] `pnpm -w test` green — **including `spec-146-t3-contract.test.ts`**, which needs the
      re-collected evidence above. A green run that skipped that suite for want of a checkout is
      not a pass and is reported as a skip.
- [ ] Build and typecheck pass.

#### Test Plan

- Unit: pin parsing with and without `upstreamBase`; the three exit codes as three distinct
  outcomes; range construction for both churn modes.
- Regression: `spec-146-t3-contract.test.ts` run with `T3CODE_ROOT` set, so the live suite
  actually executes rather than skipping.
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
- `apps/server/src/codev/schemaGuard.ts` — new. The guarded, idempotent column applier. **Not**
  a file under `Migrations/`, and **not** registered in `Migrations.ts`.
- `apps/server/src/persistence/Migrations.ts` — export a `CodevSchemaGuardLive` layer sequenced
  **after** `MigrationsLive` (`:173`) and before the projection layers open. `migrationEntries`
  itself is not touched.
- `apps/server/src/orchestration/projector.ts` — read and write the columns.
- `apps/server/src/orchestration/Schemas.ts` — re-export as the file already does.
- **The columns must flow through the whole persistence path, not just the in-memory projector.**
  Review round 1 caught the first draft naming too few modules; all four verified to exist:
  - `apps/server/src/persistence/Services/ProjectionThreads.ts`
  - `apps/server/src/persistence/Layers/ProjectionThreads.ts`
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `packages/contracts/src/orchestration.test.ts` — decode cases.
- `apps/server/src/orchestration/projector.codevHierarchy.test.ts` — new.
- `apps/server/src/codev/schemaGuard.test.ts` — new.

This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged. This is the phase's only artifact in
  this repository, and it is what makes a fork-only phase committable here.

#### Deliverables

- [ ] `role` is `"architect" | "builder" | null`; `null` means a thread Codev did not create.
- [ ] `parentThreadId` is a nullable `ThreadId`.
- [ ] **The columns are applied outside upstream's migrator, using upstream's own idiom.**
      `schemaGuard.ts` reads `PRAGMA table_info(projection_threads)` and issues
      `ALTER TABLE … ADD COLUMN` only for absent columns — the same shape as
      `042_ProjectionThreadLinkedPullRequest.ts` and seven other upstream migrations. It never
      reads or writes `effect_sql_migrations`, so upstream's watermark (`Migrator.js:78`, `:121`)
      stays where upstream put it and every future upstream migration still runs.
- [ ] The guard is idempotent and safe to run on every start: present columns are left alone,
      absent ones are added, and running it twice changes nothing the second time.
- [ ] **The guard logs once at start-up under a named signal** — `CODEV_SCHEMA_GUARD_APPLIED`
      with the columns it added, and a distinct `CODEV_SCHEMA_GUARD_NOOP` when everything was
      already present. This is the agreed mitigation for the one real cost of staying out of the
      registry: our column addition is absent from upstream's migration history, so without a log
      line it is inferrable only by reading the schema. Two signals, not one, because "added two
      columns" and "had nothing to do" are different facts and a single line covering both is the
      thing that makes the log useless.
- [ ] `ALTER TABLE … ADD COLUMN` only. Nothing is rewritten, no table is recreated, no data is
      backfilled.
- [ ] The **first draft's migration 900 is explicitly abandoned**, and `FORK.md` records why, so
      nobody reintroduces a high id later reasoning that a big gap is safe. It is the opposite of
      safe under a watermark migrator.
- [ ] `ThreadCreatedPayload` events already in the log decode with both fields defaulting to
      `null` — decoding **defaults**, never fails.
- [ ] **Start-up layer ordering is stated, not left to construction order**, and asserted by a
      test: `SqliteClient` → `MigrationsLive` → `CodevSchemaGuardLive` → the projection layers.
      A repository query that runs before the guard reads a table without our columns, and the
      failure would look like missing data rather than a boot-order bug.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 8**: a populated pre-fork database opens against the customized server; the
      added columns read as `null` ("not recorded"), not as a guessed role; and a projection
      rebuilt from a pre-fork event log decodes every historical `ThreadCreatedPayload`.
- [ ] **A newly introduced upstream migration still runs after Codev's columns exist.** This is
      the test the first draft was missing, and it is the one that would have caught migration
      900: apply the guard, then add a fake upstream migration at the next free id, and assert it
      actually executes rather than being skipped.
- [ ] **Criterion 8b**: the server is killed partway through applying the columns and the
      resulting database still opens against the **pre-fork** server binary.

      Worth stating why this test now proves something. Under the abandoned migrator route it
      would have passed **by construction** — `Migrator.js:142` wraps the whole run in
      `sql.withTransaction` and SQLite DDL is transactional, so a kill rolls everything back and
      the criterion is met without the code being careful. Outside the migrator there is no such
      wrapper: two `ALTER` statements are two atomic steps, a kill between them leaves exactly one
      column added, and it is the `PRAGMA table_info` guard that makes the next start finish the
      job. The kill test now discriminates.
- [ ] Fork typecheck green, and fork tests green **for the packages this phase touches**
      (`@t3tools/contracts`, the server's orchestration and persistence suites). A full-monorepo
      `pnpm test` is run once, at phase 11 — making it an acceptance criterion on six separate
      phases buys nothing and costs a long run each time.

#### Test Plan

- Unit: decode a `ThreadCreatedPayload` with no `role`/`parentThreadId`; encode round-trip;
  shell decode with the fields present and absent.
- Integration: build a pre-fork database fixture (populated by the pinned server), migrate it,
  read it; then rebuild the projection from its event log and compare thread counts and ids.
- Fault injection: `SIGKILL` between the two `ALTER` statements, then open the file with the
  pinned server, then restart the customized server and confirm the guard completes the job.
- Regression: a fake upstream migration at the next free id runs after the guard has applied.
- Regression: `effect_sql_migrations` is byte-identical before and after the guard runs.

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
This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged; this phase's only artifact here.

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
- [ ] Fork typecheck green; fork tests green for the orchestration suites this phase touches.

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
- `apps/server/src/auth/RpcAuthorization.ts` — map the **new RPC method** to the new scope.
- `apps/server/src/persistence/Services/ProjectionThreads.ts`,
  `apps/server/src/persistence/Layers/ProjectionThreads.ts`,
  `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`,
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — the gate block and
  `gateRevision` flow through the same four modules phase 2 threads the hierarchy columns through.
- `apps/server/src/codev/schemaGuard.ts` — extended with the gate columns. Same mechanism as
  phase 2: guarded, idempotent, outside `migrationEntries`, watermark untouched.
- `apps/server/src/orchestration/decider.ts` + `projector.ts` — allocate and enforce the revision.
- `apps/server/src/auth/…` — grant `codev:gate-write` to exactly one credential provisioned out
  of band at server start; never issue it to a thread.
- `apps/server/src/orchestration/decider.codevGate.test.ts` — new.
- `apps/server/src/auth/CodevGateScope.test.ts` — new.
This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged; this phase's only artifact here.

#### Deliverables

- [ ] The gate block carries gate name, requested-at, and #128's structured question with one to
      five choices, each with a label and a consequence, and at most one marked recommended.
- [ ] `gateRevision` is stored **separately from the block** and is a non-nullable high-water
      mark that only ever increases — including across a clear. Clearing is a write like any
      other and raises the mark.
- [ ] **The revision field is optional, and that is what makes allocation and stale-rejection
      coexist.** The first draft asserted both "`codev-agent` sends no revision, the server
      allocates" and "a write carrying a lower revision is rejected", which review round 1 
      correctly called not implementable as written — if no write ever carries a revision, there
      is nothing to reject and criterion 10 has nothing to deliver. Resolved as one rule:

      | `revision` on the command | Server behaviour |
      |---|---|
      | absent — the normal path | allocate `gateRevision + 1` atomically, apply, return it |
      | present — a replay, or a write from an older connection | apply **only if it exceeds** the current mark; otherwise refuse with `CODEV_GATE_REVISION_STALE` |

      Equal is refused, not treated as idempotent. Criterion 10's stale write is exactly the
      second row.
- [ ] **The allocated revision is returned on the new RPC's own response**, not through
      `dispatchCommand` — an earlier draft of this phase said `dispatchCommand`, which was left
      over from before the gate commands moved off it. A gate write whose response cannot be read
      is reported as unconfirmed, never as applied.
- [ ] A counter held in `codev-agent`'s memory is explicitly not used: it resets on restart, and a
      reset counter renders every later gate as *no gate pending*, a false negative exactly where
      a human is waiting.
- [ ] Historical rows default to `0`, applied by the same guard rather than by a registered
      migration — a `DEFAULT 0` on the added column, so no backfill pass is needed.
- [ ] **Gate writes travel a separate RPC method, because the existing authorization point cannot
      see command types.** Verified: `apps/server/src/auth/RpcAuthorization.ts:24` maps
      `ORCHESTRATION_WS_METHODS.dispatchCommand` as a whole to `AuthOrchestrationOperateScope`.
      It authorizes the *method*, so routing `codev.gate.set` through `dispatchCommand` and hoping
      to scope it separately is not expressible — every operator would reach it.

- [ ] **The whole RPC surface is named, because a row in the scope map alone does not compile.**
      Review round 1 caught this: `RpcAuthorization.ts:130` is
      `satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>`, and `WsRpcMethod` derives
      from `WsRpcGroup` in `packages/contracts/src/rpc.ts` — a file deliberately **outside** the
      vendored closure. So adding only the authorization row is a type error. Four places, in
      order:

      | Where | What |
      |---|---|
      | `packages/contracts/src/rpc.ts` | `Rpc.make` for `codev.gateWrite`, and membership in `WsRpcGroup` |
      | `ORCHESTRATION_WS_METHODS` (or equivalent) | the method constant |
      | `apps/server/src/ws.ts` (`:1174`, `WsRpcGroup.of({…})`) | the handler key |
      | `apps/server/src/auth/RpcAuthorization.ts` | the row pointing at `codev:gate-write` |

      Avoiding a command-type branch inside `dispatchCommand` is still right; a separate handler
      key is not that branch.
- [ ] **The gate commands stay out of `ClientOrchestrationCommand` and
      `DispatchableClientOrchestrationCommand`** (`packages/contracts/src/orchestration.ts:935-987`).
      Those unions *are* the `dispatchCommand` payload, so putting the gate commands in them would
      hand gate-writing to every holder of `orchestration:operate` and silently bypass the new
      scope — undoing this phase's entire point. Internal-only commands already exist as
      precedent: `ThreadSessionSetCommand` is not in the client union.
- [ ] A caller holding only `orchestration:operate` is refused with a **named** signal
      (`CODEV_GATE_SCOPE_REQUIRED`), not a generic 403.
- [ ] **The credential path is named, and two exclusions are part of the deliverable.**
      `AuthEnvironmentScope` is a closed `Schema.Literals` list of eight
      (`packages/contracts/src/auth.ts:84-93`), so the new scope is added there — and `auth.ts` is
      on the vendored closure, so this is a contract change phase 5 must regenerate. It must
      **not** be added to:
      - `AuthStandardClientScopes` (`auth.ts:98-104`) — the set every ordinary client is issued;
      - the token allowlist at `apps/server/src/auth/http.ts:265-274`.

      Either would grant gate-writing to exactly the callers this scope exists to exclude. The
      phase names the issuance API and the on-disk path of the single credential, rather than
      leaving both to the implementer.
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
- [ ] Fork typecheck green; fork tests green for the orchestration and auth suites this phase
      touches.

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
- `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` — `:231`'s assertion re-scoped
  (see deliverables).

#### Deliverables

- [ ] Regeneration runs against `/Users/chris/dev/t3code-codev`, not the upstream clone.
- [ ] **`codev.gateWrite` is added to `pin.json`'s `methods` map, or it is not vendored at all.**
      Verified: `generate.mjs:335` iterates `Object.entries(pin.methods)`, not
      `OrchestrationRpcSchemas`, so a method present in the schemas map but absent from
      `pin.methods` is silently ignored and never reaches `methods.json`. There is precedent to
      follow rather than invent — the `vcs.*` entries are recorded in `pin.methods` exactly
      because their method strings live in the unvendored `rpc.ts`, which is the same situation
      the new method is in.
- [ ] The closure is unchanged — still the nine files, and this is checkable in advance rather
      than discovered at generation time. `ThreadId` is defined in `baseSchemas.ts`
      (`:55-56`), which is already on the closure list, and `role` is a plain
      `Schema.Literals` union, so neither new field reaches outside. If some later edit does, the
      generator fails and the widening is a deliberate decision, not a silent follow.
- [ ] `source-hash.json` carries both the fork hashes and the upstream-at-`upstreamBase` hashes
      from phase 1.
- [ ] `shape-check.ts` is **not** relaxed. Its stated semantics — a lower bound in one direction,
      stricter in another — hold unchanged; the added fields must not turn it into a claim of
      validity it does not make.
- [ ] Patch export committed, with `FORK.md` stating plainly that it is for review and that
      patch-application is not how the fork is built or rebased.
- [ ] **`spec-146-t3-contract.test.ts:231` is re-scoped to `upstreamBase`, deliberately.** It
      asserts `evidence.pinnedCommit === pin.commit`, and this phase moves `pin.commit` to the
      fork head, so it fails here. The cold-start evidence describes the **upstream** harness
      starting the **upstream** server; the commit it should be checked against is therefore
      `pin.upstreamBase`, not `pin.commit`. Re-collecting it against the fork would be the wrong
      fix — it would silently change what the evidence is evidence *of*, and spec 146's criteria
      about the pinned harness would stop meaning what they said.
- [ ] `FORK.md` gains the **abandonment procedure**, because the spec keeps `apps/client` as the
      fallback and never says how to fall back to it: set `pin.commit` to `upstreamBase`,
      regenerate, re-run `verify`. Three lines, written while the mechanism is fresh.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 9, regeneration half**: the contract regenerates from the fork and
      `shape-check` is green.
- [ ] `role`, `parentThreadId`, `codevGate` and `gateRevision` are present in `schema.json` and
      typed (not `unknown`) in `types.d.ts`.
- [ ] `verify` passes both identities with the new `pin.commit`.
- [ ] `pnpm -w test` green, `spec-146-t3-contract.test.ts` included and **not** skipped.

#### Test Plan

- Unit: assert the four new fields resolve to real types in the generated artifacts, and that a
  round-trip payload with them passes `shapeCheck`.
- Unit: assert `source-hash.json` has both sections and that they differ.
- Regression: `spec-146-t3-contract.test.ts` passes with `:231` re-scoped and every other
  assertion untouched. The first draft claimed this suite passes *unchanged*; verified against
  the file, it cannot, and saying so was wrong.

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
- `packages/codev/src/agent-farm/thread-backend.ts` — **the file that actually owns this, and the
  one the first draft failed to name.** Verified: `:442-450` already resolves a project by
  comparing `canonicalWorkspaceKey(project.workspaceRoot)` against the target, and `:785-818`
  calls `createProject` when there is no match, all inside `ensureThreadBackendReady`. A new
  side module would have been dead code. The `role`/`parentThreadId` supply and the project map
  extend **this** path.
- `packages/codev/src/agent-farm/servers/t3-gate-publisher.ts` — new. Reads gate state through
  the existing `status-reader.ts` and writes through the `codev.gateWrite` RPC.
- `packages/codev/src/agent-farm/servers/status-reader.ts` — **`status-reader.ts` is a reader with
  no publish cycle of its own**, so the phase names the lifecycle that drives the publisher rather
  than assuming one exists: it is invoked from the same watch that already notices `status.yaml`
  changing, and on reconnect.
- `packages/codev/src/__tests__/spec-250-porch-driver-hierarchy.test.ts` — new.
- `packages/codev/src/agent-farm/__tests__/spec-250-gate-publisher.test.ts` — new.
- `packages/codev/src/agent-farm/__tests__/spec-250-project-map.test.ts` — new.

#### Deliverables

- [ ] An architect thread is created with `role: "architect"` and no parent; a builder thread
      with `role: "builder"` and the architect's thread id.
- [ ] A workspace with no project gets one created on first spawn, through
      `ensureThreadBackendReady`'s existing lookup-then-create path — extended, not duplicated.
      `project.create` is **not** idempotent (t3code refuses a second active project for a
      workspace root via `requireActiveProjectWorkspaceRootAbsent`, per `thread-backend.ts:382`),
      so the existing single-flight guard keyed on the canonical workspace root is load-bearing
      and stays.
- [ ] The map's durable source of truth and its restart behaviour are stated: it is derived from
      t3code's own project list on connect, not cached across processes, so a restart re-derives
      rather than trusting stale state.
- [ ] A `projectId` that no longer resolves is **reported as unresolvable**, not rendered as an
      empty workspace.
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
- `apps/web/src/sidebarProjectGrouping.ts` — **composed with, not extended.** Verified: this
  module groups *environments* (`EnvironmentPresence` is `local-only` / `remote-only` / `mixed`,
  and `allRemoteMembersAreDesktopLocal` distinguishes a WSL sandbox from a real remote). That is
  a different axis from architect-to-builder thread nesting, so the first draft's "extend rather
  than replace" was the wrong relationship. Codev's hierarchy is its own pure module that runs
  over the threads inside a group this one has already formed.
- `apps/web/src/codev/hierarchy.test.ts` — new.
- `apps/web/src/components/Sidebar.logic.test.ts` — extend.
This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged; this phase's only artifact here.

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
- [ ] Fork typecheck green; fork tests green for `apps/web`'s sidebar suites.

#### Test Plan

- Unit: one architect / three builders; two architects; mixed `role: null`; orphan; a builder
  whose parent is in another project (which phase 3 refuses at write time, so this asserts the
  renderer does not invent a fallback for a state that cannot exist).
- Playwright, **from this repository against the running fork**: the three-level tree in the web
  app, per `codev/resources/testing-guide.md`. Harness at
  `packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts`. Gated on a reachable fork dev
  server; an unreachable one is reported as a skip, never as a pass.
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
This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged; this phase's only artifact here.

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
- [ ] Fork typecheck green; fork tests green for `apps/web`'s codev suites. Playwright confirms
      the rendered panel.

#### Test Plan

- Unit: gate present with request, gate present without request, no gate, gate cleared.
- Unit: one to five choices; a choice with no consequence; no recommendation.
- Playwright, from this repository: drive a real builder to `plan-approval` and read the panel.
  Same gating rule — a skip is reported as a skip.

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

This repository:
- `packages/codev/src/__tests__/e2e/spec-250-tiling.spec.ts` — new. The browser measurement, here
  rather than in the fork, because the fork has no Playwright and the criteria are Codev's.
This repository:
- `tools/t3-fork/FORK.md` — the phase's fork commit logged; this phase's only artifact here.

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
- [ ] Fork typecheck green; fork tests green for `apps/web`'s codev suites.

#### Test Plan

- Unit: `columnsFor` across 1..8 panes at 1440, 1920 and 700, including the 7-at-1920 case as its
  own named test.
- Playwright, from this repository at
  `packages/codev/src/__tests__/e2e/spec-250-tiling.spec.ts`: measure pane bounding boxes and
  computed font size at 1440x900 with six panes; at 1920 with seven; at 390px for overflow. These
  are the numbers criteria 5 and 5b name, and a unit test on `columnsFor` cannot produce them —
  it proves the arithmetic, not that the rendered pane is 340px wide inside t3code's chrome.
- The seeded fixture is part of the deliverable: six builder threads with roles and parents, so
  the measurement runs against a real tree rather than a mocked grid.
- Visual: the grid beside the `apps/client` grid, to catch content that was dropped rather than
  laid out.

### Phase 10: Approval from t3code over the same-origin proxy

**Dependencies**: Phase 9

#### Objective

The gate is approved from t3code's web app, over `codev-agent`'s existing capability path,
same-origin — so the page never makes a cross-origin request in the first place, which is the
guarantee that actually holds here. (There is no page-level CSP in t3code to widen or keep
narrow; see the deliverables.)

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
- [ ] The page makes no cross-origin request, **and this is asserted by observing what the page
      requests, not by reading a CSP header.** Verified against the fork's tree: t3code sets
      `Content-Security-Policy` on `.svg` asset responses only
      (`apps/server/src/http.ts:51,62` — `default-src 'none'; style-src 'unsafe-inline'; sandbox`)
      and `apps/web/index.html` carries no CSP meta tag. **There is no page-level CSP and
      therefore no `connect-src` directive to keep closed.**

      Both the spec's Security section and this plan's first draft said `connect-src 'self'`
      "stays closed", which asserts a header that does not exist. The design is unchanged and
      still correct — the same-origin proxy means no cross-origin request is *made* — but the
      guarantee is structural, not enforced by CSP, and the test must therefore watch the
      network rather than parse a header.
- [ ] Adding a page-level CSP is **explicitly not done here** and is recorded as a follow-up. It
      would be a change to how every t3code page loads, which is far wider than this spec's
      "keep the diff narrow" constraint, and widening the fork to get a guarantee we can already
      obtain structurally is the wrong trade.
- [ ] **The proxy's upstream target is server-configured, never browser-selected.** Review round 1
      found this and it is the most consequential item in the phase: the deliverable said the web
      app "holds the `codev-agent` origin", and a server proxy that forwards to an origin the
      browser names is an SSRF primitive — a route-path allowlist does not constrain the *host*.
      So the fork's server holds an allowlist of permitted `codev-agent` origins from its own
      configuration, and the browser selects **among** them by index or id, never by URL.
- [ ] Scheme and address rules are explicit and enforced server-side: `http`/`https` only,
      loopback or the configured mesh address, no credentials in the URL, and **redirects are not
      followed**. An absolute URL arriving in a request field is refused rather than normalised.
- [ ] **Hop-by-hop stripping is dynamic, not a fixed list.**
      `client-static.ts:329-337` builds the strip set from `HOP_BY_HOP` *plus the tokens named by
      the request's own `Connection` header*, because that header names headers that are
      themselves hop-by-hop. A port that hardcodes `HOP_BY_HOP` satisfies the sentence "strips
      hop-by-hop headers" and is wrong. It also refuses to forward Tower's key headers, and this
      port refuses the same ones.
- [ ] **Proxy failure splits into two signals**, as `client-static.ts` already does: the machine
      refused the connection, versus it accepted and sent no response headers inside the bound.
      One signal for both makes an unreachable host and a hung host look identical.
- [ ] **The approval record comes from the server, never from the browser.**
      `approval.ts:300-316` refuses to fill `approvedAt`, `machine` and `sessionId` from local
      state, calling that "the client telling a human their approval landed at the one moment it
      has no business guessing". Criterion 4 asks porch to record exactly those three, so a port
      that manufactures them locally passes a naive assertion while recording fiction. `sessionId`
      stays nullable: an approval recorded before session ids existed is a real approval with an
      unknown approver.
- [ ] Approval outcomes keep **four** states, not three and certainly not two: approved,
      refused, **unconfirmed**, and **`sessionEnded`**. The first draft named three; the source
      carries four (`approval.ts:79`, `:126`, `:135`).
      - `unconfirmed` is a server answer the client could not read. The gate may well be
        approved, so rendering it as a refusal sends a human to approve twice at the one point
        where a duplicate costs something.
      - `sessionEnded` is ordinary, not exceptional — sessions idle out after 30 minutes. Folding
        it into refusal tells someone their approval failed when what they need is to re-open a
        session. Same class of error as the one `unconfirmed` exists to prevent, one layer up.
- [ ] The ceremony is named in full, not glossed as "four requests": a pairing exchange
      (`pairing/redeem`, spending a `machine-credential` token), then `openHumanSession`
      (`approval.ts:152`) — a distinct single-use token exchange presenting through
      `x-codev-human-session` — then capability issue and nonce mint, then the gate approval.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Criterion 4**: a gate is approved from t3code and porch records the approving session id,
      machine and timestamp in `status.yaml`, over `codev-agent`'s capability path.
- [ ] A caller without a machine credential, and one without a human session, are refused
      differently — neither refusal is spelled like the other.
- [ ] `afx pair revoke <machine>` stops that browser approving, and stops nothing else.
      Verified against `packages/codev/src/agent-farm/commands/pair.ts:319-324`, which revokes
      the credential and its live approval capabilities.
- [ ] `pnpm -w test` green; fork typecheck green and fork tests green for the server and web
      suites this phase touches.

#### Test Plan

- Unit: proxy header handling **including a request whose `Connection` header names an extra
  header**, which a fixed-list port forwards and a correct one strips; path allowlist; the refusal
  for a path the table does not name; both proxy failure signals.
- Unit: the full approval walk, with a branch each for approved, refused, unconfirmed and
  `sessionEnded`, and one asserting the record is server-sourced when the body is empty.
- Integration: approve a real gate end to end against a live `codev-agent` and assert
  `status.yaml`.
- Adversarial: session without machine credential; machine credential from another machine;
  revoked credential; an approval replayed after revocation.
- **SSRF**: an absolute URL in place of the allowlist id; a loopback address that is not the
  configured one; a redirect from the configured origin to somewhere else; an unconfigured
  internal target. Each refused, and refused server-side rather than by the page declining to
  ask.
- Playwright: record every request the page issues while approving a gate and assert each one is
  same-origin. This replaces the CSP assertion the first draft proposed, which would have passed
  vacuously against a header t3code never sends.

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
- [ ] **The watermark is re-checked after the rebase**, which is the check that replaces the
      first draft's "upstream must not have reached 900". Assert that every upstream migration
      arriving with the rebase actually ran, by reading `effect_sql_migrations` and comparing it
      to `migrationEntries`. "Upstream never reached our number" was the wrong invariant: under a
      watermark migrator it is precisely the condition in which upstream's migrations get
      skipped.
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
| **Upstream migrations silently skipped** — `Migrator.js:121` skips any id `<= MAX(migration_id)`, so registering a high id shadows everything upstream adds later, while logging that the schema is current | Was High | Severe | Codev's columns never enter `migrationEntries`; a guarded idempotent `PRAGMA table_info` + `ALTER` runs at start and leaves the watermark alone. Phase 2 tests that a newly added upstream migration still runs; phase 11 re-checks after the rebase |
| **The guard's own partial application** — no migrator transaction wraps it, so a kill can land between two `ALTER`s | Medium | Low | Idempotent by construction: absent columns are added, present ones skipped, so the next start finishes the job. This is what makes criterion 8b discriminate rather than pass by construction |
| **Stale gate write recreates an approved gate** | Medium | High | Server-allocated high-water mark that survives the clear; criterion 10 delivers a stale revision after approval |
| **`codev-agent` restart resets a client-side counter** and silently renders every later gate as "none pending" | Medium | High | The counter is the server's, never the publisher's. Phase 4 makes this the mechanism, phase 6 asserts it across a restart |
| The generator's source-hash becomes a tautology once generation is fork-sourced | High | Medium | Phase 1 hashes the upstream closure at `upstreamBase` alongside the fork's |
| **Creating a public fork is outward-facing** and cannot be undone quietly | Certain | Low | Flagged to the architect before `gh repo fork` in phase 1; the spec bakes the destination |
| The fork's commits cannot appear in this repository's PR, leaving a reviewer with no diff | High | Medium | `pin.commit` names it, `FORK.md` logs it, phase 5 exports patches as a review aid |
| **`acquire` writes the fork SHA into the read-only upstream clone** once `pin.commit` moves — and `smoke.mjs` and `live/integration.mjs` both call it, so it fires from an ordinary test run | Was High | Severe | Phase 1 rewires `acquire`, `start` and `status` to `upstreamBase`, not `verify` alone |
| **A new RPC method that does not compile** — the authorization map is `satisfies Record<WsRpcMethod, …>` and `WsRpcMethod` derives from the unvendored `rpc.ts` | Was High | Medium | Phase 4 names all four registration points; phase 5 adds the method to `pin.methods`, following the `vcs.*` precedent |
| **The new scope leaks into the standard client set**, handing gate-writing to every ordinary client | Medium | Severe | Two named exclusions are deliverables: `AuthStandardClientScopes` and the `auth/http.ts` token allowlist. Gate commands also stay out of `ClientOrchestrationCommand` |
| **SSRF through the same-origin proxy** — a server-side proxy forwarding to a browser-named origin, which a path allowlist does not constrain | Medium | Severe | The target is chosen from a server-held allowlist by id; absolute URLs refused, redirects not followed, scheme and address rules enforced server-side |
| **Gate scope unenforceable at the existing authorization point** — `RpcAuthorization.ts:24` scopes the whole `dispatchCommand` method, so a gate command inside it inherits `orchestration:operate` | Was High | High | Gate writes get their own RPC method with its own row in the same scope map; a builder cannot reach the method at all |
| **A new project-map module lands dead** because `thread-backend.ts` already owns workspace-to-project resolution | Was High | Medium | Phase 6 extends `ensureThreadBackendReady`'s existing lookup-then-create path rather than adding a parallel one |
| **Our columns are invisible in upstream's migration history**, the accepted cost of staying out of the registry | Certain | Low | A named start-up log signal (`CODEV_SCHEMA_GUARD_APPLIED` / `_NOOP`) makes the fact observable rather than only inferrable from the schema |
| The fork becomes unmergeable | Medium | High | Keep the diff narrow: two record fields, one gate block, one scope, sidebar, tiling, proxy. No refactors of upstream code |
| Upstream security fix reaches us late — we now fork a server that executes shell commands | Medium | High | Criterion 9's cadence gets an owner and a maximum interval after the first rebase is measured |
| **t3code has no browser test tooling**, yet six criteria say "verified in t3code's own web app" and two are browser measurements | Was High | High | The Playwright harness lives in this repository (which already has `@playwright/test`) and drives the fork's dev server; the fork gains no test dependency and its diff stays narrow |
| Browser tests are gated on a running fork, so they can silently not run | Medium | High | A skip is reported as a skip and never counted as a pass — the same rule the spec-146 live suite already follows |
| Building and testing the fork is a large `pnpm` install on Node ^24.13.1, and the upstream clone currently has **no `node_modules` at all** — verified, not assumed | High | Medium | Fork install is done once in phase 1, before any phase depends on it; the Node advisory already recorded in the harness stands. Per-phase fork test runs are scoped to affected packages, with one full run at phase 11 |
| **Phase 1 breaks a passing test by design** — editing `t3-server.mjs` invalidates the cold-start evidence `spec-146-t3-contract.test.ts:254` guards | Certain | Low | Re-collecting the evidence against a live pinned server is a planned phase-1 step, not a surprise. The assertion is not loosened |
| **Phase 5 breaks another** — `:231` asserts `evidence.pinnedCommit === pin.commit`, and `pin.commit` becomes the fork head | Certain | Medium | Re-scoped to `upstreamBase`, because the evidence describes the upstream harness. Re-collecting against the fork would quietly change what it is evidence of |
| `apps/client` and t3code drift into two half-maintained clients | High | Low | `apps/client` is frozen — it keeps passing its tests and receives fixes; new front-end features land only in t3code |

## Documentation Updates

- `tools/t3-codegen/REFRESH.md` — the two-identity refresh and the rebase procedure (phases 1
  and 11).
- `tools/t3-fork/FORK.md` — new: remote, branch, checkout path, a **per-phase commit log**
  (phases 2, 3, 4, 7, 8, 9 change only the fork, so this entry is their sole artifact in this
  repository and what makes them committable here), the statement that the exported patches are a
  review aid rather than the build mechanism, the **abandonment procedure** (revert `pin.commit`
  to `upstreamBase`, regenerate, re-verify), and why migration ids in `migrationEntries` were
  abandoned — so nobody reintroduces a high id later reasoning that a big gap is safe.
- `codev/resources/250-acceptance-evidence.md` — new: the criterion 6 and 9 runs.
- `codev/reviews/250-t3code-front-end-customization.md` — the review, at the end.
- `CLAUDE.md` and `AGENTS.md` — **only if** the fork becomes a requirement for working in this
  repo. Byte-identical if touched.
- `codev/resources/arch.md` / `arch-critical.md` and `lessons-learned.md` /
  `lessons-critical.md` — routed by tier at review time, not pre-committed here. Candidate facts:
  the two-identity vendoring rule, and that porch gate state is a projection of `status.yaml`
  with `status.yaml` authoritative.

## Plan review rounds

**Round 1, `claude` lane.** `REQUEST_CHANGES`, `HIGH` confidence. Every finding was verified
against source before being acted on, rather than taken as ground truth:

| Finding | Verified against | Outcome |
|---|---|---|
| Migration 900 shadows all later upstream migrations | `effect@4.0.0-beta.103` `unstable/sql/Migrator.js:78`, `:121` — `ORDER BY migration_id DESC` then `if (currentId <= latestMigrationId) continue` | Confirmed. Mechanism changed to a guarded start-up applier outside `migrationEntries` |
| Phase 1 breaks `spec-146-t3-contract.test.ts:254` | Read the test — it compares evidence mtime against `t3-server.mjs` and `smoke.mjs` | Confirmed. Evidence re-collection is now a phase-1 deliverable |
| Phase 5 breaks `:231` | Read the test — `expect(evidence.pinnedCommit).toBe(pin.commit)` | Confirmed. Re-scoped to `upstreamBase` |
| Seven `T3CODE_ROOT` readers, not three | Grepped all of them, including `packages/t3-client/live/integration.mjs:77` which the first draft missed | Confirmed. All seven now assigned to an identity |
| `generate.mjs:78` root switch is load-bearing | Read `:70-85` — it refuses when checkout HEAD ≠ `pin.commit` | Confirmed and stated |
| Criterion 8b passed by construction | `Migrator.js:142` wraps the run in `sql.withTransaction` | Confirmed, and now moot: outside the migrator there is no wrapper, so the kill test discriminates |
| Phase 10 understates both ported modules | Read `client-static.ts:329-337` (dynamic `Connection` tokens) and `approval.ts:79/126/135` (`sessionEnded`) and `:300-316` (server-sourced record) | Confirmed. Four outcomes, dynamic stripping, two proxy signals, server-sourced record |
| Fork-only phases have no artifact here | — | Accepted. Per-phase `FORK.md` entry added to phases 2, 3, 4, 7, 8, 9 |
| No abandonment path | — | Accepted. Added to `FORK.md` in phase 5 |
| Fork suite scope unbounded | — | Accepted. Scoped per phase, one full run at phase 11 |

**Round 1, `codex` lane** (added while the opencode lane was being diagnosed; kept, see the lane
note). `REQUEST_CHANGES`,
`HIGH` confidence, and additive to claude's rather than overlapping it — five findings, all
verified against source before being acted on:

| Finding | Verified against | Outcome |
|---|---|---|
| Gate revision semantics not implementable: the plan said both "sends no revision" and "reject stale revisions" | Its own text, plus `commands.ts:310,321` for how a result returns | Confirmed contradiction. `revision` is now optional — absent means allocate, present means must exceed the mark |
| `codev:gate-write` unenforceable at the referenced point | `apps/server/src/auth/RpcAuthorization.ts:24` maps the whole `dispatchCommand` method to `orchestration:operate` | Confirmed. Gate writes get their own RPC method with its own row in that scope map |
| Phase 6's new project-map module would be dead code | `thread-backend.ts:442-450` already resolves projects by canonical workspace key; `:785-818` creates them | Confirmed. Phase 6 now extends `ensureThreadBackendReady` instead |
| Persistence work named too few modules | All four exist: `Services/ProjectionThreads.ts`, `Layers/ProjectionThreads.ts`, `Layers/ProjectionPipeline.ts`, `Layers/ProjectionSnapshotQuery.ts` | Confirmed. Named in phases 2 and 4, with start-up layer ordering asserted |
| Proxy has no upstream-target trust boundary — SSRF | — | Accepted. Server-held origin allowlist selected by id; absolute URLs refused, redirects not followed |

**A second finding of my own: three phases planned tests with a tool the fork does not have.**
Phases 7, 8 and 9 named Playwright verification. t3code has no `playwright` in any
`package.json`, and `apps/web`'s whole test script is `vp test run --passWithNoTests --project
unit` on `@effect/vitest`. Criteria 5 and 5b are browser *measurements* — pane boxes in CSS px,
computed font size — so this was not a detail. The harness moved into this repository, which
already carries `@playwright/test ^1.58.0`, and drives the fork's dev server instead; the fork
gains no test dependency.

**A third finding of my own, while verifying the above.** Phase 10 and the spec's Security section
both claimed `connect-src 'self'` "stays closed". Verified in the fork's tree: t3code sets
`Content-Security-Policy` on `.svg` asset responses only (`apps/server/src/http.ts:51,62`) and
`apps/web/index.html` has no CSP meta tag. There is no page-level CSP and no `connect-src`
directive to keep closed. The same-origin design is unchanged and still correct, but the guarantee
is structural rather than CSP-enforced, and the test now watches the network instead of parsing a
header that is never sent.

**Round 1, `opencode` lane** (`xai/grok-4.6`). `REQUEST_CHANGES`, `HIGH` confidence, and additive
again — it found a hole in the fix made for codex's finding, which is the argument for three lanes
rather than two. All verified:

| Finding | Verified against | Outcome |
|---|---|---|
| `codev.gateWrite` is never registered on the wire; a scope row alone is a type error | `RpcAuthorization.ts:130` is `satisfies Record<WsRpcMethod, …>`; `WsRpcMethod` comes from `WsRpcGroup` in the **unvendored** `rpc.ts` | Confirmed. Phase 4 now names all four registration points |
| Gate commands must stay out of the client command unions | `orchestration.ts:935-987` — those unions *are* the `dispatchCommand` payload; `ThreadSessionSetCommand` is the internal-only precedent | Confirmed. Otherwise `orchestration:operate` writes gates and the new scope is bypassed |
| Phase 5 would not vendor the method | `generate.mjs:335` iterates `pin.methods`, not `OrchestrationRpcSchemas` | Confirmed. Added to `pin.methods`, following the `vcs.*` precedent |
| **`acquire` still keys off `pin.commit`** and would check the fork SHA out into the read-only upstream clone | `t3-server.mjs:94` (`checkout --detach pin.commit` against `t3Root`), `:389`, `:663`; callers `smoke.mjs:156` and `live/integration.mjs:196` | Confirmed, and the most damaging item in either round. Phase 1 now rewires `acquire`, `start` and `status`, not `verify` alone |
| The gate-write credential path is unnamed despite the deliverable claiming otherwise | `auth.ts:84-93` closed literal, `:98-104` standard scopes, `auth/http.ts:265-274` allowlist | Confirmed. Path named, two exclusions made deliverables |
| Phase 4's revision return path was leftover text | — | Fixed: it returns on the new RPC, not `dispatchCommand` |

**Lane note.** The `opencode` lane ran under a **non-default permission**. It auto-rejects
`external_directory` requests, and this plan cites `/Users/chris/dev/t3code` throughout, so two
runs died on their first outside read and exited `0` with no review file — a silent lane loss that
reads exactly like a review with nothing to say. It was re-run with
`OPENCODE_CONFIG_CONTENT='{"permission":{"external_directory":"allow"}}'` scoped to the single
invocation, with no global config edited. Filed as issue #261. It auto-rejects
`external_directory` requests, and this plan cites `/Users/chris/dev/t3code` throughout, so the
first two runs died on their first outside read and exited `0` with no review file — a silent lane
loss that reads exactly like a review with nothing to say. Filed as issue #261.

**The "exits 0 with no verdict" part of that was my own measurement error, and it is corrected
here rather than left standing.** Every failing run was invoked as `consult … 2>&1 | tail -15`,
and in a pipeline the reported exit code belongs to the *last* command — so the `0` was always
`tail`'s. Run with stdout and stderr redirected to files instead of piped, the same command
returns **exit code 1** and names the cause on stderr. The lane had been hard-failing correctly
all along, exactly as its own contract says it should (`commands/consult/index.ts:1693`; #20
records why a lane that quietly produces nothing is worse than one that throws).

With the permission granted *and* no pipe, the lane completed in 298s and wrote a full review. The
`codex` lane, substituted while this was being diagnosed, was kept — three independent reviews
rather than two, which earned its place: opencode found a hole in the fix made for codex's own
finding.

**The porch-level case, which is worse than the one first filed.** A prefix on a `consult` command
covers only that invocation. When *porch* drives the consultation, the child inherits the
environment porch was started with, so a per-command prefix never reaches it: the child runs with
default permissions, dies on the first external-directory read, exits `0` with no verdict, and
porch — seeing the output file still missing — re-issues the identical task. The loop is
invisible, because every individual piece reports success. The form that works is an exported
variable the child inherits:

```bash
export OPENCODE_CONFIG_CONTENT='{"permission":{"external_directory":"allow"}}'
porch next 250
```

**So this plan's opencode review, whenever it lands, ran under a non-default permission**, and a
reader should know that rather than assume a default lane produced it. The permission is broad —
it allows *any* external directory for that process, not only the t3code clone — and is accepted
here because the lane is read-only review on this machine. Both cases are on issue #261.
