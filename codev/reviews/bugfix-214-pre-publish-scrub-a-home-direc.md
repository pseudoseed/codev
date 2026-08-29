# Bugfix #214: Pre-publish scrub — a home-directory path ships in @cluesmith/t3-client, and neither new package carries its declared LICENSE

## Summary

`@cluesmith/porch-driver` and `@cluesmith/t3-client` were approved to publish on the condition that nothing identifying ships. `packages/t3-client/src/auth.ts:9` carried the maintainer's local scratch directory in a comment, and the package's `files: ["src", "dist"]` plus no `removeComments` meant it shipped three times. Fixed the comment, added the Apache-2.0 LICENSE and `repository` field both packages were missing, and — the part that outlives all of it — added a guard that resolves what each publishable package would actually put in a tarball and fails on any home-directory path it finds there.

## Root Cause

No code was broken. The comment was written during the spike with two pointers because both were live on the author's machine; one is a committed experiment directory, the other a path that exists on exactly one computer.

What made it a publishing problem rather than a typo is structural, and it is three facts stacked:

1. `files: ["src", "dist"]` puts source in the tarball, so a source comment is a shipped artifact.
2. Neither tsconfig sets `removeComments`, so the same comment is re-emitted into `dist/auth.js` and `dist/auth.d.ts`.
3. Nothing in the suite read the shipped set, so no test could have noticed any of it.

Confirmed by reproduction from a clean `pnpm install` before anything was changed:

```
packages/t3-client/src/auth.ts:9
packages/t3-client/dist/auth.js:9
packages/t3-client/dist/auth.d.ts:9
```

`npm pack --dry-run --json` confirmed all three were in the tarball. The `.js.map` and `.d.ts.map` files do not carry it.

## Fix

The comment now points only at `codev/experiments/146-t3code-porch-proof/`, which is committed and followable. It still says the endpoints were copied from a proven spike rather than derived, and still tells the reader to consult it before changing them — that was the paragraph's purpose and it is intact.

Both packages gained the Apache-2.0 `LICENSE` they already declared (byte-identical to the repo root's) and a `repository` field with a `directory` subpath.

### The guard

`packages/codev/src/__tests__/bugfix-214-publish-scrub.test.ts` — 16 tests.

It **derives** the publishable set from `packages/*/package.json` (`private !== true`) instead of restating it. That mattered on the first run: the issue said four packages publish and there are **seven**. It resolves each tarball with `npm pack --dry-run --json --ignore-scripts`, so what gets scanned is what npm would actually ship, not what `files` claims — a manifest that lies is caught by the same move. 1,244 files, ~4.5s.

**No allowlist of safe usernames, deliberately.** Documentation needs to show what a home path looks like, so the exemption is structural: a placeholder is `<user>`-shaped or an ellipsis. A name-based allowlist has a gradient — the cheapest fix for a red on a doc placeholder is to add that name to the list, and two rounds of that is where a real path becomes invisible. Three existing doc placeholders were normalised to the structural form instead of exempted by name.

## Files Changed

| File | Change |
|------|--------|
| `packages/t3-client/src/auth.ts` | Dropped the machine-local pointer; kept the committed one and the paragraph's purpose |
| `packages/t3-client/LICENSE`, `packages/porch-driver/LICENSE` | New; Apache-2.0, byte-identical to the repo root |
| `packages/t3-client/package.json`, `packages/porch-driver/package.json` | `repository` with a `directory` subpath |
| `packages/codev/src/__tests__/bugfix-214-publish-scrub.test.ts` | New guard, 16 tests |
| `.github/workflows/test.yml` | `Build codev package` step in the unit job |
| `packages/codev/src/agent-farm/__tests__/spec-146-phase-9-thread-backend.test.ts` | #209's build assertion corrected to the same criterion |
| `packages/codev/src/agent-farm/utils/claude-session-discovery.ts` | `/Users/x` → `/Users/<user>` |
| `codev-skeleton/resources/commands/agent-farm.md`, `codev/resources/commands/agent-farm.md` | `/Users/me` → `/Users/<user>`, both trees |
| `packages/t3-client/live/integration.mjs`, `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` | `T3CODE_ROOT` required rather than defaulted to one machine's path |

## Testing

Full `packages/codev` unit suite: **342 files passed, 3 skipped; 6,796 tests passed, 51 skipped, 0 failed** (191s). Builds clean for t3-client, porch-driver and codev; `grep -rn "/Users/"` over both packages' `src/` and `dist/` returns nothing.

### Mutation checks

A guard that resolves nothing passes every assertion made about what it found, so each of these was run:

| Mutation | Result |
|---|---|
| Reintroduce the home path in `auth.ts`, rebuild | fails, naming all 3 shipped copies |
| `mv packages/t3-client/dist` away | fails: `ships dist but they resolve to nothing`, naming `pnpm -w run build` as the remedy |
| Delete the `Build codev package` CI step | fails: `packages/codev … the unit test job never builds it` |
| Move that step into a job **inserted** between `unit:` and the next job | fails — the slice ends at the next top-level job, not a named one |
| Replace `run: pnpm build` under `working-directory: packages/t3-client` with a non-build step | #209's corrected guard fails; the old criterion returns `true` |
| Fixture: home path planted in a shipped file | fails (ASCII, `/home/`, and `C:\Users\` forms) |
| Fixture: `files: ["src","dist"]` with no `dist` | reports the unresolved entry — the scan over the survivors is clean, which is the hole |
| Fixture: package directory does not exist | throws rather than scanning an empty set |
| Fixture: `<user>`, `...`, `C:\Users\<user>` | passes, and nothing else does |

## Lessons

### 1. The guard found two things while it was being written, both mine

A `\u2026` Unicode-ellipsis placeholder in `agent-farm/utils/config.ts` that the hand-written scan used to size this work skipped in silence, because that scan's character class was `[A-Za-z0-9._-]`. And a stale `dist/` — `auth.ts` restored after a mutation check without a rebuild, so the source read clean while both emitted copies did not, which is the original bug's exact shape.

Both are the argument for the instrument over the sweep. A grep written by hand encodes what its author already thought of.

### 2. The same weakness was already merged, in a guard written to prevent it

`spec-146-phase-9-thread-backend.test.ts:169`, from #209, asserted `workflow.includes(\`working-directory: ${path}\`)`. That matches the **directory**, so any step in that package — a copy, a lint, a test — counted as a build. This PR's guard was about to have the identical weakness, which is what exposed it: `packages/codev` already carries a `copy-skeleton` step under that working-directory.

Both now require the `run:` line to build. Two guards in one repo disagreeing about what a build is would be worse than either being wrong alone.

### 3. Make the workflow satisfy the guard, not the guard accept the workflow

CI's unit job built five of the seven publishable packages, so the scan over `packages/codev` would have narrowed to the committed files and passed — a green run over a set it could not resolve. The options were to add a build step or to teach the guard to tolerate the absence. The second is the cheap green, and it would have removed exactly the coverage the guard exists for.

### 4. A default that works on one machine is a silent failure everywhere else

`live/integration.mjs` and `spec-146-t3-contract.test.ts` both defaulted `T3CODE_ROOT` to an absolute path. Anyone else got a failure somewhere inside the server instead of a sentence naming the missing input. Requiring the variable turns it into an immediate, named one — the same move as the guard.

**Consequence worth naming:** that checkout exists on the maintainer's machine, so the live contract suite was running locally on the old default and now skips unless `T3CODE_ROOT` is exported. CI never had the checkout, so CI is unchanged.

### 5. The emptiness test was not going through the emptiness branch

The test written to prove the guard cannot pass over an empty set asserted that the real
`packages/` is non-empty, and separately that `readdirSync` on a missing directory throws. It
never called the code that turns "no publishable package" into an error. So the vacuous-pass
defect existed **one level deeper than the guard, inside the test written to prevent it** — the
same shape as the bug, the same shape as #209's weakness, in the instrument aimed at both.

The fix drives the throw with a real empty directory and a directory holding only a
`private: true` package. The second case is the better one: *no packages* and *packages, none
publishable* are different states, and a guard that conflates them passes over a repo where
everything went `private` by accident.

Going around a branch rather than through it produces a green test that proves nothing, and it
reads exactly like one that proves something. `expect(x.length).toBeGreaterThan(0)` next to
`expect(() => somethingElse()).toThrow()` is the tell.

### 6. Sourcemaps are a disclosure route, and nobody reads a `.map`

The original audit scanned source and comments and stopped there. `sources` and `sourcesContent`
carry the build machine's absolute paths, and no human opens a minified map to check.

Checked: 1 `.map` ships across `dashboard-dist` and `v2-dist`, and every `sources` entry is
relative — this repo is clean. But it was clean **by luck rather than by a guard**, and the
question had not been asked until a reviewer asked it.

Covering it cost nothing, because a `.map` is UTF-8 text and the scan already read them. What was
missing was anything *saying* so — "covered incidentally" and "covered" are different claims, and
only one survives someone adding a binary-skip heuristic later. Two tests now plant an absolute
path in `sources` and in `sourcesContent` and assert the guard fires.

### 7. A reviewer that states its own coverage boundary

opencode said what it did **not** check — it did not re-run the suite, did not pack a tarball, and
recorded the 6,794-pass figure as unverified by it rather than repeating it as fact. That is rarer
than finding a bug, and it is the difference between a verdict that can be weighed and one that
has to be guessed at. It is also the same discipline this repo asks of its own tools: a
could-not-tell must not be spelled the same way as a no.

## Not fixed

`spec-146-t3-contract.test.ts:323` has a pre-existing type error (`T3_NODE` on a spread of `process.env`), invisible because `packages/codev`'s tsconfig excludes `**/__tests__/**` and vitest does not type-check. Out of scope; flagged rather than silently carried.

## CMAP Review

The first CMAP attempt **exited 0 having reviewed nothing.** All three lanes printed `Multiple projects found:` followed by every project id in the repo and returned success. The BUGFIX pr phase prompt gives the command without `--project-id`, and auto-detection from porch state did not work in the worktree. Checking exit status alone would have recorded three approvals from three lanes that never ran — a could-not-tell spelled exactly like a no, which is the lesson this repo already carries in `lessons-critical.md`.

Re-run with `--project-id bugfix-214 --output`, two of the three default lanes were quota-exhausted:

- **Gemini**: SKIPPED — `agy` exited 1 on quota. The lane self-reports `LANE_DID_NOT_REVIEW: true` and states it is not an approval.
- **Codex**: usage limit reached; **no output file, exit 0.**
- **Claude**: **APPROVE (HIGH).** Verified against the tree rather than the diff — independently counted 7 publishable packages, confirmed all 7 have a matching build step in the unit job, and confirmed no non-placeholder home path in `dist`, `dashboard-dist`, `skeleton` or `codev-skeleton`. It caught one thing this review had not: `packages/sdk`'s test file carries a real-looking `/Users/amr/...` path, and `sdk` ships `dist` only, so the guard's derived set correctly excludes it.
- **opencode**: **APPROVE (HIGH).** Substituted for codex per the guidance that it is the fallback lane on an account none of the others share. Reviewed the files on disk rather than the diff, and was explicit about what it did *not* verify: it did not re-run the suite or pack a tarball, so it recorded the pass figure quoted to it at the time as unchecked by it. Two nits, both checked here rather than reasoned about:
  - *The empty-population test never reaches `found.length === 0`.* Correct, and see Lesson 5.
  - *`apps/web` sourcemaps in shipped `dashboard-dist/` could carry absolute `sources`.* Checked, and see Lesson 6.

Two failure modes, and the difference matters. Gemini's lane fails **loudly** and says it did not
review. Codex fails by producing nothing and exiting 0, which is indistinguishable from success
to any caller that only checks the exit code — it relies entirely on someone noticing an absent
file. The `Multiple projects found` failure was worse than either, because it printed a wall of
~300 project ids that reads at a glance like output.

### Notes applied rather than deferred

Claude's four non-blocking notes were all fixed in this PR, and two of them were real weakenings
of the guards:

1. `pkg.rel` and `path` were interpolated into `new RegExp` **unescaped in both guards**. A
   package directory carrying a `.` or `+` would have loosened the match — the wrong direction
   for a guard. Both now escape.
2. The unit-job slice anchored on `canvas-browser:`, so a job **inserted** between `unit:` and it
   would have widened the slice and its build steps would have counted as the unit job's. Now
   slices to the next top-level job, whichever it is. Mutation-checked by moving the build step
   into an inserted job and confirming it fails.
3. The unresolved-entry failure did not name the remedy; it now says `pnpm -w run build`.
4. `shippedFiles` was doing 14 `npm pack` invocations for 7 packages because both `it` blocks
   re-resolved. Memoized: guard runtime 9.3s → 5.5s.

**A correction to this document's own CI note:** the `~12s` figure was a warm measurement, and
the step pulls `apps/web` and `apps/v2` through `codev^...` and `copy-v2`. The `integration`,
`cli` and `package` jobs already run that exact command, so the cost is known rather than new.

### Left as noted, not fixed

`execFileSync('npm', ...)` is not Windows-portable (`npm.cmd`). CI is ubuntu and development is
darwin, so this is recorded rather than worked around.
