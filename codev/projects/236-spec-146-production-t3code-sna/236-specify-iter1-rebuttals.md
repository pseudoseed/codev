# Specify iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH` confidence: **claude** and **opencode**
(`xai/grok-4.6`). They converged on the same five items, which is unusual enough to be worth
noting — the overlap is not two readings of one sentence, it is two independent verifications
landing on the same gaps.

**I verified every claim against the code before acting on any of it.** All five hold. Nothing
below is accepted on the strength of a reviewer's summary.

Accepted: 5 of 5, plus one lesser point and one arithmetic slip of my own.
Disputed: none.

---

## 1. Criteria 7 and 12 were mutually incoherent on pairing-token purpose

**Both lanes.** Claude escalated it on a second pass from "a missing argument" to "an internal
coherence defect", and that escalation is correct.

**Verified.** `PairingStore.issue()` requires `purpose: 'machine-credential' | 'client-session'`
and `redeem` enforces it, refusing — and deliberately not consuming — a token presented at the
wrong ceremony. There are two ceremonies and two redemption sites:
`agent-routes.ts:526` redeems `machine-credential` at `POST /pairing/redeem`;
`agent-routes.ts:671` redeems `client-session` at `POST /human-sessions`. The only operator
precedent, `pair-dev.mjs:71`, hardcodes `machine-credential`.
`agent-approval-path.test.ts:56-57` mints the two separately as distinct constants.

**Why this mattered more than a missing flag.** My criterion 12 was satisfiable by a command
that mints `machine-credential` only. Such a command can pair a device and can *never* open the
human session that criteria 7 and 8 depend on — so a builder could have satisfied every written
criterion and left 9b exactly as unreachable as it is today, which is the failure this whole
initiative keeps finding. The defect was in my spec, not in the reviewers' reading of it.

**Changed.** Added criterion 12b: `afx pair issue` mints **both** purposes, and `purpose` is a
**required** argument with **no default**.

Both lanes asked me to "name which is the default". I went further and removed the default,
which is a deliberate departure from what was asked. A default that is wrong does not fail at
`issue` — it fails at redemption, in a different process, against a different route, with a
message about a token rather than about the choice that was made for the operator. That is the
deferred-failure shape this repository rejects everywhere else. Refusing at issue time costs
one argument and reports the problem where the decision was made.

Also added to Current State a paragraph establishing the two-ceremony fact, and three test
scenarios: each purpose mints; a token refused at the wrong ceremony is not consumed and still
works at its own; and a `client-session` token drives an approval route end to end, so the link
from the operator command to criterion 7 is driven rather than asserted.

## 2. New snapshot statuses versus the client's validator

**Both lanes.**

**Verified.** `validateSnapshot` (`connection/types.ts:203-213`) admits exactly `not-provided`,
`unreachable` and `available` and returns null for anything else. `snapshotRejection`
(lines 191-201) classifies a present-but-unrecognised value as `unreadable`, and reserves
`older-server` for the field being *absent*. So a client build predating this change does not
degrade one row against a wired Tower — it blanks the whole machine.

**Changed.** Added criterion 5b: the in-repo validator accepts the new statuses and still
rejects anything outside the set; an older client failing closed is **the intended behaviour**,
recorded as the mixed-version cost; and the allow-list is explicitly named as the thing that
must not be loosened to green a test. Added a test scenario driving both classifications —
unrecognised value → `unreadable`, absent field → `older-server` — and a risk-table row.

Claude's framing of the danger is the part worth keeping: the hazard is not the fail-closed
behaviour, it is a builder meeting a red test and quietly relaxing the validator, which would
delete the client's refuse-what-you-cannot-read rule to make a test pass.

## 3. Approach 3B answered the wrong objection

**Both lanes.** This is the sharpest of the five.

**Verified.** `agent-auth.ts:190` gives the rationale for privileging revocation as
"revocation is privileged: an agent that could revoke could deny a human their gate" — a
**denial-of-service** argument. My draft answered a confidentiality argument ("a same-UID agent
could already forge a capability; revoking one is strictly less dangerous than minting one"),
which does not reach it at all. The conclusion survives; the reasoning I gave for it did not.

**Changed.** Rewrote the trade to answer availability on its own terms: a same-UID agent can
already write these stores directly — it can revoke, forge, delete or corrupt them — so it can
already perform that denial. A shipped command makes the denial *convenient*, not *possible*.
What is being bought is that the operator can withdraw access at all, against a status quo in
which the human cannot revoke and the agent still can.

Criterion 17 now requires the threat model to answer the availability argument specifically,
and requires **both** route `rationale` strings — `machine-credential-revoke` and
`approval-capability-revoke-machine` — to be reconciled in the same change. Claude's phrasing
of the cost of not doing so is exact: otherwise the repository carries two documents asserting
opposite things about one boundary.

## 4. Criterion 16 was an irreversible write outside the worktree

**Both lanes.**

**Verified.** `~/.agent-farm/machines/` holds one record — `dev-check`, expiring
2026-11-28, unrevoked — and it sits outside `CODEV_AGENT_FARM_DIR` isolation.
`machine-credentials.ts:313` returns false when the record is already revoked, so the operation
is not idempotent.

**Changed.** Criterion 16 now names it a **one-time manual operator action, explicitly not a
suite step**, states that automating it would have CI revoke real credentials, and names the
recovery (re-pair that machine). The corresponding test scenario is scoped to a scratch store
under `CODEV_AGENT_FARM_DIR`. Added a risk-table row.

## 5. The session-status mapping was deferred to the plan

**opencode**, and it is right on the protocol point: this is ASPIR, the spec is the last gated
WHAT, and what a row *says to a person* is a WHAT. I had named the mapping as a decision in
Current State and then declined to make it, which is the shape of leaving work for a builder to
guess at.

**Changed.** Pinned the whole table in the spec, with its precedence: a requested porch gate →
session `error` → session activity (`running`, `starting`) → thread settledness → remaining
session status. Porch outranks everything, as it already did. `error` outranks activity because
a failed session is not working whatever it last reported. Settledness outranks the idle
statuses but not the active ones, because `settledAt` is a past fact and a running turn is a
present one — which answers opencode's "which side wins when session status and settledness
disagree" explicitly rather than by implication.

opencode also asked whether new row words are allowed. **Two, and no more: `STOPPED` and
`ERROR`.** This is the one place I added something neither lane asked for, and the reason is
that mapping onto the existing five words cannot be done honestly: `interrupted`, `stopped` and
`error` would all have to fold into `SETTLED`, which renders "this crashed" and "this was torn
down" as "this finished its work". `SETTLED` keeps meaning finished. Criterion 4b caps the
additions at exactly those two so this does not become an open licence to invent words.

## Lesser points

**Concurrency bound on approval operations** (both lanes, flagged non-blocking). Accepted as
an Important open question: each operation can spawn a full check set from Tower's process and
nothing in the draft bounded N of them. Recommended answer recorded — a per-workspace or
per-project limit whose refusal is its own distinguishable state rather than a queue that hides
the wait. Also a risk-table row.

**Criterion 5 said "four" against criterion 2's "five"** (opencode). My arithmetic error, and
it turned out to be a symptom rather than a typo: opencode's accompanying point was that the
connector's `connecting`, `cooling-down` and `misconfigured` must stay distinct from
`unreachable`, which my draft mentioned in criterion 6 and had not carried into criterion 2.
Fixed by pinning the full set at **eight** in a table naming which producer emits each. Six of
the eight are answers `requestThreadBackend` already computes. `connecting` and `cooling-down`
are kept apart deliberately: one resolves on its own and the other will not until a timer
passes, which is the difference between "wait" and "go look at your server". Criterion 5 now
refers to "every snapshot-level status" rather than to a count that can drift.

## What I did not change

Nothing was disputed. Both lanes confirmed the factual claims in Current State against the
code independently, and both confirmed the three recommended approaches (1B reuse the existing
`threads` config, 2C a file-backed operation store, 3B revoke by direct store write) as sound
and feasible. Claude additionally verified that `checks.ts:63` uses async `spawn` and that
`runPhaseChecks` is awaited, so criterion 7's "run checks without blocking the request" is
feasible rather than hopeful — I had not checked that, and it is load-bearing for Decision 2.
