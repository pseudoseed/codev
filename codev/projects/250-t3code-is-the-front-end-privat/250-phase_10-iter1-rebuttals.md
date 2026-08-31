# Phase 10 — 3-way review, iteration 1

Two lanes. **Claude APPROVE / HIGH** (after a second pass that closed its own stated
coverage gap). **opencode REQUEST_CHANGES / HIGH.** The stricter lane is binding, and it
found the one defect that mattered.

Every finding was accepted. Nothing is in a disagree column.

---

## 1. The vitest e2e reported a PASS on a run that never happened — opencode, blocking

> `spec-250-t3code-approval.e2e.test.ts` returns from `it()` when the fork is unavailable, so
> criterion 4 / SSRF at the wired handler go green without running. The file's own header says
> "skips, never passes".

**Accepted, and it is the worst defect in the phase.** The guard was:

```ts
function skipIfUnavailable(): boolean {
  if (unavailable === null) return false;
  console.warn(`SKIP spec-250 t3code approval: ${unavailable}`);
  return true;      // <- vitest records this as a PASS
}
```

So a run where the fork server never started reported **8 passed** with not one assertion
executed — on the phase's own acceptance criterion. That is this project's recurring defect
inverted: not "I could not tell" spelled as "no", but spelled as **"yes"**, which is strictly
worse. The file's header had the rule written in it and the code broke it; a header is not a
mechanism.

Worse, it was invisible in every run I did, because the fork was always up. It would have
surfaced the first time someone ran the suite without `T3_NODE` — and it would have surfaced
as a green tick.

**Fixed** with `ctx.skip(...)`, which marks the test skipped and does not return, so the body
is unreachable rather than merely unexecuted. The Playwright spec beside it already did this
with `test.skip`; the two now agree.

**Demonstrated, not asserted.** Same file, same command, `T3_NODE` unset:

```
before:  Tests  8 passed (8)
after:   Tests  8 skipped (8)
```

and with the fork available, `Tests 8 passed (8)`.

## 2. `UPSTREAM_TIMEOUT_MS` claimed more than the mechanism gives — Claude, non-blocking

> applied via `upstream.setTimeout`, a Node idle-socket timeout, while the comment describes it
> as bounding "the whole exchange".

**Accepted.** `ClientRequest.setTimeout` restarts its clock on socket activity, so it bounds
SILENCE, not elapsed time. The comment said otherwise, and overstating a bound is the same class
of error as the `connect-src 'self'` claim this phase existed to correct — it reads as protection
that is not there.

The comment now says what the mechanism gives and states the residual explicitly: a trickling
upstream is not bounded by it. That upstream is one the operator named in
`T3CODE_CODEV_AGENT_ORIGINS`, so it is not a stranger, and a total-duration bound would have to
be large enough for the slowest legitimate answer — a worse trade for a threat the allowlist
already narrows to the operator's own hosts. Recorded rather than quietly accepted.

## 3. `data-codev-approval-state` was coarser than its own words — both lanes

> a session-ended outcome tags as `refused` in the machine-readable attribute while the visible
> text and testid distinguish it correctly.

**Accepted**, and both lanes finding it independently is the signal. The attribute computed three
values over four outcomes. Nothing asserts on it today, which is exactly why it was worth fixing
now rather than later: **the first test written against it would have inherited the conflation
the file's own header exists to prevent** — "the session idled out" spelled the same as "your
approval was refused", one layer below where a human reads it.

Four outcomes, four words, in an exported pure function (`approvalStateAttribute`) so the
attribute and the rendering cannot drift. Three tests, including one that pins the precedence
when an outcome carries both flags. Removing the `session-ended` branch fails two of them.

## 4. Claude's own coverage gap, stated and then closed

Claude's first pass said plainly which files it had not read — `agentState.ts`,
`useCodevAgent.ts`, `GateApproval.tsx`, `PairingPanel.tsx`, patches 0029-0031, the harness — and
rested its verdict on what it had read in full. Its second pass read them and raised confidence
from MEDIUM to HIGH.

Worth recording because the honest declaration is what made the second pass targeted. A lane that
had said nothing would have produced the same verdict with no way to tell what it covered.

## 5. A finding of my own, confirmed by the review

Between the two lanes I found that the proxy buffered request bodies with **no bound** —
Effect's `MaxBodySize` defaults to unbounded, and this route reads the whole body before
forwarding. One authenticated caller could pin arbitrary memory on the route whose whole purpose
is to be reachable from a phone.

Capped at 64 KiB; a declared oversize `content-length` is refused **before** the read, because
refusing after reading would already have done the thing the cap exists to prevent; a chunked
body declares no length, so the cap on the read catches that one. Too-large and could-not-read
get separate signals.

Claude's second pass called it "a real availability fix". Verified by running the same test
against the fork commit before it (`e0476d49aec1`): it fails there and passes at `24aeeebb3ded`,
with no fork history touched.

## What both lanes verified as holding

Server-held origin allowlist with selection by id; `CODEV_AGENT_PATH_ABSOLUTE` for a URL in the
path; redirects refused rather than followed; unreachable and silent as distinct signals;
`Connection`'s own tokens subtracted from the header allowlist; `authorization` and `cookie`
never forwarded; the machine credential and the `client-session` token both required and refused
differently; four approval outcomes with the record server-sourced and an empty 200 rendering as
`unconfirmed` rather than a manufactured yes; pane content from one workspace-state poll rather
than six transcripts; and the Playwright spec recording every request and asserting same-origin,
with a positive assertion that the proxy was reached at all so the negative cannot pass vacuously.
