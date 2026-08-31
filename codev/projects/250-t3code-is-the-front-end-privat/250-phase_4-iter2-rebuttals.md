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
