# bugfix-214 — pre-publish scrub (issue #214)

## Investigate

**Blocking finding verified at the file and line.** `packages/t3-client/src/auth.ts:9` carries
`/Users/chris/dev/t3code-spike/spike.mjs` inside the "copied from the proven spike" paragraph.
Built both packages from a clean `pnpm install`; the string reproduces exactly 3 times:

```
packages/t3-client/src/auth.ts:9
packages/t3-client/dist/auth.js:9
packages/t3-client/dist/auth.d.ts:9
```

`npm pack --dry-run --json` on `packages/t3-client` confirms all three are in the tarball
(`files: ["src","dist"]`, no `removeComments` in either tsconfig). The `.js.map` / `.d.ts.map`
files do **not** carry it — grep over the whole `dist/` found only the two.

**LICENSE / repository gaps confirmed.** No `packages/*/` directory carries a LICENSE file; the
repo root has one. Only `packages/codev` declares `repository`. Both t3-client and porch-driver
declare `"license": "Apache-2.0"`.

**Publishable set today** (no `private: true`): artifact-canvas, codev, core, porch-driver, sdk,
t3-client, types — 7, not 4. `packages/config` is the only private one.

**Root cause.** Nothing is broken in code. The comment was written during the spike with both
pointers because both were live on the author's machine; `files: ["src","dist"]` plus no
`removeComments` means a source comment is a shipped artifact, and nothing in the suite reads
the shipped set. The guard is the actual fix — the comment edit is the instance.

**Scope**: well under 300 LOC of code. Apache-2.0 text is boilerplate, not logic.

## Fix

**Parts 1–3.** `auth.ts` now points only at `codev/experiments/146-t3code-porch-proof/`, and the
paragraph still says the endpoints were copied from a proven spike and that you read it before
changing them. Rebuilt; `/Users/` is gone from `src/`, `dist/auth.js` and `dist/auth.d.ts`.
Apache-2.0 `LICENSE` copied byte-identical from the repo root into both packages, and both
manifests gained `repository` with a `directory` subpath, matching `packages/codev`'s convention.

**Part 4 — the guard**, `packages/codev/src/__tests__/bugfix-214-publish-scrub.test.ts`. Derives
the publishable set from `packages/<*>/package.json` (`private !== true`), resolves each tarball
with `npm pack --dry-run --json --ignore-scripts`, and scans every non-binary shipped file. No
name allowlist: a placeholder is `<...>`-shaped or an ellipsis, ASCII or Unicode.

**It found two things I had missed, before it was finished.**

1. A `\u2026` (Unicode ellipsis) placeholder in `agent-farm/utils/config.ts` that my own
   hand-written scan skipped in silence, because the character class I wrote by hand was
   `[A-Za-z0-9._-]`. That is the exact failure the guard exists to prevent, committed by me,
   in the process of building it.
2. A stale `dist/` — I restored `auth.ts` after mutation-checking and did not rebuild, and the
   guard failed on the two emitted copies while the source read clean. Which is the original
   bug's shape: source and shipped artifact disagreeing.

**CI.** The unit job built five of the seven publishable packages; `packages/codev`'s `dist/`,
`dashboard-dist/` and `v2-dist/` were absent, so the scan would have narrowed to committed files
and passed. Added a `Build codev package` step (~12s locally). The guard reads the job out of
`.github/workflows/test.yml` and fails if a publishable package has no build step there — and it
matches the `run:` line, not just the directory, because `packages/codev` already had a
`copy-skeleton` step that would have counted as a build.

### Mutation checks

| Mutation | Result |
|---|---|
| Reintroduce the home path in `auth.ts`, rebuild | fails, naming all 3 shipped copies |
| `mv packages/t3-client/dist` away | fails: `ships dist but they resolve to nothing` |
| Delete the `Build codev package` CI step | fails: `packages/codev … the unit test job never builds it` |
| Fixture: home path planted in a shipped file | fails (also Linux + Windows forms) |
| Fixture: `files: ["src","dist"]` with no `dist` | reports the unresolved entry; scan over the survivors is clean, which is the hole |
| Fixture: package directory does not exist | throws, rather than scanning an empty set |
| Fixture: `<user>`, `...`, `C:\Users\<user>` | passes, and nothing else does |

### Scoped-out items, cleaned because they were free

`live/integration.mjs` and `spec-146-t3-contract.test.ts` both defaulted `T3CODE_ROOT` to one
machine's absolute path. Neither ships. Both now require the variable — the script exits 2 with a
sentence naming the missing input, the test suite gates on `Boolean(T3_ROOT)` and keeps its
"skipped for no server" reporting. This is a behaviour change: running either without
`T3CODE_ROOT` set no longer silently assumes a path. CI never had that checkout, so CI is
unaffected.

### The same weakness was already merged

`spec-146-phase-9-thread-backend.test.ts:169`, from #209, asserted `workflow.includes(
\`working-directory: ${path}\`)`. That matches the directory, so any step in that package —
a copy, a lint, a test — counted as a build. The vacuous-pass shape, inside a guard written
to prevent a vacuous pass. Corrected to the same `run:`-matching criterion this PR's guard
uses, so the two cannot disagree about what a build is.

Mutation-checked as asked: replaced every `run: pnpm build` under
`working-directory: packages/t3-client` with a non-build step, keeping the directory. Old
criterion: `true` (passes). New criterion: `false` (fails). Restored workflow: `true`.

### Suite

Full `packages/codev` unit suite: **342 files passed, 3 skipped; 6,793 tests passed, 51
skipped, 0 failed** (203s). The three touched test files re-run after the last edits:
74 passed, 1 skipped.

`spec-146-t3-contract.test.ts` had a second type error at line 323 (`T3_NODE` on a spread of
`process.env`). Pre-existing, not in this diff, and invisible because `packages/codev`'s
tsconfig excludes `**/__tests__/**` and vitest does not type-check. Left alone.
