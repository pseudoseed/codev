# Phase 11, iteration 2 — what changed and what to look at

Iteration 1: **claude REQUEST_CHANGES / HIGH**, **opencode COMMENT / HIGH**. One defect, found by
both. The stricter reading was taken as binding. Full response in
`250-phase_11-iter1-rebuttals.md`.

## The binding finding

`tools/t3-fork/rebase-drill.mjs`'s header defined the outcome vocabulary as `ok` = "rebase clean,
contract regenerated, shape-check held", with `regenerate-failed` and `shape-check-failed` beside
it. The clean-rebase branch rev-parsed and rev-listed. It called neither tool, and neither of those
two outcomes was assigned anywhere in the file.

**The reviewer's cheap option is unreachable.** `generate.mjs` refuses any checkout whose `HEAD` is
not `pin.commit`, and a rebased tree never satisfies that — its head is a commit that did not exist
before the rebase. So regenerating from one means moving the pin, which is the adoption this drill
exists in order not to perform.

## What was changed

1. **Vocabulary narrowed to `ok` | `conflicts` | `could-not-run`**, which is exactly the set the file
   assigns. `ok` now means "every customization commit replayed with no conflicts", and its `detail`
   says the contract was not regenerated and shape-check did not run.
2. **`contractRegeneration.attempted: false`, with the reason, in every result.** An absent field
   reads as nobody having considered it.
3. **`contractClosure.sourceHash`** — the closure hashed off the merged tree (sha256 per file, the
   way `generate.mjs` hashes it) and compared to `generated/source-hash.json`. That is the layer
   `generate.mjs` argues is the load-bearing drift detector, because the emitted schema is blind to
   constraints behind a `decodeTo` transform.
4. **Churn counted, not typed.** `upstreamChurn.commits` / `.closureTouching` from the preserved
   clone over the same range the drill rebased across. `null` (could not count) is rendered
   `**not counted**`, never `0`.
5. **The evidence, `FORK.md` and `REFRESH.md`** corrected in three places where "regenerable" and
   "unchanged" were reading as one fact.
6. **Criterion 9's status** changed from a bare "met" to "met under the plan's amended reading", with
   a table setting its four clauses against what was actually run.

## The new fact this produced

Zero closure conflicts — so regeneration is **not blocked** — but **4 of the 9 closure files come
out of the merge with different bytes** (`auth.ts`, `baseSchemas.ts`, `environment.ts`,
`orchestration.ts`), so the regenerated contract would **not** be the one vendored.

## Falsifiability — please attack these specifically

Each new assertion was verified by reverting its mechanism and confirming failure:

| Reverted | Test that failed |
|---|---|
| Re-added `shape-check-failed` to the documented list | `documents exactly the outcomes it can assign, and no others` |
| Removed `contractRegeneration` from the evidence | `records that regeneration and shape-check did not run` |
| Set `sourceHash.moved` to `[]` | `measures the closure off the merged tree` |

**The ordering inside `closureSourceHash` is the load-bearing part.** The hash is taken while the
merged worktree is on disk, before `merge --abort`. Taken after, the worktree is the fork again and
the comparison is the fork against itself; hashing the unmerged fork directly reports `moved: []`,
which is what that tautology would publish on every run.

**A second door into the same tautology was found and closed** without either lane raising it: a
`git merge` that refuses to start leaves the worktree unmerged with no conflicts to notice, and a
guard that only asks "did the closure conflict" is vacuously satisfied there.

That decision now lives in `tools/t3-fork/drill-closure.mjs` as `closureMeasurability`, with **5 unit
tests**. It was extracted rather than left inline because `rebase-drill.mjs` is a script — importing
it runs a drill against two real checkouts — so an inline guard is covered only by whatever branch
the last real run happened to take, which is the wrong coverage for a guard that exists to fire on
cases no normal run reaches. Deleting the guard fails 2 of the 5.

**One test in that file was written and then deleted, and the deletion is the part to check.** It
asserted that the no-merge check runs before the closure-conflict check; swapping the two in the
module left it passing. `closureConflicts` is a subset of `conflictedFiles`, so a non-empty closure
conflict implies a non-empty conflict list, and the no-merge branch requires that list to be empty —
the two cannot both hold for well-formed input, so there is no order to assert. A comment in the test
file records that. **Tell me if you think the deletion was wrong.**

## The non-blocking note, actioned

Phase 11's regression run excluded `**/e2e/**`. The spec-250 Playwright suites were re-run at the
fork head: **32 passed** in 2.3m. The first attempt reported `32 skipped` and exit 0 because
`T3_NODE` was unset — the fixture refusing to start the fork server, which is phase 10's
skip-with-a-reason working as built.

## Runs behind this iteration

- `npm test -- --exclude='**/e2e/**'`: **7387 + 180 passed, 57 skipped, 0 failed**, exit 0
- `porch done` checks: build 16.6s ✓, tests 196.1s ✓
- drill re-run from the committed code; `collect-spec-250-evidence.mjs --check` exit 0
- the three phase 11 test files: **20 passed**
- fork clean at `3786b840e1a4`, upstream clean at `082e6ea52186`

## Out of scope, deliberately

- **Making the drill regenerate.** It would require loosening `generate.mjs`'s `HEAD === pin.commit`
  guard, which is why vendored artifacts are reproducible. Reasoned in the rebuttal's last section.
- **Criterion 6 (the iPad).** Closes UNMET with a runbook; no device.
- **Issue #264.** Filed, not fixed here — it is porch/tower, and folding it in would put an unrelated
  change in a fork PR. Its second occurrence happened during this iteration and is recorded there.
