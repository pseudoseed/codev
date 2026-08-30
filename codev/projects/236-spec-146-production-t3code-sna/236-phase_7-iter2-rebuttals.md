# Phase 7 iteration 2 — rebuttals

**claude: APPROVE** (iteration 2, no blocking findings). **opencode: COMMENT** (HIGH, one
non-blocking finding).

Accepted: 1. Disputed: none.

Both confirmed that iteration 1's findings are fixed on disk: the threat model's expired
"flag-only is the only practical path" bullet is rewritten in that document's own terms, both
revoke-route `rationale` strings name `afx pair revoke` and point at the trade, the README no
longer recommends the `DELETE` that cannot work holding nothing, `pair-dev.mjs` names the CLI, the
residual test at `agent-approval-path.test.ts:565` is intact — so criterion 18 holds and no claim
of verified human presence was added anywhere in this project — and the three new failure codes
are both declared and tabulated.

---

## 1. The runbook still pasted the superseded one-liners as live steps

**opencode**, non-blocking, and correct.

**Verified.** `146-remote-access-runbook.md` names `afx pair revoke` as **the** command, explains
that it works holding nothing and with Tower stopped, and then — twenty lines later — pastes the
two `node -e` store writes with no marker at all: first the machine credential, then the approval
capabilities, with the second introduced as something to do "in the same breath".

That is the pre-command world presented as current instructions, in the document an operator
reads *while* revoking. Which is the same shape as all three of iteration 1's findings, in the
same file family: I updated the section that names the new command and left the one below it
saying to do it the old way.

**And the split is itself the argument for the CLI.** The paragraph under those snippets already
says "an operator asked to remember two commands will eventually run one" — about the HTTP route.
It is at least as true of the two snippets sitting directly above it, which is what makes leaving
them there worse than untidy: running the first and stopping leaves a withdrawn device still
holding a live approval capability that `porch approve` will accept.

**Changed.** Folded into a collapsed `<details>` block titled *Superseded*, opening with **do not
run these**, naming what replaced them, and saying why they are kept at all — an operator who
meets them in an older copy of this runbook or in their own shell history should be able to find
out what happened rather than run them. Each snippet carries a `# SUPERSEDED by: afx pair revoke
<machine>` comment, and the second is labelled as the half that was forgotten.

Kept rather than deleted deliberately: this runbook's own convention, established in the
"This section used to say" block above, is to record what changed rather than to quietly become
correct.

---

## On the lane itself

The first opencode run **failed loudly with no verdict** — it performed the whole review (read the
threat model, the matrix, the README, the capability store, concluded "previous findings look
fixed") and then emitted the verdict *template* instead of a verdict. The lane refused to write
the file, which is the right behaviour and worth recording: porch reads a review with no verdict
as a non-blocking COMMENT, so a silent pass would have counted a lane outage as an approval. The
second run answered normally.
