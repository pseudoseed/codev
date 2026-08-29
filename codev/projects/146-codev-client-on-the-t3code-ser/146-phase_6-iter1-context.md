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
