# Plan iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH` confidence: **claude** and **opencode**
(`xai/grok-4.6`). They independently found the same structural defect, and it was the one that
mattered: **the plan asked for a mapping the wire could not carry.**

Every claim verified against the code before acting on it. All hold.

Accepted: 9 of 9 (2 blocking, 7 lesser). Disputed: none.

---

## 1. Nothing put `observedAt` or settledness on the wire — criteria 3 and 4 were unimplementable

**Both lanes, independently, as their lead finding.**

**Verified.** `ThreadRegistrySnapshot.t3code` is `T3codeThreadSnapshot['status']` — a bare
string (`thread-registry.ts:62`), published at `:291` and `:499`. The client mirrors it as
`T3codeReachability = 'not-provided' | 'unreachable' | 'available'` (`connection/types.ts:71`)
and `deriveRowStatus(identity, t3code)` takes that bare string. `readThreadRegistry` attaches
live threads **only** when `status === 'available'` (`:298`), and `sessionStateOf` collapses a
`LiveThread` to one optional string.

So `observedAt`, the stale age, `cooling-down`'s when-and-why and thread settledness had no path
to the client at all. My phase 1 described the client-side work as "`validateSnapshot`'s
`t3code` allow-list" — an allow-list of *strings*. Followed literally, criterion 3 has no
deliverable and criterion 4's mapping cannot be computed, because it needs session status **and**
settledness on the same row.

opencode additionally caught that my phase 1 said "extend `LiveThread` to carry session status
and settledness" and "keep `sessionStateOf`" in the same paragraph. Those cancel: the second
keeps the collapse the first exists to remove.

**Changed.** Phase 1 gained a "The wire shape" section making three decisions:

1. **`protocol.t3code` stays a string; a sibling `protocol.t3codeObservation` carries the
   payload.** Claude framed the choice as free with an undecided direction; it is not free, and
   the direction decides it. `snapshotRejection` keys `older-server` on the field being
   **absent** (`types.ts:197`), so promoting `t3code` to an object makes a *newer client against
   an older server* receive a bare string, fail validation, and blank the whole machine — a
   second cross-version failure stacked on the one criterion 5b accepted deliberately. The
   sibling field keeps that direction validating, with an absent observation reading as an
   unknown age. Only newer-server-against-older-client fails closed, which is the decided
   direction.
2. **`ThreadIdentity.sessionState?: string` becomes a structured `session`** carrying status,
   settledness and `lastError`. `sessionStateOf` keeps its meaning — absence is still not
   `settled` — and returns the structure or nothing.
3. **`readThreadRegistry` attaches on `stale` as well as `available`.** Without it a stale entry
   carries no per-row content and the stale rule has nothing to act on.

Phase 1's test plan now includes the older-server payload — valid string, no observation —
validating rather than blanking.

## 2. Phase 6 breaks an e2e tripwire no phase listed

**claude.** The sharpest finding of the two reviews, because it is a test that would have gone
red mid-implementation and read exactly like something to delete.

**Verified.** `apps/client/e2e/two-machines.spec.ts:235`, *"refuses, rather than running a build
inside the request, when the phase has checks"*, stands up a checks-enabled project, clicks
Approve through the UI, and asserts `.gate-result.is-refused` carries `PHASE_CHECKS_REQUIRED`
with the gate still pending. Its own comment says it exists because "a suite that only ever
tested the skipped one was testing a path production does not take". **It is criterion 11's only
end-to-end assertion**, and the moment phase 6's panel submits asynchronously it fails.

**Changed.** Phase 6's file list now names it with what it becomes: the refusal case drives the
synchronous route directly so criterion 11 keeps an end-to-end assertion, and a new case drives
the same checks-enabled stand through the UI for the running-then-succeeded path. Phase 6's
acceptance requires **running** the split case, not asserting it exists. Added a risk row.

I also added a table to the Executive Summary naming **all four** tests expected to change, with
the phase and the reason for each. My first draft named two. Every one of them reads in
isolation like an inconvenient check, which is precisely why the count needed to be right.

## 3. `observedAt` derived from event cadence would mark an idle live session stale

**opencode.** I had written that the freshness windows should be "derived from the
subscription's own update cadence". That is wrong, and the reason is structural rather than a
tuning problem: `orchestration.subscribeThread` is an event stream with **no cadence**. A
genuinely idle session emits nothing, so a window keyed on event arrival ages it into `stale`
and the client stops reporting a state that is perfectly well known.

**Changed.** `observedAt` now means **subscription liveness**. The `synchronized` marker and
every event bump it; while a subscription is open and healthy the entry stays `available`
however quiet the session is; an entry ages only from the moment its subscription **drops**.
`stale` therefore means "I am no longer watching this" — a fact this process actually holds —
rather than "nothing has happened lately", which is evidence of nothing. The windows key off the
existing resubscribe backoff, which is observable rather than guessed.

This is a better design than the one I would have defended, and it came from the review.

## 4. The maintainer never rescanned the thread set

**opencode.** A maintainer that reads `global.db`'s `thread_id` columns once at boot goes
permanently blind to every builder spawned afterwards — which, on a Tower that runs for days, is
most of them.

**Changed.** Phase 2 requires a rescan on the maintainer's timer: threads that appear are
subscribed, threads that go have their entries dropped.

## 5. `requestThreadBackend` on the synchronous path

**claude.** Verified: it kicks off a connect (`thread-backend.ts:485`) and performs a
synchronous five-layer config read on every call. On the snapshot path that is per-request file
I/O plus a side effect, against the spec's own non-functional criterion that the latency profile
does not change.

**Changed.** Phase 2 now states that the synchronous snapshot **never** calls it. Every side
effect belongs to the background maintainer, which stamps the connector's answer into the cache;
the snapshot reads the stamp. This also removes the config read entirely from the request path.

## 6. The startup resolution pass was unscoped by host

**claude.** The operation store is keyed by `CODEV_AGENT_FARM_DIR`, not by host, so a second
host starting against a shared root would mark a **live** host's operations `interrupted` —
reporting a running approval as dead, which is the same class of wrong answer the store exists
to prevent.

**Changed.** Phase 4 records host and pid on every record, and the pass resolves only records
this host owns whose owning process is gone. A test asserts a live-owned record is left
untouched.

## 7. `handleGateApproveAsync` would break a source-slicing test against the wrong function

**claude.** Verified: `spec-146-phase-11-approval-writes.test.ts:138` slices from
`route.indexOf('function handleGateApprove')`. Any new handler whose name starts with that
string, placed earlier in the file, captures the match and fails the test against a function
that is fine.

**Changed.** Phase 5 fixes the names as `handleApprovalSubmit` and `handleApprovalOperation`,
with the reason stated. Worth noting that claude's suggested alternative name,
`handleGateApprovalStatus`, has the same defect — `'function handleGateApprove'` is a prefix of
it — so the rule I recorded is "share no prefix", not "avoid one name".

## 8. The concurrency bound was named and never pinned

**Both lanes.** opencode put it precisely: I claimed a bound and never picked per-project versus
per-workspace, the number, or whether the refusal is a seventh state, a `refused` code, or a
submit-time error.

**Changed.** Pinned in phase 5. Two limits, both refused at **submit time** with their own
signals — **not** a seventh operation state and **not** a queue, because a queue turns "I will
not start this" into "this is running", which is the conflation the spec is organised against:

- single-flight per (workspace, project), refused `APPROVAL_ALREADY_IN_FLIGHT` naming the
  operation already running so the caller polls instead of resubmitting;
- a workspace-wide cap of 2 concurrent check runs, refused `APPROVAL_CONCURRENCY_LIMIT`,
  configurable, with the small default justified by what a running operation actually is — a
  full repository build and test suite inside the process that is also serving every other
  workspace.

## 9. Lesser points, all accepted

- **`build.ts` missing from phase 1's file list** (opencode). Verified: `sessionVisibility` is
  hard-coded as the three-value union at line 38 and assigned at line 121, so phase 1 does not
  typecheck without it. Added, with that note.
- **The contract-derived enum test belongs in `derive.test.ts`, not under `servers/`**
  (opencode). Agreed — the mapping is client behaviour. Moved.
- **`spec-146-phase-11-production-wiring.test.ts` changes in two places, not one** (claude's
  addendum). Verified: line 101 is the source-reading assertion and line 128 is
  `expect(snapshot.t3code).toBe('not-provided')`, a string equality on the published field.
  Phase 2 now names both, and keeps the no-provider case alive as an explicit call so "a host
  that wires nothing still degrades honestly" stays covered.
- **`revoke` returns a boolean and `revokeMachine` a count** (claude). Verified. Phase 3 now
  says to report them as the two shapes they are rather than collapsing them.
- **Phase 7's dependency was listed as phase 3 while it documents signals phase 4 registers**
  (claude). Corrected to phases 3, 4 and 5, each with what it supplies.
- **`--authority` was both required and defaulted** (opencode). My contradiction. Resolved: the
  **flag** is optional, the **recorded value** is never empty. Omitting it records a fixed string
  naming the command and the invoking OS account, claiming no human presence; passing an
  explicitly empty value is refused, because an operator who tried to say something and said
  nothing is not the same as one who did not try.

## What I did not change

Nothing was disputed.

Both lanes independently verified that every path the plan names exists, that the three reuse
claims hold (`requestThreadBackend`'s five kinds, the generated enum's contents, the
`MachineCredentialStore` / `ApprovalCapabilityStore` surfaces, the commander `.command('inbox')`
pattern), and that the phase ordering and its rationale are sound. Both confirmed #234 is
untouched.

claude also cleared a file I had not listed and had not checked:
`agent-failure-matrix.test.ts:424` passes the provider type into `readThreadRegistry` while its
classifier cases take a separate `reachable | unreachable` input, so phase 1 keeping the
`unreachable` variant leaves that file alone. Recorded in the Executive Summary so the next
reader does not re-derive it.

Nine risk rows were added covering the failure modes these two reviews surfaced, so the ones
that were "certain in the first draft" are recorded as having been caught rather than quietly
fixed.
