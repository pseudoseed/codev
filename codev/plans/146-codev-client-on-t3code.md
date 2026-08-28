# Plan: a Codev client on a self-hosted t3code server

**Specification**: [codev/specs/146-codev-client-on-t3code.md](../specs/146-codev-client-on-t3code.md)

## Executive Summary

The spec selects Approach 3: adopt t3code for process control, and write a new Codev client
against it. This plan sequences that work so that every claim capable of killing the project is
tested before anything expensive is built on top of it.

Three findings from reading the t3code source changed the shape of the plan before it was
written, and they are recorded here because later phases depend on them.

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
- **Phases 5-6** build the security boundary and the service that hosts it, because the approval
  threat model is the one piece of design the spec explicitly refuses to settle.
- **Phases 7-9** make the dual-write cutover representable, move architects onto threads, and prove
  a full protocol run on a second driver.
- **Phases 10-11** build the client.
- **Phases 12-13** retire the extensions and delete the terminal half.

Two prerequisites are already met and are not phases here. #128's phases 1 and 2 have shipped:
`porch gate --request-file` and `packages/codev/src/commands/porch/gate-request.ts` exist, so the
structured gate record success criterion 3 depends on is available today.

### What each phase is allowed to assume

Phases 1-4 run against a live t3code server started from the pinned commit; none of them may be
marked complete on the strength of a unit test alone. Phases 10-11 are the only phases that touch
`apps/`, and both are verified in a browser under Playwright against real viewport sizes, because
a green component suite cannot detect the layout regressions success criteria 4, 4b and 5 are
written to catch.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Vendored t3code contract with drift detection"},
    {"id": "phase_2", "title": "t3code RPC transport client"},
    {"id": "phase_3", "title": "porch-driver session lifecycle and crash recovery"},
    {"id": "phase_4", "title": "Message delivery semantics"},
    {"id": "phase_5", "title": "Approval capability and threat model"},
    {"id": "phase_6", "title": "codev-agent protocol state service"},
    {"id": "phase_7", "title": "Thread identity schema and dual-write spawn"},
    {"id": "phase_8", "title": "Architect threads and afx addressing"},
    {"id": "phase_9", "title": "Full protocol on a second driver"},
    {"id": "phase_10", "title": "codev-client tree and live status"},
    {"id": "phase_11", "title": "codev-client tiling and mobile"},
    {"id": "phase_12", "title": "Extension retirement"},
    {"id": "phase_13", "title": "Terminal layer deletion"}
  ]
}
```

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

- `packages/t3-contract/package.json` — new package. `effect` and `typescript` as
  **devDependencies only**; zero runtime dependencies.
- `packages/t3-contract/pin.json` — the pinned t3code commit SHA, the `effect` version observed at
  that commit, and the closure file list.
- `packages/t3-contract/tools/generate.ts` — the codegen. Imports the pinned checkout's contracts,
  walks the closure, emits declarations and JSON Schema.
- `packages/t3-contract/src/generated/types.d.ts` — emitted TypeScript declarations.
- `packages/t3-contract/src/generated/schema.json` — emitted JSON Schema document.
- `packages/t3-contract/src/validate.ts` — a zero-dependency validator over the emitted JSON
  Schema, covering only the subset the emitter actually produces.
- `packages/t3-contract/tools/classify-churn.ts` — replays commits against the detector.
- `packages/t3-contract/REFRESH.md` — the refresh procedure the spec's constraint requires.
- `packages/t3-contract/__tests__/drift.test.ts`
- `packages/t3-contract/__tests__/validate.test.ts`
- `packages/t3-contract/__tests__/no-runtime-deps.test.ts`

#### Deliverables

- [ ] The closure is pinned explicitly to the 9 files measured above — `auth.ts`, `baseSchemas.ts`,
      `environment.ts`, `git.ts`, `model.ts`, `orchestration.ts`, `providerInstance.ts`,
      `sourceControl.ts`, `vcs.ts` — and the generator fails loudly if the pinned checkout's import
      graph reaches a file not on that list. Silent closure growth is the failure mode this
      catches.
- [ ] `rpc.ts` is **not** vendored. Method names are taken from `ORCHESTRATION_WS_METHODS` and the
      equivalent constants, which are plain string literals.
- [ ] Codegen emits declarations and JSON Schema from the pinned checkout. Every schema in the
      closure that the emitter **cannot** represent is listed by name in a generated
      `UNREPRESENTED.md`, with the reason. An empty list is not assumed; the list is the evidence.
- [ ] `validate.ts` implements only the JSON Schema keywords the emitter actually produces,
      enumerated from `schema.json`, and throws on encountering a keyword it does not implement
      rather than passing it silently. A validator that quietly ignores a constraint reports
      "valid" for input it never checked.
- [ ] The drift test regenerates from the pinned checkout and fails on any difference from the
      committed artifacts, naming the changed schema.
- [ ] `no-runtime-deps.test.ts` asserts the package's `dependencies` field is empty and that no
      file under `src/` imports `effect`.
- [ ] The 184 commits touching the closure since 2026-02-07 are replayed through the detector and
      each is recorded as breaking or non-breaking **against the schemas Codev consumes**, with the
      breaking count written to `codev/research/146-contract-churn-classification.md`. This
      discharges success criterion 12; counting commits is explicitly not the criterion.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] `packages/t3-contract` has zero runtime dependencies, asserted by test.
- [ ] The existing #1189 boundary tests on `codev-core` and `codev-sdk` still pass unchanged.
- [ ] Regenerating from the pinned commit is a no-op; mutating any closure file in a scratch
      checkout makes the drift test fail and names the schema.
- [ ] `UNREPRESENTED.md` exists and is accurate — spot-checked by hand against at least the three
      hardest cases in the closure: `TrimmedString` (a `decodeTo` transform),
      `ForwardCompatibleArray` (a filtering transform), and `ModelSelectionSource` (a pre-decode
      legacy promotion). These are named because they are the shapes most likely to defeat a JSON
      Schema emitter, and a plan that did not name them would let the phase pass by testing only
      plain structs.
- [ ] The churn classification records a breaking count, not a commit count.
- [ ] Build and tests pass.

#### Test Plan

Unit: the validator against valid, invalid and unrepresentable payloads; the closure guard against
an import graph that reaches outside the list; the no-runtime-deps assertion.

Integration: generate against the pinned checkout twice and assert byte equality; generate against
a checkout with one schema field removed and assert the drift test fails naming that schema.

Manual: read `UNREPRESENTED.md` and confirm each entry against the source. If any entry is a schema
a later phase must validate at runtime, that is a blocker to be raised with the architect before
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
- [ ] Payloads are validated on the way in using Phase 1's validator. A payload that fails
      validation is surfaced as a named decode error carrying the method tag and the failing path.
      It is never coerced and never dropped silently.
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
- `packages/porch-driver/__tests__/delivery.test.ts`
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
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Ten messages sent during one active turn arrive after settle, in order, with none lost and
      none interleaved.
- [ ] The same idempotency key sent twice results in exactly one delivery.
- [ ] A send against a stopped server raises at the call site within a bounded timeout.
- [ ] All five properties are demonstrated and recorded. **If any fails, the phase completes with
      the failure recorded and the architect is notified** — the mailbox then survives Phase 13,
      which is the spec's stated behaviour, not a defect in this plan.
- [ ] Build and tests pass.

#### Test Plan

Integration against a live server for all five. Ordering is tested under concurrent send pressure,
not with a single sequential loop, because a sequential loop cannot detect the reordering that
matters.

---

### Phase 5: Approval capability and threat model

**Dependencies**: Phase 3

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
- [ ] Every approval records capability id, machine and timestamp in `status.yaml`.
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
- [ ] `status.yaml` records capability id, machine and timestamp on a real approval.
- [ ] Build and tests pass.

#### Test Plan

Unit: nonce single-use and TTL; verifier comparison; expiry; per-machine revocation isolation.

Integration: approve a real gate through the capability path end to end; attempt the same from a
builder's environment and assert refusal.

Manual: read the threat model against this phase's code and confirm every claim in it is one the
code actually makes true. Any claim that is aspirational is deleted rather than softened.

---

### Phase 6: codev-agent protocol state service

**Dependencies**: Phase 5

#### Objective

Turn Tower into `codev-agent`: the same process with its terminal half removed, serving protocol
state to a browser that has no filesystem access to the machine. Produce the failure matrix the
architect deferred to plan work.

This phase does not delete anything. It adds the protocol-state surface and the identity maps
alongside the existing terminal surface, which is what makes the dual-write window in Phase 7
possible.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/agent-routes.ts` — protocol state HTTP surface.
- `packages/codev/src/agent-farm/servers/agent-state-stream.ts` — porch state change stream.
- `packages/codev/src/agent-farm/servers/thread-registry.ts` — architect-name to `threadId`, and
  builder-id to `threadId`.
- `packages/codev/src/agent-farm/servers/status-reader.ts` — `status.yaml` reads, scoped per
  worktree.
- `codev/resources/146-codev-agent-failure-matrix.md`
- `packages/codev/src/agent-farm/servers/__tests__/`

#### Deliverables

- [ ] Reads `status.yaml` and serves phase, gates and the #128 structured gate content already
      produced by `gate-request.ts`.
- [ ] Streams porch state changes, so the client does not poll.
- [ ] Holds the architect-name to `threadId` map, backed by the existing `architect` table keyed on
      `workspace_path` and name, and the builder-id to `threadId` join.
- [ ] Invokes `porch approve` behind Phase 5's capability check.
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

Integration: state stream against real porch writes; approval through the capability path.

---

### Phase 7: Thread identity schema and dual-write spawn

**Dependencies**: Phase 6

#### Objective

Make the cutover representable in `global.db`, and route new spawns down the thread path while
existing PTY builders keep running untouched.

The `architect` table is the hard part, and the spec is right about why. Verified against
`db/schema.ts:177-187`: `pid INTEGER NOT NULL`, `port INTEGER NOT NULL` and `cmd TEXT NOT NULL`
all lack defaults, and a thread-backed architect has none of the three. The `builders` table does
not have this problem — its `pid` and `port` already carry `DEFAULT 0`.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/db/schema.ts`
- `packages/codev/src/agent-farm/db/migrations/` — the new migration.
- `packages/codev/src/agent-farm/commands/spawn.ts`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
- `packages/codev/src/agent-farm/commands/status.ts` — report the drain count.
- `packages/codev/src/agent-farm/db/__tests__/`

#### Deliverables

- [ ] `builders` gains a nullable `thread_id`. Old rows stay valid with no backfill, following the
      pattern `harness` and `model` established.
- [ ] `architect` gains a nullable `thread_id`, and the migration makes a thread-backed row
      representable. Two options exist and the phase picks one and records why: a table rebuild
      relaxing the three `NOT NULL` columns with a `CHECK` that exactly one shape is present, or
      an `ADD COLUMN` plus sentinel values (`0`, `0`, `''`) with the exclusivity enforced in code
      and by a partial unique index. The rebuild is stricter; the sentinel is cheaper and
      reversible. **A row must be able to represent either shape and never both**, whichever is
      chosen.
- [ ] `afx spawn` writes `thread_id` and no `terminal_id`. A builder's path is a property of its
      row, never a global mode.
- [ ] `afx status` reports the drain count: rows where
      `terminal_id IS NOT NULL AND thread_id IS NULL AND status != 'complete'`.
- [ ] No in-flight builder is migrated across paths, and there is no code that could.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Migration applies to a copy of a real `global.db` and every existing row survives.
- [ ] Migration is reversible while zero thread-backed rows exist.
- [ ] A row carrying both a `terminal_id` and a `thread_id` is rejected.
- [ ] A new spawn takes the thread path; an existing PTY builder is unaffected and still reachable.
- [ ] `afx status` reports a drain count that goes to zero as PTY builders complete.
- [ ] Build and tests pass.

#### Test Plan

Unit: migration up and down; the exclusivity constraint; the drain query.

Integration: spawn a thread-backed builder alongside a running PTY builder and drive both.

---

### Phase 8: Architect threads and afx addressing

**Dependencies**: Phase 7

#### Objective

Make an architect a thread rooted at the workspace, and keep every `afx send` addressing form
working through it — including #47's spoofing rule.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/architect.ts`
- `packages/codev/src/agent-farm/commands/send.ts`
- `packages/codev/src/agent-farm/commands/workspace-add-architect.ts`
- `packages/codev/src/agent-farm/utils/architect-name.ts`
- `packages/codev/src/agent-farm/__tests__/issue-47-builder-message-route.test.ts` — extended.

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
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] All three addressing forms reach the right architect thread.
- [ ] A builder addressing a foreign architect is refused, and the existing #47 test passes against
      the thread path.
- [ ] An architect thread is created, the server is restarted, and the thread resumes with prior
      context.
- [ ] One architect and six builders run concurrently in one workspace without either starving the
      other — success criterion 10c, measured, not asserted.
- [ ] Build and tests pass.

#### Test Plan

Unit: address parsing and the spoofing refusal.

Integration: restart survival; the concurrency measurement with real turns running, recording
memory and turn latency for the architect while six builders are active.

---

### Phase 9: Full protocol on a second driver

**Dependencies**: Phase 8

#### Objective

Run a complete protocol end to end with no PTY involved, on two provider drivers, and start the
24-hour gate clock that Phase 13 depends on.

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

### Phase 10: codev-client tree and live status

**Dependencies**: Phase 6, Phase 8

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
- [ ] A human approves a real gate from the client through Phase 5's capability path.
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

### Phase 11: codev-client tiling and mobile

**Dependencies**: Phase 10

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

### Phase 12: Extension retirement

**Dependencies**: Phase 11

#### Objective

Retire both extensions, differently, as the spec rules. This lands before deletion so that Phase 13
is not simultaneously removing the terminal layer and discovering what depended on it.

#### Files to Create / Modify

- `apps/streamdeck/` — deleted.
- `pnpm-workspace.yaml` — `apps/vscode` removed from the workspace build.
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

### Phase 13: Terminal layer deletion

**Dependencies**: Phase 9, Phase 12

#### Objective

Delete the terminal half, once and only once the gates allow it, and record the line-count
accounting the spec's final criterion asks for.

#### Gating — check before starting

This phase does not start until all of the following are true. Each is a fact recorded by an
earlier phase, not a judgement:

- [ ] Success criterion 11: the 24-hour gate started in Phase 9 has completed and resumed with
      context.
- [ ] Success criterion 12: Phase 1's churn classification records a breaking count.
- [ ] Success criterion 12b: Phase 4's five delivery semantics all held. **If any failed, the
      mailbox is not deleted and this phase proceeds without it.**
- [ ] Success criterion 10: two drivers passed Phase 9.
- [ ] The drain is complete: zero rows where
      `terminal_id IS NOT NULL AND thread_id IS NULL AND status != 'complete'`, for every
      workspace.
- [ ] Every architect has been cut over per the spec's step 4, one workspace at a time.

#### Files to Create / Modify

- `packages/codev/src/terminal/` — deleted.
- `packages/codev/src/agent-farm/servers/render-gate.ts` — deleted.
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — deleted.
- `packages/codev/src/agent-farm/servers/mailbox-*.ts` — deleted, subject to the 12b gate.
- `packages/codev/src/agent-farm/db/mailbox.ts` — deleted, same condition.
- `packages/codev/src/agent-farm/utils/harness.ts` — deleted.
- `apps/v2/` — deleted.
- The legacy dashboard — deleted.
- `packages/codev/src/agent-farm/db/migrations/` — `terminal_sessions` and `terminal_id`, in their
  own migration.
- `codev-skeleton/` — mirrored throughout.
- `codev/reviews/146-codev-client-on-t3code.md`

#### Deliverables

- [ ] PTY manager, render gate, terminal session management, harness registry, v2 client and legacy
      dashboard deleted, and the suite green without them.
- [ ] The mailbox deleted **only if** criterion 12b held; otherwise retained with the reason
      recorded.
- [ ] The `terminal_sessions` table and the `terminal_id` column go **last, in their own
      migration**, after a release has shipped with them unused. They are not dropped in the same
      commit as the code.
- [ ] All 33 non-test mailbox references and the five files reaching the PTY manager are resolved,
      not left dangling.
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
- [ ] Criterion 14: net line count is lower than baseline, recorded with both figures.
- [ ] `codev/` and `codev-skeleton/` agree; a repo-wide grep for the deleted names across both
      trees returns only intentional references.
- [ ] The schema migration is separate from the code deletion commit.
- [ ] Build and tests pass.

#### Test Plan

The full suite, green without the deleted modules. A grep-based test asserting no live references
to deleted symbols across both trees. Migration applied and reverted against a copy of a real
`global.db`.

---

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| JSON Schema codegen cannot represent the transform-heavy schemas (`TrimmedString`, `ForwardCompatibleArray`, `ModelSelectionSource`) | Medium | High | Phase 1 names these three explicitly and emits `UNREPRESENTED.md`. If any is needed at runtime, it blocks before Phase 2 rather than surfacing in Phase 10 |
| `effect@4.0.0-beta.103` on `effect/unstable/rpc/*` changes shape | High | High | Only a devDependency of the codegen; Phase 2's transport owns the envelope directly, so an Effect API change costs a regenerate, not a rewrite |
| 27 contract commits a month outruns the refresh procedure | High | High | Phase 1's drift test names the changed schema; the closure is 9 files, not 27, so a refresh is a bounded read |
| Ack backpressure missed, streams stall under load | Medium | High | Phase 2 tests it directly, with an ack-suppressed control that must stall |
| Delivery semantics fail, mailbox cannot be deleted | Medium | Medium | Phase 4 runs early and its failure is an expected outcome the spec already rules on, not a blocker |
| The approval boundary is claimed stronger than it is | Medium | High | Phase 5 states the loopback-attribution limit in the threat model and tests the refusal that actually matters |
| A second driver behaves differently | Medium | High | Phase 9 runs the full protocol on two drivers before any deletion |
| The 24-hour gate is discovered late and stalls the schedule | Medium | Medium | Started in Phase 9, four phases before it is needed |
| Architect cutover loses conversation state | Medium | High | One workspace at a time, `/arch-save` first, and the spec's rollback order: stop new spawns, drain, only then revert schema |
| Tiling ships as a wireframe that passes tests | Medium | High | Phase 11 asserts measured geometry and computed font size from the rendered page under Playwright, not from stylesheets |

## Documentation Updates

- `packages/t3-contract/REFRESH.md` — the contract refresh procedure (Phase 1).
- `codev/research/146-contract-churn-classification.md` — criterion 12 (Phase 1).
- `codev/research/146-delivery-semantics-evidence.md` — criterion 12b (Phase 4).
- `codev/resources/146-approval-threat-model.md` — the deferred threat model (Phase 5).
- `codev/resources/146-codev-agent-failure-matrix.md` — the deferred failure matrix (Phase 6).
- `codev/research/146-driver-parity.md` and `146-long-gate-evidence.md` — criteria 10 and 11
  (Phase 9).
- Tailnet pairing and teardown runbook, including `tailscale serve --https=443 off` (Phase 11).
- `codev/resources/arch-critical.md` and `arch.md` — the terminal layer's removal and
  `codev-agent`'s role, routed by tier with displacement if the hot file is at its cap
  (Phases 12-13).
- `codev/resources/lessons-critical.md` and `lessons-learned.md` — same, routed by tier.
- `CLAUDE.md` and `AGENTS.md` — kept byte-identical (Phase 13).
- `codev-skeleton/` — mirrored throughout, and the t3code server documented as an install
  requirement (Phase 13).
