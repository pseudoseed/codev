# Spec 250 — phase 11, iteration 2 rebuttals

**claude APPROVE / HIGH. opencode COMMENT / HIGH. Nothing blocking.** Four notes between them, all
actioned rather than acknowledged.

Both lanes were also asked directly whether deleting the order test was right, and both said yes for
the same reason: `closureConflicts` is built by filtering `conflictedFiles` at the call site, so the
two branch predicates are mutually exclusive and no well-formed input distinguishes the orderings.
claude added a caveat worth recording — the subset relation is a **caller obligation** the exported
function does not enforce, and `{conflictedFiles: [], closureConflicts: ['x']}` would make order
observable. That input is malformed and no caller produces it. Left as it is; the comment already
says "for well-formed input".

## 1. My own tests would have failed a correct zero-movement drill. Fixed.

**claude, and it is the sharpest finding of the two iterations because it is the same defect
inverted.** The drill produces one of two shapes, and `NO_UPSTREAM_MOVEMENT` is a **pass**: with
upstream still at our base there are no new migrations to shadow and no merged tree to hash, so that
result legitimately carries `watermark.checked: false`, `contractClosure.checked: false`, zero churn
and no `preserved` block.

The suite asserted the other shape unconditionally. Three assertions would have failed and a fourth
would have thrown, on a run that was entirely correct. Two iterations were spent on tests that pass
when they should fail; this is a test that fails when it should pass, and it is the same missing
question — *which claim is this artifact actually making?*

The shape is now named once (`zeroMovement`), each branch asserts its own contract, and a test
asserts the two ways of detecting the shape agree with each other. **Verified by running the suite
against a synthetic zero-movement evidence file: 6 passed, 7 skipped.** Against the old suite that
same file failed 3 and threw on 1.

`it (...) { if (x) return; }` in the whole-surface test became `it.runIf(x)(...)` while I was there.
A `return` inside a test body is recorded by vitest as a pass with zero assertions — which is
literally the phase 10 finding, still sitting in a file I wrote.

## 2. A comment outlived the test it described by one commit. Fixed.

**opencode.** The header of `spec-250-drill-closure.test.ts` still said "the order of the two checks
is asserted below", one commit after that test was deleted for being unfalsifiable. The accurate
comment was at the bottom of the same file, contradicting it.

Iteration 1's finding was a header claiming a check the code did not perform. This is the same thing,
one file over, introduced by the fix for it. The header now states plainly that the order is **not**
asserted and points at the comment that explains why.

opencode also caught the phase 11 review still naming `mergeProducedATree`, the inline predicate that
became `closureMeasurability` when it was extracted. Corrected, with the reason for the extraction.

## 3. The churn classification was hand-typed prose. Fixed.

**claude, and it is the same argument the collector was built on.** "3 `source-only`, 2
`consumed-change-undecidable`" sat outside the marker block in both
`250-acceptance-evidence.md` and `REFRESH.md`. I had defended keeping it as prose on the grounds that
it comes from a separate run — which is a description of the problem, not a reason.

`classify-churn --upstream-movement` is now persisted to
`codev/research/250-upstream-movement.json` and printed into the generated block. Its counts
(3 and 2) match what had been typed, which is the outcome that makes this worth doing: the fix was
not prompted by a wrong number, and the next drill is where a typed one goes wrong silently.

Two refusals came with it, both exit 3, both falsifiable by deleting the guard:

- **A classification covering a different range than the drill.** Every cell in the table would be
  individually correct while the table as a whole paired a closure-touching count with a conflict
  surface measured over a different span. Two ranges in one table is worse than one range and a gap.
- **A classification run against the fork.** `classify-churn --fork-drift` emits the same JSON shape,
  and the fork answering "what did upstream change" reports our own work back to us.

The range is tied by base plus **ref name**, because that is what `classify-churn` records. An
`origin/main` that moved between the two runs would slip through. Stated in the code rather than
papered over: the drill's target sha is printed beside it, and both runs belong to the same refresh
step.

## 4. `contractRegeneration` was not in "every result". Fixed by correcting the claim.

**opencode.** Three documents said "every result"; the three early `could-not-run` paths do not carry
it. Corrected the wording rather than padding the field into those paths. **`could-not-run` means
nothing was learned**, and a measurement-shaped field on that document is the first thing a reader
would mistake for a finding. Its `reason` is the whole document, and that is deliberate.

## Not changed, and why

**`spec-250-evidence-collector.test.ts` still mutates committed files and restores them in
`finally`.** claude flagged that a hard kill mid-test leaves the repository dirty. Removing the
hazard means giving the collector path overrides for its four inputs and its output, which widens a
tool's interface to suit a test — and the test's whole value is that it drives the collector against
its **real** inputs. The `withRestored` helper is explicit about what it does and the blast radius is
one `git checkout` of two files.

**The drill still does not regenerate the contract.** Unchanged from iteration 1: `generate.mjs`
refuses any checkout whose `HEAD` is not `pin.commit`, so doing it means moving the pin. claude
confirmed the reason is documented on every result path of a drill that ran, including the zero-churn
early return.
