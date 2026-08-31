# Review — Spec 250: t3code is the front end

## Summary

t3code became Codev's front end through a private fork (`pseudoseed/t3code@codev`), across **11
plan phases** landed as **106 `[Spec 250]` commits** on one branch — 167 commits in total, the
remainder being porch bookkeeping — across 130 files and ~40.6k insertions.
The fork gained a thread hierarchy (`parentThreadId` + `role`), a porch gate block with a
server-allocated revision, nested Workspace > Architect > Builders rendering in t3code's own
sidebar, a builder tile grid, and gate approval driven from t3code over a same-origin proxy.
**10 of 11 success criteria are met** (criterion 9 under the plan's amended reading); criterion
6, the iPad run, closes **UNMET** with a written runbook because no device was reachable.

Every number in this review is regenerated, not typed: `tools/t3-server/collect-spec-250-evidence.mjs`
rebuilds the measurement tables in `codev/resources/250-acceptance-evidence.md` and `--check`
exits 0 against the committed file.

## Spec Compliance

Full evidence, per criterion, in `codev/resources/250-acceptance-evidence.md`. Phase attribution
and the one-line evidence pointer:

- [x] **1.** Architect + 3 builders render as a tree in t3code's own web app (Phase 7) — `spec-250-hierarchy.spec.ts`, 9 Playwright tests against the live fork app.
- [x] **2.** Two architects render as two subtrees (Phase 7) — `spec-250-hierarchy.spec.ts:265`.
- [x] **3.** A gated builder shows the gate name and #128's structured question **from the gate block, not the title** (Phase 8) — `spec-250-gate.spec.ts`, 9 tests, one asserting no thread title anywhere contains a gate name.
- [x] **4.** The gate is approved from t3code and porch records the approving session id, machine and timestamp in `status.yaml` over `codev-agent`'s capability path (Phases 4, 6, 10) — `spec-250-t3code-approval.e2e.test.ts` through the real fork server's proxy into a real `status.yaml`, plus `spec-250-approval.spec.ts` from a real browser.
- [x] **5.** Six builders at 1440x900, panes ≥340x240 CSS px, body text ≥13px, measured against t3code's chrome (Phase 9) — `spec-250-tiling.spec.ts:136`, measured from the browser's own geometry rather than the component's attribute.
- [x] **5b.** Seven panes at 1920 tile **4x2, not 3x3** (Phase 9) — `spec-250-tiling.spec.ts:243`.
- [ ] **6. UNMET.** Reached from an iPad over the tailnet, no account, no relay, driving a builder to completion. **No run — no device on the tailnet.** Closed UNMET rather than as passed or left open, with the procedure at `codev/resources/250-ipad-acceptance-runbook.md`; every step that does not need the device was verified. See "Criterion 6 — UNMET, and why" in the evidence document.
- [x] **7.** A `role: null` thread created by t3code's own UI appears where it always did and nothing in the new tree claims it (Phase 7) — `spec-250-hierarchy.spec.ts:291`.
- [x] **8.** An existing database opens against the customized server, added columns read as "not recorded", and a projection rebuilt over a pre-fork event log decodes every historical `ThreadCreatedPayload` (Phases 2, 3) — `apps/server/src/codev/schemaGuard.test.ts` and the fork's projector tests.
- [x] **8b.** A migration interrupted partway leaves the database openable by the **pre-fork** server, tested by killing the server mid-migration (Phase 2) — `tools/t3-fork/criterion-8b.mjs`, evidence at `codev/research/250-criterion-8b-evidence.json`, `passed: true`.
- [x] **9. Met under the plan's amended reading**, and the difference is stated rather than smoothed over (Phase 11). Run literally, the fork does **not** rebase cleanly: a sequential rebase stops at commit **6 of 42** on `apps/server/src/server.test.ts`, and the whole conflict surface is **3 files of the 35 we modify**. The contract **does** regenerate from the rebased tree, and `shape-check` against it **moves 3 artifacts** (`schema.json`, `schema.ts`, `types.d.ts`) — the cost of adopting that base, measured rather than predicted. `verify` holds on both identities; upstream churn is 104 commits, 5 touching the pinned closure. All four clauses are tabulated against what was run in "What the criterion 9 wording asks for and what was run".
- [x] **10.** An approved gate cannot be re-displayed by a later write carrying a lower revision (Phases 4, 6) — the revision high-water-mark tests, and the live delivery in phase 6.
- [x] **11.** Hierarchy integrity refused by the server **at write time**, never rendered in a fallback (Phase 3) — `apps/server/src/codev/threadHierarchy.test.ts` plus live wire evidence at `codev/research/250-hierarchy-wire-evidence.json`, `passed: true`.

The spec's open question — **does `apps/client` survive?** — was ruled by the architect during the
project: it is **kept as the fallback and frozen.** Nothing from phases 7-10 is backported. The
freeze authorises fixes that keep its own suite green, and nothing more.

## Deviations from Plan

Per phase, what changed and why.

**Plan-wide, decided at review round 1.** Migration 900 was abandoned for
`apps/server/src/codev/schemaGuard.ts`: a numbered migration at 900 would have silently disabled
every future upstream migration below it, which is a rebase hazard that outlives the spec.

**Phase 2.** Criterion 8b moved from simulated to exercised. The plan's version constructed the
half-applied state by hand; that substitutes the thing whose absence is the risk. It became a
real child process killed mid-migration (`tools/t3-fork/criterion-8b.mjs`).

**Phase 4.** `CODEV_GATE_SCOPE_REQUIRED` was dropped from the refusal union — the transport
refuses first, so the reason was unreachable and a declared-but-unconstructable discriminant is a
lie in the type. Gate-writer provisioning became non-fatal and idempotent **by rotation, not
lookup**, because a lookup-keyed provision cannot be idempotent across a credential rotation.

**Phase 7.** Added `parent-elsewhere` to the sidebar's unattributed group, which the plan did not
call for. A parent archived after the fact orphans its children, and dropping them silently is a
second correct-looking answer.

**Phase 8.** The plan asked for a test of "a choice with no consequence". That state is
unrepresentable in the contract, so it is kept as a refusal test instead of deleted.

**Phase 9.** **Criterion 4b was added at the architect's direction** — "four columns fit", keyed
on **width alone, never on builder count**. Spec 146's wording is unchanged; this is an addition
to what phase 9 asserts, not a reinterpretation of an existing criterion.

**Phase 11 — the largest deviation, and it changed a success criterion's execution.** The plan's
phase-11 file list says `upstreamBase` and `commit` are "advanced by the drill". **They are not.**
Amended 2026-08-31 at the architect's direction: the drill runs in a throwaway clone and
`pin.json` never moves (`preserved.pinCommitUnchanged: true`). The reason is that the moment
`pin.json` names a new base, `verify-upstream` expects the preserved clone to *be* there, and
every spec 146 and 236 result tied to `082e6ea52186` stops being re-runnable. Advancing the base
is a decision taken when there is a reason — a security fix, a feature we need — never as a phase
deliverable. The spec's criterion 9 carries the amendment inline.

Also in phase 11: `apps/client` was found red and had been since phase 5. Fixed under the freeze,
which authorises exactly that.

## Consultation Feedback

Lanes: **Claude** and **opencode** on every implementation phase, plus **codex** on the plan
round. The **Gemini/agy lane produced no output for this project** and is absent from every
round rather than recorded as an approval. No `CONSULT_ERROR` was raised in any round.

Across **22 rounds** — 20 on implementation phases, 1 on the plan, 1 on the PR. Full per-round responses are
committed under
`codev/projects/250-t3code-is-the-front-end-privat/` as `*-rebuttals.md`. The **45 raw lane outputs
are `.txt` and gitignored** (`.gitignore:69`, `codev/projects/*/*.txt`) — they sit in the builder
worktree and do not travel with the PR, so the rebuttals are the durable record and the verdicts
below were transcribed from the raw files while they were still on disk. What follows is the
disposition of each round.

**Almost nothing was rebutted, and one rebuttal did not survive.** Across the 22 rounds, four
items were answered rather than changed — one brittleness note in phase 4, one deliberate deferral
in phase 9, and the drill's regeneration in phase 11 (deferred twice with reasons, then closed
after the last round). The fourth, the evidence collector's file mutation, was **rebutted in phase
11 and accepted in the review round**: the argument was sound for one of the six tests and had been
applied to all six. Every other finding was accepted and fixed; six rebuttals say in as many words
that no finding in their round was a false positive.

### Plan Phase (Round 1)

All three lanes returned **REQUEST_CHANGES**. Twenty findings, **all Addressed** — the plan was
rewritten before phase 1 began.

#### Claude
- **Concern**: Migration 900 would silently disable every future upstream migration. → **Addressed**: migration abandoned for `schemaGuard.ts`.
- **Concern**: Phase 1 breaks `spec-146-t3-contract.test.ts:254`; phase 5 breaks `:231`. → **Addressed**: both call sites updated in the phase that breaks them.
- **Concern**: Seven `T3CODE_ROOT` readers, not the three the plan named. → **Addressed**: all seven enumerated and repointed.
- **Concern**: Criterion 8b would pass by construction. → **Addressed**: rewritten as a kill test (and moot after phase 2).
- **Concern**: Phase 10 understates both modules it ports; fork-only phases carry no artifact in this repo; no abandonment path; fork suite scope unbounded. → **Addressed**: each written into the plan.

#### Codex
- **Concern**: Gate revision semantics not implementable as written. → **Addressed**: revision became server-allocated.
- **Concern**: `codev:gate-write` unenforceable at the referenced point. → **Addressed**: enforcement moved to the capability path.
- **Concern**: Phase 6's project map would be dead code. → **Addressed**: removed.
- **Concern**: Persistence work named too few modules; the proxy has no upstream-target trust boundary. → **Addressed**: the target is configured, not derived from the request.

#### opencode
- **Concern**: `codev.gateWrite` is never registered on the wire; gate commands must stay out of the client command unions; phase 5 would not vendor the method. → **Addressed**: all three — and the third resurfaced as a real defect in phase 5 (below).
- **Concern**: `acquire` still keys off `pin.commit`. → **Addressed**: this became phase 1's headline finding.
- **Concern**: Gate-write credential path unnamed; leftover revision return path. → **Addressed**.

**Two findings of my own, raised while verifying the lanes**: the CSP claim was **false** in both
my plan and the spec, and three phases planned tests with a tool the fork does not have. Both
corrected in the plan.

### Phase 1 (Round 1 — Claude APPROVE, opencode REQUEST_CHANGES; Round 2 — both APPROVE)

- **opencode**: `ready()` still runs full `verify()`. → **Addressed**.
- **opencode**: `verifyCheckout` treats a failed `git status` as clean. → **Addressed** — "I could not tell" was spelled the same as "clean".
- **Claude**: `FORK.md` overstates "nothing re-derives it"; a test heading says "the seventh readers" over six. → **Addressed**, both.
- **Claude (round 2)**: `--since` bypassed the ref-resolution guard; no direct test for the `NO_UPSTREAM_MOVEMENT` named zero. → **Addressed**, both.
- Items each lane flagged as *unverifiable from its session* are listed in the rebuttal rather than counted as findings.
- **N/A**: both lanes brushed against `pin.commit` moving to the fork head and neither asked for a change. The plan puts it at phase 5, so phases 2-4 run with the fork checkout ahead of `pin.commit` and bare `verify` reports `FORK_CHECKOUT_MISMATCH` in that window. Plan sequencing, not a phase 1 defect; flagged to the architect rather than resolved in-phase.

### Phase 2 (Round 1 — Claude REQUEST_CHANGES, opencode COMMENT; Round 2 — both APPROVE)

- **Both lanes**: "a newly introduced upstream migration still runs" never invoked the migrator. → **Addressed**, and it uncovered more than the finding: a whole class of tests here asserted against hand-built state.
- **Both lanes**: criterion 8b was simulated, not exercised. → **Addressed** — became a real kill test.
- **Claude**: `forkSkipReason` says "ahead" for any non-matching head. → **Addressed**.

### Phase 3 (Round 1 — both REQUEST_CHANGES; Round 2 — both APPROVE)

- **Blocking, both lanes**: the engine deleted every reason discriminant one layer above the tests, so the deliverable was destroyed where no test looked. → **Addressed**; the more useful half is *why it went unnoticed*, recorded in the phase log.
- **Non-blocking**: a test asserting its own literals; a test asserting its own input fixture; `commandInvariants.test.ts` had no Codev cases. → **Addressed**, all three.

### Phase 4 (Round 1 — both REQUEST_CHANGES; Round 2 — Claude APPROVE, opencode REQUEST_CHANGES; Round 3 — both APPROVE)

The longest round chain in the project, because one defect kept reappearing in different costumes.

- **BLOCKING**: the engine deleted gate refusals — the same shape as phase 3. → **Addressed**.
- **Concern**: "could not tell" shared a spelling with "no"; every unexpected cause was relabelled as a missing thread. → **Addressed**.
- **Concern**: `CODEV_GATE_SCOPE_REQUIRED` declared and never constructed. → **Addressed** by dropping it from the union.
- **Concern**: two of my own tests asserted nothing. → **Addressed**.
- **The finding that mattered most**: no projector coverage — the decider tests could not see the projector at all. → **Addressed**.
- **Concern**: the OAuth token allowlist exclusion was unasserted; the single credential was never named. → **Addressed**.
- **Round 2, opencode**: the credential had no production caller. → **Addressed** — costume one again, one layer further out.
- **Round 2, opencode**: the map row was asserted, the enforcement was not. → **Addressed**.
- **Round 2**: source-string assertions are brittle to reformatting. → **Acknowledged, not changed** in round 2; **Addressed** in round 3 once a non-brittle form existed.
- **Round 3, Claude**: `OrchestrationRefusal` kept a second copy of the refusal list; a doc comment documented a reason that cannot arrive. → **Addressed**, both.

### Phase 5 (Round 1 — Claude REQUEST_CHANGES, opencode COMMENT; Round 2 — both APPROVE)

- **Blocking, Claude**: `packages/types/src/t3/generated/schema.ts:2` named `51b55d4899e4` as a `pingdotgg/t3code` commit. That commit exists only in `pseudoseed/t3code` — the shipping module claimed upstream provenance for a fork commit, while `ATTRIBUTION.md` and `types.d.ts` had already been corrected. → **Addressed, and fixed one level up**: the three headers were three separate emissions of one claim and the third was a hand-written string elsewhere in `generate.mjs`, so correcting it in place would have left the shape that produced the miss. There is now a single `PROVENANCE` constant every emitter reads.
- Also closed in this phase, from the plan round: `codev.gateWrite` would have been vendored as **nothing at all**, because `generate.mjs` iterates `pin.methods` rather than the contract. The test that let it through asserted the input; it was replaced with one that asserts the generated output.
- **Round 2, one non-blocking note**. → **Addressed**.

### Phase 6 (Round 1 — Claude APPROVE, opencode REQUEST_CHANGES; Round 2 — both APPROVE)

- **opencode, blocking**: the gate watch is not torn down on reconnect. → **Addressed**; it needed a server the harness could not start, which is the finding's second half.
- **Claude**: three non-blocking notes. → **Addressed**.
- **Round 2, Claude**: the wire-evidence guard can flake on a fresh clone. → **Addressed**.

### Phase 7 (Round 1 — both APPROVE)

- **Concern**: `data-codev-builder-count` was two derivations of one fact. → **Addressed**.
- **Concern**: the tree covers the Active section only, documented nowhere outside a code comment. → **Addressed** by documenting it, and phase 8 inherits the boundary.
- **Concern**: no `package.json` script for the spec-250 Playwright config; `props.projectTitle ?? props.codevRoleLabel ?` reads ambiguously. → **Addressed**.

### Phase 8 (Round 1 — both APPROVE)

No blocking concerns from either lane. The fork suite was confirmed green after the last three
commits. One item was raised **by the architect during the phase rather than by a lane** and is
recorded as such in the rebuttal.

### Phase 9 (Round 1 — Claude APPROVE, opencode COMMENT)

Seven findings, all **Addressed**: the grid had no in-app entry point (and the test was complicit
in not noticing); the width was measured two ways; orphans were dropped from the grid; the sidebar
is 256px, not 232; two things the DOM was asserting that were not true; `--codev-pane-body` set and
consumed nowhere; the route computed the same grouping twice.

- One item **Rebutted**: "`BuilderPane` has no props for phase and messages, so phase 10 has to change the component." True, and intended — the architect ruled that pane content comes from `codev-agent` over the same-origin proxy in phase 10, with the fork's contract left unextended. Adding empty props in phase 9 would have been guessing the shape of data the phase cannot fetch.

### Phase 10 (Round 1 — Claude APPROVE, opencode REQUEST_CHANGES; Round 2 — Claude COMMENT, opencode APPROVE)

- **opencode, blocking**: the vitest e2e reported a **PASS on a run that never happened**. → **Addressed**, and it is the single most valuable finding of the project: a green suite that never executed is indistinguishable from a green suite that did, unless something asserts the run occurred.
- **Claude, non-blocking**: `UPSTREAM_TIMEOUT_MS` claimed more than the mechanism gives — an idle timeout does not bound a trickling upstream. → **Addressed** by correcting the claim in `agentProxy.ts` rather than the mechanism; the limitation is stated, not hidden.
- **Both lanes**: `data-codev-approval-state` was coarser than its own words. → **Addressed**.
- **Round 2, Claude**: the same-origin assertion was a **prefix match** (`url.startsWith(origin)`), and the agent host's ephemeral port can prefix-match the fixed web-app origin — `http://localhost:5733` is a prefix of `:57330`-`:57339`, ten ports inside macOS's ephemeral range, so about **0.06% of runs** would have counted a genuinely cross-origin request as same-origin and passed the phase's central security assertion anyway. → **Addressed**. A rare false pass is worse than a common one: 0.06% is exactly the rate at which nobody ever sees it fail.
- **Round 2, Claude, non-blocking**: `blob:` alongside `data:`. → **Addressed**.

### Phase 11 (Round 1 — Claude REQUEST_CHANGES, opencode COMMENT; Round 2 — Claude APPROVE, opencode COMMENT)

- **Claude, binding**: the drill's `ok` outcome **claimed** the contract regenerated and `shape-check` held, while the clean branch ran neither and both failure states were unreachable. → **Addressed**, but not in the round that raised it. **Both** rounds' rebuttals recorded it as *not changed*, with a stated reason — `generate.mjs` refuses any checkout whose `HEAD` is not `pin.commit`, so regenerating appeared to require moving the pin, which the phase-11 amendment forbids, and loosening the guard would have traded a real invariant for two outcome labels. It closed **after** iteration 2 (commit `4178aa4b5`), once the guard could be **satisfied rather than bypassed**: `git merge-tree` gives the merged tree an identity inside a throwaway clone, and a scratch copy of the codegen tool resolves a scratch `pin.json` naming it. The real `pin.json` is neither read nor written. The claim was fixed by making it true, not by narrowing it, and both new checks were verified capable of failing.
- **Claude**: the criterion 9 `shape-check` row described the current pin, not the rebase result. → **Addressed**.
- **Claude**: churn `104 / 5` was hand-typed. → **Addressed** — the whole measurement block is now generated by `collect-spec-250-evidence.mjs`, with `--check` in the suite.
- **Claude**: the regression run excluded `**/e2e/**`, so criteria 1, 2, 3, 5, 5b rested on phase 7-10 runs rather than a run at the final fork head. → **Addressed**: 32 Playwright tests re-run at `3786b840e1a4`.
- **Round 2, opencode**: my own tests would have failed a *correct* zero-movement drill. → **Addressed**.
- **Round 2**: a comment outlived the test it described by one commit; the churn classification was hand-typed prose; `contractRegeneration` was not in "every result". → **Addressed**, all three.
- **Round 2, Claude**: `spec-250-evidence-collector.test.ts` mutates two committed files and restores them in a `finally`. → **Rebutted**: the mutation is the only way to prove `--check` can fail, the restore is unconditional, and the alternative (a fixture copy) tests a copy rather than the committed file the check actually reads. Reasoning in `250-phase_11-iter2-rebuttals.md`.

### Review Phase (Round 1 — Claude APPROVE, opencode COMMENT)

The PR review. Neither lane raised a blocking finding; three items were accepted and one round of
fixes landed. Responses in `250-review-iter1-rebuttals.md`.

**Before either lane could run, both refused**, and correctly: `gh pr diff 266` returns HTTP 406
because GitHub caps the diff media type at 20,000 lines and this PR is 43,714. Both printed "a
reviewer cannot tell an empty diff from a failed fetch" — and both **exited 0** while printing it.
Filed as **#267**. Worked around with a `gh` shim serving `git diff origin/main...builder/spir-250`,
verified to produce the same 130 changed files the PR reports.

#### Claude
- **Concern**: `spec-250-evidence-collector.test.ts` mutates committed tracked files and restores them in a `finally`; a killed run leaves a dirty tree plus a stray backup, and parallel workers on the same paths would race. → **Addressed**, reversing the phase 11 round 2 rebuttal in part. That rebuttal's point held for **one** of the six tests — the one asserting the committed numbers still match the runs — and not for the five that work by *damaging* an input. The race is real and I had not checked for it: `spec-250-vendoring-identities.test.ts` reads `250-criterion-8b-evidence.json` in its **module body**, so a worker collecting it during the mutation fails on corrupted data with nothing in its output to explain why. The five damage cases now run a **copy of the collector under a `mkdtempSync` root**, the same `import.meta.url` technique the rebase drill uses — no flag added to the tool, nothing tracked written. Verified capable of failing, which this one needed: three of them assert exit 3 and `MISSING_RUN` is also exit 3, so an incomplete fixture would have passed them for the wrong reason. Removing all five mutations gives **5 failed, 1 passed**.
- **Concern**: the PR body says 166 commits, the review says 105 — reconcile or label what each counts. → **Addressed**. Both were also stale, taken against a local `main` behind `origin/main`. The branch is **167 commits, 106 of them `[Spec 250]`**, and both places now say which they count.
- **Concern**: `status.yaml` `history` records 9 review rounds while lane files exist for roughly 20. → **Addressed** by filing **#268**, not by editing the file. The pattern is exact rather than merely a gap: **a round is recorded if and only if at least one lane did not approve.** Phases 7, 8 and 9 — the three where both lanes approved on round 1 — are absent entirely, and every terminal approving round is missing. So a phase reviewed cleanly is indistinguishable from one never reviewed, and `history` understates review effort selectively, biased toward the phases that went badly.
- **Concern**: the product change lives in the private fork and is not reviewable from this diff; branch freshness and a live test run were unverified (no shell). → **N/A / checked**: the fork boundary was ruled at plan time and is stated in the PR body; the branch and counts were checked here with `git log` and `gh pr view`.

#### opencode
- **Concern**: criterion 6 is UNMET; criterion 9 is met only under the plan's amended reading; #264 is filed and unfixed on the approval path. → **N/A** — all three are already stated in the review, the evidence document and the PR body in those words. Recorded as independent confirmation, not as findings.

## Lessons Learned

### What Went Well

**The 3-way review found things no test could have.** Three of the project's most expensive
defects were found by a lane and not by the suite: the engine deleting refusal discriminants one
layer above where the tests looked (phases 3 and 4), `codev.gateWrite` vendoring as nothing at all
(phase 5), and a vitest e2e reporting a pass on a run that never happened (phase 10). Each was
green before the review.

**Evidence that regenerates cannot rot.** Every measurement in the acceptance document is produced
by `collect-spec-250-evidence.mjs` and checked by a test. Two rounds of "this number was typed"
findings stopped after the collector existed.

**Falsifiability as a standing rule.** Every regression test in this project was verified by
reverting its mechanism and confirming it fails. That rule caught tests that could not fail in
phases 4, 9 and 11 — each of which had been written, read and reviewed while incapable of failing.

**The screenshots ruled on things the tests approved.** Phase 7's tests passed on a tree the
screenshots showed was wrong; phase 9's tests passed on two defects the images made obvious. A
green Playwright run is not the deliverable.

### Challenges Encountered

**The same defect in five costumes.** A refusal reason declared in a type, deleted by an engine
layer, never constructed in production, asserted only in a decider test, and documented in a
comment that outlived it — one bug wearing five shapes across phases 3, 4 and 11. It cost three
review rounds in phase 4 alone. What eventually closed it was assertion **at the call site**
rather than at the module.

**Two commits that were equal, and a test that could not tell which it read.** `pin.commit` and
`pin.upstreamBase` were deliberately equal until the fork diverged. `classify-churn --fork-drift`
read the wrong one, every test had the right answer for the wrong reason, and the spec had *named
this exact hazard in prose*. It only became reachable once a ruling froze `pin.commit` while the
checkout moved on — and then the tool whose entire job is "what have we changed?" reported zero.

**A harness run poisoning the next suite run** (issue #263) made failures untrustworthy until the
rule "re-run a suspect suite alone before believing it" was adopted.

**Two node versions in one project.** Fork tooling needs Node 22; the codev suite must run under
Node 20 or `better-sqlite3` fails 724 tests in a way that looks exactly like a regression. This
cost real time more than once and is now written into the fork docs.

### What Would Be Done Differently

**Write the evidence collector in phase 1, not phase 11.** Every hand-typed number in the
acceptance document became a review finding. A generator that emits the measurement block and a
`--check` test that fails when the committed file drifts would have removed three rounds of
findings across two phases.

**Assert the seam before writing either end.** The phases that went cleanly (7, 8) are the ones
where the seam check came first. The phases that needed three rounds (4) are the ones where two
correct ends were built and the wiring between them was assumed.

**Name which identity a test reads while the two values are still equal.** A test written when
`commit == upstreamBase` cannot tell you which one the code reads. Either force them apart in the
fixture, or assert the field name in the source — before they diverge, because after they diverge
the bug already shipped.

### Methodology Improvements

**Porch should carry a "run alone" retry for a suspect failure.** Issue #263's poisoning made
every full-suite failure ambiguous. A protocol-level convention — a failure in a full run is not a
finding until it reproduces alone — would have saved time in three phases.

**A criterion that cannot be run needs a third status.** Criterion 6 is not met and not open; it
is **UNMET with a runbook**. The review template's checkbox has two states, and "we could not run
this and here is exactly how the next person does" is neither. It was written into the prose
instead, which works but relies on the reader noticing.

**An amended criterion should be amended in the spec, in place.** Criterion 9's amendment is
inline in the spec with the original wording preserved above it, and the evidence document
tabulates all four clauses against what was actually run. That shape is worth making standard: a
plan-level amendment recorded only in a review is invisible to anyone reading the spec later.

## Architecture Updates

- **Routed: cold** — `codev/resources/arch.md`, new `### The t3code Fork (Spec 250)` under `## Integration Points`: the two checkouts and their two pin identities, why the upstream clone must never be checked out, why the private repo is a *created* repo rather than a `gh repo fork` (a fork inherits the source's visibility), what `pin.contractSource: "fork"` changes about `verify`, the `schemaGuard.ts` watermark, and where the tooling lives. Placed under an existing top-level section deliberately, so the hot file's cold-doc map stays at its 12-topic cap.
- **Routed: hot** — `codev/resources/arch-critical.md`: one fact — t3code is the front end via the private fork, `/Users/chris/dev/t3code` is read-only, never `gh repo fork`, **`apps/client` is the frozen fallback**, and every fork commit obliges `REFRESH.md`. This is hot rather than cold because the expensive mistake it prevents is one a builder makes *before* consulting anything: extending the frozen `apps/client`, or checking out the read-only upstream clone.
- **Demotion, to respect the 10-fact cap** — the "governance docs are two-tier (Spec 987)" one-liner moved out of the hot tier into `arch.md`'s `## Governance Docs (Hot/Cold Tiers)` section, which already stated it in full. It is the one hot entry whose content is restated in the header comment of each hot file, which any producer editing one is already reading.
- Caps after the change: **10 facts, 12 map topics, 32 lines** — unchanged, all within the stated limits.

## Lessons Learned Updates

- **Routed: hot** (during the project, phases 2 and 4) — `lessons-critical.md` gained "a test that cannot fail is not a test — revert the fix and confirm the test fails", and the collaborator-substitution lesson was widened to the rule the five costumes produced: "a test that supplies the boundary itself cannot tell you the boundary exists — test the seam, not the two ends."
- **Demotion, to respect the 10-lesson cap** (during the project) — "when stuck, get an outside model's perspective and build a minimal repro" moved to `lessons-learned.md`, with **the trigger itself kept hot**, folded into the consultation lesson. A threshold only works if it is always-on: a stuck agent does not go and read the cold file, which is the whole reason it was hot.
- **Routed: cold** — `lessons-learned.md`, Critical: naming a hazard in a spec does not prevent it; only a test that can fail does — with the `classify-churn` account, and the general rule that a test written while two values are equal cannot tell you which one the code reads.
- **Routed: cold** — `lessons-learned.md`, Testing: a test whose work grows with the repository looks flaky before it looks under-budgeted, and the two have opposite remedies; and harness/screenshot runs poisoning the suite that follows them (issue #263).
- **Routed: cold** — `lessons-learned.md`, Testing, from the review round: a rebuttal is scoped to the tests its argument actually covers. The phase 11 rebuttal was sound for one test in a file of six and had been applied to all six, and applying it that widely also concealed a cross-file race nobody had looked for.

## Flaky Tests


`packages/codev/src/terminal/__tests__/session-manager.test.ts > stderr tail logging (integration)`
has timed out under full-suite load twice: `no stderr tail logged for file-based stderr` in phase 9,
and its sibling `logs session exit without stderr tail (stderr goes to file)` in phase 11. Both are
in the same block, both spawn a real process, and both pass alone. Recorded rather than skipped —
see the reasoning below, which applies to both. It spawns a real process, nothing in spec 250 goes near `src/terminal/`, and it
passed alone immediately afterwards and in the next full run (7370 passed, 0 failed). Recorded
rather than skipped: a test that passes on its own and once timed out under load is a timing
sensitivity, and annotating it as skipped would remove coverage to hide a slow machine.


### One timeout in phase 11 was NOT flaky, and calling it that would have been wrong

`spec-250-vendoring-identities.test.ts > reports zero fork drift as a named zero` timed out at the
5s default in phase 11's full run, and passed standalone in 2s. The tempting conclusion is "flaky
under load". It is not.

The test spawns `classify-churn --fork-drift`, which re-emits the whole pinned closure **once per
closure-touching commit in the range** — and that range grows every time the fork gains
customization. It was near-empty when the test was written and is 6 commits now. The work is real,
bounded by the fork's history, and rising; nothing about it is timing-sensitive.

So the budget was wrong, not the test: a 5s default that silently became too small turns a passing
test into an intermittent one without anyone touching it. Raised to 30s with the reason recorded at
the call site, because the next person to see it fail should not have to re-derive this.

The distinction matters because the two have opposite remedies. A flaky test is skipped or
stabilised; this one needed its budget corrected, and skipping it would have removed coverage of
`classify-churn`'s named-zero contract to hide arithmetic that is working correctly.


`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
Pre-existing and unrelated to spec 250: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is
empty, the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to
`/private/var`. Not skipped and not modified — editing an upstream test we did not break is
gratuitous divergence on a fork that has to rebase.

## Follow-up Items

- **Criterion 6, the iPad run.** Not descoped — unrun. The runbook is at `codev/resources/250-ipad-acceptance-runbook.md`, and every step that does not need the device was verified. It needs a device on the tailnet and nothing else.
- **A page-level CSP for t3code.** Explicitly not done in phase 10, recorded as a follow-up in the plan.
- **The proxy's idle timeout does not bound a trickling upstream.** Stated at the mechanism in `agentProxy.ts` rather than fixed; a total-duration ceiling is the fix if it ever matters.
- **Issue #263** — a harness run poisons the next suite run. Filed, not fixed here.
- **Issue #264** — a spurious "gate approved, run `porch next`" message reaches a builder from its own Playwright fixture. Filed, and the architect ruled it out of scope for this spec. It fired twice in this worktree; both times `porch status` showed no pending gate. **Any gate-approval message should be checked against `porch status` before acting on it.**
- **Issue #265** — root `npm test` filters to `@cluesmith/codev`, so nothing local runs the frozen `apps/client` suite. That is how it stayed red from phase 5 to phase 11 without anyone noticing.
- **Issue #268** — porch records only *failing* consultation rounds in `status.yaml` `history`: 9 recorded against 20 that ran, with phases 7, 8 and 9 absent entirely because both lanes approved them on the first round. A phase reviewed cleanly reads exactly like a phase never reviewed.
- **Issue #267** — `consult --type pr` cannot review a PR over GitHub's 20,000-line diff cap, and exits 0 when it refuses. Hit on this PR: `gh pr diff 266` returns HTTP 406 at 43,714 diff lines, both lanes correctly refused to review a 0-byte diff, and both returned exit 0 — so a caller checking the exit status sees a successful consultation with no output. Filed with a `pr-diff` fallback to `git diff <base>...<head>`, which has no cap and was verified to produce the same 130 changed files.
- **Issue #251** — folding the two t3code subscriptions per watched thread. Pre-existing, unrelated to this spec, noted because phase 6 touched the neighbourhood.
- **The architect has not ruled on the pane internals.** 12 screenshots at `docs/codev/spec-250/phase-10/` in the fork. The tests and measurements pass; what the panes *look like* is a human call and has not been made.

---

## Phase-by-phase record

Written incrementally as each phase landed, not reconstructed at the end. Kept because the
findings are the useful part: what was wrong, how it was found, and why the fix took the shape it
did. The sections above summarise; this is the working record.

## Phase 1 — Two-identity vendoring harness

### `acquire` wrote to the read-only clone

`acquire()` runs `git checkout --detach` against `T3CODE_ROOT`, and both `tools/t3-server/smoke.mjs`
and `packages/t3-client/live/integration.mjs` call it. Left on `pin.commit`, it would have checked a
**fork** sha out into the **upstream** clone the moment the fork diverged — from an ordinary test
run, not a deliberate invocation. The upstream clone exists precisely to stay reproducible at
`upstreamBase`; every piece of spec 146 and 236 evidence verifies against it.

Rewiring only `verify` would have left the one verb that *writes* still pointing at the fork. So
`acquire`, `start` and `status` are pinned to `upstreamBase`, and the test for it does not read the
source: it builds a throwaway repository with two commits, points `upstreamBase` at the earlier and
`commit` at the later, runs `acquire`, and asserts which sha the tree landed on.

### `verifyCheckout` reported "clean" for a checkout it could not read

Inherited from the spec 146 version, comment and all. The `git status` catch fell through to
`dirty = ''`, and an empty string is how "clean" is spelled — while the comment above it claimed
the case was reported as undetermined. It had been answering "fine" to "I could not look" for as
long as the file existed.

Found by a review lane reading the new file, not by any test. The test that now covers it triggers
the condition for real (`chmod 000` on `.git/index` leaves `rev-parse HEAD` working and makes
`git status` exit 128) and refuses to pass vacuously if the platform ignores the mode.

### Three exit codes, and the cases that were collapsed into the wrong one

Adding a second identity multiplied the "could not determine" cases and several were initially
answered as `1`:

| Case | Was | Is |
|---|---|---|
| Fork checkout absent | — | `3` `NO_FORK_CHECKOUT` |
| Fork HEAD unreadable | — | `3` `NO_FORK_HEAD` |
| `git status` failed | `0` **clean** | `3` `NO_<ID>_STATUS` |
| Merge-base uncomputable | — | `3` `NO_FORK_MERGE_BASE` |
| Contract commit absent from the fork | `1` wrong commit | `3` `NO_FORK_ANCESTRY` |
| Fork does not descend from `upstreamBase` | — | `1` `FORK_BASE_MISMATCH` |

The last row is the one worth keeping: "I could not compute a merge-base" and "the merge-base is
wrong" are different facts, and collapsing them would let a corrupt or mis-pointed checkout read as
a deliberate rebase.

---

## Phase 2 — Thread hierarchy in the fork's contract and projection

### The plan's wiring premise was wrong, and the wrong version would have passed its own test

**This is the most important finding in the project so far.**

The plan said to sequence the schema guard after `MigrationsLive` (`persistence/Migrations.ts:173`).
`MigrationsLive` is exported and **nothing in the tree builds it** — every reference is its own
definition or its own docstring. The real boot path is `persistence/Layers/Sqlite.ts`'s `setup`,
which calls `runMigrations()` directly and is what both `makeSqlitePersistenceLive` and
`SqlitePersistenceMemory` provide.

A guard hung off `MigrationsLive` would therefore **never have run in production**. And it would
not have looked broken: a test that constructs `MigrationsLive` itself and asserts the columns
appear passes perfectly. The layer works. Nothing builds it. Those are different claims and only
one of them was being tested.

This is #222's exact shape, and it is the failure mode that cost this program thirteen phases of
invisible plumbing. What caught it was reading the real boot path instead of trusting the plan's
premise — a grep for who actually constructs the thing, before wiring anything to it.

The guard is called from `setup`, and the ordering assertion reads that production file rather than
any layer the test assembles:

```
const migrations = sqliteLayerSource.indexOf("yield* runMigrations()");
const guard = sqliteLayerSource.indexOf("yield* codevSchemaGuardStep()");
assert.ok(migrations < guard, ...);
```

A second assertion pins the guard inside `setup` specifically, because both persistence layers
provide `setup` — if it ever moves into only one of them, the other boots silently without the
columns.

### Two spellings for the same two fields, and why a rebase must not "tidy" them

`ThreadCreatedPayload` uses `Schema.NullOr(...).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`.
`OrchestrationThread` and `OrchestrationThreadShell` use `Schema.optional(Schema.NullOr(...))`.

**This asymmetry is deliberate and load-bearing. Do not unify it.**

The payload keeps a decoding default because the event log is full of `thread.created` payloads
written before the fields existed, a projection rebuild replays every one of them, and the projector
reads `payload.role` unconditionally. Defaulting is what makes that read total; `optional` would
make it `| undefined` and push a branch into the hot path of every rebuild.

The read models use `optional` because that is what `linkedPullRequest` — upstream's own newest
field, sitting one line above — does, and for the same stated reason: cached snapshots from older
servers still decode. Applying the strict form to them produced **32 errors across 11 upstream test
files**. On a fork that must be rebased for the lifetime of the project, that is a recurring cost
paid every rebase, in exchange for removing `undefined` from a read model the server never emits as
`undefined`: every server read path normalizes with `?? null`.

Final upstream test churn for the whole phase: 5 fixture edits across 3 files.

The trap for a future rebase is that the strict form *looks* more correct in isolation. It is more
correct in isolation. It is worse here, and the reason is not visible from the diff.

### The ruling that froze `pin.commit` broke two phase-1 tools, silently

`pin.commit` means "the vendored contract was generated from this commit" and only regeneration
moves it, so it stays at `upstreamBase` until phase 5. Both tools below were written when
`pin.commit` and the fork HEAD were the same commit, and both had the right answer for the wrong
reason until they diverged.

1. **`classify-churn --fork-drift` measured `upstreamBase..pin.commit`.** After the freeze, a fork
   carrying real customization commits reported **zero drift**. The tool whose entire job is
   answering "what have we changed?" answered "nothing", confidently, with exit `0`. Now measures to
   `HEAD`, which is correct on both sides of phase 5.
2. **The first commit in any range was reported `baseline` and never classified**, because
   `git log from..to` excludes `from`. With a single fork commit the mode returned a placeholder
   instead of a verdict. Seeded from the range start, guarded so a `--since` *date* still falls back
   to `baseline` rather than guessing a commit.

The generalizable half is in `lessons-learned.md`: a test written while two values are equal cannot
tell you which one the code reads.

### The fork live suite skips for three phases, and says so

`spec-146-t3-contract.test.ts`'s fork-hash suite compares generated artifacts against the fork
checkout — valid only while that checkout sits ON `pin.commit`. Through phases 2-4 it does not.

Failing for three phases straight would train everyone to ignore a red suite, which is the failure
the ahead-vs-wrong distinction exists to prevent. It is gated on `FORK_AT_CONTRACT` and the suite
name carries which of three reasons it skipped for:

```
spec 250 [live: needs the fork checkout ON pin.commit — fork is at 1a414cee8409,
ahead of contract commit 082e6ea52186 (expected until phase 5 regenerates)]
```

A skip nobody can see the end of is how a suite quietly stops existing, so a test asserts the gate
is the contract commit rather than mere presence, and that it reopens by itself once phase 5 moves
the pin.

### Two acceptance criteria were tested by substitution, and review caught both

Both lanes named the same two, independently, and both were right.

**"A newly introduced upstream migration still runs after the guard"** was tested with a raw
`ALTER TABLE pretend_upstream_column`. That proves SQLite accepts another column. It says nothing
about whether the watermark let the *migrator* execute one — which is the entire question migration
900 got wrong, and therefore the entire point of the test. The fix runs
`runMigrations({ toMigrationInclusive: 41 })` → guard → `runMigrations()` and asserts 42 actually
executed and its column exists, which is upstream's own idiom.

The lesson is narrower than "test the real thing": the substitution was *adjacent* to the
mechanism and produced identical observable state. A column appeared either way. Only the path it
appeared by was in question, and that is exactly what the assertion had dropped.

**Criterion 8b** — "the server is killed partway through applying the columns and the resulting
database still opens against the pre-fork server binary" — was an in-process simulation on an
in-memory database. No kill, no file, no pre-fork binary. Three of the criterion's four nouns were
missing and the remaining one still passed.

It is now exercised, in `tools/t3-fork/criterion-8b.mjs`, recorded to
`codev/research/250-criterion-8b-evidence.json`:

| Step | Result |
|---|---|
| Pinned `t3@0.0.36` creates and migrates a real database | opened and answered |
| Codev columns present before the run | none |
| Child SIGKILLed after the first `ALTER` | `SIGKILL`, `codev_role` alone on disk |
| **Pinned pre-fork server opens the half-applied file** | **opened and answered** |
| Fork's real guard resumes | added `codev_parent_thread_id`, found `codev_role` present |
| Pre-fork server opens the fully applied file | opened and answered |

#### Why `start --keep-data` had to exist

This is the part a future reader of a green 8b most needs, because a passing criterion carries no
trace of having once been unprovable.

Writing the real test failed before it ran, on the harness rather than on the code. Criterion 8b
requires opening a database that a *previous* run left behind, and neither existing verb can:

| Verb | What it does | Why it cannot host 8b |
|---|---|---|
| `start` | wipes the data dir, then starts | deletes the half-applied file the criterion is about |
| `restart` | stop-then-start, keeping data | refuses when nothing is running — and after a kill, nothing is |

So the criterion had **no expressible form**, and had had none for as long as it had existed. That
is the finding, and it outranks the code: the in-memory simulation was not laziness, it was the
only thing the available tools could express. Whoever wrote it had a green check and no way to
learn it was green for free.

Nothing reported the gap. There was no failing test, no error, no skip — the criterion sat in the
plan reading exactly like one that passes, and **it took writing the test to discover the test
could not be written**. That is a rung below "a check that answers when it could not observe": there
was no check, because nothing could host one, and an absence has no output to inspect.

`start --keep-data` closes it. The verb exists solely so a criterion about opening an existing
database can be stated at all, which is why it is worth a line in the harness README and this
paragraph here rather than a one-word changelog entry. Filed as evidence on #199.

---

## Phase 3 — Hierarchy integrity refused at write time

### The engine deleted the entire deliverable, one layer above the tests

Both review lanes found this independently, and it is the sharpest instance yet of the pattern this
project keeps producing.

Phase 3's deliverable is six **reason discriminants**, so a caller can tell a retry ("no such
parent") from a caller bug ("wrong parent role"). `OrchestrationEngine` mapped every error the
decider raised except `OrchestrationCommandInvariantError` onto a generic invariant error reading:

> `Failed to generate an event identifier.`

For a hierarchy refusal that is not lossy, it is **false** — and it did not stop at the response.
The rejected-command receipt records `error.message`, and that receipt is replayed verbatim on any
redispatch of the same `commandId`. The wrong answer was the *permanent* answer.

All fifteen decider tests were green throughout, because they call `decideOrchestrationCommand`
directly. **The decider is not a boundary anyone sees; the engine is.** A discriminant that does not
survive the wrapper does not exist, and no quantity of testing beneath the wrapper can report that.

This is phase 2's `MigrationsLive` finding in a different costume: *testing the layer below the one
production uses*. There it was a layer nothing built; here it is a layer something wraps. Both pass
their own tests while production does something else, and in both cases the passing test is what
made the gap invisible.

The regression test was **verified to discriminate** rather than assumed: with the mapping reverted,
3 of its 4 tests fail; restored, all 4 pass. On this project that check has stopped being optional.

### Two of my own tests asserted nothing

Both caught by review, and both worth recording because they are cheap to write by accident.

**A Set of its own literals.** A test named "every refusal reports a distinct, actionable reason"
built `new Set([...six string literals])` and asserted `size === 6`. That proves six distinct
strings are six distinct strings. Every refusal could have collapsed onto a single discriminant and
it would have passed — while *claiming*, in its name, to guard exactly that. It now collects the
reasons six real dispatches return.

**An assertion against its own input.** A test archived a parent and then asserted on
`model.threads` — the object it had just constructed, which the decider never mutates. It would
have passed whatever the decider emitted. It now asserts the output: one event, one aggregate, no
event mentioning the child.

The common thread is that both tests read as if they were about the system, and both were about the
test. Neither could fail.

### Orphaning by omission

Archiving a parent is a single-aggregate event that says nothing about children. That is what makes
the orphan case work: nobody has to remember *not* to write a cascade. The test asserts the
omission directly — no emitted event mentions the child — rather than asserting a downstream state
that a cascade might also produce.

Creating a builder under an *already archived* architect is accepted. The rule is about the edge's
shape, not the parent's lifecycle; refusing would mean archiving silently changes which commands
are legal, which is a second rule nobody wrote down.

### Two things left deliberately, both recorded rather than fixed

**`parent-not-architect` covers two of the plan's listed cases** — a builder parented to another
builder, and one parented to a `role: null` thread. They share a discriminant because they share a
*reason*: the parent is not an architect. The `detail` distinguishes them for a human. If phase 7
ever needs to word them differently in the UI it will need two discriminants, and that is a cheap
change; splitting them now would have invented a distinction no caller acts on.

**The ws/RPC hop is untested**, raised by review at the close of phase 3 and now a phase 6
acceptance item rather than a note. The reasoning is this project's own history: it has been caught
twice testing below the layer production uses, and the boundary above the engine is the last hop
nothing has exercised. `porch-driver` is the first real client, so phase 6 is where a refusal
dispatched over the wire must still let a caller tell "no such parent" from "wrong parent role". A
discriminant that does not survive serialization does not exist.

### A crashed run destroying passing evidence

`criterion-8b.mjs` was documented as `> evidence.json`. A shell redirect truncates the target the
instant the process starts, so a transiently crashed run left an **empty** evidence file where a
passing one had been — and the suite then failed on a file that said nothing, rather than on the run
that broke. A good record was destroyed before anyone noticed.

`--out <path>` now writes once, at the end, and only when the run passed. A failed run leaves the
previous record untouched and reports itself through its exit code and stdout.

Worth generalizing: **a redirect is not a way to save a result, it is a way to destroy one early.**
Anything that records evidence a test later depends on should write on success, not on start.

---

## Phase 4 — Porch gate block with a server-allocated revision

### The mark has to outlive the thing it described

Criterion 10 — clear an approved gate, deliver a lower revision, the gate does not reappear — is
carried by one design choice: `gateRevision` lives **on the thread, not inside the gate block**, and
the *clear* raises it as well as the set.

Inside the block it would have vanished with the block, the stale write would have been the first
one at that revision, and an answered gate would be back in front of a human. The rule generalizes:
a monotonic guard has to outlive the state it guards, or clearing that state resets the guard.

Two rules that looked contradictory in the plan resolve into one by making `revision` **optional on
the command**: absent means the server allocates, present means apply only if it exceeds the mark.
Equal is refused as well as lower, because two writers that computed the same number are colliding,
not agreeing.

### The one defect, in five costumes — read this before wiring phase 6

#### The remedy, first, because the diagnosis is the easy half

**Assert the call site, not the module.**

Every one of the five below was caught by that single move, and every one of them would have been
prevented by it. Look at what the passing tests actually asserted:

| The test said | The question it never asked |
|---|---|
| the provisioner writes a token | does the server ever run the provisioner? |
| the guard alters a column | does anything build the layer the guard hangs off? |
| the decider refuses, with a reason | does that reason survive the wrapper the caller talks to? |
| the projector applies an event | do the decider's tests use a projected model, or one they built? |
| the scope map has a row | does the transport read that row? |

All green. All meaningless — not because the assertions were wrong, but because each asked whether
the code *works* and none asked whether production *reaches* it. Those are different questions and
only the second one was ever in doubt.

So the remedy is mechanical and cheap: when the risk is "production may not reach this", the
assertion goes on the caller. Read `serverRuntimeStartup.ts` and require the provisioner to appear
in it. Read `Layers/Sqlite.ts` and require the guard to run after the migrator. Read `ws.ts` and
require the scope lookup to wrap every RPC. These read as crude tests and they are the only ones
that could have failed.

#### And the diagnosis

Five findings across phases 2, 3 and 4 are the same defect wearing different clothes. Every one of
them passed its own tests. Every one was found by review or by a compiler, never by the suite that
was supposed to cover it.

| # | Costume | What was tested | What production did |
|---|---|---|---|
| 1 | **A layer nothing builds** | `MigrationsLive` constructed by the test, columns appear | `MigrationsLive` is exported and nothing builds it; the real path is `Layers/Sqlite.ts`'s `setup` |
| 2 | **A layer something wraps** | the decider's six discriminants, called directly | `OrchestrationEngine` rewrote them all as "Failed to generate an event identifier", then persisted it |
| 3 | **A decider tested without its engine** | gate revision rules, decider-only | `isRefusal` dropped the new refusal type; criterion 10 was false at the wire |
| 4 | **A read model every test hand-builds** | eleven decider tests, each building its own read model | a projector that dropped `gateRevision` would pass all of them while every write re-allocated revision 1 |
| 5 | **A module nothing calls** | the gate credential's scopes, path and write, all unit-tested | nothing in the server provisioned it; written one commit *after* this table |

The single sentence they share: **a test that supplies the boundary itself cannot tell you the
boundary exists.** Constructing the layer, calling under the wrapper, hand-building the read model —
each substitutes the thing whose absence or misbehaviour is the actual risk.

The rule that follows, and the one phase 6 needs: **when a value is produced in one layer and
consumed in another, test the seam, not the two ends.** That sentence is now the hot-tier lesson at
slot 8, which previously read *"a test that constructs the collaborator itself proves the
collaborator works, never that production constructs it"* — the same idea, one costume wide. The
collaborator case survives as an example clause. Phase 6 wires `porch-driver` across the
ws/RPC boundary — the last untested hop, and already an acceptance item — and it is the fifth place
this can happen. A `porch-driver` test that constructs its own transport would be costume five.

Costume 3 is now closed by construction rather than by care: see below.

**And then phase 4 produced costume five, one commit after writing this table.** The
`codev:gate-write` credential module named its scopes, named its on-disk path, tested the write —
and nothing in the server called any of it. Both review lanes found it. Its own tests were green and
every one of them was meaningless for the only question that mattered.

That is worth keeping rather than quietly fixing, because it says something the table alone does
not: **knowing the pattern does not prevent it.** The table was written, committed, and the same
defect went in beside it within the hour. What caught it was review, and what stops it recurring is
the test that now asserts the *call site* — `serverRuntimeStartup.ts` imports the provisioner and
runs it as a named phase — rather than asserting the module works.

### The same function, the third time

`isRefusal` in `OrchestrationEngine` decides which errors reach a dispatcher intact. Phase 3 fixed
it once, for `CodevHierarchyInvalidError`. Phase 4 added a **third** refusal type and did not extend
it — so every gate refusal, including the stale write that *is* criterion 10, was rewritten as
"Failed to generate an event identifier", and criterion 10 was false at the wire while all eleven
decider tests stayed green.

Both lanes found it independently. What generalizes is narrow and mechanical: **a predicate that
enumerates a category has to be extended whenever the category grows, and nothing in the type system
says so.** The union it feeds is structural; the predicate is a hand-written disjunction. Adding a
member to the union and forgetting the predicate compiles cleanly and silently drops the new member.
A type-level exhaustiveness check would have caught all three occurrences — so phase 4 added one
rather than filing a follow-up, on the reasoning that a follow-up issue is a promise to hit it a
fourth time.

`dispatchErrorKind` now classifies **every** member of `OrchestrationDispatchError` in a switch whose
`default` assigns to `never`. `isRefusal` reads that classification instead of keeping its own list,
so there is one place to update. Adding a member without classifying it **does not compile**, and the
error names the forgotten type:

```
src/orchestration/Layers/OrchestrationEngine.ts(122,13):
  error TS2322: Type 'ProbeUnclassifiedError' is not assignable to type 'never'.
```

Verified the way everything else on this project now is: a fourth member was added, the build was
confirmed to fail, and it was removed. At runtime an unrecognised error classifies as `internal` —
the safe direction, because a refusal misclassified as internal is a worse message, while an
internal error misclassified as a refusal is a lie about whose fault it was.

This is worth more than the three fixes it replaces: it converts a recurring runtime falsehood into
a build error.

### No test saw the projector, and the decider tests could not

The best finding of phase 4, from the claude lane: nothing asserted that the read model applies
either gate event.

Every decider test hand-builds its read model. So a projector that dropped `gateRevision` would pass
all eleven of them — while every write after the first re-allocated revision 1, and criterion 10
became unenforceable. The mechanism's own test suite could not see the mechanism failing.

This is the same family as the `MigrationsLive` and `isRefusal` findings, and worth stating as one
rule: **when a value is produced in one layer and consumed in another, a test that constructs the
intermediate state by hand tests neither.** The decider tests build the read model; the projector
builds it in production. Only a test that lets the projector build it can tell you the two agree.

### Three claims, three tests, all verified to fail

By phase 4 the "revert the fix and confirm the test fails" check had become routine, and it earned
its place three times in one phase: the engine's `isRefusal`, the projector's mark, and the wire's
decoding default. Each was verified by removing the mechanism and watching the specific test go red.

Also caught this way: a test asserting the revision column rejects NULL ran its `UPDATE` against an
**empty table**. Zero rows touched, trivially successful. It was noticed only because the assertion
expected a refusal — written the other way round it would have passed forever.

### A count hardcoded in a driver, failing for a reason unrelated to what it measures

`criterion-8b.mjs` hardcoded a two-element Codev column list. Phase 4 added two more columns and the
driver failed — **while the criterion it exists to protect still held**. The pinned pre-fork server
opened both the half-applied and the fully-applied database exactly as before.

That is a false negative on the thing the driver was built to guard, and it is worse than a plain
bug: the next person sees a red 8b, concludes the crash-safety property broke, and goes looking in
the wrong place. Now derived from what the guard itself reports, asserted as properties rather than
counts.

### A test that could not fail, caught by running it

The first version of "the revision column rejects NULL" ran `UPDATE projection_threads SET
codev_gate_revision = NULL` against an **empty table**. Zero rows touched, trivially successful, and
the assertion that it should have been refused failed — which is the only reason it was noticed. Had
it been written the other way round it would have passed forever while proving nothing.

The fix is one line: insert a row first, so the constraint has something to refuse. The lesson is
that "assert the constraint, not the DDL" is not enough on its own — the assertion also needs
something for the constraint to act on.

## Phase 5 — The vendored contract, regenerated from the fork

### The undecidable verdict, and why it was neither a pass nor a break

`classify-churn.mjs --fork-drift` returns three commits as `consumed-change-undecidable`. The
classifier sets `unknown` the moment a union's emitted JSON differs at all, additive or not, and
says so instead of guessing. The named input for this phase was one of them; running it against
the finished fork found three:

| Commit | Method | Classifier |
|---|---|---|
| `1a414cee8409` (phase 2) | `orchestration.subscribeThread` | union shape changed; not decidable here |
| `e1b7f7b04af5` (phase 3) | `orchestration.dispatchCommand` | union shape changed; not decidable here |
| `3a1780bbf66f` (phase 4) | `orchestration.subscribeThread` | union shape changed; not decidable here |

Deciding them means matching union members by their discriminant literal and comparing the matched
pairs, which is exactly the step the classifier declines to take. Done that way over the whole
range `upstreamBase..pin.commit`:

```
subscribeThread  output   <kind=snapshot>/snapshot/thread/{role,parentThreadId,codevGate,gateRevision}: added
                          <kind=event>/event<type=thread.created>/payload/{role,parentThreadId}: added
                          <kind=event>/event: alternative added codev.gate-set
                          <kind=event>/event: alternative added codev.gate-cleared
dispatchCommand  input    <type=thread.create>/{role,parentThreadId}: added, neither required
```

Ten findings, and not one removal, narrowed type, newly-required property, lost enum member, or
tightened `additionalProperties`. Nine of the ten are non-breaking under the rules the classifier
already states. **The tenth is not, and it is the reason the phase exists.**

On an *output*, a new union alternative is a shape the client must now handle. A client
shape-checking the `subscribeThread` stream against the pre-regeneration contract does not ignore a
`codev.gate-set` frame — it *rejects* it, because the frame matches no member of the union that
client knows. Phase 4 shipped the server side of gate writes into a repository whose vendored
contract could not decode the events they produce.

So the verdict is: **non-breaking in every respect but one, and that one is breaking against the
upstream-generated contract and non-breaking against the regenerated one.** Regenerating is the
fix, not a formality that follows it.

`spec-250-generated-contract.test.ts` holds both halves. The second half is the one that matters:
it rebuilds the pre-regeneration union by removing the two `codev.*` alternatives and asserts the
frame fails against it. Without that, "the contract accepts the frame" would be a claim about
nothing — the frame would have passed against a union that never rejected anything.

### `codev.gateWrite` would have been vendored as nothing at all

`generate.mjs` iterates `Object.entries(pin.methods)`, not the contract's RPC map. A method that
exists in the fork and is missing from `pin.methods` is not an error: it produces no schema, no
`methods.json` entry, and `checked.ts` then answers `unchecked` for every one of its payloads —
which is the "I had nothing to look with" signal working exactly as designed, arriving for a reason
nobody would have gone looking for.

The precedent was already in the file. `vcs.*` are recorded by hand precisely because their method
strings live in the unvendored `rpc.ts`; `codev.gateWrite` is the same situation. What did not
transfer was the resolution: the non-`OrchestrationRpcSchemas` branch resolved schema names from
`git.ts` and nothing else, and `CodevGateWriteInput` lives in `orchestration.ts`. The branch now
takes the module from `spec.source`, and reverting that change makes generation fail with
`pin.json names CodevGateWriteInput for codev.gateWrite, but git.ts does not export it.` rather than
silently emitting nothing.

`classify-churn.mjs` carried the same hardcoding and is fixed with it. Left alone it would have
reported `codev.gateWrite: <absent>` at every commit — "the method is not in the contract" spelled
identically to "this tool looked in the wrong file".

### The checker threw on the payload it was vendored to check

The round-trip test for the new method did not fail an assertion. It raised
`UnsupportedKeywordError: shape-check does not implement JSON Schema keyword "minItems"`.

Phase 4 bounded the gate's `choices` to one-to-five entries, which is the first schema in the
vendored closure to emit `minItems`/`maxItems`, and `shapeCheck` throws rather than passing on a
keyword it has not implemented — a refusal to report a match for something it did not check. So
`checked.ts` would have thrown at the call site on every gate-write payload, having been given a
schema it could not walk.

Implementing the two keywords is a strengthening, not the relaxation the phase deliverable forbids:
nothing that passed before fails now, nothing that failed before passes, and the checker's stated
semantics — lower bound on branded ids, excess ignored to mirror the decoder — are untouched. Both
halves were verified by reverting: dropping the keywords from `SUPPORTED` makes the round-trip throw
again, and keeping them supported while deleting the two bound checks makes only the bounds test
fail.

This is the fourth time on this project that a thing was wired and its call site was not exercised.
The test that caught it is the one that constructs the payload a caller would send and runs the
production checker over it, rather than asserting that the schema contains a `minItems` key.

### The cold-start evidence had to be re-scoped, and its collector with it

`spec-146-t3-contract.test.ts` asserted `evidence.pinnedCommit === pin.commit`. That held only while
the two identities were equal. This phase moves `pin.commit` onto the fork head, and the evidence
describes the **upstream** harness starting the **upstream** server from the read-only clone, so the
commit it should be checked against is `pin.upstreamBase`.

Re-collecting it against the fork would have been the wrong fix — it changes what the evidence is
evidence *of* while every assertion stays green, and spec 146's criteria about the pinned harness
would quietly stop meaning what they said.

Re-scoping only the test would have been half a fix. `smoke.mjs` still wrote `pinnedCommit:
pin.commit`, so the next collection would have recorded a fork sha as the provenance of an upstream
run. The field is therefore **renamed** — `pinnedCommit` to `upstreamCommit` — and reads
`pin.upstreamBase`. A rename rather than a re-point, so evidence written under the old meaning
cannot be read as though it were written under the new one; the test asserts the old key is absent,
which is what makes that true rather than merely intended. `collect-phase10-evidence.mjs` carried
the same expression and is fixed the same way.

### A gate that had to reopen without being touched

The fork-hash live suite is gated on `FORK_AT_CONTRACT` — fork HEAD equals `pin.commit`. It was
false by design for three phases and the suite skipped, naming its reason. Moving the pin makes it
true again with no edit to the gate.

That is worth asserting because the failure is silent in the other direction: a regeneration that
put `pin.commit` somewhere the checkout is not would leave the suite skipping forever, reported as a
skip reason nobody reads, while `contractSource` claimed the contract was fork-sourced. The
assertion lives **outside** the gated block, because a gate cannot assert that it opened.

### The flip, asserted against what actually ships

Phase 1 built `FORK_AHEAD_OF_CONTRACT` exiting `0` under `contractSource: "upstream"` and `1` under
`"fork"`, with fixture repositories proving both. Those fixtures build their own pin, so they would
have kept passing if the shipped pin never flipped. The phase adds two assertions they cannot make:
one reading `pin.contractSource` from the file that ships, and one running the harness against the
**real** fork checkout with a pin whose `commit` is the real HEAD's parent — a genuine ancestor,
which makes the real checkout genuinely ahead, with the same run repeated under `"upstream"` so the
test cannot pass against a harness that simply exits 1 on every ahead-ness.

### Two lanes, one finding, and the enumeration that let it through

Both reviewers landed on the same line. `generated/schema.ts:2` still read `Source:
<upstream repo> @ <fork commit>` — a commit that exists nowhere in the repository the line names.
`ATTRIBUTION.md` and `types.d.ts` had been corrected; `schema.ts` had not, and it is the module
that ships.

The three headers were three separate emissions of one claim, the third written as a standalone
string in a different part of `generate.mjs`. Fixing the third copy would have left the shape that
produced the miss, so there is one `PROVENANCE` constant now and every emitter reads it.

The sharper half of the finding is the test. The attribution case named two files by hand, so the
artifact not on the list was the one that drifted — and the suggested remedy, extend the list to
three, would have caught this instance and not the next. The test is derived from the directory
instead: **every generated artifact naming the upstream repository must also name the fork and the
base**, read from `readdirSync`, with an assertion that it found artifacts at all so it cannot pass
vacuously. Verified by reverting the header and confirming only that test fails.

### What can a human see or do now that they could not before

Nothing yet. This is infrastructure. What changed is that `porch-driver` and `codev-agent` can now
send `role`, `parentThreadId` and `codev.gateWrite` against a vendored contract that knows them, and
a `codev.gate-set` frame arriving on the stream shape-checks instead of being rejected as
unrecognized. Phase 7 is still the first that renders.

## Phase 6 — Hierarchy and gate state published by the Codev side

### The finding, and it needed a server the harness could not start

The plan's acceptance criterion for this phase is a live round trip: dispatch an
illegal hierarchy edge over a socket and assert the client can still tell "no such parent" from
"wrong parent role". The reason it is written that way is the record. Phase 2's schema guard was
wired to a layer nothing builds. Phase 3's six discriminants were rewritten by
`OrchestrationEngine` into a message that was not merely lossy but false. Both were green in every
test beneath the layer that broke them.

**The harness could not run it.** `t3-server.mjs start` runs the published `t3@<pin.cliVersion>`
CLI against the upstream checkout — that is what every spec 146 measurement is about, and that
server has no `codev.*` anything. `parentThreadId` is not in its contract, so an illegal edge is
not illegal there; it is an unknown field the decoder strips. A "wire test" against it would have
passed and proved nothing.

So the harness gained `start-fork`, which runs the fork's `apps/server/src/bin.ts` directly under
the same interpreter. There is no build step because there does not need to be one — the server
runs from source under Node's type stripping, the same way the codegen does — and adding a bundle
would put a build artifact between the source we changed and the server under test. It is a
separate verb rather than a flag on `start`, and it takes its own `T3_HARNESS_DIR` and
`T3_HARNESS_PORT`: the two bring up different servers from different checkouts, and a caller who
means one must not get the other by dropping a flag.

**The first run failed on all four cases.** Every refusal arrived as
`OrchestrationDispatchCommandError` with the reason inside `message`, as English, behind a `cause`
holding a serialized `Error`. A client could not tell `parent-not-found` from
`parent-not-architect` without parsing a sentence. Phase 3 fixed the ENGINE deleting these; the ws
layer was flattening them one hop further out — the same shape, a third time, in the layer nothing
had yet crossed.

### The fix, and the two things it taught

`OrchestrationDispatchCommandError` gains an optional `refusal` carrying the refusing error's tag
and its machine-readable reason. `bootstrapThreadDisposition`, one field above it, is the
precedent: an optional machine-readable field so a client branches without reading prose. Optional
for the same reason — most dispatch errors are internal and have no reason to give, and
`refusal: null` on all of them would be a claim rather than an absence.

`CodevHierarchyInvalidReason` **moved into the contract**, because it travels. A vocabulary that
reaches a client and is declared only in `apps/server` means every client keeps its own copy of six
string literals and checks it by hand against a file it does not import. Once it was in the
contract it could be vendored, and `porch-driver`'s copy is now checked against
`generated/schema.json` unconditionally rather than against a fork checkout the test had to skip
without.

**Four wrapping sites, not one.** The test that asserts them found two the first fix missed —
including one that rebuilds an existing dispatch error in order to add a field, and would have
deleted the discriminant while adding it. That site is the more instructive of the two: it is not a
place that forgot to lift the reason, it is a place that copies three fields by name and therefore
drops every field nobody remembered to add.

**The second run failed too, differently.** The live script read `domain.reason` — a true reading
of the old server and the wrong one for the new. That is worth recording because it is the shape of
a false negative: a test that was right about the world at the moment it was written, and whose
failure after the fix looks exactly like the fix not working.

### Losing the question is better than losing the gate

Codev bounds a gate request in BYTES (`GATE_REQUEST_LIMITS`); the fork bounds `CodevGate` in string
length, and tighter — a 1024-byte question porch accepts can exceed the fork's 500-character cap.
The fork refuses an oversize gate WHOLE, because a gate that partially applied would leave a human
looking at half a question.

So the publisher narrows, and it narrows only the optional content: the question is dropped, the
choices capped at five, a second recommendation demoted, a terminal excerpt kept tail-first behind
a truncation marker. `gateName` and `requestedAt` always travel, because they are what say a human
is needed. Every drop is named to the caller — a silently shortened question reads as the whole one.

The single case where the gate IS dropped is an unusable gate name. A name cannot be shortened
without changing which gate it names, and showing a human a gate they cannot match to their
protocol is worse than showing none.

### The publisher invents no revision, and that is what makes a restart safe

`codev.gate.set` takes an optional `revision` and this never sends one. A counter held in a
writer's memory resets when the writer restarts, and a reset counter makes every later write stale
— which renders as "no gate pending" exactly where a human is waiting.

The corollary is that reconnect republishes CURRENT state rather than replaying history, and the
publisher gets that for free by living with the connection: a new socket builds a new
`GatePublisher`, which remembers nothing. Spec test scenario 4 — kill and restart mid-gate — is
therefore not a special case in the code at all, and the test models it by building a second watch
over the same workspace after changing `status.yaml` while nothing was running.

**Only a confirmed write updates the publish memory.** A memory updated on failure would suppress
the retry, and for a gate waiting on a human "the next change to `status.yaml`" is forever.

### A dropped cycle, spelled like nothing to do

The first version of the publish cycle skipped a request while one was in flight and returned `[]`.
That is "I did nothing" spelled exactly like "there was nothing to do", and it is worse than it
sounds: the watcher fires on the same file change a caller is reacting to, so the dropped request
was reliably the caller's. Found by an integration test whose explicit `publishNow` silently did
nothing. Cycles are chained now, so every request runs, in order.

### An unreadable status.yaml publishes nothing

It does not clear. Clearing would spell "I could not read the file" like "no gate is pending", on
the one thread where a human may be waiting.

### What can a human see or do now that they could not before

Still nothing rendered — phase 7 is the first that renders. What is now true is that a spawned
builder lands on the fork with `role: "builder"` and its architect's thread id, a porch gate
reaching `pending` appears on the thread within one publish cycle, and a client that dispatches an
illegal edge gets back a discriminant it can branch on instead of a sentence it would have to parse.

## Phase 7 — Workspace to architect to builder, in t3code's own sidebar

### The seam check found two defects before a call site existed

`hierarchy.ts` is a pure function and its tests build their own row type. Both of those are right —
that is what makes them tests of the grouping — and together they cannot tell you the module fits
anything the sidebar holds. Two assignments at the top of the test file are the whole check:

```ts
const _sidebarRowsFit: (rows: readonly SidebarThreadSummary[]) => unknown = buildCodevHierarchy;
const _threadsFit: (rows: readonly Thread[]) => unknown = buildCodevHierarchy;
```

They failed, twice, on a module whose own suite was green:

- it keyed on `threadId`, the **command** spelling, while both read models call it `id`;
- `role?: X` does not accept `undefined` under `exactOptionalPropertyTypes`, so the interface
  described a shape no caller has until `| undefined` was written out.

Neither is a runtime error and neither would have thrown. Both would have shipped as
`buildCodevHierarchy(threads)` quietly returning no hierarchy, which on screen reads as an empty
workspace rather than as a bug. This is the "assert the call site, not the module" rule working
**prospectively** rather than forensically: the previous five instances were found after the code
shipped, by running it; this one was found before a caller existed, by the compiler.

### The section boundary, and the reason that was a lie

t3code splits a project into Pinned / Active / Snoozed / Settled before any grouping runs, so the
tree is built over ONE of those lists. A builder whose architect the user has pinned is therefore
looking at a list its parent is not in — and the first draft answered `parent-missing`, three rows
below the architect the user can see.

`buildCodevHierarchy` now takes `alsoVisible`, the rest of the sidebar, and answers
`parent-elsewhere`. Role still outranks section: a non-architect parent stays
`parent-not-architect` wherever it sits, because letting a section boundary change what a thread IS
would make the reason a fact about the sidebar rather than about the data.

Reading that lookup was itself a bug, and its test caught it. `elsewhereRoleById.get(id) !==
undefined` cannot distinguish "not in another section" from "in another section, with no role" —
because a roleless thread's role *is* `undefined`, and the second of those is exactly the
`parent-not-architect` case the branch exists to name. It reads `has` now. Verified by reverting to
`get`: the test fails.

### The render order is also the keyboard's order

`orderedThreads` is not only a render order. Shift-range-select and jump-hint labels are both
assigned from it. A component that reordered rows into a tree while leaving that list alone would
draw every row in the right place and send the keyboard to the wrong ones — a defect no screenshot
shows and no component test that renders one list would see. So `buildCodevSidebarOrder` returns one
order, and the caller renders in it **and** derives `orderedThreads` from it.

### Nothing changes for a project with no Codev roles

`hasCodevHierarchy` is false there, and the renderer takes the loop it has always had: same rows,
same order, no wrappers, no headings, no divider. An empty tree's chrome would be new furniture in
every upstream user's sidebar for a feature they do not have. Asserted directly — the no-hierarchy
branch returns the input list unchanged, in input order.

### Four reasons, four sentences

The orphan group carries a sentence per row rather than one "could not be placed". A reader opens
that group to find out which of four things happened, and one string for four states is the shape of
"I could not tell" spelled like an answer — the same rule that produced `parent-elsewhere` in the
first place.

### The e2e is a browser against the real stack, and it proved it can fail

`packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts` drives the FORK's web app against a
server built from the fork's source, with threads created over the wire. Not a component harness: a
component test supplies the shells itself, which is the step whose absence is the risk.

The orphan is made the way a real one is made — an architect archived after its builder exists — and
not by writing an illegal edge, because phase 3 refuses those at write time and a fixture that
produced one would be testing a state the server cannot reach.

Verified to fail: with the render branch forced to the no-hierarchy path, all eight rows still
render and every hierarchy selector goes to zero. The assertions fail; they do not pass on a flat
list.

### Screenshots are the deliverable, and there is no reference to compare them to

Committed to the fork at `docs/codev/spec-250/phase-7/`, at 390, 1440x900 and 1920, two per width
(the page, and the sidebar list at its full height — the sidebar is its own scroll container, so a
900px window clips the orphan group). Measured at every width rather than eyeballed: no horizontal
overflow, every thread title at or above 13px, zero console errors after pairing.

**There is no mockup or design reference for this tree.** The nesting is drawn in t3code's own
idiom — the same row cards, an indent and a hairline rail in the token the sidebar's other dividers
use, and a group heading in the shape of the existing Snoozed and Settled shelves. Nothing was
ported from `apps/client`. But "it matches the host app's conventions" is a claim about the
conventions, not a ruling on the appearance, and a green suite cannot make that ruling. Raised to
the architect with the screenshots rather than assumed.

### Writing the screenshots had to become opt-in

`t3-server.mjs start-fork` refuses a dirty fork checkout. A suite that wrote new PNG bytes into the
fork on every run therefore passes once and SKIPS forever, each run leaving behind the modification
that stops the next one — and the skip is correct behaviour, which is what makes it easy to miss.
Ordinary runs write into Playwright's output directory; `SPEC_250_WRITE_SCREENSHOTS=1` refreshes the
committed copies deliberately.

### The screenshots found a criterion gap the tests could not

The suite was green, every acceptance criterion had an assertion behind it, and the render was
still missing one of criterion 1's three levels. "Project, architect, that architect's builders" —
the tree had architect and builders, and the project was present only as a caption repeated on all
eight cards. Every test that could have caught it was written against the two levels that existed.

That is the project's own lesson arriving on schedule: a green suite cannot detect design
infidelity, and here it could not detect a missing *requirement* either, because the tests and the
render were built from the same reading of the plan. The screenshot is what made the gap visible,
and it took a human looking at it.

Two more came from the same review. Nothing said which row was an architect — it was carried by one
level of subtle indent plus test data that happened to be called "Architect beta" and "Builder alpha
one", and real threads are called `builder/spir-250`. And the orphan group was amber, which says
something is broken, on a state this project deliberately ruled legal.

All three are fixed, and the assertions now exist for the first two: a project heading above the
tree, no row inside the tree repeating the project name, rows outside it still carrying it, the
architect row captioned and its builders not. The third is a colour, and the screenshot is its
evidence.

### The tree covers the Active section only, and phase 8 inherits that

Named here because it is an unstated narrowing of "the sidebar renders the tree", and the only other
place it is written down is a code comment.

t3code splits a project into Pinned / Active / Snoozed / Settled before any grouping runs. The tree
is built over **Active**; the other three keep the flat rendering they have always had and reach the
grouping as `alsoVisible`, which is what lets a builder whose architect is pinned say
`parent-elsewhere` instead of `parent-missing`. That is the right scope for this phase — the split
is t3code's own and predates us — but a phase that assumes "every Codev thread is in the tree" will
be wrong for any thread the user has pinned, snoozed or settled. Phase 8's gate panel should read
gate state off the thread rather than off a position in the tree.

### Live per-row status is t3code's, and it is not a gap

Every row in the screenshots reads "now" with no working/turning indicator, which looks like spec
146 criterion 3 going unowned. It is not. `resolveSidebarThreadStatus` already returns
`approval` / `input` / `working` / `monitoring` / `failed` / `ready` from `session.status` and
`backgroundLiveness`, and the sidebar already renders it as a pill — spec 250 does not touch any of
it. The fixture's threads read "now" because they have never taken a turn: nothing is running on
them, so `ready` is the correct answer. The half spec 250 owes is **blocked on a named gate**, which
is phase 8's criterion 3.

### What can a human see or do now that they could not before

**This is the first phase with a non-empty answer.** Open t3code's sidebar and the threads Codev
created are a tree: the project as a heading, each architect below it captioned as one and above the builders
that name it, two architects side by side as two subtrees, threads Codev did not create in the flat
list they have always had, and a builder whose architect is gone named as orphaned with the reason
it could not be placed — instead of one flat list in which none of those things is distinguishable
from the others.

## Phase 8 — A porch gate, rendered from the gate block

### The gate has to be written by the credential that writes gates

The e2e fixture could not seed a gate the way it seeds everything else. A bootstrap exchange asking
for `codev:gate-write` is refused with `invalid_scope` — phase 4's design holding, not a bug to work
around. Gate writes come from ONE credential, `codev-agent`, scoped to `orchestration:read` and
`codev:gate-write` and nothing else, provisioned by the server rather than derived from whatever
token a client happens to hold.

So the fixture reads that credential from `<serverBaseDir>/codev/gate-writer.token`, where the
fork's server writes it at start, and opens its own connection with it — exactly what
`thread-backend.ts` does in production, and for the reason that file already records: the seeding
socket carries `orchestration:operate`, and putting gate writes on it is precisely what phase 4
gave the method its own scope to prevent.

A fixture that had obtained the ability another way — widening the scope, writing the column — would
have been testing a path no writer uses.

### The third state, and why it is a union rather than a nullable object

`porch gate <id>` without `--request-file` is legitimate and common, so a gate can be pending with
no question and no choices. Rendering that as "no gate" hides a human who is waiting. Rendering it
as `pending` with an empty question shows a heading with nothing under it, which reads as a broken
gate rather than an absent request. It is `pending-unstructured`, it says
"Gate pending, no structured request", and both the derivation and the panel have tests that fail
when it collapses into either neighbour.

"Structured" means there is something to READ, not that a field was sent: a gate carrying only
choices, or only a question, is structured. A gate carrying neither is not.

### It is not folded into session status, and the hue matters

`starting` / `running` / `ready` / `settled` describe what the AGENT is doing, and none of them can
say "a human has to decide". `hasPendingApprovals` cannot stand in either — that is provider TOOL
approvals, and the contract already records why the two must stay apart.

The row marker therefore has its own derivation and its own colour. Amber is Pending Approval,
indigo Awaiting Input, sky Working, violet Plan Ready, emerald Completed; reusing amber would
collapse exactly the distinction the gate block exists to make, so the gate is rose. A test asserts
the pill uses none of the five taken hues, which is the only way that claim survives a later
refactor.

It also sits OUTSIDE the status slot, which fades to make room for the row's hover actions. A gate
that vanished when someone reached for the row would be missing precisely when it was being acted
on, and no screenshot taken at rest would show it.

### The XSS test that gets quieter as the defect gets worse

Gate text — the question, every label, every consequence, the terminal excerpt — is written by a
builder agent into `status.yaml` and carried over a socket. A panel that rendered any of it as
markup would let a repository under review script the page reviewing it.

The obvious test renders a payload and asserts the markup contains no `<img`. It passes on the
current code and it would keep passing on a version that escaped the question and handed only the
terminal excerpt to `dangerouslySetInnerHTML` — that one field would simply stop matching the
escaped-count assertion, and a check that reports LESS as the defect grows is worse than no check.
So there is a second test that reads `GatePanel.tsx` and fails on any use of the escape hatch. It
matches a use (`dangerouslySetInnerHTML=` or `:`) and not a mention, because the file's own doc
comment names the thing it does not do, and a bare substring check would train the next reader to
delete the sentence rather than the risk.

### A case the plan asked for that cannot exist

The test plan asks for "a choice with no consequence". `consequence` is a required non-empty string,
so a choice without one is refused whole at the schema boundary and cannot reach a renderer. Left in
as a test that asserts the refusal, rather than dropped, so the next reader can see the case was
checked and found unrepresentable instead of assuming it was forgotten. Same shape as phase 4's
`CODEV_GATE_SCOPE_REQUIRED`.

Every fixture in both suites is DECODED through `CodevGate` rather than written as an object
literal, which is what makes that finding possible: six choices, two recommendations and a
multi-line question all fail in the fixture instead of being asserted about as though they could
arrive.

### Screenshots poisoning the suite, the second time

Phase 7 found that writing screenshots into the fork makes `start-fork` refuse the next run, and
answered it with an opt-in flag. Phase 8 added a second spec file and found the flag did not cover
it: with two files, the first writes PNG bytes and the second SKIPS, in the same run, and the skip
is correct behaviour. Screenshots now always write outside the fork and are copied in afterwards.

### Two review findings, and one of them had no good answer at first

The terminal excerpt had no caption. Unlabelled, a mono block under the choices is just trailing
output: a reader cannot tell the builder's reasoning from the failure that caused the gate from
unrelated log noise, and those need three different responses. It says "Terminal excerpt" now, which
is the name the gate request itself uses, so the caption and the field a builder fills in are the
same word.

The second was a question — does a gated ARCHITECT render the role caption AND the gate? — and the
answer was worse than yes. Both rendered, on the same line, competing for the same ~230px, so the
caption truncated to `A…`. Moving the marker to the title line fixed that and truncated the title
instead, on every gated row. Neither placement was acceptable, and the fix was not a placement: the
label dropped `Gate: ` and took the panel's gavel instead, which bought back six characters and let
the caption, the gate name and the title all survive.

A clip remains and is deliberate. A 15-character gate name on a gated architect still shows
`Archit…`; the gate name and the title are intact. That is the right order — an architect at a gate
is the row a human most needs to find — and it is recorded here rather than left for a reviewer to
notice in a screenshot.

### What can a human see or do now that they could not before

Open a builder that porch has stopped at a gate and t3code says which gate, when it was requested,
what it is asking, what each choice would do, and which one the builder recommends — instead of a
thread that looks settled. From the sidebar, that builder is marked as blocked on a person rather
than as finished. And a gate with nothing attached says so, instead of looking like no gate at all.

Nothing here approves anything: that is phase 10. This is the reading half.

## Phase 9 — Builder tiling

### The port was a re-measurement, and the difference is 228px

`apps/client/src/responsive/layout.ts` computes every column count from `viewportWidth`, because its
grid **was** the page. This one is a route inside t3code's chat shell, behind a sidebar that is
232px at rest, narrower when dragged, and gone at 390. Carrying the constants across unchanged would
have produced numbers that are right about a page nobody is looking at.

Every function takes the AVAILABLE width now, and the grid measures its own container with a
`ResizeObserver` — a window listener would miss a collapsed sidebar entirely, which changes the
space without changing the window. Six panes at 1440 have 1176px of it, not 1404.

Three columns fit either way, so **criterion 5 would have passed on the viewport version by luck.**
That is worth saying plainly: the acceptance criterion the plan leads with cannot detect the bug the
plan asks the port to avoid. Criterion 5b can, which is why it exists.

`PAGE_PADDING` dropped 18 → 12 (t3code's shell already pays for horizontal inset); `GRID_GAP` stayed
at 12 (already t3code's rhythm). Both recorded in the file with the measurement.

### The rendered columns are counted from the browser, not from the component

The grid publishes `data-codev-grid-columns`, and an assertion on that alone would be asking the
component to confirm its own arithmetic — the same defect as phase 7's builder count, which the
review caught there. So the Playwright spec counts distinct rendered x-positions of the pane boxes,
and asserts the attribute too. They have to agree.

### Two defects the screenshots caught that the tests did not

**Pane text was 12px.** `text-xs` is t3code's own secondary-label size and it is right in a sidebar
row, read from a foot away with one thread in focus. A pane is a tile in a grid of seven, scanned
rather than read, and criterion 5 puts the floor at 13 for that reason. The type went up. The
alternative — narrowing the assertion to "body text only" and declaring the labels out of scope — is
how a grid passes its tests and is unusable, which is the failure this project already has on record
from spec 83.

**At 390 the shell's floating sidebar toggle sat on the first pane's own label.** No test could see
it: every pane was over the floor, nothing overflowed, and the toggle is not part of the grid. The
route has a header now, which clears it at every width and names a screen that was otherwise seven
unlabelled cards.

### The pane says what it cannot see, and the first version of that was FALSE

Two of the four things the plan asks a pane to show — the porch phase and the last three messages —
are not on the thread. The first draft called them "not published" and asked the architect to choose
between adding a contract field, subscribing per pane, or shipping without them.

All three options were wrong, and the architect checked rather than ruling from the framing:
`codev-agent` **already publishes both**, workspace-scoped, in ONE request for the whole grid —
`GET /api/agent/v1/workspaces/<b64>/state` carries `porch.phase` and the last three messages per
identity. That is where `apps/client` reads them. So the plan's ban on six continuous subscriptions
was never in tension with showing them, and no contract change was needed.

The lasting correction is the wording. "Phase not published" is a claim about the world and it is
false; the true sentence is that this page cannot reach codev-agent yet, which phase 10 fixes. A
pane asserting data does not exist when the pane simply cannot see it is this project's most-caught
defect, and it nearly shipped again in the words rather than in the code.

### A criterion the spec dropped, restored because a screenshot argued for it

Spec 250 restated spec 146's criteria 5 and 5b and never restated 4b — the architect does not take
an equal tile where that makes a ragged row. Nothing in this plan was broken by the omission, and
the first 1440 screenshot was the argument: six builders and an architect at three columns is
3 + 3 + 1, one lonely card beside two empty slots. It is in the plan as a criterion now, so the next
reader checks it rather than remembering it.

The interesting part is the number. Spec 146 states 4b as "1920 or wider", and implementing that
literally here would have been **wrong**: `apps/client` owns the whole viewport, so its viewport
width and its available width are the same number, while this grid sits behind a sidebar where 1920
of viewport is 1688 of grid. A viewport threshold would offer the tile at 1920 with the sidebar
dragged wide enough that only three columns fit — the exact defect the criterion exists to prevent.

So it is stated as "four columns fit", which is not a proxy for the reason but the reason itself:
seven items at four columns is 4 + 3, the ordinary shape of any grid. It gives what 4b names at both
viewports 4b names, and it is right at a 1600px window with a collapsed sidebar, where the literal
reading would wrongly withhold the tile. Spec 146's wording stays as it is — `apps/client` is frozen
and still owns its viewport, so it is still true there.

Raised before building rather than after, and the architect ruled on the departure rather than on
the framing.

### A test that could not fail, and the fixture that fixed it

The architect asked whether an architect TILE stays distinguishable from a builder tile in the
multi-architect case, where there is no strip, no indent and no rail — the role prefix is the whole
distinction. It could be clipped: the prefix lived inside the truncating span, so a long enough
title in a narrow enough pane would eat it.

Two things about the check that catches it. It measures `scrollWidth` against `clientWidth` rather
than reading text, because `text-overflow: ellipsis` is invisible to a text assertion — the DOM
still holds `builder/`, so `toContainText("builder/")` passes on a prefix rendered as `buil…`. And
it could not have failed as first written: six short fixture titles never fill a pane, so a prefix
that COULD be clipped never was.

One fixture builder is named long enough to truncate now. Verified by reverting: that pane clips its
prefix by 22px, and the text assertion still passes. Real threads are named `builder/spir-250 gate
rendering in t3code` and worse, so the long title is the realistic case rather than a contrivance.

### What can a human see or do now that they could not before

Open one screen and watch six builders at once inside t3code, each pane naming the agent by role,
its status, and the gate it is stopped at if it has one — a clean 3x2 at 1440x900 with every pane
over 340x240 and the architect on a strip below it that expands on demand, seven equal tiles in four
columns at 1920 where that is not ragged, and on a phone pages of two rather than seven panes
squeezed under the readable floor.

## Phase 10 — Approval from t3code over the same-origin proxy

### The guarantee is structural, and the test the plan first proposed would have passed vacuously

The spec's Security section and the plan's first draft both said `connect-src 'self'` "stays
closed". t3code sends `Content-Security-Policy` on `.svg` asset responses only
(`apps/server/src/http.ts`), and `apps/web/index.html` carries no meta tag. **There is no
page-level CSP and therefore no `connect-src` directive to keep closed.** A test asserting one
would have been green against a header nobody sends — a check that cannot fail, on the security
property of the phase.

What actually holds is narrower and stronger: the page never *makes* a cross-origin request,
because it has no absolute URL to make one with. `agentUrl` returns a path, and
`pairing.test.ts` asserts that with `expect(() => new URL(url)).toThrow()`. The browser test
then records **every request the page issues** while it pairs, reads workspace state and
approves, and asserts each one is on t3code's origin — plus one assertion that it reached the
proxy at all, without which the first would pass on a page that made no agent request.

Adding a page-level CSP is deliberately not done. It changes how every t3code page loads, which
is far wider than this spec's diff, to obtain a guarantee already held.

### The target is configured, and a route-path allowlist would not have been enough

The plan's own most consequential item, found in review round 1: the deliverable said the web app
"holds the `codev-agent` origin", and a server proxy forwarding to a browser-named origin is an
SSRF primitive. A path allowlist does not constrain the *host*.

So the operator configures `T3CODE_CODEV_AGENT_ORIGINS` as `id=origin` entries and the browser
selects by **id**. The origins never reach the page — `/api/codev/agent-targets` answers ids
only, and the e2e asserts the agent's port does not appear in the body. A URL arriving where a
path belongs gets its own refusal (`CODEV_AGENT_PATH_ABSOLUTE`) rather than falling off the end
of the allowlist, because "this is not a path" and "this path is not carried" send a reader to
two different places.

Three unconfigured/misconfigured states get three signals, ported from `client-static.ts`'s
lesson: `CODEV_AGENTS_UNCONFIGURED`, `CODEV_AGENTS_ALL_REJECTED`, and a usable list with the
rejected entries reported beside it. An operator who typed a bad origin and one who configured
nothing need opposite next actions.

### An allowlist for headers, and the `Connection` subtraction on top of it

`client-static.ts` builds its strip set from a fixed hop-by-hop list *plus the tokens the
request's own `Connection` header names*, because that header names headers that are themselves
hop-by-hop. This port inverts the default — an **allowlist** of what may travel, since this hop
sees credentials and a denylist forwards everything nobody thought of — and still subtracts the
`Connection` tokens, because an allowlist alone forwards a header a request declares
connection-scoped, and here that header is the machine credential. Both mechanisms are exercised;
removing the subtraction fails the test named for it.

`authorization` and `cookie` are absent from the allowlist and that absence is a deliverable:
t3code's own session gates USE of the proxy and is never handed to another server.

### Two failure signals, and a redirect that is refused rather than passed on

An unreachable host and one that accepted the connection and said nothing keep separate signals,
driven against real sockets — a closed port and a server that accepts and never answers. A 3xx
from the configured origin is refused (`CODEV_AGENT_REDIRECT_REFUSED`): forwarded to the page,
the browser would follow it, cross-origin, with the request's credentials, which is the escape
the configured-target rule closes one hop earlier.

Three of `codev-agent`'s routes are deliberately not carried. The SSE stream, because this proxy
buffers and a buffered stream is live on the wire and empty in the page. Both revocation routes,
because `afx pair revoke` is the operator path and a browser that could revoke could deny a human
their own gate.

### Three defects the browser caught and the tests could not

Every unit test in this phase was green through all three.

**The page read the agent store once and froze.** Pairing succeeded, the credential reached
browser storage, the poll ran and returned 200 — and the panel still said this browser holds no
codev-agent credential. A hand-rolled subscription (a `useState` tick pushed from a module-level
listener set) rendered the first snapshot and never followed the store again. `useSyncExternalStore`
is the primitive for this shape, with a snapshot **replaced** rather than mutated so its identity
is the change signal. This cost more time than anything else in the phase, and nothing but a
browser could have found it: every function involved is individually correct.

It also could not be debugged from inside the fork. `start-fork` refuses a dirty checkout — by
design, and the right design — so instrumenting the component for a browser session is not
available without committing. The fix came from replacing the mechanism rather than from
observing it.

**A gated pane dropped the phase it had just gained.** The gate replaced the phase line, which
was right in phase 9 when there was no phase to show and wrong the moment `codev-agent`'s
projection arrived. A reader who has found the pane that wants them still needs to know what it
was doing. The gate leads in rose with its gavel; the phase follows.

**`Send a message to start the conversation.` printed across `Waiting on you: <gate>`.** On a
thread with no turns, t3code's empty-timeline placeholder is centred over the whole content column
and lands on the gate panel. **Present since phase 8** — the phase 8 panel-only screenshot could
not show it, and the full-page one did. Hidden through upstream's own `hideEmptyPlaceholder`
rather than moved, because it is also wrong advice: a thread waiting on a human approval is not
waiting for a message.

That is the second time in this spec that a cropped screenshot passed something a full-page one
would have caught, and the lesson is the screenshot's framing, not the reviewer's attention.

### Pane content landed here, and the contract was not extended for it

The architect's ruling, recorded in the plan because the phase's file list predates it. Phase 9's
panes said "Phase not read here yet — published by codev-agent", which was true: `codev-agent`
has published the porch phase and the last three messages workspace-scoped since phase 6, in ONE
request for the whole grid, and no page could reach it. The proxy is the way in, so the panes read
it here.

The project id the approval needs comes from that same snapshot, which is why the two arrived
together. A project id on the gate block would have been a second copy of a fact `codev-agent`
already owns, and two copies can disagree.

Every branch that still cannot show a phase names which one it is: not paired, the agent could not
be reached, the agent answered and does not publish this thread, or it published no porch project.
A blank line for all four would be a claim about the builder rather than about what reached the
browser. The message log keeps its three states too — an agent predating the field HAS messages it
is not sending, and that is not "no messages".

### Testing the seam, twice, because one test cannot make both claims

`spec-250-t3code-approval.e2e.test.ts` drives the REAL fork server's proxy in front of a real
`agent-routes` host, over `fetch`, ending in a real `status.yaml` — criterion 4. Nothing is
imported and no proxy function is called: the test reaches the route the only way a browser can,
so a route registered nowhere fails it. The unit tests can prove `forwardableHeaders` strips a
header; only this can prove anything is wired to `forwardableHeaders`.

`spec-250-approval.spec.ts` makes the claim a `fetch` cannot: what a real page asks for.

Both share `spec-250-agent-host.ts` rather than each building a host, so they cannot drift into
testing two different services. It seeds identities AFTER start, because the order is a circle
broken in one place: the fork server needs the agent's port in its environment at start, and the
thread ids the identities carry do not exist until that server is running.

### Falsifiability, and the one that is about configuration rather than code

Reverting five mechanisms — the `Connection`-token subtraction, the header allowlist, the redirect
refusal, the credentials-in-URL rule and the anchored route pattern — fails five unit tests.

The e2e's check is different in kind and worth naming: pointing the configured allowlist at a dead
port fails 4 of its 7 tests. That is what proves the ceremony travels the configured proxy and not
some other path that happens to work — a shape the unit tests cannot express, because the thing
under test is the wiring.

### The review found a test that reported a pass on a run that never happened

opencode's `REQUEST_CHANGES`, and the most valuable finding in the phase. The vitest e2e's
availability guard logged a warning and RETURNED, which vitest records as a **pass** — so on a run
where the fork server never started, criterion 4 and every SSRF refusal reported green with not one
assertion executed.

This project keeps finding "I could not tell" spelled as "no". This is the same defect spelled as
**"yes"**, which is strictly worse, and it was on the phase's own acceptance criterion. The file's
header states the rule — "Skips, never passes" — and the code broke it, which is the durable
lesson: a header is not a mechanism, and a rule written next to code that does not implement it
reads as reassurance.

It was also invisible to me. Every run I did had the fork up. It would have surfaced the first time
anyone ran the suite without `T3_NODE`, as a green tick.

`ctx.skip` marks the test skipped and does not return, so the body is unreachable rather than
merely unexecuted. Demonstrated rather than asserted — same file, same command, `T3_NODE` unset:
**8 passed** before, **8 skipped** after.

### Both lanes found the same coarse attribute, independently

`data-codev-approval-state` computed three values over four outcomes, so `sessionEnded` tagged as
`refused` while the visible text and testid distinguished it. Nothing asserted on it, which is
exactly why it was worth fixing before anything did: the first test written against the attribute
would have inherited the conflation the file's own header exists to prevent.

Two lanes reaching it separately is the signal that it was not a stylistic note.

### Every phase 10 deliverable, and what holds it up

Written out because "the deliverables are met" is the sentence that hides the one that is not.

| Deliverable | Held up by |
|---|---|
| Machine credential AND `client-session`, neither alone | `spec-250-t3code-approval.e2e.test.ts` — the two refusals asserted `not.toBe` each other |
| The page holds the target and the workspace path | `pairing.test.ts` round-trip; the e2e drives the real ceremony with both |
| Both travel the existing ceremony | The e2e mints through `PairingStore` with the real purposes; the Playwright spec types into the real form |
| t3code's session is never an approval credential | `agentProxy.test.ts` "never forwards t3code's own session"; the e2e sends a valid bearer with no machine credential and gets `MACHINE_CREDENTIAL_REQUIRED` |
| Credential in per-origin browser storage, with the trade stated | `pairing.test.ts` — three storage states, including a store that throws |
| **No cross-origin request, asserted by watching the network** | `spec-250-approval.spec.ts` records every request and asserts `foreign === []`, plus a positive assertion that the proxy WAS reached |
| No page-level CSP is added | Not done, and recorded here and in the plan as deliberate |
| **Upstream target server-configured, never browser-selected** | `readCodevAgentTargets` tests; the e2e's SSRF block; the targets route answers ids and the test asserts the agent's port is absent from the body |
| Scheme/address rules, no credentials in the URL, redirects not followed | `originProblem` tests (5); the redirect refusal driven against a real 302 |
| **Hop-by-hop stripping is dynamic** | The `Connection: keep-alive, X-Codev-Machine-Credential` test, which fails when the subtraction is removed |
| Two proxy failure signals | Two socket-level tests: a closed port and a server that accepts and never answers |
| **The approval record comes from the server** | `approval.test.ts` "reports a success it cannot read as unconfirmed"; criterion 4 asserts the same three fields in `status.yaml` AND in the response |
| Four outcomes, not three | Four branches in `approval.test.ts`, plus `approvalStateAttribute` mapping four to four |
| The ceremony named in full | The e2e walks all four requests in order, each through the proxy |
| Tests for this phase | 28 proxy unit + 46 web unit + 8 vitest e2e + 6 Playwright |

Two things beyond the list, both found while building rather than planned: the **unbounded request
body** (Effect's `MaxBodySize` defaults to unbounded on a route that buffers) and the review's
finding that the e2e **reported a pass on a run that never happened**.

### What can a human see or do now that they could not before

Approve a porch gate from t3code, on a phone or an iPad, without a terminal: pair the browser once
with a token from `afx pair issue`, spend a session token, and press Approve — and porch writes the
approving session id, machine and timestamp into `status.yaml`, all three read back from the server
rather than invented in the page. And on the Builders screen, see what each builder is actually
doing — its porch phase, its plan phase and the last three messages its architect sent it — where
three phases of panes had said only that the data existed somewhere else.

## Phase 11 — Acceptance run and the rebase drill

### The drill measures; it does not perform a rebase we keep

Criterion 9's wording — "the fork rebases onto a later upstream commit named in `pin.json`" — reads
as an instruction to advance `upstreamBase`, and following it literally would have spent the
evidence base. The moment `pin.json` names a new base, `verify-upstream` expects the preserved
clone to BE there, and every spec 146 and spec 236 result tied to `082e6ea52186` stops being
re-runnable.

So the drill runs on a **throwaway clone** and the real pin does not move. Both the plan and the
spec's criterion 9 carry that amendment with the reason, because the next person to read the
original sentence would otherwise do the literal thing.

**The read-only order held, and the drill checks rather than promises it.** It re-reads both
checkouts after each run and **discards its own result** if the preserved upstream left its base,
if the fork head moved, or if `pin.commit` changed — a drill that disturbed the thing it was meant
to leave alone cannot be trusted about anything else. A `git fetch` was the one write, and it is
the permitted one: remote-tracking refs move, HEAD does not, verified before and after.

### A rebase stops at the first conflict, so the first conflict understates the job

This is the design decision worth keeping. `git rebase` is sequential: it reported "stopped at
commit 6 of 42 on one file" and that answers *where does it stop*, not *how much conflicts*. A drill
that reported only that would understate every rebase it ever measured, and would do so in the
reassuring direction.

So the drill also three-way-merges the same two trees and aborts immediately — one pass, every
conflicting file. **3 of the 35 files we modify**, against upstream 104 commits ahead.

Two questions, two numbers, and neither is a substitute for the other.

### The prediction was wrong in the interesting direction

`FORK.md` rated `packages/contracts/src/orchestration.ts` **High** — it is the file upstream changes
most, and `classify-churn` found upstream had touched it twice in exactly the two unions our
customization extends (`subscribeThread`, `dispatchCommand`). It **auto-merged clean**.

What conflicted was `apps/server/src/server.test.ts`, an upstream **test** — the half `FORK.md`
already warned is easiest to forget when estimating the drill, now demonstrated rather than
asserted. The risk table carries measured beside predicted; where they disagree the measurement
wins.

### The watermark invariant finally had a real migration to bite on

Phase 2 tested "a new upstream migration landing after the guard still runs" with a synthetic
migration. In the 104 commits since, upstream shipped a real one — `043_ProjectionThreadsUnsettledAt`
— above the `042` our base leaves. Codev writes nothing to `effect_sql_migrations`, so the watermark
is whatever upstream last ran, and 043 runs.

The check is stated as the invariant rather than as the number: every migration upstream adds must
have an id above the watermark our base leaves. `checked: false` is its own state and is **not** a
pass, asserted in the evidence test so an unreadable migration directory cannot masquerade as a
holding invariant.

### `apps/client` was red, and had been since phase 5

The phase's deliverable is "confirmed frozen and still green". Frozen was true — zero files changed.
Green was not: 278 of 279.

Phase 5 regenerated the vendored contract **from the fork**, our `codevGate` object landed ahead of
the session object in the generator's numbering, and the session-status enum moved from
`$defs.subscribeThreadOutput__Objects_6` to `_7`. `derive.test.ts` still read `_6`.

**The assertion message is why this cost a minute rather than an hour.** It said: *"the generated
contract no longer declares the session status enum where this test reads it. That is this test
needing a new path, not a mapping change."* A stale read path and a broken status mapping look
identical at the failure site, and `expected undefined to be defined` alone would have sent a
reader into `deriveRowStatus`. That is what a failure message is for, and most in this repository
would not have done it.

**The freeze authorised the fix rather than forbidding it** — "frozen means it keeps passing its
tests and receives fixes, not that new front-end features land in both places". A fallback whose
suite is red is not a fallback: the whole reason `apps/client` is kept is that if this path fails
there is still something that works, and *works* is a claim its suite is the only evidence for.

**The real gap is that nothing local runs it.** The root `npm test` filters to `@cluesmith/codev`,
so `apps/client`'s suite had not run since phase 5. CI would have caught it at PR time, which makes
this a near miss rather than a hole — but "the frozen fallback's suite runs only in CI, and only
once a PR exists" is too long a loop for the one package whose job is to still work. Filed as
**#265**; deliberately not fixed here, because changing the root test command touches every
contributor's inner loop.

### Criterion 6 closes UNMET, and that is a result

No iPad was available. It closes unmet with a stated reason and an executable runbook — not passed
on a simulation, and not left open.

The runbook was worth more than the hour it took, because **verifying it against the fork rather
than writing it from memory caught three wrong instructions**, and one of them would have sent the
human to the wrong server entirely: `t3-server.mjs start-fork` starts on a throwaway data directory
with empty data, which is right for the tests and exactly wrong for a criterion that says a builder
is driven to completion. The other two were a variable that does nothing where I put it
(`T3CODE_CODEV_AGENT_ORIGINS` on the Vite command; the backend reads it) and a tailnet mode I
hand-rolled that t3code already ships (`pnpm dev:share`).

The Playwright suite is **not** recorded as a substitute. It drives the same proxy and the same
ceremony, so it covers the approval path; what the iPad closes is tailnet reach and touch targets,
and nothing on the Mac tests either.

### The third finding of one shape in two phases, and all three were mine

Both lanes, independently, found that the drill's `ok` outcome documented "rebase clean, contract
regenerated, shape-check held" while the clean branch called neither tool — and that
`regenerate-failed` and `shape-check-failed` were documented outcomes assigned nowhere in the file.
claude REQUEST_CHANGES/HIGH, opencode COMMENT/HIGH; the stricter reading is the one that was acted
on.

**The family is now three, across two phases.** A guard that logged and returned, which vitest
records as a pass. `startsWith` as a same-origin assertion, unable to fail across ten ephemeral
ports. And a comment describing work no code does. The common cause is not carelessness about
tests. It is that **the claim gets written in prose while the mechanism is being built, and the
prose is what gets re-read when checking the work** — and it is always right, because the same hand
wrote both. The remedy that generalises is a check that reads the artifact rather than the intent:
`documents exactly the outcomes it can assign, and no others` extracts the vocabulary from the
header comment and from the `outcome:` assignments and asserts set equality. A prose-only fix cannot
fail that test.

### The reviewer's cheap option was unreachable, and finding that out changed the fix

The suggested fix was to run the generator and `shape-check` in the clean branch, making the two
dead outcomes reachable. It cannot be done. `generate.mjs` refuses any checkout whose `HEAD` is not
`pin.commit`, and a rebased tree never satisfies that: its head is a commit that did not exist
before the rebase. Regenerating from one means moving the pin, which is the adoption the drill
exists in order not to perform.

So the choice was not "two lines or a comment edit". It was between narrowing the header — honest,
and leaving criterion 9 answered by `regenerationReachable`, a boolean that only says the generator
would FIND its source — and measuring something real without running the generator. Both were done.
`contractClosure.sourceHash` hashes the closure off the merged tree and compares it to
`generated/source-hash.json`, which `generate.mjs` itself argues is the load-bearing drift detector
because the emitted schema is blind to constraints behind a `decodeTo` transform.

**The measurement changed the answer, which is the only thing that justified taking it.** Zero
closure conflicts, so regeneration is not blocked — and **4 of the 9 closure files come out of the
merge with different bytes**, so the regenerated contract would not be the one vendored.
"Regenerable" and "unchanged" had been reading as a single fact in `FORK.md`, in `REFRESH.md` and in
the acceptance evidence. All three now carry both.

### The same tautology had two doors, and only one was obvious

The hash has to be taken while the merged worktree is on disk, before `merge --abort`. Taken after,
the worktree is the fork again and the comparison is the fork against itself. That was checked
rather than assumed: hashing the unmerged fork against `source-hash.json` reports `moved: []`, which
is what the post-abort version would have published on every run, looking exactly like good news.

The second door was found re-reading the fix, and neither lane raised it. Guarding on
`closureConflicts.length === 0` is the right question **once a merge has happened**. A `git merge`
that refuses to start — already up to date, a wedged index — leaves the worktree as the unmerged
fork with no conflicts to notice, and walks into the same comparison through a different branch.

That decision is `closureMeasurability`, and it lives in `tools/t3-fork/drill-closure.mjs` rather
than inline. `rebase-drill.mjs` is a script — importing it runs a drill against two real checkouts —
so an inline guard is covered only by whatever branch the last real run happened to take, which is
precisely the wrong coverage for a guard whose job is to fire on a case no normal run reaches. Five
unit tests reach it; deleting the guard fails two of them.

### A number that is typed is a number that will be wrong

opencode's third point: `104 commits, of which 5 touch the pinned closure` was prose, in the
document whose own opening paragraph explains that hand-typed numbers rot, next to a collector built
to stop exactly that. The drill now counts both from the preserved clone over the same range it
rebased across — so the churn and the conflict surface can never describe two different ranges — and
the collector prints them. `null` renders as "not counted", never as `0`.

The counted values matched what had been typed. That is the outcome that makes this worth recording:
the fix was not prompted by a wrong number, and the next drill is where a typed one would have gone
wrong silently.

### The e2e re-run, and the run that looked like a pass

claude's non-blocking note: the phase 11 regression run excluded `**/e2e/**`, so criteria 1, 2, 3, 5
and 5b rested on the phase 7-10 Playwright runs. Phase 11 adds no fork commit, so `pin.commit` is
still phase 10's head and those runs were already at the final fork head — but 2.3 minutes buys a
run instead of an argument. **32 passed.**

**The first attempt reported `32 skipped` and exited 0.** `T3_NODE` was unset and the fixture
refuses to start the fork server without it. That is phase 10's own lesson working as built: a skip
carrying its reason rather than a pass. It is also why the evidence row says "32 passed" and not
"the suite is green" — a run that exits 0 having executed nothing is the failure this phase is
about, and it turned up one more time in the phase that fixed it.

### The gap an amended criterion was hiding, and it was an hour to close

**The architect asked the question that the whole phase had routed around.** The drill proved the
rebase *measures*. It did not prove the contract still *regenerates* after one — and that is the
claim that matters on the day a new base is adopted, which is the worst possible moment to find out
it does not hold. Two iterations of review had passed over it, because every statement about it was
true: the generator refuses a tree whose HEAD is not `pin.commit`, regenerating means moving the pin,
the drill exists in order not to move the pin. All true, and it added up to a criterion that read
"met" while the interesting half was deferred.

The way out was not to loosen the guard. It was to satisfy it somewhere disposable. `git merge-tree
--write-tree` and `commit-tree` give the merged tree an identity **inside the throwaway clone** —
which matters because the sequential rebase stops at commit 6, so there is no rebased HEAD at all;
the generator reads only the closure, and the closure merges clean. Then a **scratch codegen root**:
`generate.mjs` resolves `pin.json`, its output directory and its staging area from its own file
location, so a copy of the tool under a scratch directory reads a scratch pin naming that commit.
The guard is met honestly — the artifacts really are reproducible from the commit they name.

**The contract regenerates, and `schema.json`, `schema.ts` and `types.d.ts` all move.** So adopting
this base changes the shapes Codev consumes, and that is now a measured fact with an artifact list
rather than an open question deferred to the first real rebase.

Three details that are the difference between this being evidence and being decoration:

- **The comparison is against what is vendored in this repository**, never against what the scratch
  run just wrote. The second is a tautology, and it is the third time in this phase that the
  tautology was the thing to design against.
- **A regenerated contract that differs is a result, not a failure.** Same argument as `conflicts`.
  So the outcome vocabulary stayed three words and the finding went into `contractRegeneration` with
  its artifact list. Widening the vocabulary would have re-created the defect iteration 1 found.
- **The generator needs Node 22 and the drill runs under 20.** A wrong interpreter reports
  `NO_INTERPRETER`, never "the contract does not regenerate" — the second is a claim about the fork
  made from a fact about this machine, which is the "I could not tell" rule at its most literal.

### What can a human see or do now that they could not before

Know what carrying this customization onto a newer t3code actually costs — three files, named —
instead of guessing from a risk table; and re-run that measurement any time with one command,
against a fork and an upstream clone that the measurement provably did not disturb. And read, from
the same run, what the contract that comes out the other side actually looks like: it regenerates,
and three of its shape artifacts move.

