# Spec 146, Phase 6, iteration 1 — rebuttal

**Nothing is disputed.** Two lanes returned REQUEST_CHANGES and every finding from both,
plus one from the architect and one I found myself, is accepted and fixed in `71aaf10ed`.
Build exit 0; tests 6494 passed, 48 skipped, plus 180 in codev-v2.

## Lane accounting, because a lane that did not run is not a lane that approved

| Lane | Verdict | Ran? |
|---|---|---|
| claude | REQUEST_CHANGES | Yes |
| **codex** | **none** | **No — usage limit, exit 0, no output file** |
| opencode (`xai/grok-4.6`) | REQUEST_CHANGES | Yes, as the substitute |

`.p6i1-codex.log` ends with "You've hit your usage limit… try again at 5:40 AM." The
process exited **0** and wrote **no file**, which to porch is indistinguishable from a lane
that approved. That is issue **#168**, and it is the fifth occurrence. It was caught only
because the standing rule is to check the file exists and contains a `VERDICT` before
counting the lane. `opencode` ran in its place — it is the one reviewer on an account none
of the others share.

## claude lane

**1. "The threat model's central claim covers reading and not writing, and the adversary
does both."** *Accepted, and it is the most important finding on this phase.* The store is
`JSON.parse`d with no signature, HMAC or ownership check, so a same-uid builder can append
`{ id, verifier: sha256(<a secret it chose>), … }` and present that secret.

I did not add a mitigation, because there is none: any key that would authenticate the file
has to be readable by `codev-agent`, which runs as the same user as the builder. Signing
moves the problem. So **the claim came down instead of the code going up** — *Storage* now
states the write path in full and says plainly that no local mitigation exists, and the
closing section says the property removes **replay of a legitimately issued credential**,
not forgery. This is the third time a claim on this document has been falsified for the
verb in it, and that sentence is now in the document.

**2. Three doc sites instruct the call the code now refuses.** *Accepted.* Fixed in both
trees: the `(cd worktree && porch approve …)` recipe in `SKILL.md` (4 copies),
`roles/architect.md` relaying "run porch approve" to the builder, and `roles/builder.md`
saying the builder runs it. Two of those files were edited by the phase-6 commit and I left
the contradicting line in. Verified the replacement path is real: `findStatusPath` searches
`.builders/*`, so approving from the workspace root reaches a worktree project.

**3. `capabilityId` stored on every nonce and never checked.** *Accepted.* A stored field
nothing enforces is a claim, not a constraint — the exact shape this phase's context file
named as its own risk. `consume()` now compares it and returns
`APPROVAL_NONCE_CAPABILITY_MISMATCH`, with a test that also asserts the refusal did not
consume the nonce.

**4. Single-use is not atomic.** *Accepted.* Both stores were read-modify-write against a
fixed `${path}.tmp` with no lock. Now: an exclusive `open(…, 'wx')` lock held across the
whole read-decide-write, a temp name carrying pid and random suffix, and a 30-second stale
reclaim so a killed process cannot wedge approvals. The two tests are **named for what they
exercise** — the lock being held, and being reclaimed — because they run one process and
must not be read as a concurrency proof.

**5. `CAPABILITY_REVOKED` has no row in the failure matrix.** *Accepted.* Added to
`146-codev-agent-failure-matrix.md` with what the client renders and why it must not
collapse into expired, invalid or unknown; the `HUMAN_SESSION_REVOKED` row no longer merely
predicts it.

**6. Architect ruling on `flag-only`.** *Raised, and the architect ruled.* It stays: an
architect at the workspace root is the only working approval path until the client arrives,
and refusing it would stop every gate in the program. It is now recorded in *What this does
not stop* as an explicit interim state, naming that an agent which clears its environment
and leaves the worktree can take the same path.

**Minor: `Date.parse` → `NaN` skips the expiry check.** *Accepted.* `now >= NaN` is false,
so a corrupted timestamp fell through to the secret comparison. An expiry that cannot be
read is not an expiry that has not passed; it now refuses with a distinct message.

## opencode lane

**1. "Threat model omits `architect-session` / `CODEV_ARCHITECT_NAME`."** *Accepted.* This
overlapped with the architect's finding and was fixed while the lane was running; the
section now describes four signals and three kinds, and states that
`CODEV_ARCHITECT_NAME` is inherited by everything an architect spawns.

**2. "Porch skill says architect sessions are refused; the code allows them."** *Accepted,
and this one was mine from an hour earlier* — I wrote "refuses a call it can attribute to a
builder or architect session" in the same commit that made only builders refused. Corrected
in all four copies to match `architect.md`, which already had the narrower sentence.

## From the architect

`attributeApprovalCaller` returned the evidence string `'no builder or architect session
evidence in the environment or cwd'` while **reading nothing about architects**. The string
is what an operator reads out of `status.yaml`, so it claimed a check that did not run.

Fixed by reading `CODEV_ARCHITECT_NAME` and attributing `architect-session` as its own kind
— **still allowed**, per the ruling above. It is checked **last**, because the variable is
inherited by every process an architect spawns (this builder's own shell carries it), so it
attributes "an architect session or a descendant of one" and never "an architect". Builder
evidence wins, and a test asserts that ordering.

## One neither lane caught, found on re-check

The module comment claimed `CODEV_BUILDER_ID` and `CODEV_WORKTREE_ROOT` "are present in a
builder's environment". **They are not present in this builder's.** Its own
`.builder-start.sh` — generated by the globally installed package rather than this tree —
carries no `export` lines at all, and `env` confirms neither variable is set. The env rule
is a bonus; the **cwd rule** is what actually fires. Both the comment and the threat model
now say so, with the date it was checked.

That is the same defect class as everything above, in my own comment, about the one thing
this phase is supposed to be careful about: what the caller actually receives.
