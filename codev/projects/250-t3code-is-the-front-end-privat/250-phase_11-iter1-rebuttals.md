# Spec 250 — phase 11, iteration 1 rebuttals

Lanes: **claude REQUEST_CHANGES / HIGH**, **opencode COMMENT / HIGH**. They found the same defect
and disagreed only on severity, so the stricter reading is the one acted on. Nothing here is
deferred.

## 1. `ok` claimed the contract regenerated and shape-check held. BINDING — fixed.

**Both lanes, and they are right.** The header defined the outcome vocabulary as:

```
ok                 rebase clean, contract regenerated, shape-check held
regenerate-failed  rebase landed, the generator did not
shape-check-failed both landed, the contract does not match
```

The clean-rebase branch rev-parsed and rev-listed. It never called the generator and never ran
`shape-check`, and `regenerate-failed` / `shape-check-failed` were assigned nowhere in the file —
two documented states that could not occur. An operator reading `"outcome": "ok"` in a future run's
JSON would be told shape-check held on the strength of a comment.

This is the third finding of the same shape in this project, and the first two are named in the
phase 10 record: a guard that logged and returned (vitest counts that as a pass), and a
`startsWith` same-origin assertion that could not fail on ephemeral ports. This one sits on the tool
whose stated subject is that "I could not tell" must never be spelled like "no".

**It is not closable by calling the generator.** `generate.mjs` refuses any checkout whose `HEAD` is
not `pin.commit`, and no rebased tree satisfies that — its head is a commit that did not exist
before the rebase. Regenerating from one means moving the pin, which is the adoption the drill
exists in order *not* to perform; it is step 3 of `tools/t3-codegen/REFRESH.md`, taken when a rebase
is adopted for a reason. So the reviewer's option 1 is unreachable without changing what the drill
is, and stopping at option 2 — a comment edit — would leave criterion 9 answered by a proxy nobody
had measured.

Three changes instead:

- **The vocabulary is now `ok` | `conflicts` | `could-not-run`**, which is exactly the set the file
  assigns. `ok` says "every customization commit replayed with no conflicts", and its `detail`
  string adds that the contract was not regenerated and shape-check did not run.
- **`contractRegeneration.attempted: false`, with the reason, in every result.** An absent field
  reads as nobody having considered it; this is a stated refusal a reader can quote.
- **`contractClosure.sourceHash` is the measurement that replaces the claim.** It hashes the closure
  off the merged tree, sha256 per file the way `generate.mjs` hashes it, and compares to
  `generated/source-hash.json` — the layer `generate.mjs` itself names as load-bearing, because the
  emitted schema is blind to constraints behind a `decodeTo` transform.

**That measurement changed the answer, which is the point of taking it.** The closure merges with
zero conflicts, so regeneration is not *blocked* — but **4 of the 9 closure files come out of the
merge with different bytes** (`auth.ts`, `baseSchemas.ts`, `environment.ts`, `orchestration.ts`), so
the regenerated contract would not be the vendored one. "Regenerable" and "unchanged" had been
reading as one fact.

### Proving the new checks can fail

Per the standing order, each mechanism was reverted and the test re-run.

| Reverted | Result |
|---|---|
| Re-added `shape-check-failed` to the documented list | `documents exactly the outcomes it can assign` **fails** |
| Removed `contractRegeneration` from the evidence | `records that regeneration and shape-check did not run` **fails** |
| Set `sourceHash.moved` to `[]` | `measures the closure off the merged tree` **fails** |

**The ordering inside the drill is itself load-bearing, and that was checked separately.** The hash
must be taken while the merged worktree is on disk, *before* `merge --abort`. Taken after the abort
the worktree is the fork again and the comparison is the fork against itself. Hashing the unmerged
fork against `generated/source-hash.json` directly reports `moved: []` — so the post-abort version
of this measurement is a tautology that passes on every run regardless of what upstream did. The
test asserts a non-empty `moved` whenever `upstreamChurn.closureTouching > 0`, which fails on that
tautology.

### One more door into the same tautology, found while writing the above

Neither lane raised this; it turned up re-reading my own fix. The hash is guarded on
`closureConflicts.length === 0`, which is the right question **once a merge has happened**. A
`git merge` that refuses to start at all — already up to date, a wedged index — leaves the worktree
as the unmerged fork with no conflicts to notice, and the guard would wave it through into exactly
the fork-against-itself comparison the ordering exists to avoid.

`mergeProducedATree` (`merge.ok || conflictedList.length > 0`) is now the outer condition. No merged
tree means no measurement, reported as `checked: false` carrying what git said.

## 2. The criterion 9 `shape-check` row describes the current pin. Fixed.

`| shape-check | generate.mjs --check → artifacts are up to date |` was true of `3786b840e1a4` and
sat in a table about the rebased tree. Split into two rows that cannot be read as each other:
`shape-check` **at the current pin** (what was run) and `shape-check` **on the rebased tree** (did
not run, with the reason). The generated block carries the same fact as a row of its own, so it
survives regeneration.

A new subsection, "What the drill does not do, and why that is stated rather than implied", carries
the full account in `codev/resources/250-acceptance-evidence.md`.

## 3. Churn `104 / 5` was hand-typed. Fixed.

**opencode is right that this is exactly what the collector was built to stop.** The drill now
counts both from the preserved clone over the same range it rebased across — so the churn and the
conflict surface can never describe two different ranges — and the collector prints them.
`null` (could not count) renders as `**not counted**`, never as `0`.

The counted values are **104** and **5**, matching what was typed. The verdict split (3 `source-only`,
2 `consumed-change-undecidable`) stays prose: it comes from `classify-churn --upstream-movement`,
which is a separate run and is cited as one.

## 4. The regression run excluded `**/e2e/**`, so criteria 1, 2, 3, 5, 5b rest on phase 7-10 runs.

Non-blocking in the claude lane, not raised by opencode, and **actioned anyway** — this is the last
phase before the PR gate, and standing order 11 makes a run the thing that backs those criteria.

Worth stating precisely first: **phase 11 adds no fork commit.** `pin.commit` is `3786b840e1a4`,
which is phase 10's head, so the phase 7-10 Playwright runs were already runs at the final fork
head. What changed since is codev-side only — tools, docs, and the frozen `apps/client` suite —
none of which the spec-250 specs load. The re-run is confirmation, not a correction.

**Result: 32 passed in 2.3m**, all four spec files, against the running fork web app at
`3786b840e1a4`. Recorded in the acceptance evidence's regression table as its own row.

**The first attempt reported `32 skipped` and exited 0** — `T3_NODE` was unset, and the fixture
refuses to start the fork server without it. That is phase 10's skip-with-a-reason working as built,
and it is the reason this row says "32 passed" rather than "the suite is green": a run that exits 0
having executed nothing is the failure mode this whole phase is about.

## Not changed, and why

**The `ok` branch still does not regenerate.** Making `regenerate-failed` and `shape-check-failed`
reachable would mean giving `generate.mjs` a way to accept a checkout that is not at `pin.commit`.
That guard is the reason vendored artifacts are reproducible, and loosening it so a drill can
exercise two outcome strings would trade a real invariant for a label. The drill measures the
generator's inputs instead and says, in the JSON and in the header, that it did not run the
generator.
