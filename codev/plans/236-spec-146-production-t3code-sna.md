# Plan: Production t3code snapshot, durable asynchronous gate approval, and an operator pairing command

**Specification**: [codev/specs/236-spec-146-production-t3code-sna.md](../specs/236-spec-146-production-t3code-sna.md)

## Executive Summary

The spec settled three decisions, and each one turned out to be a *reuse* decision rather than
a build decision. This plan sequences the work so that each phase lands one of them against
machinery that already exists.

- **Decision 1 (1B)** — per-workspace t3 configuration already lives in `.codev/config.json`'s
  `threads` block, `requestThreadBackend()` is already the non-blocking connector, and
  `packages/t3-client/src/subscription.ts` is already a durable resubscribing subscription. The
  work is a per-workspace cache with an observation time, plus the eight-status vocabulary and
  the session-state mapping the spec pinned.
- **Decision 2 (2C)** — the approval operation lives in a file-backed store beside the
  capability and nonce stores, using the same `atomic-store` helpers and the same
  "unreadable is not unknown" discipline.
- **Decision 3 (3B)** — `afx pair` operates the stores directly, which is what issuance already
  does today through `pair-dev.mjs`. Revocation becomes exactly as cheap as minting.

**Ordering rationale.** The client's vocabulary lands *before* the provider that produces it
(phases 1 then 2), so the wiring phase never has a window where Tower emits statuses the client
rejects as `unreadable`. The pairing command lands *before* the approval work (phase 3), so
phases 5 and 6 can be driven by hand through the real operator path instead of only through
tests — which is the specific failure this initiative keeps finding. The store lands before the
routes that write it (4 then 5), and the client consumes routes that already exist (6). The
documentation reconciliation lands last (7), when there is a shipped command for the threat
model to describe.

**What every phase shares.** No phase deletes a refusal or loosens a validator to go green.
**Four** tests are expected to change, and each is named in the phase that changes it, with what
it becomes — because every one of them reads, in isolation, like an inconvenient check to
delete:

| Test | Phase | Why it changes |
|---|---|---|
| `spec-146-phase-11-production-wiring.test.ts` (two assertions, lines 101 and 128) | 2 | a provider is now passed; the no-provider case moves to an explicit call |
| `agent-auth.test.ts` route enumeration | 5 | the route table gained two entries |
| `two-machines.spec.ts:235` — the `PHASE_CHECKS_REQUIRED` e2e | 6 | the panel now submits asynchronously; the refusal keeps an end-to-end assertion by driving the synchronous route directly |
| `build-tree.test.ts` / `validate.test.tsx` | 1 | the wire carries new statuses and an observation |

`agent-approval-path.test.ts`'s residual assertion must keep passing throughout; phase 3 is
where it would fail if real authority were ever added, and it is not.

The reviews also confirmed two files stay untouched, checked because the plan does not list
them: `agent-failure-matrix.test.ts` passes the provider type into `readThreadRegistry` and its
classifier cases take a separate input, so the `unreachable` variant surviving phase 1 leaves it
alone.

Phases are git commits on one branch, not separate PRs.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Snapshot status vocabulary and the session-state mapping"},
    {"id": "phase_2", "title": "The t3code session cache and the production provider"},
    {"id": "phase_3", "title": "afx pair issue/list/revoke"},
    {"id": "phase_4", "title": "Durable approval operation store"},
    {"id": "phase_5", "title": "Asynchronous gate approval routes"},
    {"id": "phase_6", "title": "Client submits and polls an approval"},
    {"id": "phase_7", "title": "Threat model, failure matrix, and the dev-check revocation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Snapshot status vocabulary and the session-state mapping

**Dependencies**: None

#### Objective

Teach both ends what a session state *is*, before anything produces one. After this phase the
snapshot type carries all eight statuses with an observation time, and the client renders every
value in t3code's enum as a word — driven by tests that construct snapshots directly. Nothing
is wired to a real t3code server yet, so `spec-146-phase-11-production-wiring.test.ts` still
passes unchanged.

This phase is first because the reverse order has a window in which Tower emits a status the
client classifies as `unreadable` and blanks the machine.

#### The wire shape — decided here, because nothing downstream can carry the payload without it

Both review lanes found the same hole in the first draft of this plan: `ThreadRegistrySnapshot`
publishes `t3code` as `T3codeThreadSnapshot['status']`, a **bare string**
(`thread-registry.ts:62`, published at `:291` and `:499`), the client mirrors it as
`T3codeReachability` (`connection/types.ts:71`), and `deriveRowStatus` takes that bare string.
So `observedAt`, the stale age and `cooling-down`'s when-and-why had no path to the client at
all, and spec criteria 3 and 4 were unimplementable as the plan stood. Two decisions close it.

**1. `protocol.t3code` stays a string. A sibling `protocol.t3codeObservation` carries the
payload** — `observedAt`, `ageMs`, and `message` for `cooling-down`, `unreachable` and
`misconfigured`.

Chosen over promoting `t3code` to an object because of the direction the reviewers pointed at:
`snapshotRejection` keys `older-server` on the field being **absent** (`types.ts:197`), so an
object-valued `t3code` would make a *newer client against an older server* receive a bare
string, fail validation, and blank the whole machine — a second cross-version failure on top of
the one criterion 5b already accepts. With a sibling field, an older server validates fine and
simply carries no observation, which the client reads as an unknown age. Only the
newer-server-against-older-client direction fails closed, which is the direction criterion 5b
decided deliberately.

**2. `ThreadIdentity.sessionState?: string` becomes a structured `session` field** carrying the
session status, thread settledness and `lastError`. Criterion 4's mapping needs status **and**
settledness on the same row, and one opaque string cannot hold both. `sessionStateOf`'s rule
survives unchanged in meaning — absence is still not `settled` — but it now returns the
structure or nothing rather than a string or nothing. The first draft said "split `LiveThread`"
and "keep `sessionStateOf`" in the same breath; opencode was right that those cancel.

**3. `readThreadRegistry` attaches live threads on `stale` as well as `available`**
(`thread-registry.ts:298` currently attaches only on `available`). Without this, a stale entry
carries no per-row content at all and the stale rule has nothing to act on.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/thread-registry.ts` — `T3codeThreadSnapshot` to the
  eight statuses with their payloads; `t3codeObservation` on `ThreadRegistrySnapshot`;
  `LiveThread` carrying session status and settledness; `ThreadIdentity.session`; the
  attach-on-`stale` change.
- `apps/client/src/connection/types.ts` — the `t3code` allow-list, the `t3codeObservation`
  sibling, the `ThreadIdentity.session` shape in `identity()`, and `snapshotRejection` left
  keyed on absence exactly as it is.
- `apps/client/src/status/derive.ts` — the mapping table and its precedence; the two new
  `RowStatusKind` values; the stale rule.
- `apps/client/src/tree/build.ts` — **named because phase 1 does not typecheck without it:**
  `sessionVisibility` is hard-coded as `'not-provided' | 'unreachable' | 'available'` at
  line 38 and assigned from `t3code` at line 121.
- `apps/client/src/tree/StatusStamp.tsx` — `CLASS` entries for the two new words.
- `apps/client/src/tree/MachineSubtree.tsx` — machine-level reasons for the new statuses, and
  the age where one is carried.
- `apps/client/src/client.css` — `.stamp-stopped`, `.stamp-error`.
- `apps/client/__tests__/derive.test.ts` — the mapping table, and the enumerating test that
  reads its value list from the generated contract
  (`packages/types/src/t3/generated/schema.json`). Placed here rather than under `servers/`
  because the mapping is client behaviour.
- `apps/client/__tests__/validate.test.tsx`, `apps/client/__tests__/build-tree.test.ts` —
  extended.

#### Deliverables

- [ ] `T3codeThreadSnapshot` carries `not-provided`, `not-configured`, `misconfigured`,
      `connecting`, `cooling-down`, `unreachable`, `available`, `stale`, each with the payload
      the spec's table gives it.
- [ ] `protocol.t3codeObservation` reaches the client carrying `observedAt`, `ageMs` and a
      message where the status has one; its absence reads as an unknown age, never as fresh.
- [ ] `ThreadIdentity.session` carries session status, settledness and `lastError`; a row with
      no thread carries nothing, and that is distinct from a session observed with no state.
- [ ] `deriveRowStatus` implements the spec's mapping table and its precedence: requested porch
      gate → session `error` → session activity → thread settledness → remaining session status.
- [ ] Two new row words, `STOPPED` and `ERROR`, and no others.
- [ ] A `stale` snapshot never derives `SETTLED`: a row whose last-known content would render
      `SETTLED` renders `UNKNOWN` carrying the age; an active last-known content renders its
      word under the existing stale treatment.
- [ ] A row with no thread reports its own row-specific reason, distinct from every
      snapshot-level status.
- [ ] `validateSnapshot` accepts the eight and rejects a ninth; `snapshotRejection` still
      answers `older-server` only for an absent field, and an older server's payload — valid
      string, no observation — validates rather than blanking the machine.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criteria 2, 4, 4b, 5, 5b.
- [ ] The enumerating test reads its value list from the generated contract; adding a value to
      the contract fails it.
- [ ] `spec-146-phase-11-production-wiring.test.ts` still passes untouched — this phase changes
      no wiring.
- [ ] Build and tests pass.

#### Test Plan

Unit. Construct snapshots directly and assert the rendered word for every combination of
session status and settledness in the table, including the four precedence conflicts
(`error` + active, active + settled, `stopped` + settled, `idle` + not settled). Assert a
synthetic out-of-enum value renders `UNKNOWN` naming it. Assert validator accept/reject and
both rejection classifications, **including an older server's payload** — a valid status string
with no `t3codeObservation` — validating and reading as an unknown age. Assert the stale rule in
both directions.

### Phase 2: The t3code session cache and the production provider

**Dependencies**: Phase 1

#### Objective

Tower observes real session state and serves it synchronously. This is the phase that meets
criterion 3 and the phase that makes `spec-146-phase-11-production-wiring.test.ts` fail — which
the issue says is intended, so it is updated here rather than discovered later.

#### Files to Create / Modify

#### `observedAt` means subscription liveness, not last change

The first draft said the freshness windows should be "derived from the subscription's own update
cadence". **That is wrong and opencode caught it**: `orchestration.subscribeThread` is an event
stream with no cadence, so a session that is genuinely idle emits nothing, and a window derived
from event arrival would mark a live idle session `stale` — inventing exactly the wrong answer.

So `observedAt` is stamped from **subscription liveness**: the `synchronized` marker and every
subsequent event bump it, and while a subscription is open and healthy the entry stays
`available` however quiet the session is. An entry begins ageing only when its subscription
**drops**, and ages from the drop. `stale` therefore means "I am no longer watching this", which
is a fact this process actually holds, rather than "nothing has happened lately", which is not
evidence of anything. The windows key off the existing resubscribe helper's backoff, which is
an observable rather than a guess.

#### The maintainer owns every side effect

The synchronous snapshot **never** calls `requestThreadBackend()`. That function kicks off a
connect and performs a five-layer config read on every call (`thread-backend.ts:460`, `:485`),
which on a request path is per-request file I/O against the spec's own non-functional criterion.
The background maintainer calls it on its own timer and stamps the answer into the cache; the
snapshot reads the stamp.

The maintainer also **rescans `global.db`'s `thread_id` columns on that timer**, subscribing to
threads that have appeared since start and dropping the entries of threads that have gone. A
maintainer that reads the thread set once at boot goes permanently blind to every builder
spawned afterwards.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/t3code-session-cache.ts` — **new.** A per-workspace
  cache keyed by `canonicalWorkspaceKey`, holding per-thread session status, settledness and
  `observedAt`; the background maintainer described above; and a synchronous
  `snapshot(workspacePath)` that reads the cache and the stamped connector answer.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — pass `t3codeSnapshot`, and start
  and stop the maintainer with the rest of the boot sequence.
- `packages/codev/src/agent-farm/__tests__/spec-146-phase-11-production-wiring.test.ts` —
  **updated in place, not deleted, in two places, not one.** The source-reading assertion at
  line 101 inverts to "the call passes a provider". The published-field assertion at line 128,
  `expect(snapshot.t3code).toBe('not-provided')`, becomes the no-provider case explicitly
  (`readThreadRegistry` called with no snapshot argument still reports `not-provided`), so the
  case that a host wiring nothing still degrades honestly stays covered. Both messages say what
  the wiring now guarantees and what it still does not — a terminal-backed row has no thread
  and therefore no session state.
- `apps/client/README.md` — the "Known gap: session state" section becomes a record of what is
  now wired and what remains bounded by rows having no threads.

#### Deliverables

- [ ] The snapshot function is synchronous, performs no network call, no filesystem read and
      never awaits.
- [ ] A workspace with no `threads` block causes no connection attempt and reports
      `not-configured`.
- [ ] The connector's `connecting`, `cooling-down` and `misconfigured` reach the wire as
      themselves and are not collapsed into `unreachable`.
- [ ] The thread set comes from `global.db`'s `thread_id` columns, because the contract has no
      thread listing — recorded in the module header so the next reader does not go looking for
      one — and it is **rescanned on the maintainer's timer**, not read once at boot.
- [ ] `observedAt` tracks subscription liveness; an idle-but-watched session stays `available`.
- [ ] A subscription that drops starts the entry ageing from the drop, is re-established by the
      existing resubscribe helper, and does not freeze as fresh.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criteria 1, 3, 6.
- [ ] The production wiring test asserts the provider is passed and carries a message a future
      reader can act on.
- [ ] No new blocking call on any request path: a test drives the snapshot against a workspace
      whose backend is mid-connect and asserts it returns immediately.
- [ ] Build and tests pass.

#### Test Plan

Unit against a driven fake backend: a watched-but-silent session stays `available`; a dropped
subscription ages into `stale` with the age; a discarded entry falls back to reachability alone.
Connector states pass through individually. A workspace with no config starts nothing —
asserted by observing that no connect was attempted, not by observing the status alone. A thread
that appears in `global.db` after start is picked up on the next maintainer pass, and one that
disappears has its entry dropped.

Integration: build a snapshot through `buildAgentProtocolSnapshot` with the provider installed
and assert `protocol.t3code` and per-row `sessionState`.

**Stated limit, not a gap to hide:** no thread-configured workspace exists on this machine, so
criterion 3 is verified against the generated contract and a driven fake. The review records
that distinction rather than implying a live run.

### Phase 3: `afx pair issue/list/revoke`

**Dependencies**: None

#### Objective

The operator entry point. After this phase a person can mint a token for either ceremony, see
what is outstanding, and — the point of the issue — revoke a machine while holding nothing.

Placed before the approval phases so that phases 5 and 6 can be driven by hand through the real
operator path, rather than being verified only by tests that construct their own credentials.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/pair.ts` — **new.** `issue`, `list`, `revoke`, each a
  direct store operation through `PairingStore`, `MachineCredentialStore` and
  `ApprovalCapabilityStore`.
- `packages/codev/src/agent-farm/cli.ts` — a `pair` command group beside `inbox` and `cron`.
- `packages/codev/src/agent-farm/__tests__/` — a new test file for the command surface.

#### Deliverables

- [ ] `afx pair issue --purpose <machine-credential|client-session> --authority <text>` prints
      the token exactly once to stdout. `purpose` is **required with no default**; an absent or
      unrecognised value is refused at issue time with a message naming the two valid values.
- [ ] **The `--authority` flag is optional; the recorded value is required and never empty.**
      The first draft said "required and defaulting", which opencode correctly read as two
      rules that cancel. Omitting the flag records a fixed string naming the command and the
      invoking OS account, which claims **no** verified human presence. Passing `--authority ''`
      is refused rather than silently replaced, because an operator who tried to say something
      and said nothing is not the same as one who did not try.
- [ ] The token never reaches a log, a file the command writes, or argv.
- [ ] `afx pair list` reports outstanding, redeemed, expired and revoked pairing tokens and
      paired machines, printing no secret and no verifier.
- [ ] `afx pair revoke <machine>` writes both the machine-credential tombstone and the approval
      capability revocations, and works with no credential present and with Tower not running.
      The two results are reported **as the two shapes they actually are** —
      `MachineCredentialStore.revoke` answers a boolean (was there a live credential to revoke)
      and `ApprovalCapabilityStore.revokeMachine` answers a count — not collapsed into one
      number or one boolean.
- [ ] A machine with nothing live reports that as its own answer, not as an error.
- [ ] An unparseable store reports the unreadable code from every subcommand, never "no such
      machine".
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criteria 12, 12b, 13, 14, 15, 18.
- [ ] A `client-session` token minted by the command opens a human session — driven, not
      asserted, so the link to criterion 7 is real before the approval phases rely on it.
- [ ] A token refused at the wrong ceremony is **not consumed** and still works at its own.
- [ ] `agent-approval-path.test.ts`'s residual assertion still passes.
- [ ] Every test drives a scratch store under `CODEV_AGENT_FARM_DIR`. Nothing touches the
      operator's real `~/.agent-farm`.
- [ ] Build and tests pass.

#### Test Plan

Unit against a scratch store root. Assert the token's absence over the **whole captured output
stream**, not over a known variable — the leak this guards against is the one nobody remembered
to redact. Drive both purposes and the cross-ceremony refusal. Drive revoke with no credential
and with no server, then assert a subsequent verify fails closed with
`MACHINE_CREDENTIAL_REVOKED` while a second machine still verifies.

### Phase 4: Durable approval operation store

**Dependencies**: None

#### Objective

Somewhere for an approval to live that outlasts the request, and outlasts Tower. Store and its
state machine only — no routes yet, so the phase is testable on its own and the route phase
does not have to debug two new things at once.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/approval-operations.ts` — **new.** File-backed beside the
  capability and nonce stores under the agent-farm approval root, honouring
  `CODEV_AGENT_FARM_DIR`, written through `writeJsonAtomic` under `withStoreLock`.
- `packages/codev/src/agent-farm/servers/agent-failure.ts` — register the new signals.
- `packages/codev/src/agent-farm/__tests__/` — a new test file.

#### Deliverables

- [ ] Six states: `submitted`, `running`, `succeeded`, `refused`, `failed`, `interrupted` —
      each distinct, each carrying its reason where one exists. `running` carries the phase and
      the check set being run, so an operator knows what they are waiting for.
- [ ] `succeeded` carries porch's **persisted** record — machine, session, approved-at,
      authority. No field is manufactured by the store.
- [ ] Each record names its **owner** — host and pid — and the startup resolution pass resolves
      only records this host owns whose owning process is gone. The store is keyed by
      `CODEV_AGENT_FARM_DIR`, not by host, so an unscoped pass would let a second host starting
      against a shared root mark a *live* host's operations `interrupted` — reporting a running
      approval as dead, which is the same class of wrong answer this store exists to prevent.
      Records owned by a live process, on this host or another, are left alone.
- [ ] A startup resolution pass moves every `submitted` and `running` record **it owns** to
      `interrupted` **before** the surface can answer a poll, so "running forever" is
      unreachable rather than unlikely.
- [ ] `interrupted` carries what `status.yaml` says about that gate now, including the case
      where it is in fact approved — which must not read as a failure.
- [ ] A retention sweep on the pairing-tombstone pattern.
- [ ] A store that exists and will not parse reports its own unreadable code, never "unknown
      operation".
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criteria 8, 10, 19.
- [ ] Every new signal is registered in the failure matrix collector and is distinct from every
      existing code.
- [ ] Build and tests pass.

#### Test Plan

Unit. Drive each state transition. Construct a store containing a `running` record, run the
resolution pass, and assert `interrupted` plus the `status.yaml` reading — in both the
gate-approved and gate-unapproved cases, because reporting the first as a failure is the
specific defect this exists to prevent. Assert that a record owned by a **live** process is left
untouched by the pass. Assert retention sweeps and the unreadable path.

### Phase 5: Asynchronous gate approval routes

**Dependencies**: Phase 4

#### Objective

Approving a gate from a client on an ordinary project. Submit returns immediately; porch runs
the phase checks in the background; a poll route reports what is happening.

The existing synchronous route keeps `refuseIfChecksWouldRun: true` and keeps refusing. Nothing
that works today changes behaviour.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/agent-auth.ts` — two route-table entries, both
  `human-session`, with rationale strings saying why.
- `packages/codev/src/agent-farm/servers/agent-routes.ts` — the submit handler (creates the
  operation, starts the work, returns the operation identity) and the poll handler; the startup
  resolution call from `initAgentRoutes`. **The new handlers are named `handleApprovalSubmit`
  and `handleApprovalOperation`**, deliberately not sharing a prefix with `handleGateApprove`:
  `spec-146-phase-11-approval-writes.test.ts:138` slices source from
  `indexOf('function handleGateApprove')`, so any name beginning with that string — including
  `handleGateApprovalStatus` — placed earlier in the file would capture the match and fail that
  test against the wrong function, which reads as a regression in code that is fine.
- `packages/codev/src/agent-farm/__tests__/agent-auth.test.ts` — the route enumeration, which
  **is expected to change** because the table gained entries.
- `packages/codev/src/agent-farm/__tests__/` — a new test file for the async path.

#### Deliverables

- [ ] Submitting an approval for a project whose phase declares checks returns promptly with an
      operation identity, and the gate is not approved at that moment.
- [ ] The background run calls porch's `approve()` **without** `refuseIfChecksWouldRun`, with
      the same deliberately minimal environment the synchronous path uses, and with
      `onRefusal: 'throw'` — a refusal must never become `process.exit(1)` inside Tower.
- [ ] Terminal reports come from what porch persisted; an already-approved gate reports the
      approval that exists, including when it is somebody else's.
- [ ] The capability is checked against the requesting session **before** an operation is
      created, so a wrong-session capability never creates a record.
- [ ] **The concurrency bound, pinned rather than gestured at.** Two limits, both refused at
      **submit time** with their own signals — not a seventh operation state and not a queue,
      because a queue turns "I will not start this" into "this is running", which is the
      conflation the whole spec is organised against:
      - **Single-flight per (workspace, project)**: a second submit while one is in flight is
        refused with `APPROVAL_ALREADY_IN_FLIGHT`, naming the operation id already running so
        the caller can poll it instead of resubmitting.
      - **A workspace-wide cap of 2 concurrent check runs**, refused with
        `APPROVAL_CONCURRENCY_LIMIT`. The number is small on purpose: each running operation is
        a full repository build and test suite in Tower's process, and Tower is also serving
        every other workspace. It is configurable, and the default is stated with that reason.
- [ ] The nonce is spent by porch exactly as it is on the synchronous path; two concurrent
      submissions for one project and gate do not both spend one, and the loser says so
      distinguishably.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criteria 7, 8, 9, 11.
- [ ] The synchronous route still refuses with `PHASE_CHECKS_REQUIRED`, asserted rather than
      assumed.
- [ ] The route enumeration covers both new routes, and the source-reading check for route
      literals the table has missed still passes.
- [ ] Build and tests pass.

#### Test Plan

Integration against a scratch workspace with a real `status.yaml` and a check set that passes,
and a second that fails. Submit, poll to terminal, assert the persisted record. Drive the
already-approved path with a second session and assert the other party's machine and session
are reported. Drive the wrong-session capability and assert no operation record was created.
Drive the concurrency bound.

Manual: drive one gate end to end through the routes using a `client-session` token minted by
phase 3's command, and record what was run.

### Phase 6: Client submits and polls an approval

**Dependencies**: Phase 5

#### Objective

The operator experience the previous two phases exist for: approve from the client, watch it
run, and read a result that came from `status.yaml`.

#### Files to Create / Modify

- `apps/client/src/gate/approval.ts` — submit-then-poll.
- `apps/client/src/gate/GatePanel.tsx` — the running state, with what is being run.
- `apps/client/__tests__/approval.test.ts`, `apps/client/__tests__/GatePanel.test.tsx`.
- `apps/client/e2e/two-machines.spec.ts` — **named because this phase breaks it, and it is the
  criterion 11 tripwire.** The test at line 235, *"refuses, rather than running a build inside
  the request, when the phase has checks"*, clicks Approve on a checks-enabled stand and asserts
  `.gate-result.is-refused` carries `PHASE_CHECKS_REQUIRED` with the gate still pending. The
  moment the panel submits to the async route it goes red, and its comment reads exactly like an
  inconvenient check to delete. **It is not deleted.** It splits in two: the refusal case drives
  the synchronous route directly, so criterion 11's guarantee keeps an end-to-end assertion; a
  new case drives the same checks-enabled stand through the UI and asserts the running-then-
  succeeded path, which is criterion 7's.

#### Deliverables

- [ ] The panel submits, shows a running state naming the phase and check set, and reports the
      terminal outcome.
- [ ] Each of the six operation states renders distinguishably. `interrupted` renders as
      interrupted with what `status.yaml` says — never as a failure and never as a success.
- [ ] The client continues to refuse a response it cannot read rather than filling gaps from
      local state.
- [ ] A poll that cannot reach the server is distinguishable from an operation that failed.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Spec criterion 7 end to end from the client, and criterion 8's states all rendered.
- [ ] Criterion 11 still has an end-to-end assertion after the e2e split — verified by running
      that case, not by asserting it exists.
- [ ] No status word is invented client-side; every terminal report traces to a server field.
- [ ] Build and tests pass.

#### Test Plan

Component tests driving each operation state through the panel. A test asserting that an
unreadable poll response produces a refusal rather than a rendered guess.

### Phase 7: Threat model, failure matrix, and the dev-check revocation

**Dependencies**: Phase 3 (the command it documents), Phase 4 (the signals it tabulates),
Phase 5 (the route rationale it reconciles)

#### Objective

Make the repository's documents agree with its code, and perform the one operator action the
issue names. This is last because the threat model should describe a shipped command, not a
planned one.

#### Files to Create / Modify

- `codev/resources/146-approval-threat-model.md` — the revocation trade.
- `packages/codev/src/agent-farm/servers/agent-auth.ts` — the `rationale` strings on
  `machine-credential-revoke` and `approval-capability-revoke-machine`.
- `codev/resources/146-codev-agent-failure-matrix.md` — rows for the new signals.
- `codev/reviews/236-spec-146-production-t3code-sna.md` — the record of the manual revocation.

#### Deliverables

- [ ] The threat model answers the **availability** objection specifically: the route table
      privileges revocation because an agent that could revoke could deny a human their gate,
      and the honest answer is that a same-UID agent can already write, delete or corrupt these
      stores — the command makes that denial convenient, not possible — against a status quo in
      which the human cannot revoke and the agent still can.
- [ ] Both route `rationale` strings are reconciled with the shipped command, so the repository
      does not assert the opposite of its own behaviour in two places.
- [ ] The failure matrix carries every new signal with its client rendering and its
      auto-resolution answer.
- [ ] `dev-check` is revoked using `afx pair revoke`, **once, by hand**, and the review records
      the command and its output. It writes the real `~/.agent-farm/machines/`, outside
      `CODEV_AGENT_FARM_DIR`, and `revoke()` is not idempotent, so this is **not** a suite step.
      The recovery — re-pair that machine — is named for a reader who needs the credential back.
- [ ] `apps/client/README.md`'s account of both gaps matches what now ships.

#### Acceptance Criteria

- [ ] Spec criteria 16, 17, 19.
- [ ] Every claim added to the threat model is one the code makes true — the rule that document
      holds itself to, and the rule that falsified three of its earlier revisions.
- [ ] Build and tests pass.

#### Test Plan

No new automated tests; this phase is documentation plus one recorded manual action. The
existing threat-model residual test (`agent-approval-path.test.ts`) must still pass, and the
review states which criteria were verified live and which against a fake.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Phase 2 lands before phase 1 and Tower emits statuses the client blanks the machine on | Low | High | Phase order is the mitigation, and phase 1 declares it explicitly; phase 2 depends on phase 1 |
| The phase-11 wiring test is deleted rather than updated | Medium | High — it is the tripwire on a stated gap | Phase 2 names the file as *updated in place*, with a required message about what the wiring now guarantees |
| A red validator test in phase 1 is "fixed" by loosening the allow-list | Medium | High | Spec criterion 5b states fail-closed as intended; phase 1's acceptance names the allow-list as the thing that stays strict |
| Criterion 3 is ticked on a driven fake and read as a live verification | Medium | Medium | Phase 2's test plan states the limit; phase 7's review records which criteria were live and which were not |
| A background approval throws out of a promise and Tower's `unhandledRejection` handler exits the process | Medium | High | Phase 5 requires `onRefusal: 'throw'` plus the existing route-failure guard around every async body; the store records `failed` rather than the process ending |
| N concurrent approvals each spawn a full check set from Tower | Medium | Medium | Phase 5 delivers a concurrency bound whose refusal is its own state |
| Phase 3 ships minting only one purpose, leaving criterion 9b unreachable | Medium | High | Phase 3's acceptance requires a `client-session` token to open a real session, driven |
| The `dev-check` revocation is automated and CI revokes real credentials | Low | High | Phase 7 names it a manual one-time action and scopes every phase-3 test to `CODEV_AGENT_FARM_DIR` |
| Tower opens t3 connections it did not before and one bad server degrades it | Low | Medium | Phase 2 reuses the existing per-workspace connector, its keying and its failure cooldown; no connect is ever awaited on a request path |
| Scope drifts into issue #234's static mount or tiling | Medium | Medium | No phase touches client layout; the spec names it out of scope |
| The wire cannot carry `observedAt` or settledness, making criteria 3 and 4 unimplementable | Was certain in the first draft | High | Phase 1 pins the wire shape: `t3code` stays a string, `t3codeObservation` is a sibling, `ThreadIdentity.session` is structured, and `readThreadRegistry` attaches on `stale` |
| A newer client rejects an older server as `unreadable` on a version skew nobody decided | Medium | High | The sibling-field shape keeps the older-server direction validating; only the direction criterion 5b already decided fails closed |
| The `two-machines.spec.ts:235` refusal e2e is deleted as inconvenient when phase 6 reddens it | Medium | High — it is criterion 11's only end-to-end assertion | Named in phase 6's file list with what it becomes, and phase 6's acceptance requires running the split case rather than asserting it exists |
| A `handleGateApprove`-prefixed handler name breaks `approval-writes.test.ts:138`'s source slice against the wrong function | Medium | Medium | Phase 5 fixes the two handler names to share no prefix |
| A second host on a shared `CODEV_AGENT_FARM_DIR` marks a live host's operations `interrupted` | Low | High — it reports a running approval as dead | Phase 4 records host and pid on each record and scopes the resolution pass to records this host owns whose process is gone |
| Freshness derived from event cadence marks an idle-but-live session `stale` | Was certain in the first draft | Medium | Phase 2 stamps `observedAt` from subscription liveness, so ageing begins at a drop rather than at a silence |
| The maintainer reads the thread set once and goes blind to every builder spawned afterwards | Medium | High | Phase 2 requires a rescan of `global.db`'s `thread_id` columns on the maintainer's timer |
| `requestThreadBackend` on the snapshot path adds per-request file I/O and a connect side effect | Medium | Medium | Phase 2 puts every side effect in the maintainer; the snapshot reads a stamp |

## Documentation Updates

- `codev/resources/146-approval-threat-model.md` — the revocation trade and the availability
  argument (phase 7).
- `codev/resources/146-codev-agent-failure-matrix.md` — rows for the new signals (phase 4
  registers them, phase 7 documents them).
- `apps/client/README.md` — the "Known gap: session state" section and the phase-12 note about
  asynchronous approval (phases 2 and 7).
- `packages/codev/src/agent-farm/servers/agent-auth.ts` — route `rationale` strings, which are
  operator-facing documentation living in code (phases 5 and 7).
- `codev/reviews/236-spec-146-production-t3code-sna.md` — what was verified live versus against
  a fake, and the record of the manual `dev-check` revocation.
- No arch/lessons update is proposed from this plan; whether one is warranted is a review-phase
  judgement, not a plan-phase assumption.
