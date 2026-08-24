# Review: v2 client shell — apps/v2 renders the live hierarchy

## Summary

Five plan phases shipped `apps/v2`: static `/v2/` serving and `v2-dist` packaging, a closed-read-set reducer, bootstrap plus resume reconnect, the containment site view, and a same-origin Playwright fixture. The page draws the live hierarchy from `GET /v2/events` without polling, without SDK behaviour, and without touching the C1/C2 frozen files. Review round 1 merged spec rev. 12 and landed the CI / orphan / packaging-suite fixes.

## Spec Compliance

- [x] 1. `/v2/` loads and renders every workspace, architect and builder the stream reports, inside the local machine's frame (Phase 4, 5)
- [x] 2. A new builder row appears with no reload and no client timer (Phase 3, 4, 5)
- [x] 3. Gate-waiting renders rust with a `GATE` stamp (Phase 4, 5)
- [x] 4. Stalled renders ochre and `STALLED` from the stream status (Phase 4, 5)
- [x] 5. Sparkline advances on `tick` and flattens to zero when a builder is omitted (Phase 4, 5)
- [x] 6. `gone` removes the row. Driven by a fixture frame, not `afx cleanup` (Phase 5; live cleanup is the human UX pass)
- [x] 7. Disconnect then honoured resume or refused snapshot recovers without a page reload (Phase 3, 5)
- [x] 8. A `dark` workspace plot goes dark; siblings stay live (Phase 2, 4, 5)
- [x] 9. Unreachable and zero workspaces render differently (Phase 3, 4, 5)
- [x] 10. Two pages on one scope converge (Phase 5)
- [x] 11. No `setInterval`. Exactly one `setTimeout`, the named reconnect backoff. `/api/workspaces` succeeds at most once (Phase 3)
- [x] 12. Cold load under 2s on the fixture: `cold-load-ms=138` against a 2000ms budget (Phase 5)
- [x] 13. Idle under 1 KB/s: `idle-Bps=0` (Phase 5). Resource Timing reports 0 on the still-open SSE fetch, which is the no-polling evidence
- [x] 14. `GET /v2/` injects `window.__CODEV_TOWER_KEY__` and strips `Access-Control-Allow-Origin` (Phase 1)
- [x] 15. Keyless `GET /v2/` and `/v2/assets/*` are public; keyless `/v2/events` is still 401 (Phase 1)
- [x] 16. 401, 500, thrown fetch, and 200 with `[]` produce distinct renderings (Phase 3, 4, 5)
- [x] 17. `counts` sits in the footer as machine totals, including on an empty snapshot (Phase 4, 5)
- [x] 18. A workspace-parented builder sits beside the architect; an architect-parented builder nests under it; no parent is inferred (Phase 4, 5, review)
- [x] 19. `npm pack` on `packages/codev` contains `v2-dist` (Phase 1)
- [x] 20. C1 surfaces byte-unchanged vs `origin/main` at phase 5 close (measured, then the durable test was removed)
- [x] 21. Production changes outside `apps/v2/` are `v2-static.ts`, the `v2-routes.ts` prologue, two `isPublicRoute` GET clauses, packaging, new tests, and the workspace lockfile (Phase 1)
- [x] 22. Spec 52 v2 suite and existing `isPublicRoute` cases still pass (Phase 1–5)

FR-3 is satisfied from `parentId` (spec rev. 12). FR-15 remains deferred (D5). #97 is closed; #98 and #100 stay filed.

## Deviations from Plan

- Fixture is `apps/v2/e2e/fixture-server.mjs`, not the planned `.ts`. Node 20 cannot run `.ts` without a loader.
- `AppState.httpMismatch` is extra vs the plan; `viewKind` puts it in mismatch slot 2.
- Empty site still shows `MachineFooter` when `counts` is present (D11; Codex phase 4).
- Workspace plot header name is wrapped in `.ws-plot-label` so name, mail, and stamp are separate nodes.

## Consultation Feedback

Gemini skipped (agy exit 1) on every round. Recorded as COMMENT / `LANE_DID_NOT_REVIEW`. Not an approval.

### Plan (Round 1)

#### Codex
- **Concern**: bare `GET /v2` made public → **Addressed**: D9 only `/v2/` and `/v2/assets/*`
- **Concern**: Playwright topology / two origins → **Addressed**: fixture is the sole origin on 4173
- **Concern**: `@playwright/test` missing from `apps/v2` → **Addressed**
- **Concern**: state ownership split → **Addressed**: composed `AppState`
- **Concern**: scenario 16 only hits `isPublicRoute` → **Addressed**: also `isRequestAllowed`

#### Claude / opencode
- COMMENT on plan shape. No remaining disputes.

### Phase 1 (Round 1)

#### Codex
- APPROVE. No concerns.

#### Claude
- **Concern**: `copy-v2` under vitest `NODE_ENV=test` emits a React dev bundle → **Addressed** in `8489c45ca`

#### opencode
- APPROVE.

### Phase 2 (Round 1)

#### Codex
- **Concern**: `gone` deleted `darkPaths` → **Addressed**
- **Concern**: preview used UTF-16 not 120 UTF-8 bytes → **Addressed**
- **Concern**: dark `at` always empty → **Addressed** (injectable receipt time)

#### Claude
- REQUEST_CHANGES overlapping the same three. **Addressed**.

#### opencode
- APPROVE.

### Phase 2 (Round 2)

No concerns raised — Codex, Claude, opencode APPROVE. Gemini COMMENT (skip).

### Phase 3 (Round 1)

#### Codex / Claude / opencode
- **Concern**: unreachable not cleared on a later mismatch → **Addressed**
- **Concern**: `forceFresh` cleared before a successful fresh snapshot → **Addressed**
- Other transport notes (cancel SSE, emit copy, wait TDZ, applied-eof) → **Addressed**

### Phase 3 (Round 2)

#### Codex
- **Concern**: 200 + `res.text()` reject must be mismatch → **Addressed**

#### Claude / opencode
- APPROVE.

### Phase 3 (Round 3)

#### Codex
- **Concern**: `applied-retry` must also clear `forceFresh` → **Addressed** in `05b981df5`. Phase was force-advanced; the commit landed after.

#### Claude / opencode
- APPROVE.

### Phase 4 (Round 1)

#### Codex
- **Concern**: workspace/architect status ignored → **Addressed**
- **Concern**: architect `heldMail` ignored → **Addressed**
- **Concern**: empty snapshot hid `MachineFooter` → **Addressed**

#### Claude / opencode
- APPROVE.

### Phase 4 (Round 2)

No concerns raised — Codex, Claude, opencode APPROVE. Gemini COMMENT (skip).

### Phase 5 (Round 1)

#### Codex
- **Concern**: phase 5 files untracked during review → **Addressed** (`c3d7153db`)

#### Claude
- **Concern**: vacuous resume / rust / flatten / idle assertions → **Addressed**

#### opencode
- APPROVE.

### Phase 5 (Round 2)

#### Codex
- **Concern**: resume tests did not record `since`/`stream`/mode or a page sentinel → **Addressed** (`75ce35bda`)
- **Concern**: rust scan vacuous; stalled never checked ochre → **Addressed**
- **Concern**: idle via CDP / fixture byte accounting → **Rebutted**: criteria 12–13 are measured and printed, not asserted
- **Concern**: two-page test checked only one new row → **Addressed** (full `[data-kind]` dump)

#### Claude / opencode
- APPROVE.

### Phase 5 (Round 3)

No concerns raised — Codex, Claude, opencode APPROVE. Gemini COMMENT (skip).

Architect screenshot before PR: workspace header rendered `ALPHARUN`. **Addressed** (`.ws-plot-name` is flex + 8px gap; name wrapped; two component tests + e2e computed-style).

### Review (Round 1)

Merged `origin/main` (spec rev. 12) before addressing.

#### Codex
- **Concern**: branch behind spec rev. 12 / #97 still open → **Addressed** (merge + plan/review/PR)
- **Concern**: no architect-parented builder coverage → **Addressed** (tree, SiteView, Playwright)
- **Concern**: three untracked context files → **Addressed**
- Vitest EPERM in the review sandbox: environment, not a failure

#### Claude
- **Concern**: CI never runs `apps/v2` → **Addressed** (`test.yml` unit step)
- **Concern**: `frozen-files.test.ts` freezes a one-PR constraint → **Addressed** (deleted; evidence here)
- **Concern**: `v2-packaging.test.ts` in the unit suite → **Addressed** (renamed `v2-packaging.e2e.test.ts`)
- **Concern**: `buildTree` drops unresolvable parents → **Addressed** (machine-level `parent not in tree`)
- Sourcemap: production `sourcemap: false`. `.map` stays in the allowlist for hashed leftovers; none are emitted.
- Cache-Control: not changed
- `"test": "vitest run"` reason recorded in the PR body

#### Gemini / opencode
Gemini skipped. opencode APPROVE.

Frozen C1/C2 `git diff --stat origin/main...HEAD` was empty on all 13 paths at phase 5 close, before this review round merged rev. 12 (spec only).

## Lessons Learned

### What Went Well

The fixture as sole origin removed the live-Tower flake class. Frozen-file diffs against `origin/main` made C1/C2 checkable every phase.

### Challenges Encountered

Opencode consult cannot read its temp prompt (`external_directory` under `/var/folders`); that lane's reviews were written against disk. `afx self-refresh` refuses on the opencode harness. Phase 3 needed a force-advance plus a follow-up commit for `applied-retry`.

### What Would Be Done Differently

Land the fixture's request log (`since`/`stream`/mode) in the first Playwright pass, not after two review rounds. Screenshot the site view at 1440 before calling phase 4 done.

### Methodology Improvements

A harness with no in-session clear should not emit a refresh task that can only refuse. Consult should write the opencode prompt inside the worktree, not `/var/folders`.

## Architecture Updates

- Routed: cold — `apps/v2` is an end-user surface at `/v2/`, types-only, packaged as `v2-dist` — added to `codev/resources/arch.md` (quick start, monorepo table, graph, tree)
- HOT `arch-critical.md`: no change. Cap is full. Map already has "Monorepo Structure — adding a package or build wiring"

## Lessons Learned Updates

- Routed: cold — UI/UX — sibling stamps in one header need flex + gap; `textContent` will not catch `ALPHARUN`
- HOT `lessons-critical.md`: no change. Cap is full. The fact is a UI recipe, not a cross-cutting decision rule

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Live UX pass on this machine: open `/v2/`, spawn a builder, wait past stall, human `afx cleanup`. Fixture already covers `gone`.
- #98 (dark decided once per connection) and #100 (worktree with no `global.db` row) stay filed. #97 is closed.
- `apps/v2` Playwright is not in the root CI matrix. Vitest is.
- Bare `GET /v2` (no trailing slash) is still 401. D9 matches `/v2/` only.
