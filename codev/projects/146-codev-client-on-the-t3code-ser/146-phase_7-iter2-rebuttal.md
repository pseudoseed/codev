# Phase 7 — iteration 2 rebuttals

Reviews: **codex REQUEST_CHANGES**, **claude APPROVE**.

All three codex findings are accepted, and the first one is the same defect as
iteration 1's — fixed too narrowly the first time. Nothing here is a disagreement.

---

## 1. A paired device could not use its credential — ACCEPTED, fixed

**Finding:** `tower-routes.ts` still required the host-local `codev-tower-key` on every
codev-agent route except pairing redemption. A newly paired remote device receives only
its machine credential and has no way to obtain the host key, so the documented remote
flow still could not run. The e2e masked it by sending `towerHeaders()` on every
post-pairing request.

**Verified in the file.** `isPublicRoute` carved out exactly
`POST /api/agent/v1/pairing/redeem` and nothing else, and the carve-out's own comment said
so: *"Every other `/api/agent/v1/` route still requires the key AND a machine
credential."* That sentence is the bug, written down. Iteration 1's fix got a device a
credential and then left it with nothing it could call.

This is the same finding as iteration 1's, and the reason it survived a fix is worth
naming: I fixed the request that was in the runbook rather than the flow the runbook
describes. Redemption was the failing request, so redemption is what I unblocked. The
step after it was never exercised keyless, so nothing failed.

**Fixed** by delegating the whole `/api/agent/v1/` prefix past the shared-key layer
instead of exempting one route.

The reason that is a delegation and not a hole: the agent surface carries a **stronger**
authentication than the key it stops requiring. `agent-auth.ts` demands a per-machine
credential on every route in its table (`NO ROUTE IS PUBLIC`, and a test enumerates the
table to prove it), stores only a hash, and revokes one device without touching another.
The shared key can express none of that — it is one secret for every client, and holding
it is all-or-nothing. Requiring both would add no boundary; it would only make the surface
unreachable by the devices it exists for.

It is safe to hand over wholesale because `handleAgentRoute` **claims** the prefix: it
returns `false` only for paths outside it, answers `404 AGENT_ROUTE_NOT_FOUND` for a path
the table does not name, and refuses anything unauthenticated before dispatch. Nothing
under the prefix can fall through to a keyed handler. That is the property the change
rests on, so it is asserted directly rather than assumed.

**Tests.** The e2e now reads protocol state with the credential and NO host key, which is
the shape every remote device has — that assertion is the deliverable, and it failed
before this commit. The suite also pins the boundary from four sides, because a prefix
check is exactly the kind of thing that silently widens:

- every route still refuses keyless with no credential, and refuses with its **own named
  signal** rather than Tower's bare `Unauthorized` (unreachable and unauthorized are not
  the same answer, and only one of them is a boundary);
- `/api/agent/v1-admin`, `/api/agent/v2/...`, `/api/agent` and `/api/agentx/v1/...` are
  **not** swept in — the trailing slash is load-bearing;
- `/api/terminals` and `/api/overview` still require the host key, over the wire;
- `GET` on the pairing path answers 404 from the table, so the bootstrap's exemption does
  not extend to a method the table never named.

The prefix string is written twice (`server-utils.ts` cannot import `agent-auth.ts` —
`agent-auth.ts` imports `isAllowedOrigin` from it, and a cycle between the choke point and
the surface it delegates to is not worth one constant). A test asserts the two copies
still agree, which is the only risk the duplication carries.

## 2. The runbook contradicted itself on revocation — ACCEPTED, fixed

**Finding:** the runbook said every non-pairing route needs both credentials, then
documented a `DELETE` carrying only the machine credential and human session. The live
test revoked by calling `MachineCredentialStore.revoke()` directly, so it could not catch
the mismatch.

Both halves are right. The prose was wrong and the test could not have noticed, which is
the pairing that lets a documented-but-impossible request ship.

**Fixed.** The prose is now accurate — the `DELETE` as written is exactly what the server
wants — and the section says what the host key *is* still for, so "keyless" is not read as
"a check was removed".

**On testing it over the wire:** I added an assertion that the documented request reaches
codev-agent and is refused with a named signal, rather than dying at the shared-key layer
with a bare `Unauthorized`. I did not test a *successful* revoke over HTTP. The route
requires a human session, the registry is in-memory and per-process, and the e2e Tower is
a separate process with no route to mint one — Phase 6 pairs a browser out of band. So the
half I can reach is asserted and the half I cannot is stated here rather than papered over
with a store call dressed up as an HTTP test.

## 3. `CODEV_TOWER_ALLOWED_ORIGINS` was exported beside a running Tower — ACCEPTED, fixed

**Finding:** the variable is read by the Tower process, but the runbook exported it after
describing an already-running Tower, and never verified it took effect.

Correct, and the failure mode is nasty: the browser dies at the preflight while the
variable is plainly visible in the operator's shell, which sends them looking at CORS
instead of at process environment.

**Fixed.** The order is now set-then-start, with `afx tower stop && afx tower start` —
verified against `afx tower --help` that `restart` is not a subcommand, rather than
shipping a plausible-looking command. The restart cost is stated too: it kills every
running agent session, which is not a step to run casually mid-phase.

The section also ends with a verification that reads the *server's* answer instead of the
shell's: an `Origin`-bearing `curl` should get `401 MACHINE_CREDENTIAL_REQUIRED` (origin
accepted, credential missing), and `403 ORIGIN_NOT_ALLOWED` means Tower did not inherit
the variable.

---

## What this iteration cost, and the rule it earned

Iteration 1 and iteration 2 found the same defect. The fix in between was real and the
test for it was real, and neither helped, because the test asserted the step that had
been broken rather than the flow that had to work.

**A bootstrap is not done when the bootstrap request succeeds. It is done when the thing
it bootstraps can be used.** The credential-only read is one line of test and it is the
only line that was ever load-bearing here.

## Verification

- `vitest run src/agent-farm`: **183 files, 3663 passed**, 1 skipped.
- `vitest run --config vitest.e2e.config.ts src/agent-farm/__tests__/phase7-pairing.e2e.test.ts src/agent-farm/__tests__/bridge-mode.e2e.test.ts`: **15 passed**.
- `tsc --noEmit`: clean.
- Pre-existing failures in `cli-tower-mode`, `tower-reconnect`, `send-integration` and
  `bugfix-1515-tower-isolation` were confirmed pre-existing by stashing this change and
  re-running: identical 7 failed / 9 passed. Not caused here, not fixed here.
