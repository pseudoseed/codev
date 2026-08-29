# Spec 146, Phase 6, iteration 2 — rebuttal

**Nothing is disputed.** Both lanes returned REQUEST_CHANGES on the same blocking finding and
two non-blocking ones. All three are accepted and fixed. Build exit 0; tests 6497 passed, 48
skipped, plus 180 in codev-v2.

## Lane accounting

| Lane | Verdict | Ran? |
|---|---|---|
| claude | REQUEST_CHANGES | Yes |
| **codex** | **none** | **No — still quota-blocked until 05:40; not re-attempted** |
| opencode (`xai/grok-4.6`) | REQUEST_CHANGES | Yes, as the substitute again |

Codex's usage limit from iteration 1 resets at 05:40 and iteration 2 ran before that, so the
lane was not attempted rather than being run and silently failing a second time. `opencode`
substituted again. This is the sixth iteration across the project where a default lane
produced nothing; the mechanism is **#168**.

## Blocking: PIR still instructs the call the code now refuses

*Accepted, and it is the same finding I closed incompletely in iteration 1.* Iteration 1's
finding was "agent-facing docs still instruct the refused call". I fixed `roles/` and
`SKILL.md` and **stopped there** — including deleting the `roles/builder.md` line that
deferred the question outward ("Defer to your protocol's phase prompts on who types `porch
approve`") without updating the prompts it pointed at. The hot-tier rule names this exact
step: after a framework change, grep **both** trees before claiming all fixed. I did not.

Both lanes scoped it identically and I verified the scope myself: **PIR is the only protocol
that tells a builder to run `porch approve`.** SPIR, ASPIR, AIR, EXPERIMENT, MAINTAIN,
RESEARCH, RELEASE and SPIKE contain no such instruction, and BUGFIX's `prompts/pr.md` already
says the architect approves.

Fixed at 9 sites in 5 files, mirrored in both trees (18 edits), verified with
`grep -rn "porch approve" codev/protocols/pir codev-skeleton/protocols/pir` and a per-file
`diff` between trees:

- `builder-prompt.md` — the builder no longer records the gate; it learns from `porch next`.
- `protocol.md` ×2 — the `pr` gate is approved by the architect from the workspace root.
- `prompts/{plan,implement,review}.md` — the "not on your own initiative" bullets now say
  **not at all**, because "under relay" reads as permission and the call exits 1 either way.
- `prompts/{plan,implement,review}.md` — the message the builder prints to the human reviewer
  now names the workspace root explicitly, so PIR's `dev-approval` gate has a documented
  working path again. That gate is the one the protocol calls distinctive, and leaving it
  without a path was the sharpest part of the finding.

## Non-blocking, both fixed

**1. The nonce was consumed before the phase checks and before the already-approved return**
(claude). A failed check or a double-approve burned a single-use nonce and forced a re-mint
through the authenticated route. Split into **peek** at authorization time and **consume**
immediately before the gate write: a bad nonce still fails in a second rather than after a
full build, and a run that does not approve does not spend one. `consume` remains the
authoritative single-use step, so a replay between the two still loses there. Tested both
ways, including a porch-level test that the already-approved return leaves the nonce usable.

**2. `APPROVAL_NONCE_EXPIRED` was dead code** (opencode). `#read()` swept at the TTL, so the
row was gone before `consume` could look at it and an expired nonce answered
`APPROVAL_NONCE_UNKNOWN`. The reviewer offered "delete the branch or stop sweeping"; I took
neither exactly, because deleting it would spell two different events the same way — which is
the rule this project keeps relearning. Entries are now retained for a bounded window (four
TTLs): inside it, `EXPIRED`; beyond it the record genuinely does not exist and `UNKNOWN` is
the honest answer. Both are tested, and the old test that *asserted* the wrong behaviour was
the thing hiding it.

## What I would flag to the next reviewer

The iteration-1 doc finding and the iteration-2 doc finding are the **same finding**, found
twice, because my fix covered the files a reviewer named instead of the surface the change
actually broke. The grep that would have caught it is one line and is in the hot-tier lessons.
