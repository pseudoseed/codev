# Phase 6 iteration 2 — rebuttals

**opencode: APPROVE** (HIGH, no issues). **claude: REQUEST_CHANGES** (HIGH, three findings).

Accepted: 3. Disputed: none.

Both confirmed the iteration-1 fixes: the poll/refusal collapse, the e2e running frame, the
stale comment, and the failed/interrupted appearance split.

---

## 1. A thrown `fetch` on the SUBMIT was still a refusal

**claude.** The finding I should have made myself last round.

**Verified.** I fixed the poll loop's transport handling and left the call in front of it alone.
A `fetch` that throws on the submit POST propagated out of `approveGate` into `GatePanel.run`'s
catch, which produces `{ ok: false, message }` with **no `unconfirmed`** — so it rendered
`.gate-result.is-refused` with raw "Failed to fetch" text.

The request may well have reached the server and started an approval. Reporting "not approved"
is a verdict nobody is entitled to, and it is the same defect class I had just written two
paragraphs of comment about, one call earlier in the same function.

**Changed.** The submit is wrapped, and a throw returns `unconfirmed` naming the gate and saying
it may already be running. Test drives a `fetch` that throws only on the submit.

## 2. A 401 mid-poll spun for thirty minutes and never dropped the session

**claude.** Verified: only 403 stopped early, so a 401 — the session expired, idled out, or was
revoked — was retried to the deadline and then reported a bare `unconfirmed`.

Two things wrong with that, and the second is worse than the wait. The **synchronous path already
treats 401 as `sessionEnded`**, so the two paths disagreed about what the same status means. And
because `sessionEnded` never came back, the panel kept the session and the human kept an Approve
button they could only escape by reloading the page — which is precisely what that flag was added
to prevent.

**Changed.** 401 stops alongside 403 and goes through `refusal()`, which sets `sessionEnded` for
that status. Test asserts it stops after exactly one poll and reports `sessionEnded`.

## 3. The one new UI element in the phase had no CSS

**claude**, and the most valuable of the three because *no test in the suite could see it*.

**Verified.** `.gate-progress` appeared in no rule in `client.css`, and nothing above it sets a
size, so it rendered at the browser's default 16px with default margins **inside an 11px panel**.
Every test passed: the element existed, its text was right, and the three progress tests asserted
exactly the words. None of them can see a font size.

This is #112's failure — *"a green test suite cannot detect design infidelity"* — reproduced in
the phase where I added a single element.

**Changed, twice.** The rule exists now, sized and spaced explicitly, in ochre because progress is
neither a result nor a fault and borrowing moss or rust would say something the state does not.

And because a review is not a mechanism, I added `styled.test.ts`: it collects every class name
the components emit and asserts the stylesheet knows each one. It is careful about what it
claims — **only that a rule exists**, never that the rule is right or that the element looks
correct — and it says so, because judging appearance still means opening the page and no test
here should pretend otherwise. It also anchors itself (a minimum class count and two known names)
so a collector that stopped matching this file's style would fail rather than pass on an empty
set. Against the current tree: **62 classes emitted, 0 unstyled**.

## Verification

- `apps/client`: **229 passing**, 13 files.
- `apps/client` e2e: **7 passing**, Playwright/Chromium, re-run after these changes.
- `packages/codev`: **7053 passing**, 0 failing.
- Both typechecks clean.

## A note on the pattern in this phase

Three of the four defects found across both iterations of phase 6 were *the same rule applied in
one place and not the adjacent one*: the poll but not the submit, 403 but not 401, the element
but not its rule. Each fix was correct and each was too narrow by exactly one step. Worth
recording as the shape to look for rather than as three separate mistakes.
