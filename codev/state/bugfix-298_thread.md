# bugfix-298 — npm pack test walks the live repo

## INVESTIGATE

### Reproduced

Not assumed. Ran `npm pack --dry-run --json --ignore-scripts` at the workspace root
while a background loop created and deleted `packages/codev/.test-race-298/state.db`.
Run 1 exited non-zero with exactly the issue's error:

```
npm error code ENOENT
npm error syscall lstat
npm error path .../packages/codev/.test-race-298
```

### Root cause

`packages/codev/src/__tests__/extension-retirement.test.ts:29-35` — `packedFiles()`
shells out to `npm pack --dry-run --json --ignore-scripts` with `cwd: workspaceRoot`.

The root `package.json` declares `files: ["*", "!apps/streamdeck", "!apps/vscode"]`,
so npm-packlist walks the **entire live working tree**. Concurrent tests in the same
vitest run create and remove scratch directories under that root — the named example
is `packages/codev/src/agent-farm/__tests__/pir-832-migration.test.ts:18`, which
resolves `.test-pir-832` from `process.cwd()` (= `packages/codev`), `mkdirSync`s it in
`beforeEach` and `rmSync`s it in `afterEach`, once per test case. When the walk lstats
a path that vanished between readdir and lstat, npm exits non-zero, `execFileSync`
throws, and the test fails.

Deterministic rather than flaky because the pack window is ~62s with `dist/` built and
the scratch directory churns many times inside it.

### Measured: the walk observes the disk, not the repository

Live pack list vs `git ls-files`:

- 43 files packed that git does not track: `.builder-*`, `.claude/hooks/*`,
  `*/node_modules/.bin/*`. Working-tree litter, exactly the class of thing that
  disappears mid-walk.
- 55 tracked files not packed, all explained by real packaging rules:
  `apps/web/.npmignore` (`node_modules`, `src`, `*.config.*`, `tsconfig*`) and npm's
  always-excluded names (`.gitignore`, `.npmignore`, `pnpm-lock.yaml`).

### Fix approach chosen

File list from **git** (the repository), packaging rules from **npm** (not
reimplemented):

1. `git ls-files` gives the tracked paths.
2. Materialise them as a placeholder skeleton in `mkdtemp` under the OS temp dir —
   real content only for `package.json`, `.npmignore`, `.gitignore` (the only files
   npm-packlist reads); every other path an empty file, since the walk only stats it.
3. Run `npm pack --dry-run --json` in that skeleton.

Verified fidelity: the skeleton's pack list is **identical** to the real tree's pack
list minus the 43 untracked litter files — 3575 vs 3575 entries, zero divergence in
either direction. All four assertions hold on it.

Cost: 0.3s to build the skeleton + 1.65s to pack ≈ 2s, against ~62s today.

Rejected: hand-rolling the packaging rules on top of `git ls-files`. It would have to
reimplement `.npmignore` matching and npm's default excludes, and getting that wrong
silently changes 55 files' worth of answer while the test still reads green. Rejected
also: moving scratch directories out of the walk, which narrows the window rather than
removing it.

### Scope

Single test file, well under 300 LOC. Fits BUGFIX.

### Not in scope

The sibling `existsSync(apps/streamdeck)` assertion in the same file is #297.

## FIX

Single file changed: `packages/codev/src/__tests__/extension-retirement.test.ts`.

`packedFiles()` no longer packs the live working tree. It now:

1. `git ls-files -z` at the workspace root → tracked paths.
2. Materialises them under `mkdtemp` in the OS temp dir. Real content only for
   `package.json`, `.npmignore`, `.gitignore` — the only files npm-packlist reads rather
   than stats. Everything else is an empty placeholder.
3. `npm pack --dry-run --json --ignore-scripts` in that fixture, then removes it.

The packaging rules stay npm's. Nothing about `.npmignore` or npm's default excludes is
reimplemented here.

### Architect exchange on the comparison

The architect asked for an in-test assertion that the skeleton and the **live** lists
match. I substituted skeleton vs a **real-content copy of the same git-derived set** and
said why: asserting against the live tree respawns the walk that failed 5 of 5, and the
live-vs-git difference is the 43 untracked litter files, i.e. the bug rather than drift.
The architect agreed and asked for that reasoning to live in the test comment, not only
in the PR body. It does.

### Tests added

- `derives the pack list from the repository, not from whatever is on disk` — creates
  `packages/codev/.test-bugfix-298/state.db`, of exactly the shape other suites churn,
  and asserts it never reaches the list. The regression test for #298.
- `packs the placeholder skeleton identically to the tracked tree with real contents` —
  guards the one risk the placeholder trick introduces.

### Revert verification

Reverted `packedFiles()` to the live-tree walk and re-ran:

- Regression test failed: `expected [ '.af-cron/ci-health.yaml', …(3620) ] to not include
  'packages/codev/.test-bugfix-298/state.db'`.
- Under 4 parallel churners creating and deleting 5 scratch dirs per iteration
  (~455 iterations each), the pack test failed with the issue's exact error:
  `npm error code ENOENT / npm error syscall lstat / lstat
  '.../packages/codev/.test-churn-1-4'`. Bare `npm pack` under the same churn: 6 of 6 runs
  ENOENT.
- Restored the fix and re-ran under identical churn 3 times: 7 of 7 tests passed each time.

### Cost

File went from ~62s to 10.9s for all 7 tests.
