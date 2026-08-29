# Phase 7 — iteration 1 rebuttals

Reviews: **codex REQUEST_CHANGES**, **claude APPROVE**. Both lanes produced a verdict
file; the codex lane's first attempt hit its usage limit (exit 1, no output file) and was
re-run after the reset rather than counted or substituted.

Every codex finding is accepted. Two were defects in what this phase shipped, one was a
correct reading of a deliverable I had implemented more weakly than its words. Nothing
here is a disagreement.

---

## 1. The documented bootstrap could not work — ACCEPTED, fixed

**Finding:** `tower-routes.ts` authenticates codev-agent requests with Tower's shared
local key before `agent-auth.ts` runs, so the runbook's pairing request — carrying only
`x-codev-pairing-token` — returns 401. The live test masked it by adding
`codev-tower-key` to every request.

**Verified against the file, not the summary.** `isPublicRoute` returns `false` for every
non-GET method, so `POST /api/agent/v1/pairing/redeem` never reached Phase 7's own checks.
The finding is exactly right, and it is the worst class of defect this phase could have
shipped: a runbook that instructs a flow the code refuses. A machine being paired for the
first time has no host-local key **by definition**, and handing it one to pair would
defeat pairing.

**Fixed** by allowing that single POST past the key check, with the reason stated at the
carve-out: *keyless at that layer, not unauthenticated* — it is still authenticated, by a
single-use token with a ten-minute TTL. The carve-out is one route, and a test asserts the
neighbours stay refused, including the near-miss of the same path with a different method.

## 2. CORS preflight omitted the new headers — ACCEPTED, fixed

**Finding:** `Access-Control-Allow-Headers` lists `X-Codev-Human-Session` but not the
machine-credential or pairing-token headers, so a browser on an allowed remote origin
fails at the preflight.

Correct and complete. Added both, with a preflight test that drives a real `OPTIONS`
against the running server rather than reading the constant.

## 3. A declared bind does not actually make the transport HTTPS — ACCEPTED, and the
   residual is now stated where it cannot be missed

**Finding:** `CODEV_BRIDGE_TLS=terminated` permits a plain-HTTP listener on `0.0.0.0`. A
reverse-proxy declaration does not prevent direct plaintext access, which contradicts "all
remote transport is HTTPS/WSS".

This is a strict reading of the deliverable and it is right. My code already said the host
cannot verify the declaration; it did **not** say the part that matters, which is that the
raw port stays reachable and the terminator is simply not in that path.

I did not remove the escape hatch, and the reason is in the plan rather than in my
preference: it says the existing `BRIDGE_MODE` gate "is the model and is kept", and
removing non-loopback binding would delete a supported LAN configuration — an
outward-facing change that is not mine to make inside a phase.

What changed instead:

- `decideBindPolicy`'s **allowed** decision now names the residual in its own message:
  the listener speaks plain HTTP, a routable peer bypasses the terminator, and the
  configuration that does satisfy the deliverable is a loopback bind with the terminator
  on this host.
- The runbook says the same beside the escape hatch, and recommends a firewall rule.
- Tests assert those words are present, so the message cannot be trimmed back into
  something that reads as approval.
- The architect's separate finding had already made the loopback recipe the **primary**
  one, so the path the deliverable describes is now the path the runbook leads with.

## 4. Tests did not exercise the remote-browser flow — ACCEPTED, and it was worse than
   the finding said

Fixing (1) let me add the tests this asks for: redemption with no host key, the
one-route carve-out, and a real preflight.

Writing them surfaced something the finding did not reach. `vitest-e2e-setup.ts` wraps
global `fetch` and injects `codev-tower-key` into every loopback call. My first keyless
test therefore **passed while the harness supplied the key** — it proved nothing, and
would have gone on proving nothing. Both tests now set an empty key header, which is that
setup's own documented opt-out, so the keyless path is actually keyless.

This is the same defect as a fixture that agrees with the assumption it should challenge,
arriving through the environment instead of through a fixture. It is the second time in
this phase that the environment did that: the first was ambient `BRIDGE_MODE=1` leaking
into `startTower`, which meant every "default behaviour" Tower e2e test had been spawning
a bridge-mode Tower.

---

## Architect findings, same iteration — all four applied

1. **The runbook instructed an unnecessary exposure.** It proxied Tailscale Serve to
   `http://127.0.0.1:4100` and then told the operator to bind `0.0.0.0` as well. The proxy
   already reaches loopback, so that opened every interface for nothing — the exposure this
   phase exists to prevent, in the artifact people follow without re-deriving it. The
   tailnet path now says plainly not to set `BRIDGE_TOWER_HOST`; the non-loopback recipe is
   a separate section for the one case that needs it. A test slices that section and
   asserts the instruction cannot come back.
2. **`issue()` trimmed the machine name and `revoke()` did not**, so a padded name hashed
   to a different file and answered `revoked: false` — a security control reporting a
   success-shaped failure. Normalisation is now in one place every entry point goes
   through, tested in both directions.
3. **Revoking a machine credential left that machine's approval capabilities live.** The
   route now revokes both stores in one call and reports each count separately; the runbook
   says they are two stores keyed by the same name.
4. **One unparseable file under `machines/` fails every machine closed with 503.** The
   behaviour stays — skipping it would tell a device "you were never paired", a definite
   answer this host cannot honestly give — and the blast radius plus a command that finds
   the bad file are now in the runbook's recovery section.

## State after this iteration

Build exit 0. **6607 tests passed**, 50 skipped, plus 180 in codev-v2. The two e2e suites
are excluded from `npm test` and were run separately: **12 passed**. Merged green `main`
(`c67547eef`) before re-running.

---

## Rules earned in this phase, for the review document

### A refusal test is the one case where the harness helping you is indistinguishable from the code working

Twice in this phase the environment agreed with the assumption a test existed to
challenge, and both times the test passed while proving nothing:

- **Ambient `BRIDGE_MODE=1` / `BRIDGE_TOWER_HOST=0.0.0.0` leaked into `startTower`**, so
  every "default behaviour" Tower e2e test had been spawning a bridge-mode Tower. Any
  phase-7 claim about default binding that predates the fix was never actually tested.
- **`vitest-e2e-setup.ts` wraps global `fetch` and injects `codev-tower-key`** on every
  loopback call, so the first keyless-bootstrap test passed while the harness supplied the
  key it was written to prove unnecessary.

This is the phase-5 fixture lesson — a fixture that agrees with the assumption it should
challenge — arriving through the harness instead. It is harder to see there: a fixture is
in the test file, and a harness is not.

**The rule: when a test asserts that something is REFUSED, check what the harness is doing
to the request before trusting the pass.** A pass means either the code refused or the
harness supplied what the test claimed to omit, and those are indistinguishable from the
result alone.

### Blast radius of the harness finding, swept and bounded

The architect checked every e2e file asserting 401 or 403 rather than assuming the two
found instances were the whole set:

| File | 401/403 assertions | Key opt-outs | Verdict |
|---|---|---|---|
| `phase7-pairing.e2e.test.ts` | 5 | 4 explicit | correct after the fix |
| `tunnel-e2e.test.ts` | 1 | 0 | not a false green — it targets `codevos.ai`, a remote host, and the wrapper injects only for loopback |

The contamination was confined to the two tests found and fixed. The finding is real and
the blast radius is bounded, and neither of those follows from the finding alone.

### The pairing carve-out is scoped by exact method AND exact path

`server-utils.ts` matches `POST` and `/api/agent/v1/pairing/redeem` exactly, not by
prefix. The distinction the comment draws — **keyless at this layer, not
unauthenticated** — is the one that has to survive: the route is authenticated by a
single-use ten-minute token, and the bootstrap argument is that distributing the shared
key to pair a device defeats pairing. Asserting the same-path-different-method near-miss
is what stops the carve-out widening later.

### Out of scope, filed as #184

`bridge-mode.e2e.test.ts`'s pre-existing invalid-host case resolves a four-level `dist`
path that does not exist, so Node throws `Cannot find module`, the test sees a non-zero
exit and passes. It asserts "an invalid host is rejected" and receives "the file you asked
me to run is not there." Same family as #181, where a guard never ran because an import
failed first and nothing said so. Not fixed in phase 7.
