# Spec 250, phase_3, iteration 1 — review responses

Both lanes REQUEST_CHANGES. Four findings, all accepted, none disputed. Both lanes found the
blocking one independently.

---

## Blocking — the engine deleted every reason discriminant — ACCEPTED

> `OrchestrationEngine.ts:177-185` collapses `CodevHierarchyInvalidError` into a generic
> `OrchestrationCommandInvariantError` with a misleading detail; the six discriminants never reach
> a dispatcher, and the false message is persisted onto the command receipt at `:310` and replayed
> on redispatch.

Correct on every point, including the two locations and that they had to be fixed together.

The mapping passed `OrchestrationCommandInvariantError` through and rewrote everything else as
`"Failed to generate an event identifier."` — which for a hierarchy refusal is not merely lossy,
it is **false**. It then reached `:310`, where a rejected receipt records `error.message`, and that
receipt is replayed verbatim on any redispatch of the same `commandId`. So the wrong answer was not
a one-time bad log; it was the permanent answer to that command.

**The whole phase 3 deliverable was being deleted one layer above where it was tested.** Six
discriminants exist so a caller can tell a retry ("no such parent") from a caller bug ("wrong
parent role"). None of them left the decider.

**Fixed.** `isRefusal` passes both `OrchestrationCommandInvariantError` and
`CodevHierarchyInvalidError` through, at the mapping and at the receipt branch.

## Why it went unnoticed, which is the more useful half — ACCEPTED

> No test dispatches a refusal through the engine; decider-only tests bypass the wrapper.

Exactly right, and this is the same shape as phase 2's `MigrationsLive` finding: **testing the
layer below the one production uses.** All fifteen decider tests were green while the boundary
above them destroyed their subject. A discriminant that does not survive the wrapper does not
exist, and no amount of testing beneath the wrapper can say so.

**Fixed.** `OrchestrationEngine.codevHierarchy.test.ts` dispatches through the real engine and
asserts the reason arrives intact, that distinct reasons stay distinct at the boundary, and that
the rejected receipt records the real cause. It also asserts the *absence* of the false string, so
a regression is loud rather than merely different.

**Verified to discriminate rather than assumed.** With the mapping reverted to the old form, 3 of
its 4 tests fail; restored, all 4 pass. A regression test that does not fail on the regression is
the thing this project keeps getting caught by, so it was checked rather than trusted.

## Non-blocking — a test that asserted its own literals — ACCEPTED

> `decider.codevHierarchy.test.ts:277-291` asserts a locally-built Set's size and cannot detect the
> discriminant collapse it claims to guard.

Correct, and it is worse than useless: it *claimed* to guard the collapse. It built a `Set` of six
string literals and asserted `size === 6`, which proves six distinct strings are six distinct
strings. Every refusal could have collapsed onto one discriminant and it would have passed.

**Fixed.** It now dispatches all six cases and collects the reasons the decider actually returned,
asserting both the exact sequence and that the set of returned reasons has six members.

## Non-blocking — a test that asserted its own input fixture — ACCEPTED

> `decider.codevHierarchy.test.ts:354-374` asserts against its own input fixture, not against any
> decider output.

Correct. It archived a parent and then asserted on `model.threads` — the object it had just
constructed, which the decider never mutates. It would have passed whatever the decider emitted.

**Fixed.** It now asserts the decider's output: exactly one event, `thread.archived`, on the parent's
aggregate, and no event mentioning the child. That is the real property — orphaning happens by
*omission*, not by a cascade someone has to remember not to write. Whether the child stays readable
afterwards is a persistence question, and that is asserted for real in `codev/threadHierarchy.test.ts`.

## Non-blocking — `commandInvariants.test.ts` had no Codev cases — ACCEPTED

The plan listed it as extended and it was not.

**Fixed.** Five cases, including the two ordering decisions stated as tests: `parent-is-self`
reported ahead of `parent-not-found` when both hold (the fixture has both properties, so it can
only pass if the order is right), and `parent-in-other-project` rather than `parent-not-found`.
Plus: an omitted `parentThreadId` key and an explicit `null` must reach the same refusal, because a
rule that fires on only one spelling is a rule with a hole in it.

---

## Not changed

Nothing. No finding in this round was a false positive.

## Verification after the fixes

- Fork `40fb82ce92a8`, pushed. Fork typecheck green; server **2797 passed, 8 skipped**.
- 4 engine tests, 15 decider tests, 8 `commandInvariants` tests, 9 persistence tests.
- The one fork failure, `entrypoint.test.ts`'s symlink case, remains pre-existing and unrelated.
