# bugfix-278 — spec-250 vendoring test runs against a live working checkout

## Investigate (2026-08-31)

**Bug**: `packages/codev/src/__tests__/spec-250-vendoring-identities.test.ts:737`
("exits 1 against the real fork checkout when it is ahead of a fork-sourced pin")
fails at line 754 whenever `/Users/chris/dev/t3code-codev` has uncommitted changes.

**Root cause** (traced, not pattern-matched):

- The test runs `t3-server verify` twice against `FORK_ROOT`, the *live* fork
  checkout, changing only `pin.contractSource`.
- `verifyFork()` in `tools/t3-server/t3-server.mjs:310-311` calls
  `verifyForkHead()` then `assertClean(fork)`.
  - With `contractSource: 'fork'`, `verifyForkHead()` dies MISMATCH on
    `FORK_AHEAD_OF_CONTRACT` *before* `assertClean` runs — first half still passes.
  - With `contractSource: 'upstream'`, `FORK_AHEAD_OF_CONTRACT` only warns, so
    control reaches `assertClean(fork)` (`t3-server.mjs:188-194`), which dies
    MISMATCH with `DIRTY_FORK_CHECKOUT`. Exit 1, not 0 → line 754 fails.

So the "only `contractSource` changed, so only the exit code may" assertion is
decided by whatever someone left uncommitted in the fork checkout.

**Reproduced** in scratch (no repo files touched): fork fixture one commit ahead of
an upstream-sourced pin exits 0 clean; add one untracked file and the identical run
exits 1 with `DIRTY_FORK_CHECKOUT`. Exit code flips on tree state alone.

**Why the checkout is dirty**: not a stray file. Builder pir-272 is doing fork work
in `/Users/chris/dev/t3code-codev` live — one worktree on branch `codev`, no
per-builder isolation. The test cannot assume a clean tree while fork work is in
flight. (At the moment of this write the tree happened to be clean; that is a
race, not a fix.)

**Scope**: BUGFIX. The fix is a skip-with-named-reason gate, following the
`it.skipIf(!FORK_ROOT_PRESENT)` shape already in this file and the `forkSkipReason`
precedent in `spec-146-t3-contract.test.ts:96`. Well under 300 LOC.

**Not in scope** (architect, 2026-08-31): this is not gate-blocking —
`.codev/config.json` `porch.checks.tests` already excludes this file from the tests
gate; builders hit it via their own `pnpm test`. The exclusion-list problem is #281.
Do not widen into it.

**Test-run constraint**: the shared Vitest lock is contended by three builders; a
full run costs ~18 min each. Run only the affected files.

## Fix (2026-08-31)

**Change** (3 files, ~110 LOC):
- `tools/t3-fork/checkout-state.mjs` (new) — `inspectCheckoutTree(root)` answering
  `clean` / `dirty` / `unknown`, with a one-line reason naming the path and up to 4
  porcelain entries (truncation stated, never silent). `firstUnobservable(roots)`
  names WHICH checkout is in the way. A failed `git status` is `unknown`, never
  `clean`.
- `spec-250-vendoring-identities.test.ts` — the real-checkout test now gates on
  `REAL_CHECKOUTS_OBSERVABLE` (presence AND both trees clean) instead of presence
  alone; the skip reason rides in the test name, and the body re-probes and calls
  `ctx.skip(...)` if a tree goes dirty mid-run.
- `bugfix-278-fork-tree-skip.test.ts` (new) — regression test.

**Fail-without / pass-with, proved rather than argued.** Copied the pre-fix file
from HEAD to `zz-b278-baseline.test.ts`, pointed `T3CODE_FORK_ROOT` at a fixture
repo two commits deep with one untracked `lan-serve.mjs`, ran both files:

- pre-fix: FAIL at line 754, `only contractSource changed, so only the exit code
  may: expected 1 to be +0`.
- post-fix: skipped, reason `…/dirtyfork2 has 1 uncommitted entry: ?? lan-serve.mjs`.

Baseline copy deleted afterwards.

The regression test also runs the seam end to end: a fork one commit ahead of an
upstream-sourced pin verifies exit 0 clean, and exits 1 with `DIRTY_FORK_CHECKOUT`
after one untracked file is added — so the state the guard skips on is asserted to
be exactly the state that moves the exit code.

## Out of scope, needs someone else

`spec-250-vendoring-identities.test.ts:1272` ("describes the fork commit that is
actually checked out") fails on `main` right now, unrelated to this fix and not
fixed by it:

    expected '2f64a1b0ee…' (codev/research/250-criterion-8b-evidence.json)
          to be '26b4c2dc09…' (current HEAD of /Users/chris/dev/t3code-codev)

That is the criterion-8b staleness guard giving a TRUE answer: the fork moved
(pir-272's work) and the recorded evidence predates it. It is not a "could not
tell", so skipping it would be wrong — the fix is regenerating the evidence
against the fork, which belongs with the fork work, not here.

Architect (2026-08-31): no separate issue. pir-272 re-ran all four collectors and
its branch already names 26b4c2dc09f0 in that evidence file; main still names
2f64a1b0ee2b. It resolves when 272 merges. Documented in the PR body.

## PR (2026-08-31)

PR #288. CMAP on 3 lanes:

- claude: APPROVE
- opencode: APPROVE
- codex: REQUEST_CHANGES → COMMENT after the fix

**codex's finding, and it was real.** The guard checked cleanliness once at test
entry. The two `verify` calls are separate processes, so a builder saving a file
*between* them leaves the first run observing a clean tree and the second a dirty
one — the original red result with a smaller window, not a fixed one. Fixed in
d0a9530cc: the trees are re-read after each run before its result is believed,
including the fork-sourced run, where a dirty tree also exits 1 and would have let
that assertion pass for the wrong reason.

codex's second pass (COMMENT) flagged the PR body claiming "All tests pass" while
also documenting a pre-existing failure. Corrected: the checkbox now says what
actually passed (targeted files 85/86, `porch check` green) and states plainly that
the full suite is not green because of the criterion-8b evidence assertion.

Consult needs `--issue 278`; without it the lane exits 1 listing every project.
