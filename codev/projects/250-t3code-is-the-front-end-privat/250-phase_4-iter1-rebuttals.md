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
