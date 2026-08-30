### Iteration 1 Reviews
- claude: REQUEST_CHANGES — Async submit/poll routes are sound, but the running record never carries phase/checks and the already-approved path has no route-level test.
- opencode: REQUEST_CHANGES — Async submit/poll works, but running ops carry no phase/checks, success is only proven with checks skipped, and the somebody-else already-approved path is untested.

### Builder Response to Iteration 1
# Phase 5 iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH`: **claude** and **opencode** (`xai/grok-4.6`).
They agreed on all three findings.

Accepted: 3. Disputed: none. One hedge withdrawn by its own author.

---

## 1. A running operation never said what it was running

**Both lanes.** claude traced it end to end: `approval-operations.ts` accepts `{ phase, checks }`,
`agent-routes.ts` spreads them into the poll response, and the **only** production call passes
neither — so those two fields could never appear in any response this system produces.

**Verified.** Complete plumbing with nothing connected at the far end, which is worse than an
absent feature: the fields are in the type, in the response shape, and in the store's tests, so
everything reads as though an operator gets them. opencode put the consequence plainly: *"a poll
of `running` has nothing for an operator to wait on"* — which is the spinner this phase's own
store comment says a status word becomes when it carries no content.

**Changed.** `describeWork()` reads the project's phase from the status projection and asks
**porch's own `getPhaseChecks`, after overrides**, for the check set. Deliberately porch's
computation rather than a second reading of the protocol: the names shown to a waiting operator
are then the commands that actually run, not a list that can drift from them.

It is best-effort by construction, and says so. A protocol that will not load still has an
approval worth running, and porch will reach the same problem and report it properly — so this
reports what it could read and nothing it could not. Guessing a phase name would be the failure
this whole spec is about, in the code added to fix a display gap.

## 2. Criterion 7 was not driven

**opencode**, and it is the sharpest finding in the review.

**Verified.** My success test set `skip: true` on every check, so `getPhaseChecks` returned `{}`
and `refuseIfChecksWouldRun` would never have fired. That is **the path the synchronous route
already serves**. The phase's headline criterion — *approving succeeds on a project whose phase
declares checks* — was demonstrated by removing the condition that makes it mean anything, and it
passed green.

This is the recurring defect of this initiative arriving in the test rather than the code: a
green assertion that production never exercises.

**Changed.** The fixture now takes three settings, and the middle one is what this phase exists
for:

| Setting | What it does | Why |
|---|---|---|
| `skipped` | removes the checks | the path the synchronous route already served; useful for the cheap cases |
| `passing` | keeps them **declared**, overrides the commands with `true` | the phase still declares checks, so the sync route still refuses — and this path runs them, they pass, the gate is approved |
| `real` | leaves the repository's commands in | a throwaway directory cannot pass them; this is how the refusal path is driven |

The new criterion-7 test asserts **both halves against one workspace**: the synchronous route
returns 403 `PHASE_CHECKS_REQUIRED` with the gate still pending, and the asynchronous route then
approves it. That pairing is the claim; either half alone is not.

## 3. No route-level already-approved test

**Both lanes.** opencode: *"it is the defect this reporting layer was built to stop."*

**Verified.** Criterion 9 names the case and the plan's phase-5 test plan asks for it; it was
covered only at the store level, where I had constructed the record by hand — which tests my
belief about porch rather than porch.

**Changed.** Two genuinely different sessions. The first approves; the second submits against the
now-approved gate. The second's report is asserted to carry `outcome: 'already-approved'` and the
**first** session's machine, session id and approved-at — each **cross-checked against
`status.yaml`**, not against what the route said, so the test cannot pass on a response that
agrees with itself. It also asserts the reported session is *not* the requesting one, which is
the exact falsification the synchronous route was fixed for.

## The hedge that was withdrawn

claude flagged the destructured-but-unused `ApprovalRefusedError` as a possible `noUnusedLocals`
break, then **checked and withdrew it**: no such setting in `packages/config/tsconfig.base.json`
or `packages/codev/tsconfig.json`, and no eslint config covering the package. Recorded because
withdrawing a hedge after checking is the behaviour worth having, not because the item stands.

The binding is gone anyway — it was a leftover of moving the refusal handling into
`settleApprovalFailure`.

## One assertion of mine was wrong and the code was right

My new running-record test asserted the phase was `review`; the fixture declares `implement`, and
`describeWork` reported `implement`. I fixed the assertion, not the reader. Noted because the
alternative — adjusting the reader to match a test's memory of a fixture — is how a display
becomes fiction.

## opencode's non-blocking note

The in-flight conflict test can take its `202` else-branch when the first operation settles
before the second submit arrives, so it does not always drive `APPROVAL_ALREADY_IN_FLIGHT`. True,
and left as it is with the reasoning already in the test: the store tests pin the bound
deterministically, and a route test that forced the timing would be asserting scheduling. The
branch is written to record which case ran rather than to assert one away.

## Verification

`packages/codev`: **7050 passing**, 0 failing, 3 files and 52 tests skipped. Typecheck clean.
The async route file is 14 tests; the route enumeration 63 over both new routes.

claude noted its review was static — no shell that session — which is the right thing to have
said.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
