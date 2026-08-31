# Review phase, iteration 1 — the PR review, and what changed

**Claude: APPROVE. opencode: COMMENT.** No blocking findings from either lane.

Before either could run, both refused: `gh pr diff 266` returns **HTTP 406, the diff exceeded the
maximum number of lines (20000)**, and this PR is 43,714 lines. Both printed the right refusal —
"a reviewer cannot tell an empty diff from a failed fetch" — and both **exited 0** while printing
it. Filed as **#267**, with the two halves separated: the missing `pr-diff` fallback, and a refusal
that spells itself like success to a caller checking the exit status.

The cap is on the API, not the content, and consult already writes the diff to a temp file for the
model to read rather than inlining it. A `gh` shim on PATH intercepting `pr diff` only, serving
`git diff origin/main...builder/spir-250`, produced the same 130 changed files
`gh pr view --json changedFiles` reports. `.codev/config.json` was deliberately not edited: it is a
symlink to the shared workspace config, and a `forge.pr-diff` override there would have changed the
forge for every builder and the architect to work around one oversized PR.

---

## 1. The evidence collector test mutated committed files — ACCEPTED, and the rebuttal was too broad

> `spec-250-evidence-collector.test.ts` mutates committed tracked files and restores in `finally`;
> a killed run leaves a dirty working tree plus a `.spec250-test-backup`, and parallel workers on
> the same paths would race.

**Accepted.** This was rebutted in phase 11 round 2, and that rebuttal defended a real point with
an argument that covered more ground than it should have. The point that holds: the test's value is
that it drives the collector against its **real** inputs, so copying the fixtures and pointing the
collector at the copies would test a copy. The part that did not hold: that reasoning applies to
**one** of the six tests — `agrees with the committed evidence`, the one asserting that the numbers
committed to this repository still match the runs behind them. The other five work by **damaging**
an input, and a damaged input has no reason to be the committed one.

**The race is real, and I had not checked for it.** `spec-250-vendoring-identities.test.ts` reads
`codev/research/250-criterion-8b-evidence.json` **in its module body**, at collection time. Vitest
runs test files in parallel workers. So a worker collecting that file while this one held the
mutation would fail on corrupted data, for reasons nothing in its own output would explain — and it
would look like flakiness in a file that has nothing to do with the collector.

**The fix uses a technique already in this project.** The collector resolves its root from
`import.meta.url`, exactly as `generate.mjs` does, so a **copy of the script under a scratch tree
reads that tree's inputs** — which is how phase 11's drill regenerates the contract without moving
the pin. `withScratchRoot` builds a `mkdtempSync` root, copies the collector and its six inputs
into it, and removes it in `finally`. No flag was added to the tool to suit a test, nothing tracked
is written, and a killed run leaves a temp directory rather than a mutated repository.

`spawnSync('rm', ['-f', backup])` is gone with the backup file it deleted.

**Verified capable of failing, and this one needed verifying.** Three of the five refusal tests
assert exit 3, and `MISSING_RUN` — a scratch root missing an input — is also exit 3. So a fixture
that was subtly incomplete would have made them pass for the wrong reason, which is the exact defect
this project hit five times. Removing all five mutations: **5 failed, 1 passed** — every refusal test
fails without its damage, and the happy path still passes, so the collector runs correctly in the
scratch root and nothing passes vacuously. Restored: 6 passed, and 83 passed with
`spec-250-vendoring-identities.test.ts` alongside it.

## 2. Two unreconciled commit counts — ACCEPTED

> PR body claims 166 commits; the review says 105 `[Spec 250]` commits. Reconcile or label what
> each number counts.

**Accepted.** Both numbers were also stale — they were taken against a local `main` that was behind
`origin/main`. The branch carries **167 commits, of which 106 are `[Spec 250]`**; the rest are
`chore(porch)` bookkeeping. Both places now say which they count.

Claude read this as a digit transposition of 106 into 166 and it was not, but the underlying
complaint was right: two numbers describing the same branch with nothing saying what either counts.

## 3. `status.yaml` history records 9 rounds, 20 ran — ACCEPTED, filed as #268

**Accepted, and the pattern is sharper than "a recording gap".** Cross-referencing every recorded
round against its verdicts: **a round is recorded if and only if at least one lane did not
approve.** No exception in either direction across 20 rounds.

- Phases 7, 8 and 9 are absent **entirely** — they are the three phases where both lanes approved
  on round 1.
- Every terminal, approving round is missing: phase_1 iter2, phase_2 iter2, phase_3 iter2, phase_4
  iter3, phase_5 iter2, phase_6 iter2, phase_10 iter2, phase_11 iter2.
- phase_4 iter2 is the one middle iteration recorded, and it is the one that still carried a
  `REQUEST_CHANGES`.

So a phase reviewed cleanly is indistinguishable from a phase never reviewed, and `history`
understates review effort *selectively* — biased toward the phases that went badly. Filed as
**#268**. `status.yaml` was not hand-edited.

## Not changed

**"The product change lives in the private fork and is not reviewable from this diff."** Correct
and by design — ruled at plan time, stated in the PR body's first section. The fork's own commits
are on `pseudoseed/t3code@codev` and the screenshots are at `docs/codev/spec-250/` there.

**Criterion 6 UNMET, criterion 9 met only under the amendment, #264 open on the approval path** —
opencode's three key issues. All three are already stated in the review, the evidence document and
the PR body, in those words. Recorded as confirmations, not findings.

**Claude could not verify branch freshness, the commit count, or a live test run** — it had no
shell. Checked here instead: the branch is at `origin/main` + 167, and the counts above come from
`git log` and `gh pr view`, not from memory.
