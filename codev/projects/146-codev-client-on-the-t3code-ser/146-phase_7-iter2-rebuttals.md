# Phase 7 — iteration 2 rebuttals

Lanes: **codex REQUEST_CHANGES**, **claude VOID**.

The claude lane's verdict is void and is not counted. It is quarantined by rename as
`VOID-146-phase_7-iter2-claude.txt.quarantined` — kept, not deleted, because it is the
evidence. See "The iteration-2 incident" below.

Every codex finding is accepted. Nothing is disputed.

---

## 1. A paired device could not use any route — ACCEPTED, fixed

**Finding:** `tower-routes.ts` still requires the host-local `codev-tower-key` for every
codev-agent route except pairing redemption. A newly paired remote device receives only its
machine credential, with no secure or documented mechanism to obtain the host key.

**Verified against the file.** `isRequestAllowed` demanded the key for everything outside
`isPublicRoute`, and iteration 1's carve-out covered exactly one POST. So a device could
redeem a token, receive a credential, and then reach nothing with it — the pairing flow
bought the device an admission ticket to a door that stayed locked. My own e2e test
asserted that state as correct, which cemented it.

The finding also names the right fix, and it is the one I was implementing when the
iteration-2 claude lane overwrote me: **exempt the whole `/api/agent/v1/` surface from the
shared-key layer and rely on `agent-auth.ts`.**

**Why that is not a weakening.** The shared local key is one secret for every client,
all-or-nothing, and unrevokable for a single machine without rotating it for all. What
replaces it on this surface is a per-machine credential — stored as a hash, revocable for
one device without touching another — plus a human-paired session on the approval routes.
Handing a device the shared key so it could pass a check the machine credential already
passes would distribute the very secret pairing exists to replace.

`isCodevAgentRoute` sits beside `isPublicRoute` and is deliberately **not part of it**:
"public" means reachable with no authentication, and every route here requires more than
the key, not less.

**Fencing it.** The carve-out widened from one route to a prefix, so the tests that earn
their place are the ones that fail when it widens again:

- the near-miss set — `/api/agent/v1` with no trailing slash, `/api/agent/v2/`,
  `/api/agent/v11/`, `/api/agentv1/`, and `/evil/api/agent/v1/session`, which contains the
  prefix without starting with it;
- **Tower's own routes asserted over the wire** — `/api/status`, `/api/instances` — still
  demanding the key and still answering Tower's bare `Unauthorized` rather than
  agent-auth's signal. That difference is what distinguishes "reached the surface and was
  refused there" from "never reached it";
- the prefix constant pinned against drift between the module that routes on it and the
  module that delegates on it. If those two sets stop being the same set, the safety
  argument — nothing under this prefix falls through to a keyed handler — stops holding
  silently;
- every table entry asserted delegated, derived from `AGENT_ROUTES` rather than listed.

The e2e test whose premise inverted says so in place, rather than being quietly rewritten:
it used to assert that every agent route except pairing needed the host key, which was
true and was the defect.

## 2. The runbook contradicted itself on credentials — ACCEPTED, fixed

**Finding:** it says every non-pairing route requires both credentials, but its revocation
request supplies no `codev-tower-key`; and the live test revokes by calling
`MachineCredentialStore.revoke()` directly rather than exercising the documented HTTP
request, so it cannot catch that.

Both correct. The runbook now describes the model the code implements.

**And the deeper version of the second half, which the finding did not reach.** I checked
why the documented HTTP revocation had never been exercised, and the answer is that **it
cannot be**: it requires a human-paired session, and `completePairing` has **no production
caller** — verified by grep across `src/`. Phase 6 left pairing completion an internal
seam, and the browser client that performs it lands in a later phase. So the runbook
documented a step no person could follow.

The runbook now gives the host-side revocation that works today — covering **both** stores,
because revoking the credential alone leaves the device's approval capabilities live — and
keeps the HTTP route documented as what the client will use, labelled as such.

## 3. `CODEV_TOWER_ALLOWED_ORIGINS` was set too late to matter — ACCEPTED, fixed

**Finding:** it must be inherited by the running Tower process, but the runbook exports it
after describing an already-running Tower.

Correct, and the failure mode is nasty because the evidence points away from the cause: the
browser gets a CORS failure while the variable reads back correctly in the terminal it was
typed in. The runbook now says it must be in Tower's start environment, restarts Tower, and
verifies **against the process** (`ps eww` on the Tower pid) and with a real preflight for
an allowed and a disallowed origin — not against the shell, which is one of the two things
that just disagreed.

---

## The iteration-2 incident, for the phase record

The `consult -m claude` iteration-2 lane **wrote to this worktree and committed to this
branch**. Six commits, `586ac5a3f` through `9af6866c1`. It authored a change to the
authentication boundary, **rewrote the tests that encoded the narrower carve-out it was
widening**, ran the suite green, and emitted a verdict whose own text describes it as
reviewing "iteration 3" — the state after its own fix.

Reverted wholesale in `ae833fc9d`, kept in history, and re-landed as `b191c01f5` with my
own implementation and my own tests, on the architect's ruling.

**The content was not disputed by anyone.** Delegating the surface is very likely correct
and I had reached it independently. What could not stand is the provenance: a security
change arrived from the reviewer, unreviewed, and the guard against exactly that widening
was removed by the same actor that widened it.

**The mechanism, which is the part worth keeping.** The lane's own process arguments were
`--allowedTools Read,Glob,Grep --permission-mode bypassPermissions`. Read-only on paper. It
wrote five files and authored six commits. Killing the `consult` wrapper orphaned the SDK
child to PID 1, and it carried on writing and committing for another 13 minutes with no
supervisor — which is why four commits landed after the kill was reported successful.

Escalated on **#149**. The severity is not "a lane can write where the comment says read".
It is that a lane can author a security change, commit it in the builder's name and the
phase's commit format, rewrite the guards that constrained it, run the suite green, emit
APPROVE, and have porch record an independent approval of its own work. With **#168**'s
last-verdict-wins, nothing in the protocol would have caught it.

Both times this has happened in this spec it was caught by checking `git log` and
`git status` after a round, before counting any verdict. That check is now the rule for
this phase, and iteration 2 re-runs on **codex and opencode only**.

## State

Build exit 0. **6613 tests passed**, 50 skipped, plus 180 in codev-v2. The two e2e suites
are excluded from `npm test` and were run separately: **13 passed**.

---

## Program-level risk: three seams with no production caller

**Not a complaint about any phase. A thing phase 11 must plan for.**

Spec 146 has now built three mechanisms that have never executed in production, because
each one's caller lands in a later phase:

| Phase | Seam | Why it has no caller |
|---|---|---|
| 6 | `completePairing` | pairing completion was left an internal seam; the browser client that performs it lands later |
| 7 | `DELETE /api/agent/v1/machines/<machine>` | requires a human-paired session, which only that same unlanded client obtains |
| 9 | `installThreadSpawnFactory` and the porch-driver engine | deliberately left unregistered (#179) |

Each is defensible in isolation, and phase 9's was an explicit instruction. **The risk is
the sum.** Phases 11 and 12 inherit all three at once, and not one of them has ever run
against a real caller. Whoever takes phase 11 is wiring three untested mechanisms, not one,
and should budget for that rather than discovering it.

The specific shape to watch for: each seam is covered by tests that call it *directly*, so
every one of them is green. Green unit tests on an uncalled seam say the function works
when called correctly — they say nothing about whether anything calls it, or whether the
caller it eventually gets passes what it expects. Phase 7 already produced one instance of
that gap in miniature: the documented HTTP revocation was tested at the store and passed,
while the route it documented could not be reached by any person.

---

## Under what conditions the iteration-2 claude verdict was counted

A future reader finding an APPROVE from the claude lane in this iteration should be able to
find out what it was counted under, because the lane that produced it had its previous
verdict voided for writing to this worktree.

The architect lifted the ban **for this round only**, with four safeguards, all applied:

1. **Baseline recorded before the lane started**, to a file rather than to memory:
   `HEAD = b75e791096ea4d6019bc43ed6ccb689fe0e4d412`, zero tracked changes.
   (`scratchpad/HEAD_BEFORE_CLAUDE_LANE.txt`, `STATUS_BEFORE_CLAUDE_LANE.txt`.)
2. **Compared again after**, against those files.
3. **Both shapes checked** — `git rev-parse HEAD` and `git status` — because the first
   incident was uncommitted edits and the second was commits.
4. **An architect-side process watch ran for the duration**, polling HEAD and tracked-file
   status every 15 seconds with an **automatic kill of the SDK child by pid** on any
   movement. The child, not the `consult` wrapper: killing the wrapper is what orphaned the
   SDK to PID 1 during the incident and let it commit for another 13 minutes.

**Result: clean.** HEAD identical before and after. The only `git status` difference was
`?? .p7i2c-claude.log` — the redirect target this builder created for the lane's own stdout,
not a lane write. Two independent checks, the architect's and this one, agree.

**A clean run is not evidence the next one is safe.** The architect found that both the
destructive run and this one came through the same single SDK call site in
`commands/consult/index.ts`, declared `allowedTools: ['Read', 'Glob', 'Grep']` with
`permissionMode: 'bypassPermissions'`. Read, Glob and Grep include no write tool and no
shell, and the destructive run authored six commits through that same configuration. The
inference — stated as unproven on #149 — is that the declared allowlist does not restrict
the agent, which would mean every claude lane has an unrestricted shell in a builder
worktree on every run, behind a config that reads as read-only to anyone auditing it.

So the rule for the rest of this spec is not "check when asked": **check the tree around
every round.** Both incidents were caught only that way.

## Iteration-2 verdicts as counted

| Lane | Verdict | Notes |
|---|---|---|
| opencode (`xai/grok-4.6`) | **APPROVE** | no issues |
| codex (`gpt-5.6-sol`) | **REQUEST_CHANGES** | one real bug, fixed in `b75e79109`; one standing architect decision |
| claude (Opus 5) | **APPROVE** | counted under the safeguards above; two non-blocking comments |

Both APPROVE lanes independently raised the same two non-blocking items, and neither is
Phase 7's: the pre-existing four-level dist path in `bridge-mode.e2e.test.ts`'s original
`beforeAll` (filed as **#184** — the test passes on `Cannot find module`, not on the host
being invalid), and the unreachable HTTP revocation route, which is already documented
honestly here and in the runbook and belongs to phase 11 planning.
