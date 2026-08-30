### Iteration 1 Reviews
- claude: REQUEST_CHANGES — Phase 6 deliverables are met and correctly implemented; one acceptance item was deferred to CI and one code comment is now stale.
- opencode: REQUEST_CHANGES — Poll HTTP/network errors are reported as refusals, so a still-running approval can read as "not approved".

### Builder Response to Iteration 1
# Phase 6 iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH`: **claude** and **opencode** (`xai/grok-4.6`).
They found different things, and both were right.

Accepted: 2 blocking, 2 lesser. Disputed: none.

---

## 1. A poll that could not read the state was reported as a refusal

**opencode, blocking.** The sharpest finding of this phase.

**Verified.** `pollApproval` mapped every non-200 onto `refusal()`, and a thrown `fetch` fell
through to `GatePanel`'s catch — also `ok: false` with no `unconfirmed`. Both render
`.gate-result.is-refused`, the same appearance as `state: 'failed'`.

So the poll route's **own 503, `APPROVAL_OPERATION_STORE_UNREADABLE`** — a code that exists
precisely to say "I could not read the store, this is not a verdict" — reached a human as *your
gate was not approved*. Four phases of keeping unreadable apart from unknown on the server, and
the client collapsed them back together at the last step.

opencode also named why it is the same bug as one I had already reasoned about correctly: the
timeout path returns `unconfirmed` because this client stopping does not stop porch. A 503 or a
dropped connection is that same case arriving sooner.

**And it is my own plan's deliverable**, unmet: *"A poll that cannot reach the server is
distinguishable from an operation that failed."* I wrote that and then did not do it.

**Changed.** Transport and server failures are retried to the deadline, then reported
`unconfirmed` with the operation id. **403 is the single exception** and is stopped on
immediately: this session may not read this operation, retrying will never change that, and
spinning for the whole deadline over an answered question helps nobody. Three tests: a 503 that
recovers, a thrown `fetch` that recovers, and a 403 that stops after exactly one poll.

## 2. The e2e was not run, and my own acceptance item required it

**claude, blocking.** Phase 6's acceptance says criterion 11 is *"verified by running that case,
not by asserting it exists"*. I recorded honestly that Playwright had not run — which is better
than implying it had, and is still not the same as meeting the item.

**Changed: I ran it.** The browsers were installed. **6 passed and 1 failed, and the failure was
mine** — worth far more than a pass would have been.

With `command: 'true'` the checks finished before the first poll, so the panel never left
"Submitted. Waiting for the server to start the work." and the *running* frame — the one carrying
the server's phase and check names, which is the deliverable — was never observed. The test
asserted a spinner and would have called it progress. That is this initiative's signature defect,
in the test I wrote to prove I had avoided it.

The stand's checks now take `sleep 2`, longer than the one-second poll interval, so the running
state is reached **by construction rather than by luck**. The test asserts both halves: something
specific appears immediately (not a bare spinner) *and* the server's own check names appear once
it is running. **All 7 e2e pass**, in a real browser.

This is the second time in this project that running the real thing found what the unit tests
could not — the `parseAsync` silent exit in phase 3 was the first.

## 3. A stale comment naming a host that no longer exists

**claude.** Verified: `approval.ts` said `tools/codev-agent-host` wires no operation store, while
`agent-host.ts` gained one in the same change. A comment that was true when written and false
when committed.

**Changed.** It now says what remains true — the fallback is for a host running an older build,
which is exactly when a client must not assume — and says explicitly that nothing in this
repository wires such a host any more.

## 4. The panel tests did not drive `failed` or `interrupted`

**opencode, non-blocking.** Taken, because the distinction between them is the one this phase
turns on.

**Changed.** Four tests over the outcome → appearance mapping. `failed` and `refused` share the
refused treatment (both mean the gate was not approved; their messages carry which);
**`interrupted` renders as unknown**, because the host stopping is not evidence the gate is
unapproved and rendering it as a refusal would send a human to approve what may already be
approved.

## The protocol error I made twice

After phase 5's approval I again ran `porch next` and `porch done` in one command, so porch marked
phase 6's build complete before phase 6 existed. I had recorded this same error in the phase 4
rebuttal and said I would not repeat it.

Caught at the same place both times — the consultation would have reviewed nothing — and the
phase was implemented before any review ran, so no reviewer was misled either time. But writing
it down did not prevent it. The rule I am now following instead of a resolution: **after any
approval, run `porch status` and read which phase is open before running anything else.**

## Verification

- `apps/client`: **225 passing** (33 in `approval.test.ts`).
- `apps/client` e2e: **7 passing**, Playwright, Chromium, executed here.
- `packages/codev`: **7053 passing**, 0 failing.
- Both typechecks clean.

claude noted its own review was static. opencode's finding came from reading the client's error
paths against the server's, which is where the two had drifted.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
