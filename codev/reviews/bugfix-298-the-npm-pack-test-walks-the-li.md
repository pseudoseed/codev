# Bugfix #298: The npm pack test walks the live repo while other tests mutate it

## Summary

`packages/codev/src/__tests__/extension-retirement.test.ts` asserted what the root package ships
by packing the **live working tree**. Concurrent tests churned scratch directories underneath that
tree, `npm pack` lstat'd one that had just vanished, and the test failed — five consecutive
full-suite runs, five failures, blocking `porch approve` for every project in the workspace.

The pack list now comes from the repository (`git ls-files`) with npm applying the packaging rules
to an isolated fixture. The race is gone and the file dropped from ~62s for one test to 10.9s for
all seven.

## Root Cause

`packedFiles()` ran `npm pack --dry-run --json --ignore-scripts` with `cwd: workspaceRoot`. The
root `package.json` declares `files: ["*", "!apps/streamdeck", "!apps/vscode"]`, so npm-packlist
walked the entire tree.

Other suites in the same vitest run create and delete scratch directories under that root. The
named writer is `packages/codev/src/agent-farm/__tests__/pir-832-migration.test.ts:18`, which
resolves `.test-pir-832` from `process.cwd()` (= `packages/codev`), `mkdirSync`s it in
`beforeEach` and `rmSync`s it in `afterEach` — once per test case. When the walk stat'd a path
that had been removed between readdir and lstat, npm exited non-zero, `execFileSync` threw, and
the test failed:

```
npm error code ENOENT
npm error syscall lstat
npm error path .../packages/codev/.test-pir-832/state.db
```

Deterministic rather than flaky because the walk took ~62s with `dist/` present and the scratch
directory churned many times inside that window.

### The measurement that shaped the fix

Comparing the live pack list against `git ls-files`:

- **43 files packed that git does not track** — `.builder-*`, files under `.claude/hooks/`, and
  each package's `node_modules/.bin/` shims. Working-tree litter; exactly the class of thing that
  disappears mid-walk.
- **55 tracked files not packed**, every one explained by a real packaging rule:
  `apps/web/.npmignore` (`node_modules`, `src`, `*.config.*`, `tsconfig*`) and npm's
  always-excluded names (`.gitignore`, `.npmignore`, `pnpm-lock.yaml`).

The first group is the bug. The second is why the rules were not reimplemented.

## Fix

`packedFiles()` now:

1. Takes the tracked paths from `git ls-files -z` at the workspace root.
2. Materialises them under `mkdtemp` in the OS temp directory, where no other test can reach them.
   Real content only for `package.json`, `.npmignore` and `.gitignore` — the only files
   npm-packlist reads rather than stats — and an empty placeholder for every other path.
3. Runs `npm pack --dry-run --json --ignore-scripts` in that fixture, then removes it.

The file set comes from git; the packaging rules come from npm. Neither is reimplemented in the
test, so there is no second copy of the rules to drift.

## Why the placeholder skeleton is sound

Its pack list is identical to the real tree's, minus the untracked litter: **3575 entries against
3575, zero divergence in either direction.** All four original assertions hold on it.

That is now an assertion rather than a one-off measurement. A second test packs the same
git-derived set with real contents and requires an identical list, so a future ignore mechanism
that reads a file the skeleton blanks turns the suite red instead of silently changing the answer.

It deliberately does **not** compare against the live tree. The architect asked for that
comparison; it was substituted, with agreement, because packing the live tree is the walk that
failed 5 of 5 — asserting against it would reintroduce #298 inside the test written to close it —
and because the live-versus-git difference is the 43 litter files, i.e. the bug rather than drift
to guard. That reasoning lives in the test's comment, where the next reader will ask the question.

## Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/__tests__/extension-retirement.test.ts` | `packedFiles()` derives from `git ls-files` into an isolated fixture; 2 tests added |
| `codev/state/bugfix-298_thread.md` | Builder thread |
| `codev/reviews/bugfix-298-the-npm-pack-test-walks-the-li.md` | This review |

## Regression Test

`derives the pack list from the repository, not from whatever is on disk` creates
`packages/codev/.test-bugfix-298/state.db`, of exactly the shape other suites churn, and asserts
it never reaches the pack list. If the list cannot see the path while it exists, no concurrent
create or delete of it can perturb the list either.

### Revert verification

Reverting `packedFiles()` to the live-tree walk:

- Regression test fails:
  `expected [ '.af-cron/ci-health.yaml', …(3620) ] to not include 'packages/codev/.test-bugfix-298/state.db'`.
- Under 4 parallel churners creating and deleting 5 scratch directories per iteration (~455
  iterations each), the pack test fails with the issue's exact error:
  `npm error code ENOENT / npm error syscall lstat / lstat '.../packages/codev/.test-churn-1-4'`.
  Bare `npm pack` under the same churn: **6 of 6** runs ENOENT.
- With the fix restored and identical churn running, 3 consecutive runs: **7 of 7** tests pass.

## Test Results

`porch check bugfix-298`: build ✓ (18.7s), tests ✓ (268.4s). All checks passed.

The extension-retirement file itself: 7 passed in 10.9s, against ~62s for the single pack test
before.

## Adjacent, not fixed

- **#297** — the sibling `existsSync(join(workspaceRoot, 'apps/streamdeck'))` assertion in the
  same file reads a live working tree for the same reason. Out of scope here.
- **`bugfix-214-publish-scrub.test.ts`** also shells out to `npm pack --dry-run`, but per package
  and against explicit `files` allowlists (`["dist"]`, `["src","dist"]`, …) rather than `["*"]`,
  so npm never walks a directory that other tests churn. Noted rather than changed.
- **#263** — the general shared-process-state problem this is an instance of.

## Lessons Learned

1. **A test that reads the live filesystem answers a question about the machine, not the
   repository.** The claim here was about what the package ships, which is a property of what git
   tracks plus the packaging rules. Every byte of divergence between those two answers was noise
   or a bug.
2. **When a fix needs rules that already exist somewhere, borrow the implementation rather than
   restating it.** Hand-rolling `.npmignore` matching would have put the packaging rules in two
   places, and 55 tracked files hinged on the second copy staying correct.
3. **Prove the substitute matches before trusting it.** The skeleton was only safe to adopt
   because its list was compared entry-for-entry against a real-content pack, and that comparison
   is now in the suite rather than in a builder's scrollback.
