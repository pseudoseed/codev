# Specification: Production t3code snapshot, durable asynchronous gate approval, and an operator pairing command

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/236-*.md.
-->

## Problem Statement

Spec 146 phase 11 landed `apps/client` on `main` and left two of its acceptance criteria
unmet. This spec covers the three mechanisms that meet them, plus the one that makes them
reachable by a person rather than by a test.

Each of the three is a mechanism the phase-11 work *named* as missing. None is a design. Each
carries one decision that has to be made before code, and the issue is explicit that the
decision is the deliverable:

1. **Criterion 3 — live status on every row.** Tower wires no `t3codeSnapshot` provider, so
   the protocol snapshot always reports `t3code: 'not-provided'` and the client renders every
   non-blocked row as `UNKNOWN`. Blocked rows work, because a gate comes from porch.
2. **Criterion 9b — approving a gate from the client.** The approval route refuses any
   project whose current phase declares checks, because running a repository's build and test
   suite inside an HTTP request is unbounded. An operator who reaches a gate in the client is
   sent back to the CLI, which is the thing the client exists to avoid.
3. **No operator entry point.** `PairingStore.issue()` has two callers: a dev script and
   tests. There is no command a person can run, so the whole approval path is test-reachable
   only, and criterion 9b would stay unreachable in production even after (2) is fixed.

(3) forces a security decision that (1) and (2) do not. Minting a pairing token needs only
write access to a file. Revoking a machine credential currently needs a live human session,
which needs a live machine credential — **so the operator who wants to withdraw access is the
one who cannot**. That is backwards: the cheap operation should be the one that reduces
access. A live credential on this machine (`dev-check`, expiring 2026-11-28, verified
unrevoked in `~/.agent-farm/machines/`) exists precisely because it could not be revoked
through the API.

Who is affected: the operator driving builders from the codev client — today from a checkout,
after issue #234 from a Tower mount — and anyone reading a status tree that says `UNKNOWN`
where it should say what an agent is doing.

## Current State

### Session state is never observable from a real Tower

`initAgentRoutes` accepts an optional `t3codeSnapshot: (workspacePath) => T3codeThreadSnapshot`.
`tower-server.ts` does not pass one, so every snapshot takes the `not-provided` branch. The
client's `deriveRowStatus` correctly refuses to invent a status and renders `UNKNOWN` with
"this server is not reporting session state". `spec-146-phase-11-production-wiring.test.ts`
asserts that the production call passes no provider, so the gap is recorded rather than
forgotten. **That test failing is the intended signal that this spec landed.**

The stated obstacle is real: the provider signature is synchronous and a t3 connection is not.

Four things the issue does not say, established by reading the code:

- **Per-workspace t3 configuration already exists** and has since phase 9. `.codev/config.json`
  and `.codev/config.local.json` carry a `threads` block (`serverUrl`, `bootstrapToken`), read
  through the five-layer config loader by `readThreadBackendConfig(workspaceRoot)`. There is no
  new home to choose. Half-configured already throws rather than reading as "not configured".
- **A non-blocking connector already exists.** `requestThreadBackend(workspaceRoot)` answers
  `ready | connecting | cooling-down | misconfigured | not-configured` without awaiting, and a
  durable resubscribing subscription with cursor resume already ships in the t3 client.
- **The contract has no thread listing.** `orchestration.subscribeThread` is a stream keyed by
  one `threadId`; `orchestration.searchThreads` is a text search over message content, not an
  enumeration. The set of threads to observe therefore comes from `global.db` — the `thread_id`
  columns on the `architect` and `builders` rows, which is exactly the set the registry joins on.
- **The two vocabularies do not match.** t3code reports a session `status` of
  `idle | starting | running | ready | interrupted | stopped | error`, and carries settledness
  separately as thread-level `settledAt` / `settledOverride`. The client recognises `settled`,
  `running`, `turning`, `starting`, `ready` and renders anything else as `UNKNOWN` naming the
  word it did not know. So forwarding t3code's own vocabulary unchanged would leave `idle`,
  `interrupted`, `stopped` and `error` reading as UNKNOWN. **Criterion 3 needs a mapping
  decision, not only a wire.**

There is a fifth limit that bounds what any of this can achieve today: `sessionState` is
attached only to rows that carry a `thread_id`, and every real row in `global.db` is
terminal-backed. This workspace has no `threads` block at all. A row with no thread has no
session to observe, and that is a third fact — distinct from "the server did not say" and from
"the server could not be reached".

### Approving a gate from the client fails for ordinary projects

`handleGateApprove` calls porch's `approve()` in Tower's process with
`refuseIfChecksWouldRun: true`. Porch refuses with `PHASE_CHECKS_REQUIRED` whenever the current
phase declares checks and at least one survives `.codev/config.json` overrides. That is most
gates on most projects: the `pr` gate on an AIR or SPIR project sits in a phase with a check
set.

The refusal is deliberate and its reasoning is recorded in the option's own comment: an HTTP
request will not hold a connection open for a repository's build and test suite, and **a
request timeout is not a fix** — a client that gives up does not stop porch, so the abandoned
call goes on to approve the gate while the client reports that it did not. Reporting one
outcome while another happened is the failure this whole initiative is organised against.

What is missing is not a longer timeout. It is a place for the operation to live that outlasts
the request.

### There is no `afx pair`

`PairingStore.issue()` is called by `apps/client/scripts/pair-dev.mjs` and by tests. The dev
script mints a token, redeems it against a running Tower using `~/.agent-farm/local-key`, and
writes the credential into `apps/client/.dev-machines.json`. It is a development affordance
that documents itself as one.

Revocation has no operator path at all. `DELETE /api/agent/v1/machines/<id>` and
`DELETE /api/agent/v1/approval-capabilities/machine/<id>` are both declared `human-session` in
the route table — **verified, closing the issue's "unverified, check it" item: both are, not
just the first.** `human-session` includes `machine-credential`, so an operator holding nothing
is refused at the machine-credential check with 401 `MACHINE_CREDENTIAL_REQUIRED` before the
session check is even reached. Withdrawing access requires already having it.

### What pairing does and does not establish

Recorded here because it bounds every option below. A same-UID agent can mint its own pairing
token, redeem it, hold a session this surface cannot distinguish from a browser's, and approve
its own gate. `146-approval-threat-model.md` says so, and `agent-approval-path.test.ts` pins it
under the name *"lets anything with filesystem access complete the ceremony — the stated
residual"*. The system **records** an `authority` string — the minter's own account of what
authorized the mint — and carries it verbatim to the session, the capability and `status.yaml`.
It does not verify human presence, and nothing in this spec claims to.

## Desired State

**Session state.** A Tower serving a thread-configured workspace reports each thread-backed
row's live state, sourced from a background subscription and served synchronously from a
cache that knows its own age. A workspace with no t3code server configured says exactly that,
in its own word, rather than borrowing "not provided" — and a cache too old to trust says
`stale` with the age, never `available` and never `settled`. The client's vocabulary covers
every state t3code can report, so an unrecognised word means a genuinely newer server rather
than an unfinished mapping.

**Gate approval.** An operator approves a gate from the client on an ordinary project. The
request returns immediately with the identity of a submitted operation; the operation runs the
phase checks to completion in the background; the client polls and shows what is happening
while it runs. Every terminal report comes from what porch persisted, never from what the
client asked for. An operation interrupted by a Tower restart reports that it was interrupted
and what `status.yaml` says now — not "failed", and not "running" forever.

**Operator command.** `afx pair issue`, `afx pair list` and `afx pair revoke` exist. Issuing
prints a token once to the terminal and records the invoking operator's account of their own
authority. Listing shows outstanding tokens and paired machines without printing a secret.
**Revoking works for an operator holding no credential**, and the trade that makes it possible
is written down where the next reader will find it.

## Success Criteria

- [ ] 1. `tower-server.ts` passes a `t3codeSnapshot` provider, and
      `spec-146-phase-11-production-wiring.test.ts` is updated — not deleted — to assert the
      wired state and what it now guarantees.
- [ ] 2. `T3codeThreadSnapshot` distinguishes at least: never asked, no t3code server
      configured for this workspace, configured but unreachable, observed and fresh, observed
      but stale. No two of those five share a code, and `stale` carries the age of what it is
      reporting.
- [ ] 3. A snapshot served from cache reports when its data was observed. A consumer can
      compute the age without asking a second question.
- [ ] 4. Every value in t3code's session-status vocabulary
      (`idle`, `starting`, `running`, `ready`, `interrupted`, `stopped`, `error`) plus
      thread-level settledness maps to a client status the client renders as a word rather
      than as `UNKNOWN`. A value outside that set still reports `UNKNOWN` naming the value.
- [ ] 5. A row with **no thread** reports its own reason ("this row has no t3code thread"),
      distinct from the four snapshot-level reasons in criterion 2.
- [ ] 6. Building the provider never blocks the request that reads it: the snapshot function
      stays synchronous, performs no network call, and a workspace whose backend is
      connecting, cooling down or misconfigured is answered immediately with that state.
- [ ] 7. Approving a gate from the client succeeds on a project whose phase declares checks.
      The submit call returns within the same bound as any other route and does not wait for
      the checks.
- [ ] 8. A submitted approval is observable while it runs: a client can ask for its state and
      receive at least submitted / running / succeeded / refused / failed / interrupted, each
      distinct, each carrying a reason where one exists.
- [ ] 9. A completed approval reports the record **porch persisted** — machine, session,
      approved-at, authority — and never a value manufactured by the reporting layer. An
      already-approved gate reports the approval that exists, including when it is somebody
      else's.
- [ ] 10. An operation still running when Tower stops reports `interrupted` afterwards,
      together with what `status.yaml` says about the gate now. It never reports `failed` on
      the strength of the interruption alone, and it never stays `running` forever.
- [ ] 11. `refuseIfChecksWouldRun` remains available and remains the behaviour of any caller
      that has not opted into the asynchronous path. The refusal is not deleted; it stops
      being the only answer.
- [ ] 12. `afx pair issue` prints a token exactly once to stdout, records a non-empty
      `authority` naming the invoking operator, and the token appears in no log file and in no
      argv.
- [ ] 13. `afx pair list` reports outstanding tokens and paired machines, including revoked
      ones marked as revoked, and prints no secret or verifier.
- [ ] 14. `afx pair revoke <machine>` succeeds for an operator holding no machine credential
      and no human session, and revokes **both** the machine credential and that machine's
      approval capabilities.
- [ ] 15. After `afx pair revoke`, that machine's every authenticated request fails closed
      with `MACHINE_CREDENTIAL_REVOKED`, and no other machine's records are touched.
- [ ] 16. The live `dev-check` credential on the development machine is revocable by the new
      command. This is the concrete case the issue names, and it is verified by doing it.
- [ ] 17. The security trade behind criterion 14 is recorded in
      `146-approval-threat-model.md` in the terms that document already holds: what the
      mechanism establishes, what it does not, and which test pins the residual.
- [ ] 18. `agent-approval-path.test.ts`'s residual assertion — that a builder minting for
      itself records exactly that authority — still passes, or fails **because real authority
      was added**, with the change surfacing there rather than anywhere else.
- [ ] 19. Every new failure code is registered in the codev-agent failure matrix and is
      distinct from every code that already means something else.
- [ ] 20. Build and the full test suite pass.

## Constraints

Fixed by the issue. The issue carries no section headed "Baked Decisions"; these are its
explicit prohibitions and directives, reproduced so they are not relitigated downstream.

- **Phase 12's plan and the static mount stay in #234.** This spec does not touch the client
  tiling, the mobile paging, or serving the client from Tower.
- **Do not fix asynchronous approval with a request timeout.** A client that gives up does not
  stop porch, so a timeout abandons a call that goes on to approve the gate anyway — reporting
  one outcome while another happened. Submit, poll, report.
- **`spec-146-phase-11-production-wiring.test.ts` is expected to fail** when the provider is
  wired. Update it as part of the change; do not delete it.
- **The pairing token is printed once to a terminal, never to a log and never to argv.**
- **Authority is recorded from the invoking operator, and no claim of verified human presence
  is made.** A same-UID builder can mint its own token; that residual is documented and pinned
  by a test. If real authority is ever added, that test fails, and that is where the change
  should surface.
- **The cheap operation must be the one that reduces access.** `afx pair revoke` has to work
  for someone holding nothing. Decide how, and record the trade.

Fixed by the existing system.

- Porch remains the only writer of `status.yaml`. No approval path writes it directly.
- `t3codeSnapshot` is called inside request handling; it must remain synchronous and must not
  perform I/O that can block.
- Tower is one process serving every workspace in `global.db`. Anything per-workspace is keyed
  by canonical workspace path; a process-global anything reintroduces the phase-9 defect where
  one workspace's engine served another's turns.
- A store that exists but will not parse reports its own "unreadable" code and never the
  "unknown" one. Absence and illegibility are different answers.
- The client refuses a response it cannot read rather than filling gaps from local state.
- `.codev/config.local.json` is part of the config chain; a local-only t3 server must keep
  working without a committed config change.
- Node builtins and existing workspace dependencies only. No new runtime dependency for the
  pairing command.

## Assumptions

- The vendored t3 contract in `packages/types/src/t3/generated/` is current for the pinned
  t3code server. `orchestration.subscribeThread` and the `session.status` enum are taken from
  it rather than from a running server, because no thread-configured workspace exists on this
  machine to observe.
- `~/.agent-farm/` is writable by the operator running `afx`. This is already true of every
  other agent-farm command and of `PairingStore.issue()` today.
- Issue #234 lands the static mount independently. This spec's client-visible behaviour is
  verifiable from a checkout via the existing dev servers and does not wait on it.
- Criterion 3 can be *measured* end to end only on a workspace configured with a t3code
  server. Where no such workspace is available, the criterion is verified against the contract
  and a driven fake, and the spec says which was which rather than implying a live run.

## Solution Approaches

### Decision 1 — where t3 config lives, and the staleness policy

#### Approach 1A: New Tower-level t3 configuration

Add a t3 connection block to Tower's own configuration, listing workspaces and their servers.

*Pros:* Tower holds everything it needs at startup without reading each workspace.
*Cons:* A second home for configuration that already exists in `.codev/config.json`, which is
the file the CLI, spawn and the thread backend all read. Two sources of truth for one fact,
and the local-override layer (`config.local.json`) would have to be duplicated or lost.
*Risk:* High. It is the "distributed state" failure this repository has a standing lesson
about.

#### Approach 1B: Reuse the existing per-workspace `threads` block (recommended)

Tower reads each known workspace's existing `threads` configuration through the same loader
the CLI uses, and reaches the server through the same non-blocking connector phase 9 built. A
per-workspace cache holds, for every thread id the registry knows from `global.db`, the last
observed session status and settledness together with the time it was observed. The snapshot
function reads that cache and returns immediately.

*Pros:* No new configuration surface at all — the issue's first decision resolves to "it
already lives there". Reuses the connector, its cooldown, and the durable resubscribing
subscription. The thread set comes from the same store the registry joins on, so the cache
cannot describe a thread the snapshot will not mention.
*Cons:* Tower now opens a t3 connection per configured workspace, which it did not before.
Bounded by the existing cooldown and by the fact that unconfigured workspaces cost nothing.
*Risk:* Low. Every part is load-bearing in production already.

**Recommended: 1B.**

#### Staleness policy

The cache must never be able to say "settled" when it means "I last looked a while ago". So:

- The snapshot type gains an explicit `not-configured` status — a workspace with no t3code
  server is a fourth fact, not a spelling of `not-provided`.
- `available` carries `observedAt` and means observed within a freshness window.
- Beyond that window the cache reports `stale` with its age and its last-observed content
  clearly labelled as such. A `stale` snapshot never derives `settled`; the client shows the
  same STALE treatment it already gives a disconnected machine, for the same reason.
- Beyond a longer discard window, the cached content is dropped and the snapshot reports
  unreachable or not-configured on its own merits. Holding an hours-old session status is
  holding a wrong answer.

The exact windows are an open question below; the *shape* — three bands, an age on the wire,
and no derivation of `settled` from stale data — is the decision.

#### The vocabulary mapping

t3code's `session.status` and the thread's settledness map onto the client's five words. The
mapping is stated in the plan and asserted by a test that enumerates the contract's enum, so a
server that adds a state fails a test rather than rendering as UNKNOWN in the field. An
unmapped value still renders UNKNOWN naming the value — that branch stays.

### Decision 2 — where the asynchronous approval operation lives

The request submits; something outlasts the request; the client polls. What holds it:

#### Approach 2A: In-memory map in Tower

Fast, no new store.

*Pros:* Trivial. No serialisation, no lock.
*Cons:* A Tower restart mid-approval loses the operation entirely, so the client polls an id
that answers "unknown" — which reads as "your approval never existed" for an approval that may
well have landed. That is the exact conflation this initiative exists to prevent, and
criterion 10 rules it out.
*Risk:* Medium, and the failure is invisible until it happens during a real gate.

#### Approach 2B: A new table in `global.db`

*Pros:* Durable, queryable, in the store Tower already opens.
*Cons:* A schema migration, and `global.db` is the user-global store shared with every
workspace's live agent state. An approval operation is short-lived operational state in the
approval domain, and the approval domain's other two stores (capabilities, nonces) are
deliberately file-backed and outside it.
*Risk:* Medium. Migration ceremony for a record whose natural retention is hours.

#### Approach 2C: A file-backed operation store beside the approval stores (recommended)

The same shape as the capability and nonce stores: a file under the agent-farm approval root,
written atomically under the existing store lock, honouring `CODEV_AGENT_FARM_DIR` so a test
host and the agent-host tool write somewhere throwaway.

*Pros:* Durable across a restart, so criterion 10 is reachable. Consistent with the two stores
it sits beside, including their "exists but will not parse" discipline. No migration. Records
sweep on a retention window the way pairing tombstones already do.
*Cons:* A third file-backed store in the approval domain. Concurrent writers need the lock
that already exists for exactly this.
*Risk:* Low.

**Recommended: 2C.**

#### What it reports while running

Distinct states, because they send an operator to different places: **submitted** (accepted,
not started), **running** (porch is executing, with the phase and the check set it is running
so the operator knows what they are waiting for), **succeeded** (carrying porch's persisted
record), **refused** (porch declined, carrying its code — an unmet precondition, not a
failure), **failed** (an error, carrying it), **interrupted** (Tower stopped while this was
running, carrying what `status.yaml` says about the gate *now*).

A restart resolves every `submitted` or `running` record it finds to `interrupted` before the
surface answers a poll, so the "running forever" state is unreachable rather than unlikely.
Whether the interrupted operation is resumable is an open question; reporting it honestly is
not.

The synchronous refusal stays for callers that have not opted in, so nothing that works today
changes behaviour.

### Decision 3 — how `afx pair revoke` works for someone holding nothing

This is the decision the issue exists to force.

#### Approach 3A: A bootstrap credential for the CLI

`afx` mints itself a machine credential and calls the HTTP route.

*Pros:* One code path; revocation stays server-side.
*Cons:* It **grants** access in order to withdraw it, and the credential it grants is
indistinguishable from any other. It also does not work when Tower is down, which is exactly
when an operator most wants to revoke.
*Risk:* High, and it makes the expensive operation cheaper rather than making the cheap
operation the one that reduces access.

#### Approach 3B: Revoke by writing the store directly (recommended)

`afx pair revoke` opens the machine-credential and approval-capability stores on disk — the
same stores, through the same classes, under the same lock — and writes the revocation
tombstone. No Tower, no credential, no session.

*Pros:* Works for an operator holding nothing, and works when Tower is down. It is symmetric
with issuance, which is already a direct store write: **minting and revoking cost the same,
and that is the point.** Tower's own verification reads the same store on every request, so a
revocation takes effect on the next request without a restart or an invalidation message.
*Cons:* The revocation boundary is now filesystem write access to `~/.agent-farm`. It grants
no new power — the threat model already states that a same-UID process can write these stores,
and `PairingStore.issue()` already relies on exactly that access. What changes is that the
capability is now *used* by a shipped command, so it must be stated rather than left implicit.
*Risk:* Low, and honestly describable. A same-UID agent could already forge a capability
record; being able to revoke one is strictly less dangerous than being able to mint one.

#### Approach 3C: Keep the HTTP route and relax its auth

Downgrade the revoke routes from `human-session` to `machine-credential`, or add an unauthenticated
loopback exemption.

*Pros:* Keeps one path.
*Cons:* A loopback exemption is not an authorization boundary — the auth module says so at
length, and over loopback TCP the peer is not attributable. Downgrading to
`machine-credential` still requires a credential the operator does not hold. Neither reaches
an operator holding nothing.
*Risk:* Medium to high; it weakens a boundary without solving the problem.

**Recommended: 3B**, with the HTTP routes left exactly as they are for clients that do hold a
session. The trade goes into `146-approval-threat-model.md` in that document's own terms.

`afx pair issue` and `afx pair list` are direct store operations for the same reason, which is
also what they do today through the dev script.

## Open Questions

**Critical (blocks progress)**

- None. Each of the three decisions has a recommended approach that can be implemented against
  code that exists.

**Important (shapes design)**

- **The freshness and discard windows for the session cache.** The three-band shape is decided;
  the numbers are not. They should be derived from the subscription's own update cadence rather
  than picked, and stated with what they were derived from.
- **Is an interrupted approval operation resumable, or only reportable?** Reporting is required
  by criterion 10. Resuming is more, and re-running phase checks after a restart may be the
  wrong default when the gate may already be approved. Recommendation: report only, and let the
  operator resubmit against a snapshot that now shows the gate's real state.
- **How long an approval operation record is retained.** Long enough that a client returning
  after a disconnect still finds its answer; short enough that the store does not accumulate.
  The pairing store's tombstone retention is the nearest existing precedent.
- **Whether `afx pair revoke` should also be able to revoke a *pairing token* that has been
  minted and not yet redeemed.** The store supports it; the issue does not ask for it. Leaving
  it out means an unredeemed token can only be waited out.

**Nice-to-know**

- Whether the session cache should also feed the terminal-backed rows some equivalent
  liveness signal. Out of scope here: those rows have no thread, and criterion 5 makes that
  visible rather than papering over it.
- Whether `afx pair` should offer a redeem subcommand, replacing the dev script outright.

## Test Scenarios

**Session state**

- A workspace with no `threads` configuration reports `not-configured`, not `not-provided`,
  and the client renders a reason naming that.
- A configured workspace whose server cannot be reached reports `unreachable` with the
  connector's own message, and a row does not fall back to `settled`.
- A cache entry inside the freshness window reports `available` with `observedAt`; the same
  entry past the window reports `stale` with its age and derives no `settled`; past the discard
  window the content is gone and the status reflects reachability alone.
- Every value of the contract's session-status enum, enumerated *from the generated contract
  rather than from a typed list*, maps to a rendered word. A synthetic unknown value renders
  `UNKNOWN` naming the value.
- A row with no `thread_id` reports its own row-specific reason, and that reason is not the
  machine-level one.
- The snapshot function performs no network call: called against a workspace whose backend is
  mid-connect, it returns immediately with `connecting`-equivalent content.
- The production wiring test is updated and asserts the provider is passed, with a message
  telling a future reader what the wiring guarantees and what it does not.

**Asynchronous approval**

- Submitting an approval for a project whose phase declares checks returns promptly with an
  operation identity, and the gate is not yet approved at that moment.
- Polling that operation moves through running to succeeded, and the terminal report carries
  porch's persisted machine, session, approved-at and authority.
- A gate that was already approved by somebody else reports the approval that exists, with the
  other party's machine and session, not the requester's.
- Checks that fail produce `refused` with porch's code, and the gate is not approved.
- An operation record found in `submitted` or `running` at startup is reported `interrupted`,
  together with what `status.yaml` says about that gate — including the case where the gate
  *is* approved, which must not report as a failure.
- A caller that does not opt into the asynchronous path still gets the synchronous refusal
  with `PHASE_CHECKS_REQUIRED`.
- Two concurrent submissions for the same project and gate do not both spend a nonce, and
  whichever loses says so distinguishably.
- A capability belonging to a different session is refused before any operation is created.

**`afx pair`**

- `issue` prints one token, and the token string appears in no file the command writes and in
  no captured log stream. Asserted over the whole captured output, not over a known variable.
- `issue` records a non-empty authority naming the invoking operator, and refuses an empty one.
- `list` shows outstanding, redeemed, expired and revoked records without printing a secret or
  a verifier.
- `revoke` succeeds with no credential present and with Tower not running; a subsequent
  authenticated request from that machine fails closed with `MACHINE_CREDENTIAL_REVOKED`, and a
  second machine's requests continue to succeed.
- `revoke` withdraws the machine's approval capabilities as well as its credential, and reports
  the two counts separately rather than as one boolean.
- `revoke` on a machine that has nothing live reports that as its own answer, not as an error.
- A store that exists but will not parse produces the unreadable code from every subcommand,
  never "no such machine".
- The threat model's residual test — a builder minting for itself records that authority — still
  passes.

**Non-functional**

- Wiring the provider does not change the latency profile of the workspace state route: the
  handler still performs no network I/O.
- A workspace with no t3code server configured causes no connection attempt and no cooldown
  entry.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The cache reports a stale session state as current, so a finished agent still reads as working | Medium | High — it is the exact failure the STALE band exists to prevent | `observedAt` on the wire, three explicit bands, and a hard rule that `stale` never derives `settled` |
| Criterion 3 cannot be measured live because no thread-configured workspace exists on this machine | High | Medium | Verify against the generated contract and a driven fake; state plainly in the review which criteria were observed live and which were not. Do not tick a criterion on a fake |
| Tower opens t3 connections it did not before, and one bad server slows the process | Low | Medium | Reuse the existing non-blocking connector, its per-workspace keying and its failure cooldown; never await a connect on a request path |
| An asynchronous approval is reported succeeded while porch actually refused, or the reverse | Low | High | Every terminal report reads porch's persisted record; the interrupted path reads `status.yaml` rather than guessing |
| An approval operation store grows without bound | Medium | Low | Retention sweep on the same pattern as the pairing tombstones |
| `afx pair revoke` writing the store directly is read as a new security weakness | Medium | Medium | State the trade in the threat model in its own terms: the write capability already exists and is already relied on by issuance; this makes withdrawal as cheap as grant, which is the correct direction |
| The pairing token leaks into a log, a shell history or argv | Low | High | Print once to stdout; never accept or emit it as an argument; assert its absence over the whole captured output |
| Updating the phase-11 wiring test is mistaken for deleting an inconvenient check | Low | Medium | Update in place with a message that says what the wired state now guarantees; the issue names this expectation explicitly |
| Scope creep into issue #234's static mount or tiling | Medium | Medium | Named as out of scope in Constraints; no client layout work in this spec |

## References

- Issue #236 — this spec's source, and the three decisions it forces.
- Issue #234 — phase 12: client tiling, mobile, and the static mount. Explicitly not this spec.
- `codev/specs/146-codev-client-on-t3code.md` and `codev/plans/146-codev-client-on-t3code.md` —
  the parent spec and plan, including criteria 3 and 9b.
- `codev/resources/146-approval-threat-model.md` — what pairing establishes and does not; the
  document criterion 17 extends.
- `codev/resources/146-codev-agent-failure-matrix.md` — the classification every new failure
  code joins.
- `codev/resources/146-remote-access-runbook.md` — the transport posture the pairing command
  operates inside.
- `apps/client/README.md` — the phase-11 record of both gaps, which this spec closes and which
  will need updating with it.
