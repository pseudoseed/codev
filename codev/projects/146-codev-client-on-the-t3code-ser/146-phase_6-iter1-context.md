# Spec 146, Phase 6, iteration 1 — context for reviewers

## Disclosure about phase 5, stated precisely

Phase 5 **force-advanced** at the iteration-3 safety ceiling (`ae757d09f`). That is not the
same as "phase 5 was never reviewed", and the difference matters for what you should
re-examine here.

- The **iteration-3 diff was lane-reviewed** (three lanes; four findings) and the architect
  verified the result **in the source**, not from my summary, before approving.
- **Only the final fix set has been seen by no consult lane**: `9e8fd08e2`, `77c8e6a91`,
  `87763cc84`. Those three commits are the ones carrying no external review.

I claim neither more nor less than that. If you want a place to start, start there.

## The defect class this phase is most likely to repeat

Phase 5 produced six instances of one defect: **a claim about the shape of something,
asserted where it was convenient and never checked against a real instance.** In phase 6
the shape in question is **who is asking**. So every statement in this phase about an
identity or a permission is meant to be traceable to something the code actually reads —
not to a comment describing what a caller "is".

Two mechanisms survived phase 5 and are used again here rather than re-derived:

1. **Derive from the artefact instead of describing it.** A list you type is a claim; one
   you read is a fact. The builder-environment test reads the generated launch script, and
   the failure-matrix collector reads the emitters.
2. **Make the guard assert its own reach.** The emitter scan requires every scanned file to
   yield at least one code, so a narrowing fails by name instead of going quiet. This phase
   adds `lib/approval-capability.ts` to that scan rather than defining new codes outside it.

## What this phase deliberately does NOT claim

`porch approve` enforced only `--a-human-explicitly-approved-this`
(`packages/codev/src/commands/porch/index.ts:899` before this phase), and **any agent with a
shell can type that flag**. This phase does not inherit the assumption that the flag proved
anything. It never did, and the threat model says so in those words.

What replaces it is smaller than "an agent cannot approve its own gate", and
`codev/resources/146-approval-threat-model.md` states the residual paths that remain open,
including the one nothing in this phase closes: `status.yaml` is a file inside the builder's
own worktree and the builder can write it directly.

---

## Builder response to the iteration-1 reviews

Two lanes ran. **Both REQUEST_CHANGES. Nothing disputed; every finding accepted and fixed.**

| Lane | Verdict | Wrote to the tree? |
|---|---|---|
| claude | REQUEST_CHANGES | No |
| codex | **NEVER RAN** — see below | n/a |
| opencode (substitute) | REQUEST_CHANGES | No |

### The fifth silent lane failure

**The codex lane exited 0 and produced no output file.** `.p6i1-codex.log` ends with
"You've hit your usage limit… try again at 5:40 AM." A quota-exhausted lane and an
approving lane are the same answer to porch, which is issue **#168**. I checked the file
existed and contained a `VERDICT` before counting it, which is the only reason this was
caught. The **opencode** lane (`xai/grok-4.6`) ran as the substitute, per the standing rule
that it is the reviewer on an account none of the others share.

### Findings fixed

**From the architect** (the ninth instance of the class, this time in a string):
`attributeApprovalCaller` returned the evidence `'no builder or architect session evidence in
the environment or cwd'` while **reading nothing about architects**. `CODEV_ARCHITECT_NAME` is
set in every architect session and the function never looked at it. The string is what an
operator reads out of `status.yaml`, so it claimed a check that did not run. Fixed by reading
it and attributing `architect-session` as its own kind — still **allowed**, because refusing
architects would leave no working approval path until the client exists. It is checked **last**,
because the variable is inherited by everything an architect spawns (this builder's own shell
carries it), so it attributes "an architect session or a descendant of one", never "an
architect".

**From the claude lane:**

1. **The threat model's central claim covered reading and the adversary also writes.** The
   store is `JSON.parse`d with no integrity check, so a same-uid builder can append a record
   whose verifier is the hash of a secret it chose. There is **no local mitigation** — any key
   authenticating the file is readable by the same user — so the claim came down instead of
   the code going up. The closing section now says the property removes *replay of a
   legitimately issued credential*, not forgery.
2. **Three doc sites instructed the call the code now refuses.** The `(cd worktree && porch
   approve)` recipe in `SKILL.md` (4 copies), `roles/architect.md` telling the builder to run
   it, and `roles/builder.md` saying the builder runs it. All fixed in **both trees**.
3. **`capabilityId` was stored on every nonce and never checked** — a stored field nothing
   enforces is a claim, not a constraint. `consume()` now compares it, with a test.
4. **Single-use was not atomic.** Read-modify-write with a fixed `.tmp` and no lock. Now an
   exclusive `open(…, 'wx')` lock across the whole read-decide-write, a unique temp name, and
   a 30s stale-lock reclaim. The tests are **named for what they exercise** — the lock being
   held and being reclaimed — because they run one process and are not a concurrency proof.
5. **`CAPABILITY_REVOKED` had no row in the failure-matrix document.** Added, with what the
   client renders and why it must not collapse into expired/invalid/unknown.
6. **`Date.parse` returning `NaN` skipped the expiry check** and fell through to the secret
   comparison. An expiry that cannot be read is not an expiry that has not passed.

**From the opencode lane:** the porch skill I had just rewritten said `porch approve` refuses a
builder **or architect** session; the code refuses only builders. Corrected in all four copies.
Its threat-model finding had already been fixed by the architect's report while it was running.

**Ruled by the architect, not changed:** the `next.ts` frontmatter path stays open. Gating it
while direct `status.yaml` writes remain possible would read as more protection than exists;
recording it as `authorization: pre-approved-artifact` is the right minimum.

### One thing I got wrong that neither lane caught

The module comment claimed `CODEV_BUILDER_ID` and `CODEV_WORKTREE_ROOT` "are present in a
builder's environment". **I checked this builder's own `.builder-start.sh` and it carries no
`export` lines at all** — it was spawned by the globally installed package rather than this
tree. The env rule is a bonus; the **cwd rule is what fires in practice**. Both the comment and
the threat model now say that, with the date it was checked.

**Build**: exit 0. **Tests**: 6494 passed, 48 skipped, plus 180 in codev-v2.
