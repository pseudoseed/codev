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
