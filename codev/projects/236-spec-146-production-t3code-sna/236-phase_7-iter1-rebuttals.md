# Phase 7 iteration 1 — rebuttals

**opencode: REQUEST_CHANGES** (HIGH, three findings). **claude: APPROVE** (HIGH, two doc nits —
one of them the same file opencode blocked on).

Accepted: 5 (three from opencode, one nit from claude, one I found by grepping). Disputed: none.

Both confirmed the phase's substance: the revocation trade recorded in the threat model's own
terms, both route `rationale` strings reconciled, the matrix rows added, `dev-check` actually
revoked, and `agent-approval-path.test.ts`'s residual assertion intact — so criterion 18 holds
and no claim of verified human presence was added anywhere in this project.

---

## The shape of every finding here

All three of opencode's, and claude's nit, are the same thing: **documentation still describing
the pre-command world.** Which is precisely what this phase exists to fix. I updated the two
documents the plan named and left the adjacent ones asserting the opposite — the same
"one step too narrow" pattern that accounted for five of phase 6's six findings, in a different
costume.

## 1. The threat model's own "What this does not stop" had expired

**opencode.** The sharpest of the three, because of where it is.

**Verified.** That bullet still read: *"`flag-only` is the only practical human approval path
until the client exists. Issuance is reachable only over the `codev-agent` HTTP route with a
paired session, and the client that would hold one arrives in a later phase. Until then every
real approval is `flag-only`."*

True when phase 6 wrote it. False after this spec: the client exists, `afx pair issue --purpose
client-session` mints the token a session costs, and a capability-backed approval is reachable
by a person. **And I edited the section directly above it in the same commit.**

The document's opening rule is that every claim in it is one the code actually makes true, and
that two earlier revisions were falsified for describing a boundary that was not there. This was
the mirror image: a residual that had stopped being one, left standing.

**Changed.** The bullet now says what remains true — flag-only is still reachable, still not a
control, and taken by every CLI approval — and what changed: it is no longer the *only* practical
path. With the sentence about its own expiry, because that is this document's habit.

## 2. `apps/client/README.md` told operators to use the route that does not work

**Both lanes.** Verified: `Revoke it with DELETE /api/agent/v1/machines/<name>`. That route is
`human-session`, `human-session` includes `machine-credential`, so it requires already holding
the credential being withdrawn — **the exact defect this whole command exists to fix**, still
being recommended in the client's own README.

**Changed.** `afx pair revoke <name>`, with a sentence on why the old instruction was the one
that could not work, so a reader who remembers the old line knows it was wrong rather than
merely superseded.

## 3. The operator runbook contradicted the threat model

**opencode**, and explicitly noted as a file the plan did not list.

**Verified.** `146-remote-access-runbook.md` said *"There is no `afx` subcommand for this yet —
the operator surface lands with the client phase"* and showed `new PairingStore().issue()` with
no arguments. **That call now throws**: `purpose` and `authority` are both required.

So the operator runbook — the document someone follows at a terminal — told them to run something
that fails, while the threat model two directories over described the command that works.

**Changed.** `afx pair issue --purpose machine-credential`, with why `--purpose` has no default
and what `--authority` records (and does not claim). Added a **Withdraw a device** section:
`afx pair list`, `afx pair revoke`, why it works holding nothing, and a pointer to the trade in
the threat model. A short note records that the old text throws, because a runbook whose history
is invisible invites someone to restore it.

## 4. Two more the reviews did not reach

Found by **grepping the repository for the stale instruction** rather than editing the files I
had in mind — which is the correction to my own process here, not a separate finding:

- The runbook's *other* revocation passage still presented the HTTP DELETE as the way to revoke.
  Now labelled "for a client that holds a session", with an explicit "not the route to reach for
  at a terminal".
- `apps/client/scripts/pair-dev.mjs`'s header said there is no CLI for pairing and pointed
  revocation at the same DELETE. Now names `afx pair issue` as the operator command and says why
  the script still does both halves (a dev client that cannot authenticate shows nothing).

## 5. claude's heading nit

`## For phase 7, stated here so it is not inherited by accident` — ambiguous now that two specs
have a phase 7. Changed to `For spec 146 phase 7`.

## Verification

- `packages/codev`: typecheck clean; route enumeration and failure matrix **110 passing**; full
  suite **7053 passing** as of the phase-7 commit.
- `apps/client`: **232 passing**, e2e **7 passing**.
- `agent-approval-path.test.ts:565` — the residual assertion passes unchanged.
- No `DELETE /api/agent/v1/machines` instruction remains anywhere as a recommendation. The
  occurrences that survive are: the spec's Current State (historical, correct), the threat
  model's statement of the problem (correct), the runbook's route reference (now scoped to a
  client with a session), and two explicit "not this, use `afx pair revoke`" notes.
