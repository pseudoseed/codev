### Iteration 1 Reviews
- claude: REQUEST_CHANGES — Gate mechanism and revision semantics are correct; three failure-reason defects in the contract and ws handler should be fixed before phase 5 vendors them.
- opencode: REQUEST_CHANGES — Engine still rewrites CodevGateWriteError, so criterion 10 is false at the wire; gate-write credential is never issued.

### Builder Response to Iteration 1
# Spec 250, phase_4, iteration 1 — review responses

Both lanes REQUEST_CHANGES. Eight findings, all accepted, none disputed. Both lanes independently
found the blocking one, and it is the same defect as phase 3's in the same function.

---

## BLOCKING — the engine deleted gate refusals — ACCEPTED

> `isRefusal` does not include `CodevGateWriteError`, so criterion 10 is false at the wire.

Correct, and this is the sharpest thing in the round. Phase 3 fixed `isRefusal` once, for
`CodevHierarchyInvalidError`. Phase 4 added a **third** refusal type and did not extend it. So every
gate refusal — including the stale write that *is* criterion 10 — was rewritten as
`"Failed to generate an event identifier"` and persisted onto the rejected receipt.

**All eleven decider tests stayed green throughout**, because they call the decider directly. The
same lesson as phase 3, and I still walked into it: *adding a refusal type without adding it to
`isRefusal` is now the same mistake three times.*

**Fixed.** `isRefusal` covers all three; `CodevGateWriteError` added to `OrchestrationDispatchError`.
An engine-level test asserts the stale write arrives carrying `CODEV_GATE_REVISION_STALE`, and
**verified to discriminate**: with `isRefusal` reverted it fails, restored it passes.

## "Could not tell" shared a spelling with "no" — ACCEPTED

> `ws.ts` returns `CODEV_GATE_THREAD_NOT_FOUND` for a committed-but-unconfirmed write.

Correct, and the lane's second pass sharpened it into the more serious version: **this is the
routine retry path, not a rare defensive one.** An idempotent replay of the same `commandId` commits
nothing, returns an empty event array, and lands there *every time*. A normal retry was being
reported to the caller as a nonexistent thread.

**Fixed.** `CODEV_GATE_WRITE_UNCONFIRMED`, with a message that says explicitly: do not assume it
applied, do not assume it did not, re-read the thread.

## Every unexpected cause was relabelled as a missing thread — ACCEPTED

**Fixed.** `CODEV_GATE_WRITE_FAILED` for database and decode failures. Relabelling those as a
missing thread sends someone to look for a thread that is there, and hides a broken database behind
what reads like ordinary caller error.

## `CODEV_GATE_SCOPE_REQUIRED` was declared and never constructed — ACCEPTED, dropped

Both lanes: emit it or drop it. **Dropped.** The real refusal is `EnvironmentAuthorizationError`
carrying `requiredScope: "codev:gate-write"`, raised by the transport before the handler runs — and
that is already distinguishable from a 401 and from any other scope failure. A second refusal path
for a case the transport already blocks would be unreachable code that only a test bypassing
production could reach.

### And the same defect one place further, which the fix surfaced

`CODEV_GATE_THREAD_NOT_FOUND` was *also* declared and never constructed: a missing thread went
through `requireThread`, which raises the generic invariant error. The gate RPC declares its error
as `CodevGateWriteError`, so the declared error type was a lie for the commonest failure.

Found by **tightening a test**, not by reading: replacing `expect(_tag).toBe("Failure")` with an
assertion on the reason failed immediately. Now the decider raises the declared error.

## Two of my own tests asserted nothing — ACCEPTED

> Assertions guarded behind `if (events[0]?.type === ...)` with nothing outside; the
> thread-not-found test asserts only `_tag === "Failure"`.

Both correct. The guarded form passes vacuously when the type is wrong — the test reports success by
asserting nothing at all. This is the **third** time this round of reviews has caught me writing a
test that cannot fail.

**Fixed.** `gateSetPayload` / `gateClearedPayload` assert the event type and return the payload, so
a wrong type fails there. The thread-not-found test now asserts the reason.

## THE FINDING THAT MATTERS MOST — no projector coverage — ACCEPTED

> No test asserts the projector or pipeline applies either gate event. A projector that dropped
> `gateRevision` would pass all 11 decider tests while every write after the first re-allocated
> revision 1.

This is the best finding of the round and the lane is exactly right about why: every decider test
**hand-builds its read model**, so they cannot see a projector that forgets the mark. And a
forgotten mark is not a cosmetic bug — it is the precise failure the revision mechanism exists to
prevent, invisible to the suite that was meant to protect it.

**Fixed.** Six projector tests, including one that plays set → clear → set and asserts the mark is
3 rather than 1. **Verified to discriminate**: with `gateRevision` dropped from the projector, two
of the six fail.

## The OAuth token allowlist exclusion was unasserted — ACCEPTED

The scope is excluded from three places and only two were tested. `AuthStandardClientScopes` governs
what a client is *issued*; the `auth/http.ts` allowlist governs what a client may *ask for*. Excluded
from the first and present in the second is not excluded at all.

**Fixed.** Asserted against the source, because the list is an inline literal with no exported value
— which is itself worth noting: an allowlist nobody can read from a test is an allowlist nobody can
check.

## The single credential was never named — ACCEPTED

`apps/server/src/codev/gateCredential.ts` names both halves the plan asked for: the issuance API
(`EnvironmentAuth.issueSession`, upstream's own, not a new mechanism) and the on-disk path
(`<baseDir>/codev/gate-writer.token`, mode `0600`).

It holds `orchestration:read` + `codev:gate-write` and deliberately **not** `orchestration:operate`:
`codev-agent` publishes gate state, it does not create threads or drive turns. Granting operate
would make this credential a superset of an ordinary client's and remove the point of separating
them. The scope set is asserted as a *set*, not a containment check, because a containment check
passes while the credential quietly grows.

The token is written to a temp file and renamed, so a reader never sees a half-written token — a
truncated bearer token fails authentication in a way that looks like revocation.

---

## Not changed

Nothing. No finding in this round was a false positive.

## Verification after the fixes

- Fork `3d0e76776cd9`, pushed. Fork typecheck green; contracts **304 passed**; server
  **2832 passed, 8 skipped**, 1 pre-existing.
- Three regression tests verified to fail when their mechanism is removed: the engine's `isRefusal`,
  the projector's mark, and the wire-level decoding default.
- `server.test.ts > routes websocket rpc server.upsertKeybinding` failed once under the full
  parallel run and passes in isolation and on re-run. Recorded as flaky, not fixed; likely the same
  shared-resource class as issue #263.


### Iteration 2 Reviews
- claude: APPROVE — Phase 4 delivers the gate block, server-allocated revision, isolated scope and RPC method; all 8 iteration-1 findings fixed with discriminating tests verified.
- opencode: REQUEST_CHANGES — Gate revision and scope machinery is in; the single codev:gate-write credential is still never provisioned at server start.

### Builder Response to Iteration 2
# Spec 250, phase_4, iteration 2 — review responses

claude APPROVE, opencode REQUEST_CHANGES. They agree on the substance: the same single gap, which
opencode treated as blocking and claude as carry-forward. **Treated as blocking**, because the plan
says the credential is *"provisioned out of band **at server start**"* — that makes it phase 4's
work, not the consumer's phase.

---

## The credential had no production caller — ACCEPTED, and it is costume one again

> `writeCodevGateWriterToken` has no production caller — the credential is named and tested but
> nothing issues it at server start.

Correct, and it is worth naming precisely what happened. `gateCredential.ts` named the scopes, named
the on-disk path, and tested the write. Nothing in the server ever called any of it.

That is **costume one from this very phase's review** — "a thing tested in isolation that production
never builds" — produced in the same phase that added the hot-tier lesson about it, one commit after
writing the four-costume table. The module's own tests were all green and all meaningless for the
question that mattered.

**Fixed.** `provisionCodevGateWriter` runs as a named startup phase,
`"codev.gate-writer.provision"`, handed the server's own `baseDir` and
`EnvironmentAuth.issueSession`.

Two decisions inside it, both stated rather than left implicit:

- **Non-fatal.** A server that cannot write the token is still a working server for every other
  client, and failing the whole boot over `codev-agent`'s credential would take the UI down with it.
  It logs `CODEV_GATE_WRITER_PROVISION_FAILED` so the failure is not met later as an unexplained
  authorization error.
- **Idempotent by rotation, not by lookup.** A fresh session each start, file overwritten. Reusing
  an existing token would mean reading a bearer credential back off disk to decide whether to keep
  it, and a server that reads tokens is a larger target than one that only writes them. A stale
  session expires on its own TTL.

**The test asserts against the production source**, because "production calls this" is a fact about
the call site and not about the module. Verified to discriminate: removing the startup phase fails
it.

## The map row was asserted, the enforcement was not — ACCEPTED

> No test asserts the wire-level refusal for a caller holding only `orchestration:operate`; the map
> row is asserted but not the enforcement.

Correct, and the same shape one layer down: **a row nothing reads documents an intention.** The row
is only load-bearing if `requiredScopeForRpcMethod` is on the path every RPC takes.

**Fixed.** Asserts `ws.ts` routes through it on **both** wrappers — a method registered as a stream
would otherwise slip past the effect-only one — and that the gate handler is registered through the
instrumented wrapper rather than bare. Plus: an unmapped method **throws** rather than defaulting to
something permissive, which is the failure direction that matters for a new RPC.

## Source-string assertions are brittle to reformatting — ACKNOWLEDGED, not changed

Fair, and already mitigated the way the lane notes: every one carries an existence guard and a
positive control, so a moved or renamed target fails loudly rather than passing vacuously.

Not changed because the alternative is worse. Three of these assert **absences** — a command not in
a union, a scope not in an allowlist, a call site that must exist — and an absence has no runtime
value to inspect. A brittle test that fails when the code moves is a maintenance cost; no test at
all is how all four costumes shipped.

---

## Not changed

Only the brittleness note above, with reasons. Neither other finding was a false positive.

## Verification after the fixes

- Fork `0254c84e1241`, pushed. Fork typecheck green; server **2839 passed, 8 skipped**, 1
  pre-existing.
- Four regression tests in phase 4 verified by removing their mechanism and watching the specific
  test go red: `isRefusal`, the projector's mark, the wire decoding default, and now the startup
  provisioning.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
