### Iteration 1 Reviews
- claude: REQUEST_CHANGES — Store, states, ownership scoping and interruption reporting are solid; the lock-timeout path emits the STORE_UNREADABLE code, conflating "retry succeeds" with "the file will not parse".
- opencode: REQUEST_CHANGES — Split lock timeout from store-unreadable; the rest of the phase-4 store is done.

### Builder Response to Iteration 1
# Phase 4 iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH`: **claude** and **opencode** (`xai/grok-4.6`).
They found the same blocker independently.

Accepted: 4 (1 blocking, 3 lesser) + 1 non-blocking from opencode. Disputed: none.

Both confirmed the phase's contract otherwise: the six states, the owner-scoped interruption,
`status.yaml` injected rather than guessed, retention, unreadable ≠ unknown, and the signals
classified in the collector.

---

## 1. A lock timeout was spelled as a corrupt file

**Both lanes, blocking.** opencode: *"Retry vs inspect-the-file is two remedies."* claude: the
same, plus the observation that all three sibling stores already have a dedicated
`*_STORE_LOCKED`.

**Verified.** `withStoreLock(path, lockedCode, …)` throws `${lockedCode}: could not acquire …`
on a timeout, and I passed `APPROVAL_OPERATION_STORE_UNREADABLE` at all three call sites. So a
2-second contention miss reported the store as unparseable.

**This is the defect the store exists to prevent, committed inside it**, by someone who had
just spent three phases on that exact rule and written a module header about it.
`atomic-store.ts` takes the code as a parameter precisely so the lock code and the parse code
stay different; `PAIRING_STORE_LOCKED`, `MACHINE_STORE_LOCKED` and `APPROVAL_STORE_LOCKED` have
existed since their stores did. opencode's point about timing is the one that made it blocking
rather than tidy-up: phase 5 puts this code on the poll path, so the collapse would have shipped
to a client.

**Changed.** Added `APPROVAL_OPERATION_STORE_LOCKED` and passed it at all three sites.

Worth recording what happened next: **the failure-matrix collector failed on the new code being
unclassified.** That is the collector doing exactly its job, and it is the reason phase 4 added
both new files to its scanned list — a guard added one commit earlier caught the next commit.
Classified as `NON_MATRIX` alongside its three siblings, with their wording: a retry succeeds.

## 2. No held-lock test

**claude.** Verified: the three sibling stores each have one and this file did not, which is why
nothing caught (1).

**Changed.** Added, modelled on `approval-capability.test.ts`'s, and **named for what it actually
exercises**: it does not run two processes, so it is not a concurrency proof and the name says so.
It asserts the lock is genuinely taken, that the code is `LOCKED` and explicitly *not*
`UNREADABLE`, and that the blocked attempt left nothing behind.

## 3. `resolveInterrupted` skipped by raw pid equality

**claude.** The subtlest finding in the review, and I would not have found it.

**Verified.** The self-check was `operation.owner.pid === this.#owner.pid`. A Tower crashes with
pid 4242; the OS hands the restarted Tower the same pid; the pass sees its own pid, treats the
record as its own live work, and skips it. Forever — on precisely the restart that was supposed
to clean it up. And `isAlive(4242)` would answer `true` anyway, because it *is* 4242, so the
fallback could not rescue it either.

**Changed.** `OperationOwner` gains a `runId`, minted once per process at module scope so two
stores in one process agree about whose work is whose. The decision is now four explicit cases,
and the third is the one that was wrong:

| Owner | Verdict |
|---|---|
| another host | not ours to judge |
| our own run | live by definition; `isAlive` is not consulted |
| **our pid, a different run** | **definitively gone — we hold that pid now** |
| another pid on this host | ask the OS |

A record with no `runId` predates the field, so "is it mine?" is unanswerable; it is treated as
**not** mine, because stranding a record forever is worse than re-reporting a gate this host is
about to report anyway.

## 4. `#sweep` kept records with an unparseable `settledAt` without stating why

**claude.** The behaviour was already what I wanted; the silence was the defect.

**Changed.** It says so now: an unreadable timestamp says nothing about how old a record is, and
dropping it would let an unreadable field delete an operator's only account of an approval — "I
could not tell" acted on as "old enough to discard".

## 5. `markRunning` / `settle` could overwrite a terminal record

**opencode, explicitly non-blocking** ("cheap to reject, not a phase-4 blocker"). Taken, because
it is cheap and because the consequence is in this store's problem domain: a late callback from
an abandoned run could rewrite an outcome an operator had already been shown — a second answer to
a question already answered.

**Changed.** `#update` refuses when the record is terminal, with tests across all four terminal
states including `interrupted`.

## What I did not change

Nothing was disputed. opencode noted the concurrency bounds are "early phase-5 work, not a skip";
they are in the store because that is where single-flight has to be enforced, and phase 5 wires
the routes onto them.

## A protocol error of my own, recorded here rather than left in the history

After phase 3's approval I ran `porch next` and `porch done` in one command, intending to trigger
phase 3's iteration-2 review. `porch next` had already advanced to phase 4, so that `porch done`
**marked phase 4's build complete before phase 4 existed**, and the next `porch next` offered a
phase-4 consultation on an empty phase.

I caught it there and implemented the phase before running any review, so nothing was reviewed
that was not there and no reviewer was misled. But `porch done` is a claim about work, and
running it without having done the work makes a false one. Not pipelining `porch next` into
`porch done` again.

## Verification

`packages/codev`: **7036 passing**, 0 failing, 3 files and 52 tests skipped. Typecheck clean. The
operation store is 28 tests; the failure-matrix collector 47.

claude noted its review was static — no shell in that session — which is the right thing to have
said rather than implying otherwise.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
