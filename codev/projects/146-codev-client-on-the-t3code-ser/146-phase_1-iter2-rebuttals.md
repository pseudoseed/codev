# Phase 1, iteration 2 — rebuttals

gemini APPROVE. codex and claude REQUEST_CHANGES, and between them they found one security
defect and one that would have blocked Phase 2 on its first import. Both were real. Everything
below was checked against the source before I acted.

## The security defect — both lanes, and they were right

**Finding (codex, claude):** `tools/t3-server/.runtime/` was tracked, including
`secrets/server-signing-key.bin`, `secrets/cloud-link-ed25519-key-pair.bin`, `state.sqlite`, and
`server.log` containing a pairing token. Claude quoted the token. Directly contradicts the spec's
constraint that pairing tokens are "never written to a repository, a log, or a shell history file".

**Verified, and worse than the finding said.** I checked whether it had been pushed, ran
`git branch -r --contains HEAD`, got nothing, and reported "contained". That test asks whether
*my tip* is on a remote, not whether the *secrets* are. Porch had already pushed a commit carrying
them. **The repository is public**, so this was a live public exposure for roughly nine minutes,
not an internal mistake.

**Cause, stated plainly:** `git add tools/t3-server/` — staging a **directory**, which swept in
the live data directory my own smoke runs had just created. It is not `git add -A`, and it is
exactly what that rule exists to prevent. I followed the letter and broke the intent.

**Resolved**, under the human's authorisation, in this order: remote branch deleted; history
rewritten from `8f2a2c195`, the last clean commit, with 13 commits collapsed to 4 and every path
staged explicitly; three independent checks run; then pushed and the *remote* re-verified rather
than the local branch. The third check walks each commit's **tree** rather than its diff, because
the two the gate asked for were both diff-based and two tests of the same kind are one test run
twice. `.gitignore` for `.runtime/` is in the first commit, not added afterwards.

No rotation: the keys belong to a loopback throwaway instance the harness `rm -rf`s on every
start, and T3 Connect ships disabled so the relay identity was never linked. The architect
confirmed that against `apps/server/src/cloud/environmentKeys.ts` rather than taking my word.

## `t3Defs` unexported — would have blocked Phase 2 immediately

**Finding (claude):** `t3Defs` is missing from the public export, so `shapeCheck` throws on the
six ref-carrying schemas Phase 2 depends on.

**Verified and fixed.** `t3Defs` was generated but `index.ts` exported only `t3Schemas` and
`t3Methods`. Any Phase 2 consumer calling `shapeCheck(payload, schema)` would have hit
`UnresolvedRefError` on its first ref-carrying schema. `UnresolvedRefError` itself was also
unexported, so a caller could not even catch it by name to distinguish a resolution failure from
a genuine mismatch.

**Root cause is a testing gap, not a typo.** Every test imported from
`../../types/src/t3/shape-check.js` — the *file* — so nothing exercised the surface consumers
actually use. Added tests that import through the package entry point and assert the full export
list, including one that performs the exact Phase 2 call shape end to end.

## The churn report — codex was right and I was wrong

**Finding (codex):** the report "labels every emitted-schema difference breaking".

**Correct.** I flagged in advance that I might defend my own work too readily here, re-read the
report, and the finding held. `consumed-change` was documented as "**This is the breaking
count**", and that is a **superset**: adding an optional field changes the emitted schema and
breaks nobody. "21 breaking, 39%" was an upper bound wearing a precise name, which is worse than
publishing no number.

Implemented real classification — property removed, property became required, type narrowed,
enum member lost, `additionalProperties` tightened:

| Verdict | Count |
|---|---|
| `breaking` | **0** |
| `non-breaking` | 3 |
| `consumed-change-undecidable` | 18 |
| `source-only` | 32 |
| `unclassifiable` | 1 |

The 18 are union changes: `ClientOrchestrationCommand` and `subscribeThread`'s output are unions,
and whether a client breaks depends on which variant it sends, which a schema diff does not say.
Returned as unknown rather than guessed. The correction is stated in the report rather than
quietly replacing the old figure.

## The `npx` gap — accepted as partially met, not marked done

**Finding (codex):** the harness runs `npx --yes t3@latest` while `verify` checks only the
checkout, so Phase 1's "start and verify a server at the pinned commit" is not met.

**Correct, and the architect ruled on it: the criterion is partially met, and it is now stated in
the plan next to the criterion rather than footnoted in a README** — "a criterion marked met with
a footnote is a criterion nobody re-reads". Two closures named: build the server from the pinned
tree, or pin the CLI version in `pin.json`. Carried into Phase 2's entry conditions so no later
phase can assume it away.

## Smaller findings, all fixed

- **Four stale "20 schemas" references** against an actual `LOSSY.md` count of 22. Fixed, and the
  generated one now derives the number from `lossy.length` so it cannot go stale again; the prose
  ones stopped quoting a count at all.
- **`REFRESH.md` still cited "184 commits, stale in weeks"** — the figure I had just corrected.
  Updated to the real classification.
- **Three unchecked Phase 1 deliverables** in the plan whose work exists and whose acceptance
  criteria were checked. Marked.
- **An uncommitted test block.** Committed.
- **`start()` wiping `data/` churns the tree.** Moot once `.runtime/` is untracked and ignored.

## Recorded as checked, not adopted

- **Transform-stripping comparison for loss detection** (codex, both rounds). The heuristic finds
  all three cases the plan names and 19 more, and the claim is proved directly by
  `transform-blindness-probe.mjs` whose committed output shows a zero-byte schema diff against a
  changed source hash. A second mechanism adds surface without adding evidence.
- **`acquire()` should clone a cold checkout** (codex). Keeping the refusal: a tool should not
  clone into a path it did not create. The architect agreed and directed the criterion be reworded
  to match what it does, which is done.
- **`afx shell` is PTY-coupled** (claude, round 1). `commands/shell.ts` has no import from
  `terminal/`. Only `attach.ts` does.

## Status

44 spec-146 tests pass, now including the entry-point suite. Remote verified clean. Phase 1
deliverables complete, with the `npx` gap carried forward explicitly rather than closed.
