# Spec 146, Phase 5, iteration 3 — responses to the review

Both lanes **REQUEST_CHANGES**, plus a further architect-run review on the resulting
diff. **Nothing disputed; every finding accepted and fixed.** Neither lane wrote to
the tree.

## Both lanes, independently — I moved the wall, I did not remove it

Iteration 2 keyed the builder→porch join on `thread_id`. That resolves **only when the
two stores agree**, so a genuine disagreement in a multi-project worktree found no
record and emitted `PORCH_JOIN_AMBIGUOUS` instead of `THREAD_ID_DISAGREEMENT`. The
acceptance criterion was still unreachable in production **after the fix I reported as
closing it**.

Claude verified by executing `readThreadRegistry` from `dist` rather than reading my
tests, which is how it saw past a green suite.

**Fixed:** identity now comes from the builder id, which stays true while the stores
differ. Disagreement is detectable because the record is identified *before* the
thread ids are compared.

### And the test I wrote to close the previous instance had the same defect

It was named *"and disagreement then fires"*, set `status.yaml`'s `thread_id` to
**match** the database, and asserted only `management === 'managed'`. **Fourth
instance of name-versus-assertion drift this phase, mine, inside the fix for the
third.** Both lanes flagged it.

## codex — `PORCH_RECORD_UNMAPPED` gave a false diagnosis

It said *"has no global.db identity row"* when a row can exist naming a different
thread. That does not merely fail to help: it sends an operator to **create** a row
instead of reconciling two that disagree — confidently, in the wrong direction.

**A wrong diagnosis is worse than a missing one.** The message now states what is
known and names both possibilities, pinned by a test asserting it does *not* make the
stronger claim.

## The architect's review of the resulting diff — four more, all real

All four verified against the real stores before any code changed.

1. **The `builder-` strip is load-bearing, not defensive.** All **12 of 12**
   `builders.id` rows carry the prefix, and `row.id` is exactly what
   `statusForWorktree` receives. My comment called it defensive without ever querying
   the table. **And the raw id must be tried first**, because
   `codev/projects/builder-task-nhnj-task-NHnJ` has `id: builder-task-nhnj`.
2. **No fixture used a real DB id shape.** Mine matched porch's shape but not the
   **database's** — the store this function actually reads.
3. **The decoy comment was false and the guard inert.** It claimed a decoy whose id
   was the colliding digits; the decoys were `decoy-1`/`decoy-2`, no colliding record
   was written, and the fixture passed under both orderings. Replaced with the real
   `799`/`bugfix-799` pair.
4. **Zero-padded ids exist and collide.** `0087`, `0088`, `0092`, `0120`, `0124` are
   real, and `0120` (spir) coexists with `120` (air). Digit-matching across that
   boundary resolves to the **wrong** project with a *resolved* record.

### The padding guard, and the over-correction I caught before committing

My first version refused **any** numerically-equal match — which would have stopped
the legitimate `120` builder resolving at all, trading a rare wrong answer for a
common missing one. Exact textual digits now win when present; a
numerically-equal-**only** match refuses and falls to `PORCH_JOIN_AMBIGUOUS`. The
residual case — a builder id that drops a project's padding — is stated as a **known
limit in the code**, because it would resolve wrong rather than not at all.

Task ids never reach the digits branch: `generateShortId` can be all digits, so
matching a project by it would be coincidence rather than association. That closes
the short-id hazard structurally rather than by probability.

## What actually changed the outcome

**Fixtures are generated from disk now.** Two lanes each found an id shape the other
missed, and **both had been sitting in `codev/projects` the whole time**. Neither
could have been missed by a list read off the directory.

A test classifies every real porch id, fails **naming** any shape the resolver was not
built for, asserts the scan is not vacuous, and asserts the `0120`/`120` collision
still exists so the guard against it cannot quietly stop being justified. Outside the
repo it skips honestly rather than passing a completeness claim it did not check.

**A list you type is a claim; one you read is a fact.**

## Sixth instance, and why more discipline is not the fix

Six instances this phase of one defect: **a claim about the shape of something,
asserted where it is convenient, never checked against a real instance.** A field
name, a quote style, a worktree's contents, an id convention, twice.

I wrote the rule against it two commits before breaking it, *in the commit that
introduced the rule*. So this is not a knowledge gap, and treating each instance as a
separate lesson has failed six times. The two things that have worked are mechanical
and survive me forgetting:

- **derive from the artefact instead of describing it**, and
- **make the guard assert its own reach**.

## Receipts

- **48 tests** across `servers/`.
- Every fix mutation-verified, each killing only its own test: remove raw-id-first and
  only the `builder-task-nhnj` row fails; remove the identity join and only the
  disagreement test fails.
- Production sources restored and confirmed unmodified after each mutation.
- Live-verified by the architect's lane at production scale:
  `THREAD_ID_DISAGREEMENT` fires for `spir-146`, `air-173`, `bugfix-1137`, `pir-183`,
  `aspir-242` and `secfix-1` — resolved, not ambiguous, not unmanaged, and the only
  signal.
