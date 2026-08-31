# Spec 250 — acceptance evidence

What was run, on what, with what result. One row per criterion, and **a criterion with no run and
no test says so** rather than borrowing another criterion's evidence.

Recorded 2026-08-31. Fork at `3786b840e1a4`; upstream preserved at `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`.

**10 of 11 met. Criterion 6 is UNMET and says why.** Nothing here borrows another criterion's
evidence, and nothing that was not run is recorded as passing.

## The criteria

| # | What it asks | Evidence | Status |
|---|---|---|---|
| 1 | architect + 3 builders render as a tree, in t3code's own web app | `spec-250-hierarchy.spec.ts` — 9 Playwright tests against the live fork app | **met** |
| 2 | two architects render as two subtrees | `spec-250-hierarchy.spec.ts:265` | **met** |
| 3 | a gated builder shows the gate name and #128's question, from the gate block not the title | `spec-250-gate.spec.ts` — 9 tests, one of which asserts no thread title anywhere contains a gate name | **met** |
| 4 | the gate is approved from t3code and porch records session id, machine and timestamp in `status.yaml`, over `codev-agent`'s capability path | `spec-250-t3code-approval.e2e.test.ts` through the REAL fork server's proxy, ending in a real `status.yaml`; and `spec-250-approval.spec.ts` from a real browser | **met** |
| 5 | six builders at 1440x900, panes ≥340x240, body text ≥13px, measured against t3code's chrome | `spec-250-tiling.spec.ts:136` — measured from the browser's own geometry, not from the component's attribute | **met** |
| 5b | seven panes at 1920 tile 4x2, not 3x3 | `spec-250-tiling.spec.ts:243` | **met** |
| 6 | reached from an **iPad** over the tailnet, no account, no relay, driving a builder to completion | **no run** — no device available; runbook written and verified | **UNMET** |
| 7 | a `role: null` thread appears where it always did and nothing claims it | `spec-250-hierarchy.spec.ts:291` | **met** |
| 8 | an existing database opens against the customized server; added columns read as "not recorded"; a projection rebuilt over a pre-fork event log decodes every historical payload | `apps/server/src/codev/schemaGuard.test.ts` and the projector tests in the fork | **met** |
| 8b | a migration interrupted partway leaves the database openable by the **pre-fork** server — by killing the server, not by argument | `tools/t3-fork/criterion-8b.mjs`, evidence at `codev/research/250-criterion-8b-evidence.json`, `passed: true` at the pin | **met** |
| 9 | the fork rebases onto a later upstream, the contract regenerates and passes `shape-check`, `verify` holds on both identities, and upstream churn is measured and non-zero | this document's next section | **met** |
| 10 | an approved gate cannot be re-displayed by a later write carrying a lower revision | phase 4's revision high-water-mark tests, and the live delivery in phase 6 | **met** |
| 11 | hierarchy integrity refused **at write time**, not rendered in a fallback | `apps/server/src/codev/threadHierarchy.test.ts`, plus the live wire evidence at `codev/research/250-hierarchy-wire-evidence.json`, `passed: true` | **met** |

## Criterion 9 — the rebase drill, in full

Run by `tools/t3-fork/rebase-drill.mjs`; machine-readable at `codev/research/250-rebase-drill.json`;
procedure recorded in `tools/t3-codegen/REFRESH.md`.

**Nothing real moved, and the drill checks it rather than promising it.** `/Users/chris/dev/t3code`
was fetched — remote-tracking refs move, HEAD does not — and re-read afterwards at
`082e6ea52186`, clean. The fork was unmoved and clean. `pin.commit` unchanged. The drill discards
its own result if any of those is false.

| Question | Answer |
|---|---|
| upstream churn, `082e6ea52186..origin/main` in the **upstream** checkout | 104 commits, of which **5 touch the pinned closure**: 3 `source-only`, 2 `consumed-change-undecidable` |
| which two are undecidable | `orchestration.subscribeThread` and `orchestration.dispatchCommand` union shapes — **the two unions our customization adds members to** |
| where does a sequential rebase stop | commit **6 of 42**, at `3a1780bbf` (phase 4's gate block), on `apps/server/src/server.test.ts` |
| the whole conflict surface | **3 files of the 35 we modify**: that test, `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts` |
| is the vendored contract regenerable afterwards | **yes** — zero conflicts in the pinned closure |
| does the watermark still hold | **yes**, and against a real new migration: upstream added `043`, above the `042` our base leaves |
| `shape-check` | `generate.mjs --check` → `artifacts are up to date` |
| `verify` on both identities | upstream clean at `082e6ea52186`; fork clean at `3786b840e1a4` **on** `082e6ea52186` — the merge-base assertion |

**The measurement disagreed with the prediction, and the measurement wins.**
`packages/contracts/src/orchestration.ts` — rated **High** in `FORK.md`, and the file upstream
changed twice in exactly the unions we extend — **auto-merged clean**. What conflicted instead was
an upstream **test**, which `FORK.md` had already flagged as the half easiest to forget when
estimating the job. The risk table now carries both numbers.

**Zero churn would also have passed**, reported as `NO_UPSTREAM_MOVEMENT`. It is not what happened;
the churn is real, and which of the three outcomes it was is stated rather than left as a bare zero.

## Criterion 6 — UNMET, and why

**No iPad was available.** The architect asked twice and had no answer. This closes as unmet with a
stated reason, not as passed and not left open.

- The runbook exists and is executable: `codev/resources/250-ipad-acceptance-runbook.md`, 16
  numbered steps, each verified against the fork rather than written from memory.
- **The Playwright suite is NOT a substitute, and it must not be recorded as one.** It drives the
  same proxy and the same ceremony in a desktop browser, so it covers the approval path. What the
  iPad closes is the **tailnet reach** and the **touch targets** — and nothing on the Mac tests
  either of those.
- What it would take: a device on the tailnet, `pnpm dev:share` from the fork root, and about
  fifteen minutes.

## Regression runs, and what is red for reasons that are not ours

| Tree | Command | Result |
|---|---|---|
| Codev | `npm test -- --exclude='**/e2e/**'` | **7377 passed, 57 skipped**; 2 timeouts on the first run, both diagnosed below |
| Fork, web | `apps/web && npx vp test run` | **2984 passed** |
| Fork, server | `apps/server && npx vp test run` (whole server suite) | **2873 passed, 8 skipped, 1 failed** — the `entrypoint.test.ts` symlink one |
| Fork, typecheck | `vp run --filter @t3tools/contracts --filter t3 --filter @t3tools/web typecheck` | clean |
| Fork, whole monorepo | `npx vp test run` from the fork root | **8949 passed, 1 failed, 24 suites failed to load** |

**The 24 load failures and the 1 failure are all environmental or pre-existing, and none is in a
package spec 250 touches.** Stated with the reason rather than waved at:

- **22 × `apps/desktop/**`** — `Error: Electron failed to install correctly, please delete
  node_modules/electron and try installing again`. The Electron binary is not installed in this
  checkout. Spec 250 changes **0 files** under `apps/desktop` (measured:
  `git diff <base>..HEAD -- apps/desktop .github` is empty).
- **`.github/scripts/thread-transfer-report.test.cjs`** — "No test suite found in file". A CommonJS
  script the runner collects and cannot read.
- **`apps/web/src/terminal/ghostty/runtimeAbi.test.ts`** — needs a native artifact this checkout
  does not build.
- **`spec-250-vendoring-identities > reports zero fork drift as a named zero`** — timed out at the
  5s default on the first phase-11 run, 2s standalone. **Not flaky: the budget was wrong.**
  `classify-churn --fork-drift` re-emits the pinned closure once per closure-touching commit, and
  that range grows as the fork does. Raised to 30s with the reason at the call site.
- **`session-manager.test.ts > stderr tail logging (integration)`** — has timed out under
  full-suite load twice, in two sibling tests of the same block. Both spawn a real process, both
  pass alone. Recorded, not skipped.
- **`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint`** — the one real
  test failure, and it is pre-existing: byte-identical to the base commit, and macOS resolves
  `/var` to `/private/var`. Not skipped and not modified — editing an upstream test we did not
  break is gratuitous divergence on a fork that has to rebase.

## `apps/client`, the frozen fallback

**Frozen: confirmed.** `git diff <phase-7 boundary>..HEAD -- apps/client` is empty; its last commit
is spec 236's. Nothing from spec 250's phases 7-10 was backported.

**Green: confirmed, and the suites are named** — "still green" should not itself be an unchecked
claim.

| Suite | Command | Result |
|---|---|---|
| unit | `apps/client && npm test` (`vitest run`) | **16 files, 279 tests, 0 failed** |
| types | `apps/client && npm run check-types` (`tsc --noEmit`) | **clean** |
| e2e | `apps/client && npx playwright test` (3 specs, real servers) | **23 passed** |

### It was red first, and the reason is worth keeping

One of those 279 failed when phase 11 first looked. Spec 250's phase 5 regenerated the vendored
contract **from the fork**, our `codevGate` object landed ahead of the session object in the
generator's numbering, and the session-status enum moved from
`$defs.subscribeThreadOutput__Objects_6` to `_7`. `derive.test.ts` still read `_6`.

Fixed — one character, plus a comment saying why the number moved and that a positional read of a
generated artifact will move again.

**The freeze authorises this.** "Frozen means it keeps passing its tests and receives fixes, not
that new front-end features land in both places." A fallback whose suite is red is not a fallback:
the reason `apps/client` is kept is that if the t3code path fails there is still something that
works, and *works* is a claim its suite is the only evidence for.

**The assertion message is why this cost a minute instead of an hour.** It said: *"the generated
contract no longer declares the session status enum where this test reads it. That is this test
needing a new path, not a mapping change."* Two very different problems — a stale read path and a
broken status mapping — look identical at the failure site, and the message named which one.
`expected undefined to be defined` alone would have sent a reader into `deriveRowStatus`.

**The real gap is filed, not fixed here: [#265](https://github.com/pseudoseed/codev/issues/265).**
The root `npm test` filters to `@cluesmith/codev`, so nothing local runs `apps/client` at all — it
went red at phase 5 and nothing noticed until phase 11. CI would have caught it at PR time, which
makes it a near miss rather than a hole; "the frozen fallback's suite runs only in CI, and only once
a PR exists" is still too long a loop for the one package whose job is to still work.
