# Spec 146, Phase 5, iteration 2 — responses to the review

Both lanes **REQUEST_CHANGES**. **Nothing disputed; every finding accepted and fixed.**
Neither lane wrote to the tree, and claude verified and stated that explicitly, citing
the voided iteration-1 verdict.

## claude — the builder→porch join could never resolve in production

**This is the most consequential defect of the phase, and it reached `main` green.**

`statusForWorktree` resolved only when a worktree held exactly one `status.yaml`. A
real builder worktree in this repo holds **302** project directories; `main` holds
303. So the join did not fail *sometimes* — it **could never succeed at any point in
its life**. Every thread-backed builder was reported `THREAD_UNMANAGED`, and
`THREAD_ID_DISAGREEMENT` sat behind a record that was never resolved, making the
phase's own reconciliation acceptance criterion **unreachable code**.

Claude verified it by execution rather than by reading, which is why it found what
three review rounds had not.

**Fixed in two parts.**

1. **`thread_id` is the designed join and is now tried first.** Phase 8 is its first
   writer, so it finds nothing until then — which is honest, not a stub.
2. **The ambiguous case gets its own signal.** Several candidates with none naming
   the thread means the managing record is **unknown**; `THREAD_UNMANAGED` asserts
   nothing manages it. Two different facts with different remedies, so
   `PORCH_JOIN_AMBIGUOUS` is a matrix row rather than a reused word — which is the
   distinction this whole phase exists to preserve.

The single-project fallback stays, for worktrees that genuinely hold one.

**Why the tests missed it, which matters more than the fix.** They passed *because
their fixtures shared the code's false premise*: one project per worktree, the exact
shape that made the bug invisible. The basis was a comment — *"A builder worktree
normally owns one project"* — that nothing ever checked.

New fixtures use **multi**-project worktrees, and the verified count is written into
the test so a future fixture cannot quietly contradict it. The rule is recorded in
`146-phase_5-iter1-rebuttals.md`: **when a fixture encodes a claim about production
shape, verify it against a real instance once and put the number in the test.**

Both halves are mutation-verified and each kills only its own test: disable the
`thread_id` join and the resolves-by-thread_id test fails; collapse the ambiguity
branch and the `AMBIGUOUS` test fails.

## claude — my guard matched single-quoted literals only

`PAIRING_PRINCIPAL_REFUSED` shipped unclassified from a template literal while the
guard stayed green. **Third time that guard has been narrower than its own comment
claimed** — single-quotes only, keyed on `code:`, and first-five-lines in porch's
`checks.ts`. Every one the same mistake: encoding an assumption about the thing being
scanned, with no way to notice the assumption lapsing.

**So it was not widened a fourth time and left there.** It now asserts its own reach:
every scanned file must yield at least one code, so a file going quiet fails by name.
Verified by re-narrowing the pattern — `agent-routes.ts yielded no codes; the
collector has gone blind on it`. A guard that cannot state its reach cannot report
losing it.

## claude — the non-human principal refusal had no test

Added. It is the definition of a **human**-paired session doing its work: Phase 6
issues capabilities against this session, so a builder or architect able to pair
would make *"issuance is not reachable without a human-paired session"* untrue. The
test also asserts the human path still succeeds, so the refusal is not merely
"everything throws".

## codex — the plan's named integration tests were missing

The test plan says *"a human-paired session recognised and an unpaired one refused"*.
Only the `REVOKED` path went through the HTTP route.

**I had filed this as a known gap in my own iteration-1 record. That was wrong**, and
a reviewer reading the plan caught it. Filing a stated plan requirement as a known
gap converts a defect into a documented decision, which is the one habit that would
make the rest of this worthless.

Both added at route level and mutation-verified in each direction: a gate that always
accepts fails the two refusal tests; a gate that always refuses fails the recognised
one. Recognised and refused are a pair — "recognised" is the precondition Phase 6's
entire check rests on, and "refused" is what stops an unpaired caller reaching it.

## Not a code finding: the checks failed twice on cross-builder contention

`porch done` reported `CHECKS FAILED` twice with identical code that passed on
re-run. The second failure named its cause: *"Another Vitest run owns shared Tower
state; waiting. No test files found, exiting with code 1"* — a concurrent vitest run
in **another builder's worktree** (`.builders/bugfix-174`).

Recorded rather than retried into silence, because "it passed on retry" is not "it
works", and the first occurrence looked like a mystery flake only because porch
truncated its output to the first five lines (**#172**). I did not kill the other
builder's process.

## Receipts

- **40 tests** across `servers/`, 35 in the failure-matrix file.
- Every fix in this round mutation-verified, each killing only its own test.
- Production sources restored and confirmed unmodified after each mutation.
- Full suite via `porch done`: build 16.3 s, tests 211.8 s, both green.
