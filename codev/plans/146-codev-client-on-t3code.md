# Plan: a Codev client on a self-hosted t3code server

**Specification**: [codev/specs/146-codev-client-on-t3code.md](../specs/146-codev-client-on-t3code.md)

## Executive Summary

The spec selects Approach 3: adopt t3code for process control, and write a new Codev client
against it. This plan sequences that work so that every claim capable of killing the project is
tested before anything expensive is built on top of it.

Four findings from reading and running the t3code source changed the shape of the plan before it
was written, and they are recorded here because later phases depend on them.

**The contract question the spec deferred is settled, and the answer is codegen.** t3code serves
its RPC over `RpcSerialization.layerJson` (`apps/server/src/ws.ts:2492`). Under that layer the
wire envelope is about ten tagged JSON shapes — `Request`, `Ack`, `Interrupt`, `Eof`, `Ping`
client-to-server, and `Chunk`, `Exit`, `Defect`, `Pong`, `ClientEnd` back — one JSON object per
WebSocket frame, carrying a `tag` string naming the method and an opaque `payload`
(`.repos/effect-smol/packages/effect/src/unstable/rpc/RpcMessage.ts:61-155`). The domain schemas
are not in the envelope. The server decodes payloads with its own copies and never requires the
client to hold them, which is exactly why the spike's `Schema.Unknown` payloads worked end to end.

So runtime schemas are not needed to *speak* the protocol. They are needed to *validate* t3code's
domain payloads, so that a contract change surfaces as a decode failure instead of an `undefined`
read three layers away. That is a build-time obligation, not a runtime one. Effect 4 exports
`SchemaRepresentation.toJsonSchemaDocument`, so Codev can hold `effect` as a **devDependency of a
codegen tool**, emit plain type declarations plus a JSON Schema document from the pinned t3code
checkout, and leave `packages/types` with zero runtime dependencies. The server/client isolation
boundary tests from #1189 stay green, and the spec's vendoring constraint is satisfied by
generated artifacts rather than by copied Effect source.

**The emitter was run before this plan was written, and it is lossy in a way that changes the
design.** The probe is committed at `codev/experiments/146-schema-emitter-probe/` and was run
against `effect@4.0.0-beta.103` **installed from npm** — the version t3code pins — on Node 22.
It is not run against the vendored `.repos/effect-smol` checkout in the t3code clone, which is
`4.0.0-beta.102`; that copy is cited in this plan only for the RPC wire-format source, never for
emitter behaviour. `toJsonSchemaDocument` handled every shape in the closure — structs, unions,
literals, brands, refinements and both transform forms — so nothing in it is unrepresentable.
But `Schema.String.check(isNonEmpty())` emits `minLength: 1`, while the
*same check applied on the decoded side of a `decodeTo` transform* emits a bare `{"type": "string"}`
with the constraint gone. `SchemaRepresentation.toRepresentation` is blind to it as well: the
constrained and unconstrained forms serialise to the byte-identical document
`{"representation":{"_tag":"String","checks":[]},"references":{}}`.

That matters more than it looks, because `TrimmedNonEmptyString` is exactly that shape and it is
the base of every branded entity id in t3code — `ThreadId`, `ProjectId`, `CommandId`, `TurnId`,
`MessageId` and the rest. Two consequences, both designed into Phase 1:

- The generated JSON Schema is a **lower bound** on t3code's validation, never an equivalent. A
  validator built on it accepts input the server rejects. It is a shape check, and Phase 1 requires
  it to say so in its own type name rather than being called a validator of the contract.
- **A generated-artifact drift test alone cannot detect drift behind a transform.** If t3code
  relaxed a branded id tomorrow, the emitted document would not change by one byte. So Phase 1
  carries two drift layers, not one: a **source hash** over the 9 closure files that fires on any
  change and forces a human to look, and the **generated diff** that names what changed in a shape
  Codev consumes. The source hash is the load-bearing one; the generated diff is the one that
  explains. At 9 files this is a bounded read, which is the reason the closure is pinned to a list
  rather than followed dynamically.

**The vendoring surface is a tenth of what it looks like.** `packages/contracts` is 19,662 lines,
but the transitive import closure of `orchestration.ts`, `git.ts` and `auth.ts` — everything this
integration actually consumes — is 9 files and 3,663 lines. `rpc.ts` is deliberately excluded:
the spike proved a client declares its own minimal `RpcGroup` naming only the methods it calls,
so vendoring t3code's full 1,123-line RPC group would import a dependency on every unrelated
subsystem for nothing.

**Churn is worse than the spec measured.** The spec cites 89 commits to `orchestration.ts`. Across
the full 9-file closure the figure since 2026-02-07 is **184 commits**, roughly 27 a month rather
than 14. Additionally, t3code pins `effect: 4.0.0-beta.103` and imports its RPC from
`effect/unstable/rpc/*` — a pre-1.0 beta on a path the library itself marks unstable. This does
not change the approach, but it moves the drift test from load-bearing to critical, and it is why
Phase 1 both builds the detector and runs it across all 184 commits rather than deferring that to
the deletion gate.

### Sequencing

The architect's direction is that risky, falsifiable work comes first and the UI comes last, and
the phase order follows it literally:

- **Phases 1-4** answer questions that can kill the project: can the contract be vendored and kept
  honest, can a client speak the protocol correctly under reconnect and backpressure, can porch's
  check-then-advance loop survive its own crash, and can messages meet the five delivery semantics
  the spec makes the mailbox's deletion conditional on.
- **Phases 5-7** build `codev-agent`, then the approval boundary it issues, then the transport and
  service security posture around both. The approval threat model is the one piece of design the
  spec explicitly refuses to settle, and it cannot be built before its issuer exists.
- **Phases 8-10** make the dual-write cutover representable in both stores, move architects onto
  threads with the rest of `afx` following, and prove a full protocol run on a second driver.
- **Phases 11-12** build the client.
- **Phases 13-15** retire the extensions, delete the terminal half, and drop its schema behind a
  release checkpoint.

Two prerequisites are already met and are not phases here. #128's phases 1 and 2 have shipped:
`porch gate --request-file` and `packages/codev/src/commands/porch/gate-request.ts` exist, so the
structured gate record success criterion 3 depends on is available today.

### What each phase is allowed to assume

Phases 1-4 run against a live t3code server started from the pinned commit, brought up by the
harness Phase 1 builds; none of them may be marked complete on the strength of a unit test alone.
Phases 11-12 are the only phases that touch `apps/`, and both are verified in a browser under
Playwright against real viewport sizes, because a green component suite cannot detect the layout
regressions success criteria 4, 4b and 5 are written to catch.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Vendored t3code contract with drift detection"},
    {"id": "phase_2", "title": "t3code RPC transport client"},
    {"id": "phase_3", "title": "porch-driver session lifecycle and crash recovery"},
    {"id": "phase_4", "title": "Message delivery semantics"},
    {"id": "phase_5", "title": "codev-agent protocol state service"},
    {"id": "phase_6", "title": "Approval capability and threat model"},
    {"id": "phase_7", "title": "Transport and service security posture"},
    {"id": "phase_8", "title": "Thread identity in status.yaml and global.db"},
    {"id": "phase_9", "title": "Architect threads and afx command parity"},
    {"id": "phase_10", "title": "Full protocol on a second driver"},
    {"id": "phase_11", "title": "codev-client tree and live status"},
    {"id": "phase_12", "title": "codev-client tiling and mobile"},
    {"id": "phase_13", "title": "Extension retirement"},
    {"id": "phase_14", "title": "Terminal layer deletion"},
    {"id": "phase_15", "title": "Terminal schema drop"}
  ]
}
```

### Revisions after the first review round

The first 4-way review produced one APPROVE and three REQUEST_CHANGES. Every finding below was
checked against the code before being acted on, and the ones that were right changed the plan:

- **Generated artifacts move into `packages/types`,** which is what the spec's constraint actually
  says. Only the codegen *tool* lives outside it, because that tool needs `effect` as a
  devDependency and `packages/types` must keep none. The original draft put both outside and was
  simply not following the constraint.
- **A pinned server has to be obtainable.** Phases 1-4 all say "against a live server on the pinned
  commit" and nothing provisioned one. Phase 1 now owns acquisition, startup and version
  verification.
- **`threadId` must land in `status.yaml`,** not only in `global.db`. The spec makes `status.yaml`
  the join key and `ProjectState` (`commands/porch/types.ts:217`) has no field for it. Phase 8 now
  covers both stores; the original covered one.
- **Phases 5 and 6 were swapped.** Approval issuance needs `codev-agent`'s routes to exist, and the
  original ordering had the dependency backwards.
- **`approve()` mutates before it checks.** Verified: the verify auto-complete and the gate
  auto-create both call `writeStateAndCommit` before the flag test at `index.ts:898`. Phase 6 moves
  authorization ahead of every write.
- **Security got a phase.** Pairing, per-machine credentials, binding, HTTPS/WSS, origin rules and
  route authentication are spec constraints that the draft left to a CSP bullet in a UI phase.
- **Migration mechanics were invented.** There is no `db/migrations/` directory and no
  down-migration framework; migrations are inline `v2..vN` blocks in `db/index.ts` gated on
  `_migrations` rows. Phase 8 names the real mechanism and drops the "reversible" claim it cannot
  honour.
- **Deletion split in two.** The spec requires the `terminal_sessions` drop to happen after a
  release has shipped with the columns unused, so it is Phase 15, behind a release checkpoint.
- **The 12b contingency now matches the spec.** The spec says criterion 13 is *not attempted* if
  12b fails. The draft said Phase 14 proceeds without deleting the mailbox, which contradicted it.
- **`afx interrupt`, `cleanup` and `dev` were unassigned** despite the spec promising their
  contracts survive. Phase 9 owns them.
- **`apps/web` was missing entirely.** It is the legacy dashboard the spec deletes — React and
  xterm on `codev-sdk`. The sdk's terminal surface does **not** go with it: `apps/vscode` still
  imports `TowerClient`, `backoffDelayMs` and `TerminalType` from `@cluesmith/codev-sdk/tower-client`
  (`connection-manager.ts:2-3`, `terminal-manager.ts:7`), so `tower-client` is retained as a
  compile-only surface. Phase 14 carries the ruling and the reasoning.

One finding is recorded but not adopted: a reviewer asked for `rpc.ts` to be vendored for
method-to-payload mapping. Phase 1 keeps it excluded and instead pins the mapping explicitly, since
vendoring a 1,123-line RPC group to recover eight method names would pull in every unrelated
subsystem's schemas.

**A note on provenance.** Part of the Phase 4 scheduled-delivery and `afx inbox` content was
written into this file by a process other than the builder while the review round was running. Its
citations were checked against the source and are accurate — `cron-delivery.ts` does import
`db/mailbox.js`, `delayed-send.ts` does persist `--delay` bodies as mailbox rows, and `inbox.ts`
does list held rows — so the content is kept on its merits. The provenance is recorded because an
artifact editing itself mid-review is worth knowing about.

## Phase Breakdown

### Phase 1: Vendored t3code contract with drift detection

**Dependencies**: None

#### Objective

Settle the architectural question the spec deferred, and produce the vendored contract every later
phase compiles against. Answer it with generated artifacts rather than copied Effect source, so
that `packages/types` keeps the zero-runtime-dependency property the #1189 boundary tests enforce.

The phase is falsifiable in a specific way: if `SchemaRepresentation.toJsonSchemaDocument` cannot
represent the schemas in the closure, this approach fails here rather than in Phase 10, and the
fallback is recorded before any client code exists.

#### Files to Create / Modify

**Generated artifacts live in `packages/types`.** The spec's constraint says Codev "vendors the
schema types from a pinned t3code commit into `packages/types`", and the first draft of this plan
put them in a new package instead. Review was right that this was not following the constraint.
The split is between *artifacts* and *tooling*: the artifacts are declarations, JSON and a shape
check with no imports, so they sit in `packages/types` without disturbing its zero-runtime-deps
property. Only the generator needs `effect`, so only the generator lives outside.

- `packages/types/src/t3/generated/types.d.ts` — emitted TypeScript declarations.
- `packages/types/src/t3/generated/schema.json` — emitted JSON Schema document.
- `packages/types/src/t3/generated/source-hash.json` — per-file hashes of the 9 closure files.
- `packages/types/src/t3/generated/UNREPRESENTED.md`, `LOSSY.md` — emitted reports.
- `packages/types/src/t3/shape-check.ts` — a zero-dependency shape check over the emitted JSON
  Schema, covering only the subset the emitter actually produces. No imports.
- `packages/types/src/t3/pin.json` — the pinned t3code commit SHA, the `effect` version observed at
  that commit, and the closure file list.
- `packages/types/package.json` — an export map entry for the new subpath. Today `exports` carries
  only `"."`, so nothing under `src/t3/` is reachable by a consumer without one; review caught this
  and it would have surfaced as an unresolvable import in Phase 2.
- ~~`packages/types/tsconfig.json` — `resolveJsonModule` and a copy-into-`dist` step.~~
  **Superseded during implementation, and the simpler answer is better.** The generator emits
  `generated/schema.ts` as a TypeScript module alongside `schema.json`, and `shapeCheck` takes the
  schema as a parameter rather than importing it. So there is no JSON import, no
  `resolveJsonModule`, and no copy step that could pass CI and then fail at a consumer's runtime
  because the file never reached `dist`. `schema.json` survives purely as the diffable artifact for
  the drift test.
- `packages/types/__tests__/t3-drift.test.ts`
- `packages/types/__tests__/t3-shape-check.test.ts`
- `packages/types/__tests__/no-runtime-deps.test.ts`
- `packages/types/src/t3/generated/ATTRIBUTION.md` — the MIT notice for the t3code source these
  artifacts derive from, plus the pinned SHA. **This is a licence obligation, not tidiness.**
  `@cluesmith/codev-types` is published, is Apache-2.0, and ships `files: ["src", "dist"]`, so the
  generated artifacts leave this machine inside a distributed package. MIT requires the notice
  travel with the distribution. Review caught this; the first revision would have shipped derived
  MIT work with no notice.
- `pnpm-workspace.yaml` — **`tools/*` added to the workspace globs.** Today they are `packages/*`
  and `apps/*` only, so a `tools/t3-codegen` package would never have its `effect` devDependency
  installed and the codegen would not run. The alternative — a standalone install step documented
  in `REFRESH.md` — is rejected because a refresh procedure whose first step is "remember to
  install" is a procedure that gets skipped.
- `tools/t3-codegen/package.json` — the generator, **outside** `packages/types`. `effect` and
  `typescript` as devDependencies. In the workspace so it installs, excluded from the publish and
  the release build.
- `tools/t3-codegen/generate.ts` — imports the pinned checkout's contracts, walks the closure,
  emits every artifact above.
- `tools/t3-codegen/classify-churn.ts` — replays commits against the detector.
- `tools/t3-codegen/REFRESH.md` — the refresh procedure the spec's constraint requires.
- `tools/t3-server/` — the pinned-server harness: acquire, install, start, verify version, pair,
  stop. Phases 1-4, 5 and 8-10 all claim to run against a live pinned server and nothing provided
  one; this is that.
- `tools/t3-server/README.md` — how to bring one up by hand, and how CI is expected to behave when
  it cannot.

#### Deliverables

- [x] The closure is pinned explicitly to the 9 files measured above — `auth.ts`, `baseSchemas.ts`,
      `environment.ts`, `git.ts`, `model.ts`, `orchestration.ts`, `providerInstance.ts`,
      `sourceControl.ts`, `vcs.ts` — and the generator fails loudly if the pinned checkout's import
      graph reaches a file not on that list. Silent closure growth is the failure mode this
      catches.
- [x] `rpc.ts` is **not** vendored, and the phase records why rather than leaving it implicit.
      Review asked for it, on the grounds that Phase 2 needs a method-to-payload mapping. It does,
      but `rpc.ts` is 1,123 lines whose transitive closure is 27 files and 11,120 lines — three
      times the whole rest of the vendoring surface — because it names every unrelated subsystem's
      RPCs. Instead, the mapping for the eight methods Codev actually calls is written out
      explicitly in `pin.json` as `method → payload schema → success schema`, generated from the
      closure and checked by the drift test. Method names come from `ORCHESTRATION_WS_METHODS` and
      its equivalents, which are plain string literals.
- [x] **A pinned server can be brought up by anyone** — with one gap, stated rather than
      footnoted. `start` runs the published `t3` CLI against the pinned checkout, so the *source*
      is pinned and the *binary* is not, and `verify` cannot see a divergence between them. The
      architect's ruling: this criterion is **partially met**, the gap is carried into Phase 2's
      entry conditions rather than left in a README, and no later phase may assume it away. Two
      closures exist — build the server from the pinned tree, or pin the CLI version in
      `pin.json` too. `tools/t3-server/` acquires the pinned
      commit, installs it, starts it, **verifies the running server's commit matches `pin.json`**,
      and stops it. The verification is the point: `pin.json` on its own records an intention, and
      every phase that claims to test against the pinned server is worthless if the server it
      reached was some other build.
- [x] CI behaviour is decided and documented, not left to discovery: either CI provisions the
      server, or the live-server tests are tagged and skipped there with the skip **visible in the
      run output**. A silently skipped integration suite reports green for tests that never ran.

      **Decided: no drift-check job.** CI runs Node 20 with no t3code checkout, so
      `generate --check` would fail its guard and a conditional job would skip forever while
      reporting green. CI covers artifact self-consistency through the normal suite; it does not
      cover drift, and that absence is tracked as **#152** rather than left in this note.
- [x] Codegen emits declarations and JSON Schema from the pinned checkout. Every schema in the
      closure that the emitter **cannot** represent is listed by name in a generated
      `UNREPRESENTED.md`, with the reason. An empty list is not assumed; the list is the evidence.
      The pre-plan run against the hard cases produced no unrepresentable shapes, so an empty list
      here is the expected result — but it is generated, not asserted from that run.
- [x] **`LOSSY.md`, generated alongside it, lists every emitted schema whose JSON Schema is weaker
      than the Effect schema it came from** — detected by emitting each closure schema both as
      written and with its transforms stripped, and recording every case where the two differ.
      This is the list the pre-plan run showed is not empty, and it is more important than
      `UNREPRESENTED.md`.
- [x] `shape-check.ts` is **named for what it does**. It implements only the JSON Schema keywords
      the emitter actually produces, enumerated from `schema.json`, and throws on encountering a
      keyword it does not implement rather than passing it silently. Its result type is not called
      `valid`; passing means "matches the emitted shape", and the distinction is in the name
      because a check that reports success for a constraint it never saw is the failure mode here.
- [x] **Two drift layers.** `source-hash.json` holds a hash per closure file, and the drift test
      fails on any change to any of the 9 files — this is the layer that catches a relaxed branded
      id, which the generated artifacts provably cannot see. The generated-artifact diff runs
      alongside it and names the changed schema when the change is one the emitter can express.
      A source-hash failure with no generated diff is a valid and expected outcome, and the test
      reports it as "changed, effect on consumed shapes unknown" rather than as either a pass or a
      silent failure.
- [x] `no-runtime-deps.test.ts` asserts the package's `dependencies` field is empty and that no
      file under `src/` imports `effect`.
- [x] The commits touching the closure are replayed through the detector and each is recorded as
      breaking or non-breaking **against the schemas Codev consumes**, with the breaking count
      written to `codev/research/146-contract-churn-classification.md`. Criterion 12 discharged;
      counting commits is explicitly not the criterion.

      **Done, and the window is not the one the spec names.** The spec's 184 commits run from
      2026-02-07, but the nine-file closure did not exist until 2026-05-02 — `auth.ts` arrived
      2026-04-09, `providerInstance.ts` 2026-04-29, `vcs.ts` and `sourceControl.ts` 2026-05-02.
      Before those dates "changed against the vendored types" has no referent. Commits before
      roughly 2026-06-01 additionally cannot be emitted with the pinned Effect at all; they fail
      inside `SchemaAST` because they predate `4.0.0-beta.103`. Those are reported as a **third
      verdict**, `unclassifiable`, never folded into breaking or safe.

      **Measured result: 21 of 54 classifiable commits (39%) change a shape Codev consumes**, and
      `orchestration.dispatchCommand` (15) and `orchestration.subscribeThread` (13) absorb nearly
      all of it — the two methods `porch-driver` is built on. The spec assumed a pin goes stale in
      weeks; at ~20 closure commits a month this is closer to 8 consumed-changes a month. The
      refresh procedure is operational tooling, not a safety net.
- [x] **The pinned-server test harness is built here, because Phases 2, 3, 4 and 9 all declare
      acceptance criteria against "a live server on the pinned commit" and nothing else in this plan
      produces one.** The read-only clone at `/Users/chris/dev/t3code` has **no `node_modules`** —
      it has never been installed — so bringing a server up is real work, not a precondition
      somebody already met. The harness covers: checkout at `pin.json`'s SHA, install, start on a
      known port, obtain a test session token without a relay, tear down, and clean up worktrees the
      run created. A builder improvising this in Phase 2 leaves Phase 9 to improvise it again
      differently.
- [x] **How CI behaves without a server is decided here and stated once.** The live-server tests are
      a separate suite from the unit suite, and their absence is reported as *skipped for no server*,
      never as a pass. Success and "could not tell" must not be spelled the same way, which is the
      same rule Phase 2's gap signal and Phase 6's failure matrix are built on.
- [x] Tests for this phase.

#### Acceptance Criteria

- [x] `packages/types` still has zero runtime dependencies after the generated artifacts land,
      asserted by test, and no file under `packages/types/src/t3/` imports `effect`.
- [x] The existing #1189 boundary tests on `codev-core` and `codev-sdk` still pass unchanged.
- [x] Regenerating from the pinned commit is a no-op; mutating any closure file in a scratch
      checkout makes the drift test fail and names the schema.
- [x] **The transform-blindness regression test.** Take `TrimmedNonEmptyString` in a scratch
      checkout, remove its `isNonEmpty` check, regenerate, and assert that the **source-hash layer
      fails**. This case is chosen because the generated artifacts demonstrably do *not* change:
      both forms emit `{"type":"string"}` and both serialise to the identical Representation
      document. A drift test that passes here is not detecting drift, and this is the assertion
      that proves the second layer is doing work.
- [x] `UNREPRESENTED.md` and `LOSSY.md` exist and are accurate — spot-checked by hand against the
      three hardest cases in the closure: `TrimmedString` (a `decodeTo` transform),
      `ForwardCompatibleArray` (a filtering transform), and `ModelSelectionSource` (a pre-decode
      legacy promotion). The pre-plan run showed the first two are representable but lossy —
      `TrimmedNonEmptyString` loses `minLength`, and `ForwardCompatibleArray` emits `{"type":
      "array"}` with no `items` — so both belong in `LOSSY.md`, and a `LOSSY.md` that omits them is
      wrong.
- [x] The churn classification records a breaking count, not a commit count, and states which layer
      caught each breaking change. Since the source-hash layer fires on cosmetic changes too, the
      classification distinguishes "source changed, consumed shapes unaffected" from "consumed
      shapes changed" — otherwise the breaking count is inflated to the commit count and the
      criterion is not met.
- [x] **The harness brings up a live server on the pinned commit, twice, on a
      machine where it has never run** — that is the state `/Users/chris/dev/t3code` is in today.
      A dispatched no-op command returns successfully, then teardown leaves no stray process, port
      binding or worktree. Phase 2 does not start until this passes, since every one of its
      acceptance criteria assumes it.
- [x] With no server running, the live suite reports skipped-for-no-server and the unit suite still
      passes. Neither reports green for tests that did not execute.
- [x] Build and tests pass.

#### Test Plan

Unit: the shape check against matching, non-matching and unrepresentable payloads; the closure
guard against an import graph that reaches outside the list; the no-runtime-deps assertion.

Integration: generate against the pinned checkout twice and assert byte equality; generate against
a checkout with one schema field removed and assert the generated-diff layer fails naming that
schema; generate against a checkout with `isNonEmpty` removed from `TrimmedNonEmptyString` and
assert the source-hash layer fails while the generated diff stays empty.

Manual: read `UNREPRESENTED.md` and `LOSSY.md` against the source. If any entry is a constraint a
later phase intended to rely on at runtime, that is a blocker to raise with the architect before
Phase 2 starts, not a note to carry forward.

---

### Phase 2: t3code RPC transport client

**Dependencies**: Phase 1

#### Objective

A typed client that speaks the t3code RPC protocol correctly, including the two properties the
spike did not exercise: acknowledgement-based stream backpressure, and resubscription by sequence
after a dropped connection. This is where the spec's "no completion event is lost on reconnect"
claim stops being a one-off observation and becomes a tested property.

#### Files to Create / Modify

- `packages/t3-client/package.json` — new package.
- `packages/t3-client/src/envelope.ts` — the RPC envelope, encode and decode.
- `packages/t3-client/src/socket.ts` — WebSocket lifecycle, reconnect with backoff.
- `packages/t3-client/src/client.ts` — request/response and streaming call surface.
- `packages/t3-client/src/auth.ts` — OAuth token exchange and WS ticket issuance.
- `packages/t3-client/src/resume.ts` — `afterSequence` resubscription and gap detection.
- `packages/t3-client/__tests__/`

#### Deliverables

- [ ] Envelope encode/decode for all ten wire shapes, validated against
      `RpcMessage.ts` as the reference.
- [ ] Streaming calls send `Ack` per received `Chunk`. The server enables ack-based backpressure
      (`RpcServer.ts:115`, `supportsAck`), so a client that does not acknowledge stalls its own
      stream after the server's buffer fills. This is a protocol obligation, not an optimisation,
      and it is why the phase exists separately from Phase 3.
- [ ] Payloads are shape-checked on the way in using Phase 1's `shape-check.ts`. A payload that
      fails is surfaced as a named decode error carrying the method tag and the failing path. It is
      never coerced and never dropped silently. Per Phase 1, this is a lower bound on t3code's own
      validation and the code says so — no call site may treat a passing shape check as proof the
      payload is contract-valid.
- [ ] Reconnect resubscribes with `afterSequence` at the last applied sequence.
- [ ] If the server answers a resubscription with a snapshot instead of the requested range, the
      client reports a **gap** as its own distinct signal. It does not return an empty range, and
      it does not return a range that looks contiguous. "I could not tell" and "there was nothing"
      must not be spelled the same way.
- [ ] With the server unreachable, every call fails loudly at the call site. There is no silent
      queue at this layer.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Against a live server on the pinned commit: connect, dispatch a command, subscribe to a
      thread, receive a typed stream to completion.
- [ ] A stream of more chunks than the server's buffer completes, proving acks are honoured. A
      deliberately ack-suppressed client stalls, proving the test can tell the difference.
- [ ] Socket killed mid-stream at a known sequence; resubscription replays exactly the missing
      range and the completion event is present.
- [ ] A forced snapshot response produces a gap signal distinguishable from both success and
      empty.
- [ ] Build and tests pass.

#### Test Plan

Unit: envelope round-trip for every shape; gap detection; backoff.

Integration, against a live pinned server: the four acceptance scenarios above. This phase is not
complete on unit tests — the whole point is what the real server does.

---

### Phase 3: porch-driver session lifecycle and crash recovery

**Dependencies**: Phase 2

#### Objective

Map porch's model onto t3code sessions, with the crash semantics the spec is specific about. This
delivers spawn, run-a-phase, checks-between-turns and interrupt as library calls with no PTY
involved.

#### Files to Create / Modify

- `packages/porch-driver/package.json` — new package.
- `packages/porch-driver/src/thread.ts` — create with worktree, settle detection, interrupt.
- `packages/porch-driver/src/turn.ts` — start a turn, settle on `activeTurnId: null`.
- `packages/porch-driver/src/cursor.ts` — sequence cursor persistence.
- `packages/porch-driver/src/commands.ts` — `commandId` generation and the dispatch journal.
- `packages/porch-driver/src/worktree-setup.ts` — the `installHarnessWorktreeFiles` replacement.
- `packages/porch-driver/src/harness-map.ts` — `--harness` to `driverKind`, `--model` to
  `modelSelection.model`.
- `packages/porch-driver/__tests__/`

#### Deliverables

- [ ] Settle detection keys on `activeTurnId: null`, not on session status. The spec records that
      an interrupted turn reports status `ready`, so status alone cannot distinguish an interrupted
      turn from a finished one.
- [ ] Every command carries a porch-generated `commandId`, journalled to disk **before** dispatch.
- [ ] The sequence cursor advances **after** the handler completes, never before. Every handler is
      idempotent, because this yields at-least-once delivery by construction.
- [ ] Phase checks run as shell in the thread's own `worktreePath`, outside the thread, between
      turns.
- [ ] `--harness` maps to a t3code `driverKind` and `--model` to `modelSelection.model`. An
      unsupported pair fails at spawn, matching today's `assertHarnessAcceptsModel` behaviour.
- [ ] Role prompts are delivered as the first turn's content, replacing `buildScriptRoleInjection`
      and `buildRoleInjection`.
- [ ] `worktree-setup.ts` reimplements the Claude write-guard from #1018 and `opencode.json`
      placement. If either cannot be reproduced, its absence is recorded explicitly in the phase
      commit rather than discovered later — the spec permits deliberate acceptance, not silent
      loss.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A thread is created on a worktree, runs a turn to settle, has a file written externally in
      its `worktreePath`, and reads the new value back on the next turn.
- [ ] Killing the driver between journal write and dispatch, then restarting, does not apply the
      command twice.
- [ ] Killing the driver inside the window between handler completion and cursor write causes the
      event to be **reprocessed**, not skipped. The test asserts reprocessing, since that is the
      property the at-least-once choice buys.
- [ ] A turn interrupted mid-shell reports `activeTurnId: null`, and the interrupted command's
      side effect is absent.
- [ ] Build and tests pass.

#### Test Plan

Unit: cursor ordering; commandId journal; harness and model mapping including the rejection path.

Integration against a live server: the four acceptance scenarios, with the two crash tests killing
a real process at a real window rather than simulating it.

---

### Phase 4: Message delivery semantics

**Dependencies**: Phase 3

#### Objective

Demonstrate the five properties the spec makes the mailbox's deletion conditional on. This phase
exists early and separately because success criterion 13 depends on 12b: if these do not hold, the
mailbox stays and the deletion phase is not attempted. Discovering that in Phase 13 would waste
every phase in between.

#### Files to Create / Modify

- `packages/porch-driver/src/deliver.ts`
- `packages/porch-driver/src/queue.ts`
- `packages/porch-driver/src/scheduled.ts` — durable scheduled delivery on the thread path.
- `packages/porch-driver/__tests__/delivery.test.ts`
- `packages/porch-driver/__tests__/scheduled.test.ts`
- `codev/research/146-delivery-semantics-evidence.md`

#### Deliverables

- [ ] Messages to one builder are delivered in the order sent.
- [ ] A message sent during an active turn is queued and delivered on settle. Never dropped, never
      interleaved into a running turn.
- [ ] Every send returns an acknowledgement meaning the server accepted it durably. The
      acknowledgement explicitly does not claim the agent read it, and the type name says so.
- [ ] Commands carry caller-generated idempotency keys; a retry after an ambiguous failure delivers
      once.
- [ ] With the server unreachable, a send fails loudly at the call site and does not silently
      queue. This is the one place where the old mailbox's hold-and-retry behaviour is deliberately
      not reproduced, and the difference is documented.
- [ ] Evidence written to `codev/research/146-delivery-semantics-evidence.md`, since success
      criterion 12b gates a later phase and needs a record a reviewer can check.
- [ ] **Durable scheduled delivery is rebuilt here, because two surviving features depend on the
      mailbox Phase 13 deletes.** The spec keeps cron and delayed-send in `codev-agent`, and both
      reach the mailbox directly: `servers/cron-delivery.ts:27-29` imports `db/mailbox.js` and
      `mailbox-delivery.js`, and `servers/delayed-send.ts` persists every `--delay` body as a
      mailbox row. Deleting the mailbox without this is a silent loss of `afx send --delay` and of
      every cron notification, so it is designed here rather than discovered in Phase 13. The
      requirement is narrow: a pre-due message survives a restart, fires once at its due time, and
      is deduplicated by the same idempotency key the four properties above already establish.
- [ ] **`afx inbox` is ruled on, not left dangling.** `commands/inbox.ts` exists only to list, show
      and dismiss *held* mailbox rows, and "held" is a render-gate concept that does not exist on
      the thread path — a queued turn is delivered on settle, never held pending a readable prompt.
      Either the command retires with the mailbox, or it is repointed at pre-due scheduled messages.
      Whichever is chosen is recorded here, because CLAUDE.md documents `afx inbox` and a command
      that silently stops working is worse than one that is removed.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Ten messages sent during one active turn arrive after settle, in order, with none lost and
      none interleaved.
- [ ] The same idempotency key sent twice results in exactly one delivery.
- [ ] A send against a stopped server raises at the call site within a bounded timeout.
- [ ] A scheduled message written before a restart fires once after it, at its due time, and a
      duplicate schedule under the same idempotency key does not double-fire. This is the property
      `--delay` and cron both need, tested once.
- [ ] All five properties are demonstrated and recorded. **If any fails, the phase completes with
      the failure recorded and the architect is notified** — the mailbox then survives Phase 13,
      which is the spec's stated behaviour, not a defect in this plan.
- [ ] Build and tests pass.

#### Test Plan

Integration against a live server for all five. Ordering is tested under concurrent send pressure,
not with a single sequential loop, because a sequential loop cannot detect the reordering that
matters.

---

### Phase 5: codev-agent protocol state service

**Dependencies**: Phase 3

#### Objective

Turn Tower into `codev-agent`: the same process with its terminal half removed, serving protocol
state to a browser that has no filesystem access to the machine. Produce the failure matrix the
architect deferred to plan work.

This phase runs **before** the approval capability, not after. Review caught the original ordering
backwards: `codev-agent` is the issuer, so its routes and its session notion have to exist before
anything can be issued against them.

This phase does not delete anything. It adds the protocol-state surface and the identity maps
alongside the existing terminal surface, which is what makes the dual-write window in Phase 8
possible.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/agent-routes.ts` — protocol state HTTP surface.
- `packages/codev/src/agent-farm/servers/agent-state-stream.ts` — porch state change stream.
- `packages/codev/src/agent-farm/servers/thread-registry.ts` — architect-name to `threadId`, and
  builder-id to `threadId`.
- `packages/codev/src/agent-farm/servers/status-reader.ts` — `status.yaml` reads, scoped per
  worktree.
- `packages/codev/src/agent-farm/db/index.ts` — the `thread_id` columns, see below.
- `packages/codev/src/agent-farm/db/schema.ts` — `GLOBAL_SCHEMA` convergence.
- `codev/resources/146-codev-agent-failure-matrix.md`
- `packages/codev/src/agent-farm/servers/__tests__/`

**The `thread_id` columns land here, not in Phase 8.** Review found a circular dependency in the
first revision: this phase's registry reads `architect.thread_id` and `builders.thread_id`, Phase 8
added those columns, and Phase 8 declared a dependency on this phase. As ordered, neither could be
built. The split that resolves it is between *schema* and *use*: this phase adds the two nullable
columns and the migration that carries them, because it is the first phase that needs them to
exist. Phase 8 keeps everything that writes and reads them at spawn time — the `status.yaml` field,
the dual-write, the drain count, and the backup-and-restore path. The migration mechanics, the
additive-only ruling and the automatic backup are all specified in Phase 8 and apply to the
migration written here.

#### Deliverables

- [ ] Reads `status.yaml` and serves phase, gates and the #128 structured gate content already
      produced by `gate-request.ts`.
- [ ] Streams porch state changes, so the client does not poll.
- [ ] Holds the architect-name to `threadId` map, backed by the existing `architect` table keyed on
      `workspace_path` and name, and the builder-id to `threadId` join.
- [ ] Defines the **human-paired session** that Phase 6 issues capabilities against: what
      constitutes one, how `codev-agent` recognises it, and its lifetime. This is the bridge review
      found missing — without it, "issuance is not reachable without a human-paired session" is a
      sentence with no referent. The approval *invocation* itself lands in Phase 6, behind that
      phase's check.
- [ ] **The failure matrix**, covering at minimum: `codev-agent` down; `codev-agent` up but t3code
      down; t3code up but `codev-agent` down; `status.yaml` unreadable or malformed; a thread with
      no porch record; a porch record whose thread no longer exists; `global.db` locked; a
      capability presented after revocation; and disagreement between `status.yaml` and thread
      state. Each row states the signal emitted, what the client renders, and whether it is
      auto-resolved. Per the spec, disagreement is **reported, never auto-resolved**.
- [ ] Each failure mode emits its own distinct signal. An unreachable server, an empty result and a
      malformed file must not be spelled the same way, because a partial answer reads as a complete
      negative one.
- [ ] A thread with no matching porch record renders as **unmanaged**, never hidden.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] With porch state changing on disk, a connected client receives the change without polling.
- [ ] A blocked gate's structured question and choices are served, not just the gate name.
- [ ] Every row of the failure matrix has a test asserting its distinct signal.
- [ ] Startup reconciliation reports a `status.yaml`-versus-thread disagreement and does not
      resolve it.
- [ ] The terminal surface still works; nothing is removed in this phase.
- [ ] Build and tests pass.

#### Test Plan

Unit: status reading including malformed input; the registry joins; each failure signal.

Integration: state stream against real porch writes; a human-paired session recognised and an
unpaired one refused.

---

### Phase 6: Approval capability and threat model

**Dependencies**: Phase 5

#### Objective

Close the self-approval path, and write down the threat model the spec deliberately deferred:
issuance root of trust, storage, expiry, revocation, and replay protection.

Three facts verified against the code shape this phase, and they are recorded because the spec has
already had two versions of this claim falsified:

1. `porch approve` today enforces only the flag. `packages/codev/src/commands/porch/index.ts:898`
   checks `hasHumanFlag` and nothing else, then writes `status.yaml`. Verified by reading it.
2. **Tower's existing request authentication cannot help.** It uses a shared key at
   `~/.agent-farm/local-key` (`tower-server.ts:467`), mode `0600`, owned by the same user a builder
   process runs as. A builder can read it. It is a machine boundary, never a human-versus-agent
   boundary, and any design that leans on it is already defeated.
3. **The workspace `.env` is symlinked into every builder worktree**
   (`spawn-worktree.ts:88-96`). Any secret placed there is readable by every builder, so the
   capability must not live in `.env`, and a test must assert that it does not.
4. **`approve()` mutates before it authorizes.** Raised in review and confirmed: the verify
   auto-completion and the gate auto-creation branches both call `writeStateAndCommit` *above* the
   `hasHumanFlag` test at `index.ts:898`. So an unauthorized call already writes and commits
   `status.yaml` before being refused. Moving the check to the top of the function is part of this
   phase, not a follow-up.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/approval-capability.ts`
- `packages/codev/src/commands/porch/index.ts` — gate `approve()` on the capability.
- `packages/codev/src/commands/porch/approval-record.ts` — capability id, machine, timestamp.
- `codev/resources/146-approval-threat-model.md`
- `packages/codev/src/agent-farm/__tests__/approval-capability.test.ts`
- `packages/codev/src/agent-farm/__tests__/builder-env-no-capability.test.ts`

#### Deliverables

- [ ] **Both entry points carry the same check.** `porch approve` gates on the capability, not on
      the flag string. The flag stays as a typed confirmation of intent and its help text stops
      describing it as a control, because it never was one.
- [ ] **The host stores a verifier, never a replayable credential.** A hash lives on the host; the
      secret lives with the human's client session. A builder reading the host's storage learns
      nothing it can present.
- [ ] Replay protection: each approval presents a single-use nonce bound to the project id and gate
      name, with a bounded TTL. The existing `lib/nonce-store.ts` is the model; approval nonces are
      separate from tunnel registration nonces and are not shared with them.
- [ ] Expiry and revocation: capabilities carry an expiry, and revoking one machine's capability
      leaves other machines' untouched.
- [ ] `codev-agent` refuses issuance to any caller it can identify as a builder or architect
      process, and issuance is unreachable without a human-paired session. **The limits of that
      identification are stated honestly in the threat model**: over loopback TCP the peer process
      is not directly attributable, so the refusal is a defence-in-depth layer and the
      verifier-not-credential property is the actual boundary. Claiming otherwise is what got the
      previous two revisions falsified.
- [ ] **Authorization happens before any mutation.** The capability check moves to the top of
      `approve()`, above the verify auto-completion and gate auto-creation branches. A refused call
      writes nothing and commits nothing.
- [ ] Every approval records **the approving session id**, the capability id, the machine and the
      timestamp in `status.yaml`. Success criterion 9b names the session id specifically, so
      recording only the capability id would not satisfy it; both are stored because they answer
      different questions — which credential was used, and which human session used it.
- [ ] The threat model document covers issuance root of trust, storage, expiry, revocation, replay
      and CSRF, and states plainly what the design does **not** stop: a human who holds the
      capability can hand it to an agent, and no design prevents that.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `porch approve --a-human-explicitly-approved-this` run inside a builder worktree with no
      capability is **refused**. This is the test that would have failed before this phase, and it
      is the point of the phase.
- [ ] A test over the generated builder start script asserts no approval capability appears in the
      builder's environment, and a second test asserts none appears in the symlinked `.env`.
      Success criterion 9c requires the first; the second exists because of the symlink above.
- [ ] A replayed approval nonce is refused.
- [ ] Revoking one machine's capability leaves another machine's approvals working.
- [ ] **A refused approval leaves `status.yaml` byte-identical and adds no commit.** This is
      asserted by hashing the file and counting commits either side of the refused call, because
      the current code would fail it.
- [ ] `status.yaml` records session id, capability id, machine and timestamp on a real approval.
- [ ] Build and tests pass.

#### Test Plan

Unit: nonce single-use and TTL; verifier comparison; expiry; per-machine revocation isolation.

Integration: approve a real gate through the capability path end to end; attempt the same from a
builder's environment and assert refusal.

Manual: read the threat model against this phase's code and confirm every claim in it is one the
code actually makes true. Any claim that is aspirational is deleted rather than softened.

---

### Phase 7: Transport and service security posture

**Dependencies**: Phase 6

#### Objective

Give the spec's Security constraints an owner. The draft of this plan left them to a CSP bullet
inside a UI phase, which review correctly called incomplete: pairing, per-machine credentials,
binding, transport encryption, origin rules and route authentication are all server-side
properties, and none of them belong to the client.

The premise is the spec's own: the t3code server executes arbitrary agent shell in worktrees, so
reaching it is equivalent to shell access. A tailnet is transport, not an authentication model.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/machine-credentials.ts` — per-machine storage and revocation.
- `packages/codev/src/agent-farm/lib/pairing.ts` — pairing token issuance and redemption.
- `packages/codev/src/agent-farm/servers/agent-auth.ts` — authentication for every `codev-agent`
  route and stream.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — binding policy.
- `codev/resources/146-remote-access-runbook.md` — pairing, exposure, and teardown.
- `packages/codev/src/agent-farm/__tests__/agent-auth.test.ts`

#### Deliverables

- [ ] **Every `codev-agent` HTTP route and every stream is authenticated.** No unauthenticated
      read of protocol state, because gate content and worktree paths are not public. A route added
      without auth fails a test that enumerates the router rather than checking a list by hand.
- [ ] Pairing tokens are **single-use with a bounded TTL**, and are never written to a repository,
      a log, or a shell history file. A test asserts the token does not appear in the log stream.
- [ ] **Per-machine credentials, stored separately and individually revocable.** Revoking one
      machine does not disturb another. This is the property success criterion 15's scenario tests
      from the client side; here it is tested at the store.
- [ ] **Loopback-only binding is the default**; exposing an interface is an explicit action. The
      existing `BRIDGE_MODE` gate (`tower-server.ts:109-116`) is the model and is kept.
- [ ] All remote transport is HTTPS/WSS. A plaintext non-loopback bind is refused, not warned
      about — the current code warns and continues, and that is a deliberate change recorded here.
- [ ] Explicit origin rules on both the HTTP surface and the WebSocket upgrade. A WebSocket that
      ignores `Origin` is reachable from any page the browser visits, which is the specific hole
      that makes CSRF relevant to a localhost service.
- [ ] The runbook covers `npx t3 pair --tailscale` and its teardown,
      `tailscale serve --https=443 off`, because the spec records that the mapping persists until
      it is torn down.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] An unauthenticated request to every `codev-agent` route is refused, enumerated from the
      router so a new route cannot be forgotten.
- [ ] A pairing token redeems once and is refused the second time; an expired one is refused.
- [ ] Revoking machine A's credential leaves machine B working, asserted at the credential store.
- [ ] A non-loopback bind without TLS is refused at startup.
- [ ] A WebSocket upgrade from a disallowed origin is refused.
- [ ] Build and tests pass.

#### Test Plan

Unit: token single-use and TTL; per-machine revocation isolation; origin matching; the binding
refusal.

Integration: the full pairing flow against a live server, then teardown, following the runbook as
written so the runbook is tested rather than merely authored.

---

### Phase 8: Thread identity in status.yaml and global.db

**Dependencies**: Phase 5

#### Objective

Make the cutover representable in **both** stores, and route new spawns down the thread path while
existing PTY builders keep running untouched.

Two corrections from review shape this phase.

**`status.yaml` is the join key and the original plan forgot it.** The spec says the client joins
porch and t3code "on a `threadId` that porch records in `status.yaml` at spawn". `ProjectState`
(`commands/porch/types.ts:217`) has no such field, and writing the id only into `global.db` would
leave the authoritative join unimplemented. Both stores are covered here.

**The migration framework named in the draft does not exist.** Verified: there is no
`db/migrations/` directory. Migrations are inline `v2`…`vN` blocks in `db/index.ts`, each guarded
by a `SELECT version FROM _migrations` probe, with fresh databases short-circuited by marking every
version done against `GLOBAL_SCHEMA` in `schema.ts`. **There are no down-migrations.** So the
draft's "migration is reversible" acceptance criterion was not achievable, and it is replaced
below with one that is.

#### What rollback actually means here

The spec's rollback section reads as though the schema can be reverted. Given the framework above,
it cannot, and this plan says so plainly rather than implying otherwise.

**There is no mechanism to un-apply a migration.** `_migrations` records versions applied and
nothing reads it backwards. So "revert the schema" is not an operation this system offers.

What *is* revertible is the spec's steps 1 and 2, and the spec is already right that those are the
rollback:

1. **Stop new thread-backed spawns.** `afx spawn` returns to the PTY path. This is a code change,
   fully revertible, and it takes effect immediately.
2. **Let existing thread-backed builders finish,** or capture each one's branch and worktree path
   and close its thread deliberately. Never drop a thread with unmerged work.

Step 3 — the spec calls it cleanup, not rollback — is **restore from a backup of `global.db`**,
and nothing else. There is no down-migration to run instead. Two consequences follow and both are
deliverables below:

- The migration is written to be **additive only** on the way in. `ADD COLUMN` leaves the existing
  table shape untouched, so a database that has taken the migration is still readable by the
  previous release even though the column is unknown to it. A table rebuild would not have that
  property, which is the deciding argument between the two options below and is why the choice is
  made here rather than by the implementer.
- **A copy of `global.db` is taken before the migration runs**, once, automatically, and its path
  is logged. This is the only thing that makes step 3 possible at all, and a migration that assumes
  a backup exists without creating one is assuming something no code guarantees.

The `architect` table is the hard part, and the spec is right about why. Verified against
`db/schema.ts:177-187`: `pid INTEGER NOT NULL`, `port INTEGER NOT NULL` and `cmd TEXT NOT NULL`
all lack defaults, and a thread-backed architect has none of the three. The `builders` table does
not have this problem — its `pid` and `port` already carry `DEFAULT 0`.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/db/index.ts` — the new inline migration, following the existing
  `_migrations` version pattern.
- `packages/codev/src/agent-farm/db/schema.ts` — `GLOBAL_SCHEMA` convergence for fresh databases.
- `packages/codev/src/commands/porch/types.ts` — `thread_id` on `ProjectState`.
- `packages/codev/src/commands/porch/state.ts` — serialization of the new field.
- `packages/codev/src/agent-farm/commands/spawn.ts`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
- `packages/codev/src/agent-farm/commands/status.ts` — report the drain count.
- `packages/codev/src/agent-farm/db/__tests__/`

#### Deliverables

- [ ] **`status.yaml` records the `threadId` at spawn.** `ProjectState` gains the field, it
      round-trips through the existing read and write path, and a `status.yaml` written before this
      change still loads — the field is optional, matching how `awaiting_input` and `pr_history`
      were added.
- [ ] The `thread_id` columns themselves were added in Phase 5, which is the first phase that
      needs them to exist. This phase does not re-add them; it is the first that **writes** them.
      Old rows stay valid with no backfill, following the pattern `harness` and `model` established.
- [ ] For `architect`, **the `ADD COLUMN` plus sentinel-values option is chosen** (`pid` 0, `port` 0, `cmd` `''`), with exclusivity enforced in code rather than by a
      `CHECK`. The rejected alternative — a table rebuild relaxing the three `NOT NULL` columns
      with a `CHECK` constraint — is stricter at the schema level, but it changes the table shape,
      and with no down-migration the only way back is a restore from backup. Additive stays
      readable by the previous release; a rebuild does not. **A row must represent either shape and
      never both.**
- [ ] **A backup of `global.db` is taken before the migration runs**, and its path is logged at
      `info`. Step 3 of the spec's rollback is a restore, so the backup is not a precaution, it is
      the mechanism.
- [ ] The migration follows the existing mechanism exactly: a new version constant, a guarded
      inline block in `db/index.ts`, and matching `GLOBAL_SCHEMA` text so a fresh database and a
      migrated one converge. A test asserts they converge, since that is the property the
      short-circuit depends on.
- [ ] `afx spawn` writes `thread_id` to both stores and no `terminal_id`. A builder's path is a
      property of its row, never a global mode.
- [ ] `afx status` reports the drain count: rows where
      `terminal_id IS NOT NULL AND thread_id IS NULL AND status != 'complete'`.
- [ ] No in-flight builder is migrated across paths, and there is no code that could.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Migration applies to a copy of a real `global.db` and every existing row survives.
- [ ] A fresh database built from `GLOBAL_SCHEMA` and a migrated one have identical schemas.
- [ ] **Rollback is tested as the spec defines it, not as a schema revert**: stop new thread-backed
      spawns, confirm `afx spawn` returns to the PTY path immediately, and assert no thread-backed
      row is orphaned. The spec is explicit that dropping `thread_id` while thread-backed builders
      exist orphans real work, so the revertible step is the spawn path, not the column.
- [ ] **The restore path is exercised once, for real**: take the automatic backup, apply the
      migration, restore the backup, and confirm the previous release opens the restored database.
      This is the only rollback the framework supports, so it is tested rather than assumed.
- [ ] A migrated database opens without error under the **previous** release, proving the migration
      is additive. This is the property that makes a restore optional rather than mandatory.
- [ ] A row carrying both a `terminal_id` and a `thread_id` is rejected.
- [ ] A `status.yaml` written before this change loads unchanged; a new one carries `thread_id`.
- [ ] A new spawn takes the thread path; an existing PTY builder is unaffected and still reachable.
- [ ] `afx status` reports a drain count that goes to zero as PTY builders complete.
- [ ] Build and tests pass.

#### Test Plan

Unit: the migration against a copied real database; fresh-versus-migrated schema convergence; the
exclusivity constraint; the drain query; `ProjectState` round-trip with and without the field.

Integration: spawn a thread-backed builder alongside a running PTY builder and drive both.

---

### Phase 9: Architect threads and afx command parity

**Dependencies**: Phase 8

#### Objective

Make an architect a thread rooted at the workspace, keep every `afx send` addressing form working
through it — including #47's spoofing rule — and give the rest of `afx` a thread-backed
implementation.

The spec's open question 4 rules that `afx` stays, with `spawn`, `send`, `status`, `interrupt`,
`cleanup` and `dev` keeping their contracts and only the engine changing. Review found the draft
covered the first three and left the last three unassigned; they are owned here.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/architect.ts`
- `packages/codev/src/agent-farm/commands/send.ts`
- `packages/codev/src/agent-farm/commands/interrupt.ts`
- `packages/codev/src/agent-farm/commands/cleanup.ts`
- `packages/codev/src/agent-farm/commands/dev.ts`
- `packages/codev/src/agent-farm/commands/workspace-add-architect.ts`
- `packages/codev/src/agent-farm/utils/architect-name.ts`
- `packages/codev/src/agent-farm/__tests__/issue-47-builder-message-route.test.ts` — extended.
- `packages/codev/src/agent-farm/__tests__/afx-parity.test.ts`
- `codev/resources/146-architect-cutover-runbook.md` — the per-workspace cutover procedure.

#### Deliverables

- [ ] An architect is a thread whose worktree is the workspace root.
- [ ] `afx send architect`, `afx send architect:<name>` and `afx send <workspace>:architect` all
      become a turn on the target architect's thread, keeping their current meanings.
- [ ] **#47's spoofing rule survives**: a builder naming an architect other than its own is
      refused. The map lives in `codev-agent`, not in the caller, which is what makes the rule
      enforceable rather than advisory.
- [ ] Identity comes from the thread id recorded at spawn, replacing `CODEV_BUILDER_ID` and
      `CODEV_WORKTREE_ROOT`. A builder that `cd`s out of its worktree keeps its identity — the
      #47 failure mode is structurally gone rather than patched.
- [ ] An architect thread survives a server restart and resumes with context.
- [ ] **`afx interrupt` becomes `thread.turn.interrupt`.** This is the command whose old
      implementation the spec singles out as "sending ESC and hoping", and the spike proved the
      typed form actually kills the process — `SHOULD_NOT_FINISH` never printed. Settling is
      detected on `activeTurnId: null`, per Phase 3, not on session status.
- [ ] **`afx cleanup` removes a thread-backed builder's worktree via t3code's worktree lifecycle**
      rather than the PTY-era path, and refuses to remove one with unmerged work — the spec's
      rollback section is explicit that a thread must never be dropped with unmerged work.
- [ ] **`afx dev` keeps working against a thread-backed worktree.** It resolves the worktree path
      from the thread rather than from `terminal_sessions`, which is where it reads it today.
- [ ] A parity test drives each of `spawn`, `send`, `status`, `interrupt`, `cleanup` and `dev`
      against a thread-backed builder and asserts the command's observable contract is unchanged.
      The spec promises "same commands, same flags, new engine", and this is what makes that
      checkable rather than aspirational.
- [ ] **The architect cutover runbook is written here and exercised on one workspace.** Phase 14
      gates on "every architect has been cut over per the spec's step 4", but a gate checkbox is not
      a procedure and no other phase owns one. The spec is explicit that this step is not a drain:
      an architect conversation cannot be migrated, so cutover means `/arch-save`, stop the PTY
      architect, start the thread-backed one, re-init from the saved state, and live with it before
      doing the next workspace. The runbook records what `/arch-save` did **not** capture on the
      first real cutover, because that is the spec's named rollback trigger and it is only
      discoverable by doing it.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] All three addressing forms reach the right architect thread.
- [ ] A builder addressing a foreign architect is refused, and the existing #47 test passes against
      the thread path.
- [ ] An architect thread is created, the server is restarted, and the thread resumes with prior
      context.
- [ ] One architect and six builders run concurrently in one workspace without either starving the
      other — success criterion 10c, measured, not asserted.
- [ ] `afx interrupt` on a running turn leaves `activeTurnId: null` and the interrupted command's
      side effect absent.
- [ ] `afx cleanup` refuses a thread-backed builder with unmerged work and succeeds without it.
- [ ] `afx dev` binds against a thread-backed worktree.
- [ ] Build and tests pass.

#### Test Plan

Unit: address parsing and the spoofing refusal; the cleanup refusal predicate.

Integration: restart survival; the six-command parity run against a thread-backed builder; the
concurrency measurement with real turns running, recording memory and turn latency for the
architect while six builders are active.

---

### Phase 10: Full protocol on a second driver

**Dependencies**: Phase 9

#### Objective

Run a complete protocol end to end with no PTY involved, on two provider drivers, and start the
24-hour gate clock that Phase 14 depends on.

Only Codex was exercised in the spike. Success criterion 10 requires a second driver before
deletion, and this phase is where a driver-specific failure surfaces while it is still cheap.

#### Files to Create / Modify

- `packages/porch-driver/__tests__/full-protocol.test.ts`
- `packages/porch-driver/src/drivers/` — per-driver quirks, if any are found.
- `codev/research/146-driver-parity.md`
- `codev/research/146-long-gate-evidence.md`

#### Deliverables

- [ ] A complete BUGFIX protocol on a t3code thread: spawn, phases, checks between turns, a gate
      that pauses at least one hour, PR, merge. No PTY code path runs, asserted rather than
      assumed.
- [ ] Porch restarts mid-protocol, resubscribes with `afterSequence`, and loses no completion
      event.
- [ ] The same run on a **second, non-Codex driver**. Any behavioural difference is recorded in
      `146-driver-parity.md` rather than worked around silently.
- [ ] The 24-hour gate test is **started** in this phase and its evidence recorded when it
      completes. It gates Phase 13, so it must be running well before Phase 13 begins; starting it
      here is the only way the schedule works.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Criterion 1 passes on two drivers.
- [ ] Criterion 2 passes: restart mid-protocol, no lost completion.
- [ ] A one-hour gate resumes with context on both drivers.
- [ ] The 24-hour gate run is started and its start recorded.
- [ ] Build and tests pass.

#### Test Plan

Integration, long-running, against a live server. The one-hour and 24-hour gates are elapsed for
real; a fake clock does not test what the reaper does.

---

### Phase 11: codev-client tree and live status

**Dependencies**: Phase 6, Phase 7, Phase 9

#### Objective

The left sidebar tree: machine, workspace, architects, that architect's builders, with correct live
status on every row — including a builder blocked on a gate showing #128's structured question, not
only a gate name. Multi-machine and honest degradation land here too, because a tree that cannot
say "disconnected" is worse than no tree.

The stack matches `apps/v2`: React 19, Vite 6, Vitest 4, Playwright.

#### Files to Create / Modify

- `apps/client/package.json`, `vite.config.ts`, `tsconfig.json`
- `apps/client/src/tree/` — the workspace tree.
- `apps/client/src/connection/` — per-machine connection, one per server.
- `apps/client/src/status/` — row status derivation.
- `apps/client/src/gate/` — structured gate rendering and approval.
- `apps/client/e2e/`

#### Deliverables

- [ ] The tree renders machine, workspace, architects, and each architect's builders.
- [ ] Every row carries live status: working, turning, blocked on a named gate, or settled.
- [ ] A blocked builder shows its structured question and choices without navigation, and is
      visually distinct from a settled one. A gate name alone does not satisfy this.
- [ ] **Where porch and t3code disagree, porch wins and the client shows porch's value.** Titles,
      pins and activity entries are display projections, never a source of truth.
- [ ] A thread with no porch record renders as unmanaged, not hidden.
- [ ] One client connects to more than one machine's server at once, each independently live.
- [ ] With one server stopped, its subtree is marked disconnected **with a last-updated
      timestamp**, other machines stay live, and nothing renders blank or silently stale.
- [ ] A human approves a real gate from the client through Phase 6's capability path.
- [ ] No `dangerouslySetInnerHTML` on agent output; a restrictive CSP; explicit origin rules. The
      client holds credentials for N servers, which makes XSS a credential-theft path rather than a
      defacement one.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Criterion 3: correct live status on every row including the structured gate content.
- [ ] Criterion 7: two machines in one tree, independently live.
- [ ] Criterion 8: one server stopped, subtree disconnected with a timestamp, others unaffected.
- [ ] Criterion 9b: a real gate approved from the client, with session id, machine and timestamp in
      `status.yaml`.
- [ ] Criterion 15's scenario: revoking one machine's token fails that subtree closed and leaves
      others unaffected.
- [ ] A grep asserts no `dangerouslySetInnerHTML` in the app.
- [ ] Build and tests pass.

#### Test Plan

Unit and component: status derivation for every state; the porch-wins reconciliation; disconnected
rendering.

E2E under Playwright against two live servers: both trees correct, one stopped, the subtree marked,
a gate approved.

---

### Phase 12: codev-client tiling and mobile

**Dependencies**: Phase 7, Phase 11

#### Objective

The tiled pane grid, the architect strip, and the narrow-viewport paging — verified at the exact
measurements the spec gives, because these criteria are arithmetic and a component test cannot
check them.

#### Files to Create / Modify

- `apps/client/src/grid/` — the tile grid.
- `apps/client/src/pane/` — a builder pane.
- `apps/client/src/architect-strip/`
- `apps/client/src/responsive/` — paging behaviour.
- `apps/client/e2e/tiling.spec.ts`, `apps/client/e2e/mobile.spec.ts`

#### Deliverables

- [ ] Six builders tile at 1440x900 in a 3x2 grid, every pane at least **340x240 CSS px**, body
      text at **13px or larger**, each pane showing builder id, status, and the last three agent
      messages.
- [ ] The architect does **not** occupy a seventh tile at 1440x900. It gets a persistent strip
      below the grid showing status and its last message, and expands to a full pane on demand,
      replacing the grid. A seventh equal tile is offered only at 1920 or wider.
- [ ] At 390px wide the same six page one-per-screen with **no horizontal scroll**. The grid pages
      rather than shrinks.
- [ ] Reachable over a tailnet from an iPad, and able to drive a builder to completion from there.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Criterion 4, measured under Playwright at 1440x900: pane dimensions and computed font size
      asserted from the rendered page, not from the stylesheet.
- [ ] Criterion 4b: no seventh tile at 1440x900; the strip is present; expansion replaces the grid;
      a seventh tile appears at 1920.
- [ ] Criterion 5, measured at 390px: `document.documentElement.scrollWidth` does not exceed the
      viewport width.
- [ ] Criterion 6: an iPad on the tailnet drives a builder to completion. This one is manual and is
      recorded with what was actually done.
- [ ] Build and tests pass.

#### Test Plan

E2E under Playwright at 1440x900, 1920x1080 and 390px, asserting measured geometry.

Manual: the iPad run, over the tailnet, with the teardown step
(`tailscale serve --https=443 off`) exercised afterwards so the runbook is tested rather than
written.

---

### Phase 13: Extension retirement

**Dependencies**: None; must land before Phase 14

#### Objective

Retire both extensions, differently, as the spec rules. This lands before deletion so that Phase 14
is not simultaneously removing the terminal layer and discovering what depended on it.

#### Files to Create / Modify

- `apps/streamdeck/` — deleted.
- `pnpm-workspace.yaml` — `apps/vscode` excluded from the workspace build. The file globs
  `apps/*`, so this is a negation entry (`!apps/vscode`) beside the glob, not the removal of a
  list entry. Deleting the glob would drop every app including the new client.
- `package.json` — packaging excludes both.
- `apps/vscode/README.md` — marked unsupported.
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — routed by tier.

#### Deliverables

- [ ] `apps/streamdeck` is deleted. Nothing upstream touches it, so removal is clean.
- [ ] `apps/vscode` **stays in the tree**, dropped from the workspace build and from packaging, and
      marked unsupported in its README. Deleting it would conflict on every upstream merge forever;
      upstream is 173 commits ahead and every one of its `apps/` changes is in `apps/vscode`.
- [ ] A fresh `npm pack` contains neither.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Criterion 9: `npm pack` output contains no `apps/streamdeck` and no `apps/vscode` entries,
      asserted by a test over the packed tarball rather than by inspection.
- [ ] The workspace builds without `apps/vscode`.
- [ ] Build and tests pass.

#### Test Plan

Unit: a test that runs `npm pack --dry-run` and asserts on the file list.

Manual: confirm the vscode README states unsupported.

---

### Phase 14: Terminal layer deletion

**Dependencies**: Phase 10, Phase 13

#### Objective

Delete the terminal half, once and only once the gates allow it, and record the line-count
accounting the spec's final criterion asks for.

#### Gating — check before starting

This phase does not start until all of the following are true. Each is a fact recorded by an
earlier phase, not a judgement:

- [ ] Success criterion 11: the 24-hour gate started in Phase 10 has completed and resumed with
      context.
- [ ] Success criterion 12: Phase 1's churn classification records a breaking count.
- [ ] **Success criterion 12b: Phase 4's five delivery semantics all held.** The spec is explicit —
      "If it fails, the mailbox stays and 13 is not attempted." So a 12b failure does **not** mean
      this phase runs without the mailbox; it means this phase does not run. The draft of this plan
      said otherwise and contradicted the spec. On a 12b failure, stop here, report to the
      architect, and let them rule on scope.
- [ ] Success criterion 10: two drivers passed Phase 10.
- [ ] The drain is complete: zero rows where
      `terminal_id IS NOT NULL AND thread_id IS NULL AND status != 'complete'`, for every
      workspace.
- [ ] Every architect has been cut over per the runbook Phase 9 wrote, one workspace at a time.

#### Files to Create / Modify

- `packages/codev/src/terminal/` — deleted.
- `packages/codev/src/agent-farm/servers/render-gate.ts` — deleted.
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — deleted.
- `packages/codev/src/agent-farm/servers/mailbox-*.ts` — deleted, subject to the 12b gate.
- `packages/codev/src/agent-farm/db/mailbox.ts` — deleted, same condition.
- `packages/codev/src/agent-farm/utils/harness.ts` — deleted.
- `apps/v2/` — deleted.
- `apps/web/` — deleted. This is the legacy dashboard, named by path rather than by description:
  `apps/` holds `streamdeck`, `v2`, `vscode` and `web`, and `@cluesmith/codev-web` is the
  xterm-based one (`@xterm/addon-canvas`, `addon-fit`, `addon-web-links` on `codev-sdk`). A phase
  that says "the legacy dashboard" and lists no path leaves a builder three candidates.
- `packages/sdk/` — **its terminal surface does not go dead with `apps/web`, and an earlier
  revision of this plan was wrong to say so.** Review falsified it and the check confirms:
  `apps/vscode/src/connection-manager.ts:2-3` imports `TowerClient` and `backoffDelayMs`, and
  `terminal-manager.ts:7` imports `TerminalType`, all from `@cluesmith/codev-sdk/tower-client`.

  This collides with Phase 13 by design, not by accident. Phase 13 keeps `apps/vscode` in the tree
  precisely so upstream's 173 commits keep merging cleanly, and dropping it from the build hides a
  local break while leaving every future upstream merge landing vscode code against an sdk that no
  longer exports what it imports. So the ruling has to be explicit, and it is: **the sdk's
  `tower-client` module is retained as a compile-only surface for `apps/vscode`.** It stops being
  wired to anything live when `apps/web` goes, but its exported types and the `TowerClient` shape
  stay so the unbuilt app still typechecks if someone builds it. The alternative — deleting the
  exports and accepting a permanently broken `apps/vscode` — throws away the exact benefit Phase 13
  was designed to buy.
- `codev-skeleton/` — mirrored throughout.
- `codev/reviews/146-codev-client-on-t3code.md`

The `terminal_sessions` table and the `terminal_id` column are **not touched here**. They go in
Phase 15, behind a release checkpoint.

#### Deliverables

- [ ] PTY manager, render gate, terminal session management, harness registry, v2 client and legacy
      dashboard deleted, and the suite green without them.
- [ ] The mailbox deleted. If criterion 12b failed, this phase does not run at all — see the gate
      above.
- [ ] **The schema is left alone.** `terminal_sessions` and `terminal_id` survive this phase
      unused, which is precisely the state the spec requires a release to ship in before they are
      dropped.
- [ ] **Twelve non-test files reach the PTY layer, not five.** The "five" figure was inherited
      from the spec without re-measuring; review caught it and the measurement confirms twelve:
      `spawn-worktree.ts`, `attach.ts`, `shellper-husk-sweep.ts`, `tower-tunnel.ts`,
      `tower-websocket.ts`, `mailbox-wiring.ts`, `tower-utils.ts`, `tower-server.ts`,
      `tower-instances.ts`, `tower-routes.ts`, `tower-types.ts`, `tower-terminals.ts`. Reproduce
      with:

      ```bash
      grep -rln "pty-manager\|ptyManager\|from '\.\./\.\./terminal\|from '\.\./terminal" \
        packages/codev/src --include="*.ts" | grep -v __tests__ \
        | grep -v "^packages/codev/src/terminal"
      ```

      Every one of the twelve is resolved here, and each is marked **delete** or **edit**, because
      the distinction is the whole difficulty of this phase. Four of them are components the spec
      **keeps** in `codev-agent` and are therefore surgery, not deletion — verified by counting
      their terminal references: `tower-routes.ts` (7), `tower-server.ts` (2), `tower-tunnel.ts`
      (1), and `session-log-sweep.ts` (1, reached via the census). A builder who reads the earlier
      revision's flat list as a delete list removes the HTTP server the spec preserves.

      | File | Fate |
      |---|---|
      | `tower-terminals.ts` | delete |
      | `shellper-husk-sweep.ts` | delete |
      | `commands/attach.ts` | delete — see the `afx attach` ruling below |
      | `mailbox-wiring.ts` | delete with the mailbox |
      | `tower-routes.ts` | **edit** — 7 terminal references removed, routes preserved |
      | `tower-server.ts` | **edit** — 2 references removed, the HTTP/WS server survives |
      | `tower-tunnel.ts` | **edit** — the tunnel survives |
      | `session-log-sweep.ts` | **edit** — the spec keeps the sweep |
      | `process-census.ts` | **edit** — 1 reference |
      | `tower-websocket.ts` | **edit** — terminal channels go, protocol state stays |
      | `tower-utils.ts`, `tower-types.ts`, `tower-instances.ts` | **edit** — shared helpers and types |
      | `spawn-worktree.ts` | **edit** — the PTY spawn path goes, worktree setup stays |

      The test files that import `../../terminal/` are deleted or rewritten alongside their
      subjects; a phase that leaves them is not green.
- [ ] **`afx attach` is ruled on.** It is registered at `cli.ts:253` and `commands/attach.ts` is
      PTY-coupled, but the spec's open question 4 lists six preserved commands and `attach` is not
      among them, so no phase claimed it either way. It **retires with the PTY layer**: attaching to
      a terminal has no meaning once a builder is a thread, and the thread's own view replaces it.
      Its removal is announced in the release notes rather than discovered, because it is a
      registered command a human may have in muscle memory.

      A reviewer also flagged `afx shell` as PTY-coupled. It is not: `commands/shell.ts` has no
      import from `terminal/`, and the grep above does not return it. Recorded so the next reader
      does not re-open a question that was checked.
- [ ] All 33 non-test mailbox references are resolved, not left dangling. **Four of the 33 are
      features or commands the spec keeps**, not call sites to unwire. Each is named, because a
      builder who treats them as unwiring removes behaviour silently:
      - `servers/cron-delivery.ts:27-29` and `servers/delayed-send.ts` import `db/mailbox.js`
        directly. Both move onto Phase 4's scheduled-delivery path here.
      - `commands/cleanup.ts:17` imports `dismissHeldForAgent` from `db/mailbox.js`. `afx cleanup`
        is one of the six commands the spec's open question 4 preserves, so its held-message
        teardown needs an equivalent on the thread path, or an explicit ruling that a settled
        thread has nothing to dismiss.
      - `commands/status.ts` renders `heldCount` and `mailboxEscalated` per builder. "Held" is a
        render-gate concept with no thread-path equivalent, so those columns either retire or point
        at pre-due scheduled messages — the same ruling Phase 4 makes for `afx inbox`, applied
        consistently rather than per call site.
      `commands/inbox.ts` follows whichever ruling Phase 4 recorded.
- [ ] Every framework change is mirrored in `codev-skeleton/`, and the whole repo is grepped across
      both trees before this is called done.
- [ ] `codev-skeleton/` documents running a t3code server as an install requirement, which it
      becomes at this point.
- [ ] Net Codev-owned line count recorded in the review against the pre-migration baseline,
      counting `codev-client` as added.
- [ ] The review at `codev/reviews/146-codev-client-on-t3code.md`.

#### Acceptance Criteria

- [ ] Criterion 13: all named components deleted (subject to the 12b condition) and the suite is
      green.
- [ ] Criterion 14: net line count is lower than baseline, recorded with both figures under **one
      stated counting rule**. Review caught the earlier revision mixing rules — `terminal/` was a
      non-test figure while `apps/v2` and `apps/streamdeck` were with-tests figures, which makes
      the total meaningless.

      **The rule: non-test `.ts` and `.tsx` only**, excluding any path matching `__tests__`,
      `.test.` or `.spec.`. Measured under that rule today, before deletion starts:
      `packages/codev/src/terminal` **5,250**, `apps/v2` **1,713**, `apps/streamdeck` **2,017**,
      `render-gate.ts` **646**, `tower-terminals.ts` **1,185**. The same command produces the
      after figure, and both appear in the review:

      ```bash
      find <dir> -type f \( -name "*.ts" -o -name "*.tsx" \) \
        | grep -vE "__tests__|\.test\.|\.spec\." | xargs wc -l | tail -1
      ```
- [ ] `codev/` and `codev-skeleton/` agree; a repo-wide grep for the deleted names across both
      trees returns only intentional references.
- [ ] `terminal_sessions` and `terminal_id` still exist and are unreferenced by live code.
- [ ] Build and tests pass.

#### Test Plan

The full suite, green without the deleted modules. A grep-based test asserting no live references
to deleted symbols across both trees, and one asserting the schema is untouched.

---

### Phase 15: Terminal schema drop

**Dependencies**: Phase 14, and a shipped release

#### Objective

Drop `terminal_sessions` and `terminal_id`, last, after a release has shipped with them unused.

This is a separate phase because the spec makes it one: the columns "go last, in their own
migration, after a release has shipped with them unused". Bundling the drop into Phase 14 would
mean shipping the deletion and the irreversible schema change together, and there is no
down-migration framework to undo it — a point Phase 8 establishes and this phase inherits.

#### Gating — check before starting

- [ ] A release has shipped containing Phase 14, with `terminal_sessions` and `terminal_id`
      present and unused.
- [ ] No live code references either, re-checked at the tip rather than trusted from Phase 14.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/db/index.ts` — the drop migration, following the inline
  `_migrations` version pattern established in Phase 8.
- `packages/codev/src/agent-farm/db/schema.ts` — `GLOBAL_SCHEMA` updated to match.
- `packages/codev/src/agent-farm/db/__tests__/`

#### Deliverables

- [ ] `terminal_sessions` dropped and `terminal_id` removed from `builders` and `architect`, in one
      migration of their own containing nothing else.
- [ ] `GLOBAL_SCHEMA` updated so a fresh database and a migrated one still converge.
- [ ] **The fresh-versus-existing sentinel is changed in this same migration, because dropping
      `terminal_sessions` breaks it.** `db/index.ts:152-156` decides `isFresh` by asking whether the
      `terminal_sessions` table exists, and the comment there says the check deliberately is *not*
      `_migrations`, since that table "could exist but be empty in a partially-initialized legacy
      DB". Drop `terminal_sessions` and every existing `global.db` is misread as fresh on the next
      open: the code runs `GLOBAL_SCHEMA`, marks versions 1…`GLOBAL_CURRENT_VERSION` applied, and
      **returns early — so no future migration ever runs on that database again.** The data
      survives, because `GLOBAL_SCHEMA` is `CREATE TABLE IF NOT EXISTS` throughout; what is lost is
      the ability to migrate that database ever again, silently and with no error, surfacing at
      v21 on someone else's issue months later.

      **The sentinel becomes `builders`,** ruled by the architect and recorded here rather than
      left to the implementer. It is the one table the system cannot function without, so unlike
      `terminal_sessions` it can never be dropped by a later migration — which is the property the
      sentinel actually needs and the reason `terminal_sessions` was a poor choice in hindsight
      rather than a careless one. The original comment's reasoning stands: the check must not be
      `_migrations`, because that can exist but be empty on a partially-initialized legacy DB.
- [ ] The release checkpoint recorded in the review: which version shipped with the columns unused.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The migration applies to a copy of a real post-release `global.db` and every surviving row is
      intact.
- [ ] Fresh and migrated schemas are identical.
- [ ] **A migrated database is opened a second time and is still detected as existing.** Apply the
      drop, close, reopen, and assert the bootstrap took the migration path and not the fresh path
      — then add a version 21 no-op and assert it applies. Without this the regression is invisible:
      the first open after the drop looks completely normal, and the damage only shows up whenever
      the next migration is written, which could be months later and by someone else.
- [ ] The commit contains the migration and nothing else.
- [ ] Build and tests pass.

#### Test Plan

Unit: the migration against a copied real database; fresh-versus-migrated convergence.

Manual: confirm against the release history that a shipped version carried the unused columns. This
is a fact to look up, not to assume.

---

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Generated schemas are weaker than t3code's, so drift behind a transform is invisible | **Confirmed** | High | Measured before this plan was written: `TrimmedNonEmptyString` and `TrimmedString` emit identical JSON Schema *and* identical Representation documents. Phase 1 adds a source-hash layer over the 9 closure files as the load-bearing detector, with a regression test asserting the generated layer alone would miss it |
| The shape check is mistaken for contract validation at a call site | Medium | High | Named `shape-check`, not `validate`; `LOSSY.md` enumerates every weakened schema; Phase 2 forbids treating a pass as contract validity |
| `effect@4.0.0-beta.103` on `effect/unstable/rpc/*` changes shape | High | High | Only a devDependency of the codegen; Phase 2's transport owns the envelope directly, so an Effect API change costs a regenerate, not a rewrite |
| 27 contract commits a month, and the source-hash layer fires on cosmetic changes too | High | Medium | The closure is 9 files, so each fire is a bounded read; the generated diff runs alongside and answers "did anything we consume change" in most cases without a manual read |
| Ack backpressure missed, streams stall under load | Medium | High | Phase 2 tests it directly, with an ack-suppressed control that must stall |
| Delivery semantics fail, mailbox cannot be deleted | Medium | Medium | Phase 4 runs early and its failure is an expected outcome the spec already rules on, not a blocker |
| The approval boundary is claimed stronger than it is | Medium | High | Phase 6 states the loopback-attribution limit in the threat model and tests the refusal that actually matters |
| A second driver behaves differently | Medium | High | Phase 10 runs the full protocol on two drivers before any deletion |
| The 24-hour gate is discovered late and stalls the schedule | Medium | Medium | Started in Phase 10, four phases before it is needed |
| Architect cutover loses conversation state | Medium | High | One workspace at a time, `/arch-save` first, and the spec's rollback order: stop new spawns, drain, only then revert schema |
| Tiling ships as a wireframe that passes tests | Medium | High | Phase 12 asserts measured geometry and computed font size from the rendered page under Playwright, not from stylesheets |
| Deleting the mailbox silently removes `afx send --delay` and cron notifications | **Confirmed** | High | Both hard-import `db/mailbox.js` (`cron-delivery.ts:27-29`, `delayed-send.ts`) while the spec keeps both features. Phase 4 builds durable scheduled delivery on the thread path; Phase 14 moves them onto it rather than treating them as call sites to unwire |
| **The harness pins the checkout, not the server binary** | **Confirmed** | High | `tools/t3-server/` starts the published `t3` CLI against the pinned tree. The source is pinned; the CLI is not, so a divergence between them is **invisible to `verify`**. Two closures exist — build the server from the pinned tree, or pin the CLI version in `pin.json` too — and neither is done in Phase 1. **No later phase may assume this away.** A phase that needs it closed says so at its boundary rather than inheriting it silently; Phases 2, 3, 4, 9 and 10 all test against this harness |
| The live-server harness is improvised per phase, or never built | Medium | High | The pinned clone has no `node_modules` and has never been installed. Phase 1 owns the harness and Phase 2 does not start until it comes up twice from cold; absence reports as skipped, never as pass |

## Documentation Updates

Rebuilt from the phase breakdown after review found six entries assigned to the wrong phase and the
pinned-server README listed under two conflicting paths. Each document appears once, against the
phase that owns it.

| Document | Phase |
|---|---|
| `tools/t3-codegen/REFRESH.md` — the contract refresh procedure | 1 |
| `tools/t3-server/README.md` — bringing up a pinned server, and CI behaviour without one | 1 |
| `codev/research/146-contract-churn-classification.md` — criterion 12 | 1 |
| `packages/types/src/t3/generated/UNREPRESENTED.md` and `LOSSY.md` — generated, not hand-written | 1 |
| `codev/research/146-delivery-semantics-evidence.md` — criterion 12b | 4 |
| `codev/resources/146-codev-agent-failure-matrix.md` — the deferred failure matrix | 5 |
| `codev/resources/146-approval-threat-model.md` — the deferred threat model | 6 |
| `codev/resources/146-remote-access-runbook.md` — pairing, exposure, and `tailscale serve --https=443 off` | 7 |
| `codev/resources/146-architect-cutover-runbook.md` — the spec's step 4, per workspace, and what `/arch-save` did not capture on the first real cutover | 9 |
| `codev/research/146-driver-parity.md` and `146-long-gate-evidence.md` — criteria 10 and 11 | 10 |
| `apps/vscode/README.md` — marked unsupported | 13 |
| `packages/types/src/t3/generated/ATTRIBUTION.md` — MIT notice for the derived t3code source | 1 |
| `codev/resources/arch-critical.md` and `arch.md` — the terminal layer's removal and `codev-agent`'s role, routed by tier with displacement if the hot file is at its cap | 14 |
| `codev/resources/lessons-critical.md` and `lessons-learned.md` — same, routed by tier | 14 |
| `CLAUDE.md` and `AGENTS.md` — kept byte-identical | 14 |
| `codev-skeleton/` — mirrored throughout, and the t3code server documented as an install requirement | 14 |
| Release notes — `afx attach` retired | 14 |
| `codev/reviews/146-codev-client-on-t3code.md` — including the line-count figures under the stated rule, and the release version that shipped the unused columns | 14, 15 |
