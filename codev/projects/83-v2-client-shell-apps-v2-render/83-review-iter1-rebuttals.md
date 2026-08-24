# Review iter 1 rebuttals — spec 83

## Codex: branch is behind spec rev. 12

Accepted. Merged `origin/main` (`22271aa15`). Plan, review, and PR body now say FR-3 is satisfied from `parentId`, #97 is closed, and #100 is the leftover defect. Client behaviour was already parentId-faithful; rev. 12 does not change it.

## Codex: no architect-parented builder coverage

Accepted. `tree.test.ts`, `SiteView.test.tsx`, and a Playwright case now drive `parentId: architect:1` and assert the row is inside that architect, not the workspace-level list.

## Codex: untracked phase context files

Accepted. `83-phase_4-iter2-context.md`, `83-phase_5-iter2-context.md`, and `83-phase_5-iter3-context.md` are included.

## Codex: could not rerun Vitest (EPERM)

Not a product defect. Suite rerun is local.

## Claude: CI never runs apps/v2

Accepted. `.github/workflows/test.yml` has a `Run v2 unit tests` step (`apps/v2`, `pnpm test`). Playwright stays out of the matrix.

## Claude: frozen-files.test.ts is a one-PR constraint

Accepted. Test deleted. The empty `git diff --stat` at phase 5 close is recorded in the review. Those files are frozen for spec 83, not forever.

## Claude: v2-packaging.test.ts in the unit suite

Accepted. Renamed to `v2-packaging.e2e.test.ts` so the default vitest exclude (`**/*.e2e.test.ts`) applies. `vitest.e2e.config.ts` includes `src/**/*.e2e.test.ts`.

## Claude: buildTree drops unresolvable parents

Accepted. Architects and builders whose `parentId` is missing from the map render at machine level under `parent not in tree`. No parent is inferred.

## Claude: sourcemap: true + .map allowlist (non-blocking)

Accepted the decision. Production `sourcemap: false`. `.map` stays in `ASSET_EXT` so a leftover hashed map would still be served as a static asset, not as HTML. None are emitted.

## Claude: Cache-Control (non-blocking)

Rejected for this round. Hashed filenames already cache-bust; the header is not a spec criterion.

## Claude: state why test is `vitest run` (non-blocking)

Accepted in the PR body. Bare `vitest` is watch mode and hangs porch.

## Gemini (COMMENT, lane skipped) / opencode (APPROVE)

No action.
