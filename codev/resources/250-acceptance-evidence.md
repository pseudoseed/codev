# Spec 250 — acceptance evidence

What was run, on what, with what result. One row per criterion, and **a criterion with no run and
no test says so** rather than borrowing another criterion's evidence.

Recorded 2026-08-31. Fork at `3786b840e1a4`; upstream preserved at `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`.

## The criteria

| # | What it asks | Evidence | Status |
|---|---|---|---|
| 1 | architect + 3 builders render as a tree, in t3code's own web app | `spec-250-hierarchy.spec.ts` — 9 Playwright tests against the live fork app | **met** |
| 2 | two architects render as two subtrees | `spec-250-hierarchy.spec.ts:265` | **met** |
| 3 | a gated builder shows the gate name and #128's question, from the gate block not the title | `spec-250-gate.spec.ts` — 9 tests, one of which asserts no thread title anywhere contains a gate name | **met** |
| 4 | the gate is approved from t3code and porch records session id, machine and timestamp in `status.yaml`, over `codev-agent`'s capability path | `spec-250-t3code-approval.e2e.test.ts` through the REAL fork server's proxy, ending in a real `status.yaml`; and `spec-250-approval.spec.ts` from a real browser | **met** |
| 5 | six builders at 1440x900, panes ≥340x240, body text ≥13px, measured against t3code's chrome | `spec-250-tiling.spec.ts:136` — measured from the browser's own geometry, not from the component's attribute | **met** |
| 5b | seven panes at 1920 tile 4x2, not 3x3 | `spec-250-tiling.spec.ts:243` | **met** |
| 6 | reached from an **iPad** over the tailnet, no account, no relay, driving a builder to completion | **no run** — see below | **UNMET** |
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

## `apps/client`, the frozen fallback

**Frozen: confirmed.** `git diff <phase-7 boundary>..HEAD -- apps/client` is empty; its last commit
is spec 236's. Nothing from spec 250's phases 7-10 was backported.

**Green: NO, and the cause is ours.** 278 of 279 pass.
`__tests__/derive.test.ts` reads the session-status enum from the generated contract at
`$defs.subscribeThreadOutput__Objects_6`; phase 5 regenerated that contract from the fork, our
`codevGate` object landed ahead of it in the generated numbering, and the enum is now at `_7`. The
mapping is unaffected — only the read path went stale, which is what the test's own failure message
says.

It went unnoticed because `apps/client` is not in the root `npm test` (that filters to
`@cluesmith/codev`), so its suite had not run since phase 5. Phase 11's deliverable is the first
thing that looked.

The fix is one character. **It is not applied here**, because `apps/client` is under a standing
freeze — raised with the architect rather than decided by me.
