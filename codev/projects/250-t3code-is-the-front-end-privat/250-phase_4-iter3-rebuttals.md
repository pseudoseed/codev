# Spec 250, phase_4, iteration 3 — review responses

**Both lanes APPROVE.** opencode: KEY_ISSUES none. claude: APPROVE with three non-blocking
findings. All three fixed here rather than filed, because the ruling on this project is that
structural fixes are in-phase — a follow-up issue is a promise to hit it again.

Fork `51b55d4899e4`, pushed.

---

## `OrchestrationRefusal` kept a second copy of the refusal list — ACCEPTED

> `OrchestrationRefusal` hand-lists the same three tags `dispatchErrorKind` now owns. Classifying
> a fourth refusal in the switch without touching the Extract narrows to the wrong type.

Correct, and it is the same shape as the bug the switch was added to kill, one line below it.
Runtime would have stayed right while the type quietly lied — which is worse than the original,
because the compile-time mechanism I had just installed would have been sitting there looking
like it covered this.

**Fixed by making the classification data instead of control flow.** `DISPATCH_ERROR_KIND` is a
table under `as const satisfies { readonly [K in OrchestrationDispatchError["_tag"]]: ... }`:
a missing member is a missing key, an extra one is an excess property. `OrchestrationRefusal` is
derived from the table's literal values, so there is nothing left to forget to update.

Verified both directions:

- delete the `CodevGateWriteError` row → `TS2741: Property 'CodevGateWriteError' is missing`,
  naming the tag;
- flip it to `"internal"` → 2 engine tests go red, including the one asserting the stale write
  reaches the dispatcher still carrying `CodevGateWriteError`.

The `?? "internal"` on the lookup is kept and is load-bearing at runtime even though the index
signature is total: `isRefusal` reaches it with an `unknown` cause it has only shape-checked. The
existing test feeding it `_tag: "SomethingFromTheFuture"` covers that path.

## The doc comment documented a reason that cannot arrive — ACCEPTED

> The comment above `CodevGateWriteErrorReason` still says "Three causes" and documents
> `CODEV_GATE_SCOPE_REQUIRED`, dropped from the union.

Correct, and the lane names the cost precisely: a phase 6/8 consumer reads that comment and
writes a branch for a reason no server will ever send. A stale comment on a wire type is not
cosmetic — it is a contract that disagrees with itself, and the reader has no way to know which
half is current.

**Fixed.** The comment now says four, and says why the scope case is *not* one of them: it is
refused by the transport as `EnvironmentAuthorizationError` with
`requiredScope: "codev:gate-write"`, before the handler runs. Written as an instruction not to
add it back, since "there is no reason for the scope case" invites exactly that.

## The source assertion was brittle to reformatting — ACCEPTED

Raised in iteration 2 as well; I acknowledged it and did not change it. The lane's iteration-3
version is narrower and it is right: this particular one asserted **exact indentation**, and the
fact under test is only "gateWrite is the first argument to `observeRpcEffect`".

**Fixed** with a whitespace-tolerant regex. Verified both directions, because a laxer assertion
has to be shown still able to fail:

- register the gate handler bare → fails;
- collapse the call to one line → passes (10 passed).

The three assertions that check **absences** are unchanged, for the reason given in iteration 2:
an absence has no runtime value to inspect, and each carries a positive control.

---

## Not changed

Nothing. No finding in this round was a false positive.

## Verification

- Fork `51b55d4899e4`, pushed. Typecheck green (contracts + server).
- Server suite **2839 passed, 8 skipped, 1 failed** — `entrypoint.test.ts > matches through a
  symlinked entrypoint`, pre-existing, unmodified, byte-identical to the base commit. Same counts
  as iteration 2.
- `250-criterion-8b-evidence.json` regenerated at the new fork HEAD; `passed: true`, and the
  harness re-verified upstream clean at `082e6ea52186`.
- Four discrimination checks run for the three fixes (missing key, flipped classification, bare
  registration, reformat tolerance).
