# Plan review round 1 — rebuttals

Three lanes ran: `claude`, `codex` and `opencode`. Porch names two; the third is explained under
[Lane note](#lane-note).

**All three returned `REQUEST_CHANGES`, and I accepted every finding.** There is nothing in the
disagree column. Two of the findings were errors of mine that would have caused real damage, and
one of the reviews corrected a fix I had just made in response to another — which is the argument
for having run three.

Every finding was checked against source before I acted on it. Reviewer summaries are evidence,
not ground truth, and one of them turned out to be right about the fault while wrong about the
mechanism.

---

## claude lane

### 1. Migration 900 would silently disable every future upstream migration — ACCEPTED

The most important finding in the round, and my error.

Verified in `node_modules/.pnpm/effect@4.0.0-beta.103/.../unstable/sql/Migrator.js` — the exact
version `pin.json` names. It is a **watermark**, not a set difference:

```js
const latestMigration = sql`SELECT migration_id, name, created_at FROM ${sql(table)} ORDER BY migration_id DESC`  // :78
if (currentId <= latestMigrationId) { continue; }                                                                 // :121
```

Registering 900/901 makes the watermark 901, so upstream's later 043, 044, … arrive **below** it
and are skipped while the migrator logs that the schema is current. My mitigation ("number far
above upstream's range") converted a loud collision into silent schema divergence, and my proposed
guard test — fail if upstream reaches 900 — asserted the inverse of the right invariant.

**Changed.** Codev's columns never enter `migrationEntries`. A guarded, idempotent
`PRAGMA table_info` + `ALTER TABLE … ADD COLUMN` runs from a layer sequenced after `MigrationsLive`
and never touches `effect_sql_migrations`.

**Found while fixing it:** this is upstream's own idiom, not an invention.
`042_ProjectionThreadLinkedPullRequest.ts` is exactly that shape, and `021`, `022`, `032`, `033`,
`034`, `035`, `039` and `040` all do the same. The only difference is where it is invoked from.

This contradicted a spec **Assumption** ("the added columns follow that mechanism"). I raised it
rather than changing it quietly; the architect ruled on 2026-08-30 to stay out of the registry, and
the spec's risk row was amended under their authority as approver. The accepted cost — our columns
are absent from upstream's migration history — is mitigated by a named start-up signal,
`CODEV_SCHEMA_GUARD_APPLIED` / `CODEV_SCHEMA_GUARD_NOOP`.

### 2. Phase 1 breaks `spec-146-t3-contract.test.ts:254` — ACCEPTED

Read the test: it compares the cold-start evidence's mtime against `t3-server.mjs` and `smoke.mjs`,
and phase 1 edits `t3-server.mjs`. The test is doing its job — it exists so a harness change cannot
ride on stale evidence.

**Changed.** Re-collecting the evidence against a live pinned server is now a phase-1 deliverable,
with the command in the phase. The assertion is not loosened.

### 3. Phase 5 breaks `:231` — ACCEPTED

`expect(evidence.pinnedCommit).toBe(pin.commit)`, and phase 5 moves `pin.commit` to the fork head.
My claim that the spec-146 suite "still passes unchanged" was false.

**Changed.** Re-scoped to `pin.upstreamBase`. The evidence describes the **upstream** harness
starting the **upstream** server, so `upstreamBase` is the commit it should be checked against.
Re-collecting it against the fork would have been the wrong fix: it would silently change what the
evidence is evidence *of*, and spec 146's criteria about the pinned harness would stop meaning what
they said.

### 4. Seven `T3CODE_ROOT` readers, not three — ACCEPTED

Correct. I missed `packages/t3-client/live/integration.mjs:77` because my first grep was truncated
at 20 lines — my error, not a subtle one.

**Changed.** All seven are now assigned to an identity in a table in phase 1, and
`generate.mjs:78`'s head check moving to the fork root is called out as the load-bearing edit
rather than left implicit.

### 5. Criterion 8b passed by construction — ACCEPTED, and now moot

Verified: `Migrator.js:142` wraps the run in `sql.withTransaction`, and SQLite DDL is transactional,
so a kill would have rolled everything back and the criterion would have been met without the code
being careful.

Moot after finding 1: outside the migrator there is no wrapper. Two `ALTER`s are two atomic steps, a
kill between them leaves exactly one column added, and the `PRAGMA table_info` guard is what makes
the next start finish the job. The kill test now discriminates, and the plan says why.

### 6. Phase 10 understates both modules it ports — ACCEPTED

Verified all three sub-points:

- `client-static.ts:329-337` builds the strip set from `HOP_BY_HOP` **plus the tokens named by the
  request's own `Connection` header**. A port hardcoding the fixed list satisfies the sentence
  "strips hop-by-hop headers" and is wrong.
- `approval.ts` has **four** outcomes, not three: `sessionEnded` (`:79`, `:126`, `:135`) is distinct
  from `unconfirmed` and is ordinary — sessions idle out at 30 minutes. Folding it into refusal
  tells someone their approval failed when they need to re-open a session.
- `approval.ts:300-316` forbids manufacturing `approvedAt`, `machine` and `sessionId` client-side.
  Criterion 4 asks porch to record exactly those three, so a port that fills them locally passes a
  naive assertion while recording fiction.

**Changed.** All four are deliverables now, plus the two proxy failure signals and the named
pairing ceremony.

### 7. Fork-only phases have no artifact here — ACCEPTED

**Changed.** Phases 2, 3, 4, 7, 8 and 9 each log their fork commit in `tools/t3-fork/FORK.md`,
which is their only artifact in this repository and what makes them committable here.

### 8. No abandonment path — ACCEPTED

The spec keeps `apps/client` as the fallback and never says how to fall back to it.

**Changed.** `FORK.md` gains it in phase 5: revert `pin.commit` to `upstreamBase`, regenerate,
re-verify.

### 9. Fork suite scope unbounded — ACCEPTED

**Changed.** Per-phase runs are scoped to the packages that phase touches; one full run at
phase 11.

---

## codex lane

### 1. Gate revision semantics not implementable as written — ACCEPTED

A genuine self-contradiction. I wrote both "`codev-agent` sends no revision, the server allocates"
and "a write carrying a lower revision is rejected", plus a criterion 10 that delivers one. If no
write ever carries a revision, there is nothing to reject.

**Changed.** `revision` is optional: absent means allocate `gateRevision + 1`; present means it must
**exceed** the mark or be refused `CODEV_GATE_REVISION_STALE`. Equal is refused, not treated as
idempotent. Criterion 10's stale write is the second case.

### 2. `codev:gate-write` unenforceable at the referenced point — ACCEPTED

Verified: `RpcAuthorization.ts:24` maps `ORCHESTRATION_WS_METHODS.dispatchCommand` **as a whole** to
`AuthOrchestrationOperateScope`. It scopes methods, not command types.

**Changed.** Gate writes travel their own RPC method with its own row in that map. See the opencode
section — this fix was itself incomplete.

### 3. Phase 6's project map would be dead code — ACCEPTED

Verified: `packages/codev/src/agent-farm/thread-backend.ts:442-450` already resolves a project by
comparing `canonicalWorkspaceKey(project.workspaceRoot)`, and `:785-818` calls `createProject`, all
inside `ensureThreadBackendReady`. My new `t3-project-map.ts` would have sat unused.

**Changed.** Phase 6 extends that path. Also recorded: `project.create` is **not** idempotent
(`:382`, t3code refuses a second active project for a workspace root), so the existing single-flight
guard is load-bearing and stays. The publish cycle is named too — `status-reader.ts` is a reader with
no cycle of its own, so the phase says what drives the publisher.

### 4. Persistence work named too few modules — ACCEPTED

All four exist and are now named in phases 2 and 4: `persistence/Services/ProjectionThreads.ts`,
`persistence/Layers/ProjectionThreads.ts`, `orchestration/Layers/ProjectionPipeline.ts`,
`orchestration/Layers/ProjectionSnapshotQuery.ts`.

**Changed.** Start-up layer ordering is also stated and asserted by a test —
`SqliteClient` → `MigrationsLive` → `CodevSchemaGuardLive` → projections. A repository query running
before the guard would read a table without our columns, and that failure would look like missing
data rather than a boot-order bug.

### 5. Proxy has no upstream-target trust boundary — ACCEPTED

A server proxy forwarding to a browser-named origin is an SSRF primitive, and a route-path allowlist
constrains the path, not the host.

**Changed.** The target is chosen from a **server-held** allowlist by id, never by URL. Scheme and
address rules enforced server-side, no credentials in the URL, redirects not followed, absolute URLs
refused rather than normalised. Adversarial tests named.

---

## opencode lane

This lane found a hole in the fix I had just made for codex's finding 2, which is why it was worth
keeping all three.

### 1. `codev.gateWrite` is never registered on the wire — ACCEPTED

Verified: `RpcAuthorization.ts:130` is `satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>`,
and `WsRpcMethod` derives from `WsRpcGroup` in `packages/contracts/src/rpc.ts` — which `pin.json`
**deliberately excludes** from the closure. Adding only the authorization row is a type error.

**Changed.** Phase 4 names all four registration points: `Rpc.make` and `WsRpcGroup` membership in
`rpc.ts`, the method constant, the handler key in `ws.ts:1174`, then the authorization row.

### 2. Gate commands must stay out of the client command unions — ACCEPTED

`ClientOrchestrationCommand` and `DispatchableClientOrchestrationCommand`
(`orchestration.ts:935-987`) *are* the `dispatchCommand` payload. Putting the gate commands there
would hand gate-writing to every `orchestration:operate` holder and bypass the new scope entirely —
undoing the whole point of the phase.

**Changed.** Stated as a deliverable, with `ThreadSessionSetCommand` recorded as the internal-only
precedent.

### 3. Phase 5 would not vendor the method — ACCEPTED

Verified: `generate.mjs:335` iterates `Object.entries(pin.methods)`, not `OrchestrationRpcSchemas`,
so a method in the schemas map but absent from `pin.methods` is silently ignored.

**Changed.** `codev.gateWrite` is added to `pin.json`'s `methods`, following the `vcs.*` precedent —
those entries exist there for exactly this reason.

### 4. `acquire` still keys off `pin.commit` — ACCEPTED

**The most damaging finding in the round.** `acquire()` does
`gitIn(t3Root, 'checkout', '--detach', pin.commit)` (`t3-server.mjs:94`) against `T3CODE_ROOT`, the
read-only upstream clone. Once phase 5 moves `pin.commit` to the fork head, that tries to check a
fork SHA out into the clone the spec keeps pinned at `upstreamBase`. `start` (`:389`) and `status`
(`:663`) compare the same way, and both `smoke.mjs:156` and `live/integration.mjs:196` call
`acquire` — so it fires from an ordinary test run, not a deliberate invocation.

I had rewired only `verify`, which is the one verb that does not write.

**Changed.** Phase 1 rewires `acquire`, `start` and `status` to `upstreamBase`.

### 5. Gate-write credential path unnamed — ACCEPTED

Verified: `AuthEnvironmentScope` is a closed `Schema.Literals` of eight (`auth.ts:84-93`), and
`auth.ts` is on the vendored closure, so this is a contract change phase 5 regenerates.

**Changed.** The phase names the issuance API and the credential's on-disk path, and adds two
exclusions as deliverables: the scope must not enter `AuthStandardClientScopes` (`auth.ts:98-104`)
nor the token allowlist (`apps/server/src/auth/http.ts:265-274`). Either would grant gate-writing to
exactly the callers the scope exists to exclude.

### 6. Leftover revision return path — ACCEPTED

Fixed: the allocated revision returns on the new RPC's own response, not through `dispatchCommand`.
That sentence predated the gate commands moving off `dispatchCommand`.

---

## Two findings of my own, raised while verifying the above

Recorded here because they change the plan and neither came from a reviewer.

### The CSP claim was false, in my plan and in the spec

Phase 10 and the spec's Security section both said `connect-src 'self'` "stays closed". Verified in
the fork's tree: t3code sets `Content-Security-Policy` on `.svg` asset responses only
(`apps/server/src/http.ts:51,62` — `default-src 'none'; style-src 'unsafe-inline'; sandbox`), and
`apps/web/index.html` carries no CSP meta tag. **There is no page-level CSP and no `connect-src`
directive to keep closed.**

The same-origin design is unchanged and still correct — the proxy means no cross-origin request is
*made* — but the guarantee is **structural, not enforced**, and must not be written as enforced. The
test now records every request the page issues under Playwright instead of parsing a header that is
never sent. Adding a page-level CSP is recorded as an explicit non-goal here: it changes how every
t3code page loads, far wider than the spec's "keep the diff narrow" constraint.

The architect confirmed this is an error in the spec and is fixing the Security section.

### Three phases planned tests with a tool the fork does not have

Phases 7, 8 and 9 all said "verified under Playwright". **t3code has no `playwright` in any
`package.json`**, and `apps/web`'s entire test script is `vp test run --passWithNoTests --project
unit` with `@effect/vitest` as its only test dependency. Criteria 5 and 5b are browser
*measurements* — pane bounding boxes in CSS px, computed font size — which a vitest unit test cannot
produce; it proves the arithmetic in `columnsFor`, not that the rendered pane is 340px wide inside
t3code's chrome.

**Changed.** The harness lives in this repository, which already carries `@playwright/test ^1.58.0`
in `packages/codev`, `apps/client`, `apps/v2` and `packages/artifact-canvas`, and drives the fork's
dev server over HTTP. Two reasons, in order: it keeps the fork diff narrow, which the spec names as
its unmergeability mitigation, and the criteria are Codev's so the tests that close them belong in
Codev's CI. Cost recorded: those tests need a running fork, so they are gated, and **a skip is
reported as a skip, never counted as a pass**.

---

## Lane note

Porch names `claude` and `opencode`. A third lane, `codex`, was added while the opencode lane was
being diagnosed and was kept once it worked — three independent reviews rather than two.

The opencode lane failed five times before producing this review, and **part of my report on why was
my own measurement error**, corrected here rather than left standing.

- **Real cause.** opencode auto-rejects `external_directory` permission requests. This plan cites
  `/Users/chris/dev/t3code` throughout, so the lane died on its first read outside the workspace.
  `runOpencodeConsultation` sets `OPENCODE_PERMISSION` unconditionally
  (`commands/consult/index.ts:1806`) and `OPENCODE_READ_ONLY_PERMISSION` (`:1647`) covers only
  `edit`, `write`, `patch` and `bash` — `external_directory` is not in it, so it falls back to
  opencode's default of ask, which auto-rejects when non-interactive.
- **My error.** I reported every failure as "exit 0 with no verdict". Every one of those runs was
  invoked as `consult … 2>&1 | tail -15`, and in a pipeline the reported exit code is the *last*
  command's — so the `0` was always `tail`'s. Run clean, the same command returns **exit code 1** and
  names the cause on stderr. The lane had been hard-failing correctly the whole time, exactly as its
  contract says (`index.ts:1693`; #20 records why a silent lane is worse than a loud one). Filed
  under #261; the "porch spawns consult without the env var" theory in that issue describes a
  mechanism that does not exist — porch is a pure planner and emits the command for the builder to
  run.
- **What made it work.** `OPENCODE_CONFIG_CONTENT='{"permission":{"external_directory":"allow"}}'`
  scoped to the invocation, and no pipe. 298s, full review, exit 0. No global config was edited.

**So this plan's opencode review ran under a non-default permission**, and a reader should know that
rather than assume a default lane produced it. The grant is broad — it allows *any* external
directory for that process, not only the t3code clone — and is accepted here because the lane is
read-only review on this machine.
