# aspir-236 — Spec 146: production t3code snapshot, async gate approval, operator pairing command

## 2026-08-29 — Specify phase

### Worktree was 49 commits behind main

Spawned from a stale base: `origin/main` had 49 commits my branch lacked, including every
phase-11 artifact the issue talks about (`apps/client/`, `gate-approve` route,
`spec-146-phase-11-production-wiring.test.ts`, the `authority`/`purpose` fields on
`PairingStore`). Nothing in the issue reproduced against my tree until I merged
`origin/main` in. Merge was clean. **If a later reader wonders why the first exploration
found no `refuseIfChecksWouldRun`, that is why.**

### What I verified before writing the spec

Read, not assumed:

- `tower-server.ts:737` — the real `initAgentRoutes` call, and the comment block at :751
  stating the `t3codeSnapshot` gap.
- `agent-routes.ts` — `handleGateApprove` sets `refuseIfChecksWouldRun: true` (line ~854);
  `AgentRouteContext.t3codeSnapshot` is `(workspacePath) => T3codeThreadSnapshot`, synchronous.
- `porch/index.ts:1165` — the refusal fires when the phase declares checks AND any survive
  overrides. Its own doc comment carries the "a timeout abandons a call that approves anyway"
  reasoning the issue repeats.
- `agent-auth.ts` — **both** revoke routes are `human-session`: `machine-credential-revoke`
  (line 193) and `approval-capability-revoke-machine` (line 185). The issue's "unverified,
  check it" item is **confirmed**.
- `~/.agent-farm/machines/` — one record, `dev-check`, `expiresAt 2026-11-28T02:28:09.850Z`,
  **not revoked**. The issue's context paragraph is accurate on this machine.
- Per-workspace t3 config **already exists**: `.codev/config.json` (and `config.local.json`)
  `threads: { serverUrl, bootstrapToken }`, read by `readThreadBackendConfig()` in
  `thread-backend.ts`. There is nothing new to invent for "where t3 config lives".
- `requestThreadBackend()` in `thread-backend.ts` is already the non-blocking
  ask-and-move-on connector Tower needs, with a `ThreadBackendAvailability` union that
  distinguishes not-configured / connecting / cooling-down / misconfigured / ready.
- The vendored t3 contract (`packages/types/src/t3/generated/`) has
  `orchestration.subscribeThread` (streaming, keyed by a single `threadId`) and **no thread
  listing method**. `searchThreads` is a text search over messages, not an enumeration. So
  the set of threads to watch has to come from `global.db`'s `thread_id` columns.
- `packages/t3-client/src/subscription.ts` already implements a durable resubscribing
  subscription with cursor resume. The machinery for a cached background subscription exists.

### Two findings the issue does not mention, and they change the work

**1. The session vocabularies do not match.** t3code's `session.status` enum is
`idle | starting | running | ready | interrupted | stopped | error`, plus thread-level
`settledAt` / `settledOverride`. The client's `fromSessionState` (`apps/client/src/status/derive.ts`)
maps only `settled`, `running`, `turning`, `starting`, `ready` and reports everything else as
`UNKNOWN: the server reported session state "X", which this client does not recognise`.
Wiring a provider that forwards t3code's own words therefore renders `idle`, `interrupted`,
`stopped` and `error` as UNKNOWN — honest, but still not criterion 3. **The mapping is part
of the work, not a detail of it.**

**2. `sessionStateOf` only fires for rows carrying `thread_id`.** Every architect and builder
row in `global.db` is terminal-backed today, and this very workspace has no `threads` block in
`.codev/config.json`. So on this machine, a correctly wired provider still yields no session
state for any row — because there are no threads to observe, which is a different fact from
"not provided" and has to be spelled differently. Criterion 3 is measurable only on a
thread-configured workspace, and the spec says so rather than letting a green test imply
otherwise.

### Next

Spec drafted, `porch done 236` for the 3-way consultation.

### Specify iteration 1 — consultation (claude, opencode/grok)

Both REQUEST_CHANGES, both HIGH confidence, and they converged on the same five items. I
verified every claim against the code before acting on any of it; all five hold.

1. **Criteria 7 and 12 were mutually incoherent — the real find.** `PairingStore.issue()`
   requires a `purpose`, and there are two ceremonies: `pairing/redeem` consumes
   `machine-credential`, `human-sessions` consumes `client-session`. My criterion 12 never
   named purpose, and the only operator precedent (`pair-dev.mjs:71`) hardcodes
   `machine-credential`. A command satisfying criterion 12 as drafted could pair a device and
   never open the human session criteria 7/8 depend on — leaving 9b exactly as unreachable as
   it is today. Added 12b: both purposes, `purpose` **required with no default**, refused at
   issue time. A wrong default fails only at redemption, which is the deferred-failure shape
   this repo rejects.
2. **`validateSnapshot` hard-rejects unknown `t3code` values** (`connection/types.ts:203-213`)
   and `snapshotRejection` classifies present-but-unknown as `unreadable`, not `older-server`
   — absence of the field is what means older server. So new wire codes blank a whole machine
   on an older client. Added 5b stating fail-closed is intended and that the allow-list must
   not be loosened to green a test.
3. **Approach 3B answered the wrong objection.** `agent-auth.ts:190` privileges revoke on
   *availability* grounds ("an agent that could revoke could deny a human their gate"); I had
   answered confidentiality. Rewrote it: a same-UID agent can already write or corrupt those
   stores, so it can already perform that denial — the command makes it convenient, not
   possible, and the status quo is a human who cannot revoke while the agent still can.
   Criterion 17 now also requires reconciling both route `rationale` strings.
4. **Criterion 16 was an irreversible write outside the worktree.** Revoking real `dev-check`
   touches `~/.agent-farm/machines/` outside `CODEV_AGENT_FARM_DIR`, and `revoke()` returns
   false when already revoked. Marked it a one-time manual operator action, explicitly not a
   suite step, with re-pair named as the recovery.
5. **The session-status mapping was parked in the plan.** Fair: ASPIR's spec is the last gated
   WHAT and this is what a row says to a person. Pinned the full table plus its precedence
   (porch → `error` → activity → settledness → idle), and decided **two** new row words,
   `STOPPED` and `ERROR`. Without them a crashed or torn-down session folds into `SETTLED`,
   which reads as "this finished its work" for a session that did not.

Also pinned the snapshot status set at eight (`not-provided`, `not-configured`, `misconfigured`,
`connecting`, `cooling-down`, `unreachable`, `available`, `stale`) — six of them are answers
the existing connector already computes, and `connecting` vs `cooling-down` is the difference
between "wait" and "go look at your server". Fixed my own four/five arithmetic slip between
criteria 2 and 5. Added the concurrency bound on approval operations as an Important open
question.

### Plan iteration 1 — consultation

Both lanes REQUEST_CHANGES, both HIGH, and again they converged. The lead finding was one I
had missed entirely and both found independently: **the plan asked for a mapping the wire could
not carry.** `ThreadRegistrySnapshot.t3code` was a bare status string on the server
(`thread-registry.ts:62`) and mirrored as a bare string on the client (`types.ts:71`), so
`observedAt`, the stale age and thread settledness had no path to `deriveRowStatus` at all.
Criteria 3 and 4 were unimplementable as written.

Decisions taken in response, all in phase 1:

- **`t3code` stays a string; `t3codeObservation` is a sibling.** Chosen over promoting `t3code`
  to an object because `snapshotRejection` keys `older-server` on the field being *absent* — an
  object-valued `t3code` would make a newer client reject an older server's bare string as
  corrupt and blank the whole machine. The sibling keeps that direction validating.
- **`ThreadIdentity.sessionState: string` → `session: { status, settled, lastError? }`.** One
  string cannot carry both a session status and thread settledness, and both are needed:
  `stopped` + settled finished, `stopped` + unsettled did not.
- **`readThreadRegistry` attaches live threads on `stale` too**, not only `available`.
  Otherwise a stale snapshot carries no per-row content and the stale rule has nothing to act on.

Also fixed from review: `observedAt` now means **subscription liveness**, not event cadence
(`subscribeThread` has no cadence, so an idle-but-live session would have aged into stale);
the maintainer must rescan thread ids rather than read them once; the snapshot path must never
call `requestThreadBackend` (it connects and does a five-layer config read); the startup pass is
scoped by owning host/pid; handler names must share no prefix with `handleGateApprove`
(`approval-writes.test.ts:138` slices source from `indexOf('function handleGateApprove')`); and
`--authority` was both required and defaulted in my draft.

`two-machines.spec.ts:235` is criterion 11's only end-to-end assertion and phase 6 reddens it.
Named in the plan with what it becomes rather than left to be discovered as a red test.

## Phase 1 — snapshot vocabulary and the session-state mapping

Landed. Server: the eight-status union with payloads, `T3codeObservation`, `LiveThreadSession`,
attach-on-stale, and `T3CODE_UNREACHABLE` extended to `cooling-down` but deliberately **not** to
`not-configured` / `misconfigured` — a workspace that names no server has nothing to be
unreachable, and borrowing that code would send an operator to check a server that does not
exist.

Client: the mapping table with its precedence (porch → `error` → activity → settledness → idle),
two new words `STOPPED` and `ERROR`, the stale rule, per-status machine-level reasons, and the
validator extended to the eight statuses plus a structured session and observation.

**The old mapping recognised a word no server sends.** `fromSessionState` had a `case 'settled'`,
but `settled` is not a t3code session status — settledness is a thread-level field. So the client
had a branch for a value it would never receive and no branch for four values it would (`idle`,
`interrupted`, `stopped`, `error`). That is now pinned by a test that reads the enum out of
`packages/types/src/t3/generated/schema.json` rather than from a typed list, with an anchor
asserting the read actually found `idle` and `error` so a schema-shape change cannot make the
loop silently verify nothing.

### Two environment notes for whoever picks this up

1. **The worktree had no `node_modules`.** `pnpm install --frozen-lockfile` at the worktree root
   was needed before anything could typecheck or run.
2. **`packages/codev/skeleton/` is a gitignored build output and its absence fails 18 test files
   / 80 tests** that have nothing to do with the change — protocol resolution falls back and
   `Unknown review type "pr" ... protocols available here: "impl"` is what it looks like. `pnpm
   --filter @cluesmith/codev run copy-skeleton` fixes it. I nearly recorded those 80 as a
   regression; they are not.

### Phase 1 iteration 1 — consultation

Both lanes REQUEST_CHANGES, both HIGH, both blocking on the same two items. Both were real and
both were mine.

1. **Criterion 5 was not implemented.** `deriveRowStatus` checked only
   `identity.session === undefined` and never looked at `threadId` or `backing`, so a
   terminal-backed row — which is *every real row today* — rendered "t3code returned no state for
   this thread" about a thread it does not have, sending a reader to look for something t3code
   lost when nothing is missing. Added the branch, keyed on `threadId` (the field a session is
   joined on server-side), placed after the porch gate so a terminal row still reports its gate,
   which is the only live signal such a row has.

   Claude then sharpened it in a second pass: `multi-machine.test.tsx` was the suite's only
   terminal-backed fixture and it gave those rows a `session` while omitting `threadId` — **a
   shape the server cannot produce**, since the registry attaches a session by joining on the
   thread id. The one fixture modelling production's real row was masking the gap. Fixed, and
   `derive.test.ts` gained a `terminalRow()` helper so the case is constructible at all.

2. **The observation dropped `message` and `since`.** `observationOf` emitted only for
   `available` and `stale`, so `cooling-down` reached the client as a bare word with no when and
   no why, and `misconfigured`'s account of which half of the config is written reached it
   nowhere. The plan said to carry them and I did not. `T3codeObservation`'s members are now all
   optional — different statuses have different things to say — with `observedAt`/`ageMs`
   validated as a pair, because half of them is a payload the client cannot read rather than a
   partial answer to make the best of.

Also from review: fixtures annotated `ThreadIdentity` while omitting the required `backing`
(`apps/client/tsconfig.json` has `include: ["src"]`, so tests are not typechecked — worth
knowing before trusting a green `tsc` there); added render tests for the six machine-level notes
and the two new stamps. The note test initially passed on one sentence repeated six times
because `renderMachine` leaves earlier renders in the document — scoped to the returned
container.

## Phase 2 — the t3code session cache and the production provider

Landed. Criterion 3 is now reachable: `tower-server.ts` passes a `t3codeSnapshot`, and the
phase-11 tripwire is inverted in place with a comment recording what the wiring does and does
not buy.

### The seam I had to build, and why one socket

`ResumingSubscription` in `packages/t3-client` looked like the obvious tool and is the wrong
one here: it takes a `connect()` that returns a transport it OWNS, opening fresh ones across
drops. Opening a t3 connection costs a bootstrap-token exchange, and a pairing-issued token is
**one-time** — `thread-backend.ts` says so in its own `token-refused` message. A second
connection would spend the credential the engine needs.

So the read side rides the engine's existing socket. `T3Client.stream(method, payload, onValue)`
already exists; `connectDispatcher` was returning only `dispatcher.call`. Added a
`ThreadStreamer` registry in `thread-runtime.ts` beside the engine registry, registered and
evicted with the engine and guarded by the **engine's** identity, so a late close cannot drop
what a later reconnect installed.

### Two contract facts I got wrong first and fixed by reading the schema

1. **`settledOverride` is `'settled' | 'active' | null`, not a boolean.** My first cut tested
   `=== true`. An explicit `'active'` means the thread is NOT settled even though `settledAt`
   carries a timestamp, so treating `settledAt` as decisive would report a thread its owner
   deliberately un-settled as finished. The override now wins in both directions.
2. **The subscription is a fold, not a read.** The snapshot frame arrives once; everything after
   it is events — `thread.session-set`, `thread.settled`, `thread.unsettled`. Reading only the
   snapshot would have frozen each session at subscription time and gone on reporting it as
   current, which is the exact "it had finished when I last looked" failure this phase exists to
   prevent, produced from inside the mechanism built to prevent it.

   The corollary matters as much: an unreadable or unrelated frame returns what is already
   known rather than `undefined`. Silence about a fact is not evidence against it, and erasing
   the session on every unrelated event would flip a row to UNKNOWN whenever its agent was busy.

### Freshness

`observedAt` is stamped from subscription **liveness**, so a watched-but-silent session stays
`available` however quiet it is, and ageing starts at the drop. The window is 60s because
`requestThreadBackend` will not retry a failed connect for 60s — anything shorter flaps every
entry through `stale` on an ordinary reconnect. Content is discarded after 10 minutes: an
hours-old status is a wrong answer with a disclaimer on it, and the disclaimer stops being read
long before the content stops being wrong.

Subscribing happens synchronously inside the sweep rather than on a microtask. The deferred
version made "subscribed" true one turn of the event loop after the pass that decided it, which
is a distinction nothing benefits from; a try/catch buys the same protection against a
synchronous throw escaping the maintenance pass.

Suite: 6967 passing, 0 failing. Client 205 passing.

### Phase 2 iteration 1 — consultation

Both lanes REQUEST_CHANGES, both HIGH, and they found the same two bugs independently. Both were
real and both were the same defect from two directions: **a status word that asserted more than
the process knew**.

1. **An unobserved thread published as `available`.** The sweep created the cache entry when it
   opened the subscription, seeded `observedAt` with the creation time, and `#observed` then read
   that placeholder as an observation moments old. So between opening a subscription and the
   first frame, the machine claimed to have observed a thread nothing had seen. `observedAt` is
   now `undefined` until a frame lands, and an entry with none is not published. Also fixed the
   drop path: a subscription that ended without ever delivering must not stamp a time, or "never
   seen" becomes "seen just now, then lost".

2. **A ready backend with no threads reported `connecting` forever.** This is the state *every
   real workspace is in* — no row in `global.db` carries a `thread_id` — so a connected, healthy,
   correctly configured Tower would have said "still connecting to t3code" for as long as it ran.
   Saying the connector's word for a connect in flight after the connector has already answered
   `ready` is exactly the collapse the eight-status set exists to prevent. Connected-with-nothing-
   to-watch is now `available` with an empty thread list, and each row says why it has no session.

   Keying that on `cache.threads.size` was my first fix and it was wrong: the map loses an entry
   when its content is discarded for age, so a workspace that HAS a thread would have reported
   having none — turning a discarded observation into an assertion that there is nothing to
   observe. Keyed on the thread-id count from the sweep instead. The discard test caught it.

Also added the two tests the plan named and I had skipped: the no-config case driven against the
**real** `requestThreadBackend` (every other test injects `availabilityFor`, which proves nothing
about it), and the integration through `buildAgentProtocolSnapshot` — which is the one that asks
what a client actually receives, and which both lanes noted would have caught both bugs.

Clarified the README: Tower emits seven of the eight statuses; `unreachable` is not one of them,
because a failed connect becomes `cooling-down`, which says more. It stays in the vocabulary for
a host that observes unreachability another way.

Suite after fixes: 6975 passing, 0 failing.

### Phase 2 iteration 2 — APPROVE + COMMENT, and a NUL byte

claude APPROVE, opencode COMMENT. Both confirmed the two iteration-1 bugs are fixed and tested.
I took all four remaining items, because three of them are the same honesty class the phase is
about and the fourth is cheap.

1. **`#threadIds` turned a failed read into "nothing to watch"** (opencode). It caught a failed
   query and returned `[]`; the sweep then stamped a zero count, deleted every entry, and
   published `available` with an empty thread list — "I could not tell" spelled as "there is
   nothing here", in the module I had just fixed twice for exactly that. It returns `null` now
   and the sweep leaves the previous answer standing, which is the rule `#workspaces` already
   followed.
2. **`sweep()`'s try/catch wrapped the whole loop** (claude), so one throwing workspace skipped
   every workspace after it, and theirs then aged into `stale` — a t3code problem reported in
   workspaces that never had one. Per-workspace now.
3. **`#subscribed` keys were never cleared** (claude). The live socket was the smaller half: the
   real damage is that a thread which left and came back would be considered already subscribed
   and never watched again, silently.
4. Left as-is with reasoning recorded: the machine-level age takes the oldest entry, so one
   dropped thread marks the whole snapshot `stale`. Conservative, and inherent to one age per
   snapshot on the phase-1 wire.

**The NUL byte.** Fixing (3) surfaced something that had been in the file since phase 2's first
commit: `#ensureSubscribed` built its key as `` `${key}\x00${threadId}` `` — a literal NUL where
I intended a space — and my new `#forget` built it with a real space. The two never matched, so
the `delete` silently missed. Nothing could show it: the separator is invisible in an editor and
in a diff, and it was harmless for as long as exactly one place both wrote and read the key. It
only became a bug when a second call site had to agree with the first.

Both sites now go through one `subscriptionKeyFor()`. I also scanned all 29 files changed on
this branch for NUL bytes — none remain.

Suite: 6979 passing, 0 failing.

## Phase 3 — `afx pair issue/list/revoke`

Landed. Three subcommands, all direct store operations, so **revoking costs exactly what
minting costs** and works with no credential and with Tower down — which is when an operator
most wants it. The HTTP routes are unchanged for clients that do hold a session.

`--purpose` is required with no default. A default would fail at redemption — a different
process, a different route, a message about a token rather than about the choice made silently
for the operator. `--authority` is the mirror: the flag is optional, the recorded value is never
empty, and an explicitly empty one is refused because an operator who tried to say something and
said nothing is not the same as one who did not try. The default names the command and the OS
account and says outright that no human presence was verified.

### Verified by running it, not only by tests

Drove the real CLI (`runAgentFarm(['pair', ...])`) against a scratch `CODEV_AGENT_FARM_DIR`:
issue for both purposes, list showing outstanding/redeemed/expired and paired machines, revoke
on a name with nothing live, and exit code 1 for both a missing and an unknown `--purpose`.

That is how I found the one real bug in this phase: **`cli.ts` uses `parseAsync`, which awaits
what an action returns.** I had written the actions as `.action(() => { void (async () => {...})(); })`,
which hands it nothing to wait for — so the process exited before the dynamic import resolved and
`afx pair issue` printed **nothing, silently, with exit code 0**. Every other action in the file
is `async` and awaited; mine now are too. No unit test would have caught it: the tests call the
functions directly, and the defect lives entirely in the wiring between commander and the module.
This is the "code that passes its tests and production never reaches" shape, caught by driving
the actual command.

### Test notes

`revoke` against a corrupt store needed the corrupt file to be **that machine's own record** —
the store keeps one file per machine keyed by a hash of the name, so junk under another name is
correctly "not this machine" rather than "unreadable". The narrower claim is the true one.

The token-leak assertion walks every file under the scratch root rather than checking a known
variable, because the leak this guards against is the one nobody remembered to redact.

Suite: 7003 passing, 0 failing.

### Phase 3 iteration 1 — APPROVE + COMMENT

opencode APPROVE, claude COMMENT. No blockers; I took five of the six notes.

The one that matters is claude's: **`pairRevoke` could report a failure for something that had
already succeeded.** The credential tombstone is written first, then the approval capability
store is read — so an unreadable approval store threw straight out with nothing printed. The
operator saw "the command failed" for a revocation that HAD happened, and a re-run then answered
"nothing live to revoke", which reads as "it was never paired". That is reporting one outcome
while another occurred, in the command written to fix exactly that asymmetry. It now prints what
did happen first and raises `PAIR_REVOKE_PARTIAL` naming which half failed.

Also fixed: my corruption `it.each` had **one row whose second element was never used** — a table
shaped like coverage that covered one case; four subcommand/store pairs are now exercised. Added
a test that drives the default root through `CODEV_AGENT_FARM_DIR`, since every other test injects
a path and a rename of a default subdirectory would leave them green and production wrong.
`stores()` uses `path.join`. `--ttl-minutes abc` is refused by name instead of surfacing the
store's `PAIRING_TTL_INVALID`. The leak assertion now checks the secret is absent from every
output line except the token line, rather than matching a shape.

Deferred with agreement: the new `PAIR_*` codes are not in the failure-matrix collector's scanned
file list. Criterion 19 is assigned to phases 4 and 7, and claude said to track it there.

Suite: 7008 passing, 0 failing.

## Phase 4 — durable approval operation store

### A protocol mistake of mine first

After phase 3's approval I ran `porch next` (which advanced to phase_4) and then `porch done`
blindly, in one command, to trigger what I thought was phase 3's iteration-2 review. That
`porch done` marked **phase 4's build complete before phase 4 existed**, and the next `porch next`
offered a phase_4 consultation on an empty phase. I caught it at that point and implemented the
phase before running any review, so nothing was reviewed that was not there — but the lesson is
that `porch done` is a claim, and running it without having done the work makes a false one.
Do not pipeline `porch next` into `porch done`.

### The store

File-backed beside the capability and nonce stores, same root, same lock, same
"exists but will not parse" discipline. Not `global.db`: an approval operation is short-lived
operational state in the approval domain, and putting it there would mean a schema migration for
a record whose natural retention is hours.

Six states — `submitted`, `running`, `succeeded`, `refused`, `failed`, `interrupted` — kept apart
because they send an operator six different places. `refused` is deliberately not `failed`: porch
declining because a precondition is unmet is porch working, and merging them would send someone
to debug a host when the answer is that their checks did not pass. `running` carries the phase and
the check set, because "running" with nothing beside it is a spinner.

**Each record names its owning host and pid.** The store is keyed by `CODEV_AGENT_FARM_DIR`, not
by host, so an unscoped resolution pass would let a second Tower mark a *live* host's operations
interrupted — a running approval reported as dead, which is the failure the store exists to
prevent, committed by its own recovery. The pass skips other hosts, live pids, and this process's
own records (live by definition). `EPERM` from `kill(pid, 0)` reads as **alive**, because it means
the process exists and belongs to someone else.

`interrupted` reads `status.yaml` and reports what it found. The approved case is the one that
matters: a host that died *after* porch wrote the gate leaves a running record and an approved
gate, and calling that a failure would send an operator to approve something already approved.

### Criterion 19, including phase 3's deferred codes

Added `../lib/approval-operations.ts` **and** `../commands/pair.ts` to the failure-matrix
collector's scanned list (the collector needed a `../commands/` branch in its rename guard).
Three new matrix rows — `APPROVAL_OPERATION_INTERRUPTED`, `_UNKNOWN`, `_STORE_UNREADABLE`. The
successes and refusals (`APPROVAL_OPERATION_SUBMITTED`, `APPROVAL_ALREADY_IN_FLIGHT`,
`APPROVAL_CONCURRENCY_LIMIT`) and all seven `PAIR_*` codes went to `NON_MATRIX` with a reason
each: they answer "your request was wrong, or it worked", not "a service or file failed".

Suite: 7030 passing, 0 failing.

### Phase 4 iteration 1 — both lanes REQUEST_CHANGES on the same collapse

Both found it independently: **I passed `APPROVAL_OPERATION_STORE_UNREADABLE` as `withStoreLock`'s
`lockedCode`**, so a 2s contention miss reported the store as a corrupt file. "Retry, it will
work" and "go and look at that file" spelled with one word — in the store whose entire purpose is
keeping such pairs apart, written by someone who had just spent three phases on that exact rule.
Every sibling store has had its own `*_STORE_LOCKED` from the start, and `atomic-store.ts` takes
the code as a parameter precisely so they stay different. Added `APPROVAL_OPERATION_STORE_LOCKED`.

The failure-matrix collector then failed on the new code being unclassified — which is the
collector doing its job, and the reason phase 4 put both new files into its scanned list.

claude's three others, all real:

- **No held-lock test**, unlike all three sibling stores. Added, named for what it exercises (it
  does not run two processes and must not be read as a concurrency proof) and asserting LOCKED
  rather than UNREADABLE.
- **`resolveInterrupted` skipped by raw pid equality**, so a Tower that crashed and restarted with
  the *same pid* would ask "is 4242 alive?", get `true` because it is now itself, and leave the
  dead run's record `running` forever — on exactly the restart meant to clean it up. Added a
  per-process `runId`: same host + same pid + different run means the previous holder is
  definitively gone. An absent `runId` (a record predating the field) is treated as not-mine,
  because stranding a record forever is worse than re-reporting a gate.
- **`#sweep` kept records with an unparseable `settledAt` without saying why.** It is deliberate —
  an unreadable timestamp says nothing about age, and dropping the record would act on "I could
  not tell" as "old enough to discard" — and now says so.

opencode's non-blocking note taken too: `markRunning`/`settle` could overwrite a terminal record,
so a late callback from an abandoned run could rewrite an outcome an operator had already been
shown. Now refused.

Suite: 7036 passing, 0 failing.

## Phase 5 — asynchronous gate approval routes

Landed. `POST .../gates/approvals` submits and answers **202** with an operation id; `GET
.../gates/approvals/<id>` reports it. The synchronous `gate-approve` route is untouched and
still refuses with `PHASE_CHECKS_REQUIRED` — criterion 11 — and the first test in the new file
asserts that against a checks-enabled project rather than assuming it.

Everything is checked **before** an operation exists: malformed body, unknown workspace, and a
capability belonging to another session all refuse with no record written. An operation is a
durable artifact an operator can see; creating one and then refusing it would put a failed
approval in their history for a request that never had the right to make one. Three tests assert
`operations.records()` is empty after each refusal.

`runApprovalOperation` runs porch **without** `refuseIfChecksWouldRun` — that is the whole point —
with the same deliberately minimal env as the synchronous route and `onRefusal: 'throw'`, since
porch's CLI answers a refusal with `process.exit(1)` and that inside Tower would end the process.
The failure path reads `status.yaml` before concluding anything: something thrown *after* porch
wrote the gate must not be recorded as `failed`, or an operator is told to approve what is
already approved.

`initAgentRoutes` resolves interrupted operations synchronously, before the surface can answer a
poll — so "running forever" is unreachable rather than unlikely.

### Two guards caught me mid-phase, which is what they are for

1. **The dispatcher-literal check in `agent-auth.test.ts`.** My submit response echoed a `poll`
   URL built by interpolating `AGENT_ROUTE_PREFIX`, which put the path literal
   `/api/agent/v1/workspaces/` in the dispatcher naming no route. That guard exists to find a
   path the router *serves* without a table entry, and a URL the server merely quotes is the
   noise that would train someone to loosen it. Dropped the field: the client already holds the
   encoded workspace (it just called submit on it) and the id.
2. **The failure-matrix collector**, twice — once for `APPROVAL_OPERATION_STORE_LOCKED` in
   phase 4 and once for `APPROVAL_OPERATIONS_NOT_AVAILABLE` here. Both were caught by the file
   list phase 4 extended, one commit after extending it.

Handler names are `handleApprovalSubmit` / `handleApprovalOperation`, sharing no prefix with
`handleGateApprove`, because `spec-146-phase-11-approval-writes.test.ts` slices the file from
`indexOf('function handleGateApprove')`.

Suite: 7047 passing, 0 failing. Route enumeration 63 passing over both new routes.

### Phase 5 iteration 1 — both lanes REQUEST_CHANGES, three findings, all mine

1. **`markRunning` was never passed a phase or a check set.** The store accepted them from the
   first commit, the poll response spread them, and the one production call passed neither — so
   those fields could never reach a client. Complete plumbing with nothing connected at the end,
   which is worse than an absent feature because it reads as present. Added `describeWork()`,
   which asks **porch's own `getPhaseChecks` after overrides** rather than re-reading the
   protocol, so the names an operator waits on are the commands that actually run. Best-effort:
   a protocol that will not load reports nothing rather than a guessed phase.

2. **Criterion 7 was not driven.** opencode caught it precisely: my success test skipped every
   check, so `getPhaseChecks` returned `{}` and `refuseIfChecksWouldRun` would never have fired —
   that is the path the *synchronous* route already served. A green test proving the phase's
   headline criterion by removing the condition that makes the criterion mean anything.

   The fixture now has three settings, and the middle one is the phase: `passing` keeps the
   checks **declared** and overrides their commands with `true`. The same workspace is asserted
   to be refused by the synchronous route and approved through the asynchronous one, in one test.

3. **No route-level already-approved test.** Criterion 9, covered only at the store level. Added:
   two different sessions, the second reporting `outcome: 'already-approved'` and the **first**
   session's machine, session id and timestamp — all cross-checked against `status.yaml` rather
   than against what the route said.

One assertion of mine was wrong and the code was right: I asserted the running record's phase was
`review` when the fixture declares `implement`. `describeWork` reported what the file says.

Suite: 7050 passing, 0 failing.

### Phase 5 iteration 2 — APPROVE + COMMENT, three notes taken

opencode APPROVE, claude COMMENT. No blockers; all three notes fixed because each is a
report-vs-reality gap and phase 6 is about to consume this record shape.

1. **The async path dropped porch's `delivery` caveat.** The synchronous route has forwarded
   `delivery` / `deliveryMessage` since phase 11; mine did not, so a `committed-not-pushed`
   approval reported plain success **on the path ordinary projects must use**. The gate is
   approved and the operator is never told to push. Added the fields to the record and forwarded
   them. The test drives it through the poll route rather than asserting a shape built in the
   test, which is what my first version did and proved nothing.
2. **The poll answered `APPROVAL_OPERATION_SUBMITTED` for terminal states.** Cosmetic, but a
   label that contradicts the field beside it is the one that gets read. Derived from the state
   now: `APPROVAL_OPERATION_SETTLED` for succeeded/refused/failed (`state` says which — a code
   per outcome would be two places to keep in step for one fact), and `interrupted` keeps its own
   because it says something about the host rather than about the approval.
3. **`describeWork` named the phase `verify-approval` is leaving.** `approve()` enters `verify`
   *before* computing checks — its own comment says why — so reading the phase off `status.yaml`
   would have shown the review phase's build and tests for a run that executes neither. This is
   the one case where the display could be **confidently wrong rather than absent**, so it is
   special-cased to `{ phase: 'verify', checks: [] }`, which holds in every case where the
   approval proceeds at all.

Suite: 7053 passing, 0 failing.

## Phase 6 — the client submits and polls

### The protocol mistake, repeated

I pipelined `porch next` into `porch done` again after phase 5's approval, so porch marked phase
6's build complete before phase 6 existed — the same error I recorded in the phase 4 rebuttal and
said I would not repeat. Caught it at the same point (the consultation would have reviewed
nothing) and implemented the phase before running any review, so again no reviewer was misled.
**`porch next` and `porch done` must never be in one command.** Writing it down twice has not
worked; the rule is now: after an approval, run `porch status` and read which phase is open
before anything else.

### The client

`approveGate` submits to `/gates/approvals`, polls until terminal, and reports. A host that
answers **501** falls back to the synchronous route — `tools/codev-agent-host` was such a host,
and the fallback keeps every older path approving everything it ever could.

Every terminal state maps to something a human can act on, and the two that matter are the ones
that are *not* refusals: `interrupted` is `unconfirmed` carrying the server's reading of
`status.yaml`, and a `succeeded` record this build cannot parse is `unconfirmed` too. Both would
otherwise send someone to approve what may already be approved. **Giving up waiting is also
`unconfirmed`, never a refusal** — this client stopping does not stop porch, so reporting "not
approved" would reintroduce the exact failure the async path exists to prevent, in the client.

The panel shows the server's own phase and check names while it runs. Three distinct sentences —
accepted-not-started, running-with-no-detail, running-these-checks — because one "Approving…" for
all three is the spinner this phase exists to remove.

### Test harness bug worth recording

`approval.test.ts`'s router matched routes by `url.includes(path)`, and **`/gates/approve` is a
prefix of `/gates/approvals`** — so the synchronous stub answered the asynchronous submit and
every test passed against a route it was not exercising. Longest-match now, plus GET support and
scripted multi-answer routes for polling. A helper that silently answers the wrong route is the
same defect as production code that does.

### The e2e split

`two-machines.spec.ts:235` was criterion 11's only end-to-end assertion and the UI no longer
reaches that branch. **Not deleted**: it drives the synchronous route directly now, and a new
test drives the UI's async path on a `passingChecks` stand — checks declared (so the sync route
still refuses the same project) with commands overridden to `true` (so they pass). `agent-host`
now wires an operation store, or the e2e stand would have fallen back to sync and the new path
would have gone untested while the suite looked complete.

**Not run: Playwright e2e.** It is excluded from porch's `tests` check (`--exclude='**/e2e/**'`)
and no browser run happened here. The spec file changes are unverified by execution and are
recorded as such.

Suites: client 218 passing, server 7053 passing, 0 failing.

### Phase 6 iteration 1 — two blockers, and the e2e I said I had not run

Both lanes REQUEST_CHANGES.

**opencode: a poll that could not read the state was reported as a refusal.** `pollApproval`
mapped every non-200 — including the server's own 503 `APPROVAL_OPERATION_STORE_UNREADABLE` — and
a thrown `fetch` onto a plain refusal, which the panel renders identically to a failed approval.
So the server took care to say "I could not read the store" and the client told a human their
gate was **not approved**. The timeout path already knew the rule (this client stopping does not
stop porch); a transport failure is the same case arriving sooner. Now retried to the deadline
and reported `unconfirmed`. **403 is the one exception** — this session may not read this
operation, and retrying will not change that — with a test asserting it does not spin.

**claude: run the e2e.** My own phase-6 acceptance said the split case is "verified by running
that case, not by asserting it exists", and I had recorded it as not run. Playwright browsers
were installed; I ran it. **6 passed, 1 failed — mine.**

The failure was worth more than a pass: with `command: 'true'` the checks finished before the
first poll, so the panel never left "Submitted" and the running frame carrying the server's phase
and check names was never observed. The test asserted a spinner and would have called it
progress. The stand's checks now take `sleep 2`, longer than the one-second poll interval, so the
running state is reached **by construction rather than by luck**. All 7 e2e now pass, in a real
browser, including the new async approval.

That is the second time this phase that running the thing found what the tests could not: the
`parseAsync` bug in phase 3 and this one.

Also fixed: the stale comment naming `agent-host` as a host with no operation store, when the
same change wired one into it. Added panel tests for `failed` and `interrupted` — the second must
render as **unknown, not refused**, because the host stopping is not evidence the gate is
unapproved.

Suites: client 225 passing, e2e 7 passing, server 7053 passing.

### Phase 6 iteration 2 — opencode APPROVE, claude REQUEST_CHANGES on three

All three real, all fixed.

1. **A thrown `fetch` on the SUBMIT reached the panel's catch**, which carries no `unconfirmed`,
   so a request that may well have started an approval rendered as "not approved". The same
   defect I had just fixed for the poll, **one call earlier** — I fixed the loop and not the call
   in front of it.
2. **A 401 mid-poll was retried for thirty minutes** and then reported a bare `unconfirmed`. The
   synchronous path already treats 401 as `sessionEnded`, so the two paths disagreed and the dead
   session was never dropped — the human keeps an Approve button they can only escape by
   reloading. 401 now stops alongside 403.
3. **`.gate-progress` had no CSS at all.** The one new element in the phase, rendering at the
   browser's 16px with default margins inside an 11px panel. Every test passed: it rendered, its
   text was right, and nothing in the suite can see a font size. That is #112's failure exactly.

For (3) I added `styled.test.ts`, which collects every class name the components emit and asserts
the stylesheet knows each one. It does **not** claim the rule is right or that the element looks
correct — only that the stylesheet has heard of it. Judging appearance still means opening the
page. Ran against the current tree: 62 classes emitted, 0 unstyled.

e2e re-run after the changes: 7 passing.

Suites: client 229 passing (13 files), e2e 7 passing, server 7053 passing.

### Phase 6 iteration 3 — APPROVE + COMMENT, and the pattern again

opencode APPROVE, claude COMMENT with two residuals — both explicitly advisory, both fixed,
because both are the **same "one step too narrow" shape** I had just named in my own iteration-2
rebuttal:

1. **A 5xx on the SUBMIT was still a refusal.** `handleApprovalSubmit` writes the operation record
   *before* it writes the 202, so a server error after that point leaves an approval running while
   answering with a failure. I had fixed the thrown-`fetch` sibling one round earlier and left the
   status-carrying one. Now `unconfirmed` for 5xx; a 4xx stays a refusal, because malformed,
   unknown-workspace and wrong-session are definite answers about the request.
2. **A poll 404 spun to the 30-minute deadline.** A host that accepted an operation and then does
   not know it has answered definitely; re-asking cannot change it. Now stops, reported
   `unconfirmed` — both facts are true and neither is a verdict on the gate.

Four rounds of review on this phase found six defects and **five were this same shape**: the rule
applied in one place and not the adjacent one. Poll but not submit. 403 but not 401. Element but
not rule. Thrown fetch but not 5xx. 401/403 but not 404. Worth carrying forward as a thing to
look for rather than as six separate misses.

Client: 232 passing, 13 files.

## Phase 7 — threat model, failure matrix, and the dev-check revocation

Landed. The documentation now agrees with the code, and the credential the issue was written
around is gone.

**The threat model** gained *"Who can revoke, and the trade that decides it"*, answering the
objection the route table actually raises — **availability**, not confidentiality. A same-uid
agent can already write these stores, so it can already deny a human their gate; the command
makes that denial convenient, not possible. And the alternative was never "an operator who cannot
be denied", it was the status quo where the human cannot revoke and the agent still can. Stated
as a trade rather than as a win.

**Both route `rationale` strings** now say the same thing the command does. Before this the
repository asserted, in code an operator reads, that revocation is privileged — while shipping a
CLI that revokes without a session.

**The failure matrix** gained three rows and one section explaining what is deliberately *not* a
row: the eight snapshot statuses are a state machine, not faults, and only two of them are
failures at all (both already covered by `T3CODE_UNREACHABLE`). `not-configured` never borrows
that code, because sending an operator to check a server that does not exist is a confident wrong
diagnosis.

**`dev-check` is revoked.** Run once by hand against the real `~/.agent-farm`:
`credential revoked`, `0 capability record(s) revoked`, read back as
`REVOKED at 2026-08-30T10:19:11.703Z`. Recorded in the review with the recovery (re-pair) and
with why it must never become a suite step: it writes outside `CODEV_AGENT_FARM_DIR` and
`revoke()` is not idempotent, so automating it would have CI revoke real credentials.

`agent-approval-path.test.ts`'s residual assertion still passes — no claim of verified human
presence was added anywhere in this project.

Suite: 7053 passing, 0 failing.

### Phase 7 iteration 1 — opencode REQUEST_CHANGES, claude APPROVE

Same class of finding from both: **documentation still describing the pre-command world**, which
is precisely what this phase exists to fix. I updated the threat model and the matrix and left
three other files asserting the opposite.

1. **The threat model's own "What this does not stop"** still said flag-only was the only
   practical human approval path and that "the client arrives in a later phase". True when phase
   6 wrote it; false after this spec. That document's rule is that every claim is one the code
   makes true, and I edited the section above it while leaving this one expired. Rewritten:
   flag-only is still reachable and still not a control — it is no longer the *only* path.
2. **`apps/client/README.md`** told operators to revoke with the session-gated HTTP DELETE — the
   instruction that does not work, and the reason this whole command exists.
3. **`146-remote-access-runbook.md`** (opencode; not in the plan's file list) said there is no
   `afx` subcommand and showed a `new PairingStore().issue()` call with no `purpose` or
   `authority` — **that call now throws**. The operator runbook and the threat model were
   asserting opposite things about the same command. Rewritten with `afx pair issue`, and a
   *Withdraw a device* section added.

Two more the reviews did not reach, found by grepping for the stale instruction across the repo:
the runbook's HTTP-route section (now labelled "for a client that holds a session", with a note
saying it is not the route to reach for at a terminal) and `pair-dev.mjs`'s header.

claude's nit taken too: the threat model's "For phase 7" heading now says "For spec 146 phase 7",
since two specs now have one.

The lesson is the one from phase 6 in a different costume: I fixed the documents the plan listed
and not the adjacent ones. Grepping for the stale instruction — rather than editing the files I
had in mind — is what found the last two.

## Post-PR review round — codex REQUEST_CHANGES (3) + my own claude lane (3)

All six verified against the code before acting. Every one was real.

### codex, all three confirmed

1. **`unreachable` was advertised and unreachable.** `ThreadBackendAvailability` has no
   `unreachable` kind and `snapshot()` contains zero occurrences, so the provider could never
   emit it while my spec's table said it did. **Did not delete the variant** — that folds
   "unreachable" into "cooling-down" at the type level, the exact conflation the eight statuses
   exist to prevent. Revised the contract deliberately: eight in the vocabulary, seven emitted by
   this provider, `unreachable` reserved for a producer that genuinely observes it. Pinned by a
   test that drives every connector state and asserts the emittable set, plus a second that reads
   the connector's own union so a new state cannot fall through unmapped.
2. **Interrupted operations were unpollable.** Sessions are memory-only; the poll required
   `operation.sessionId === humanSessionId`. So the restart that creates the `interrupted` record
   also destroys the only session that could read it — **the durable state whose entire purpose is
   surviving a restart was unobservable by the client that needed it.** Added `machine` + an
   unguessable `receipt` returned once at submit; `mayRead()` accepts the submitting session OR
   the receipt from the same machine. Machine alone would not do: every session on a paired
   device presents that device's credential.
3. **`#forget` cancelled nothing, and my test hid it.** The sharpest of the three. `#forget`
   dropped bookkeeping while the stream ran on, and the test called the fake's `forget()` — a
   thing production never does — so the test performed the cleanup whose absence was the defect.
   `T3Client.cancel(id)` was public but `stream()` minted its id privately, so cancellation was
   unreachable by construction; added an `onRequestId` callback, gave the streamer a
   `{ done, cancel }` handle, and the fake now removes its sink **only** on `cancel()`. The test
   asserts `held.cancelled()`, so it fails if production stops cancelling.

### my claude lane, all three confirmed

4. **A test pinned stale documentation.** `agent-auth.test.ts` asserted the runbook says "Today,
   revoke at the host" and `completePairing` "has no production caller" — both false since phase
   11 added the human-sessions route. A test whose job was keeping the runbook honest had become
   the thing keeping it stale: any correct fix reddened it. Now pins the property that still
   matters.
5. Runbook still said the human-session route was "not yet reachable by a person".
6. **I broke the pairing procedure.** My `## Withdraw a device` section landed between "the
   client exchanges it:" and its redeem block. Removed it; the content belongs in the existing
   "Revoke one device", which is where it now lives.

### And phase 10's evidence guard caught my t3-client change

Changing `client.ts` reddened `spec-146-phase-10-full-protocol.test.ts`, which content-hashes the
files its recorded live runs describe. Re-running needs a live t3code server this workspace has
none configured for, so I took the guard's documented second path: `supersededBy` in the evidence
JSON **and** a matching note in `146-driver-parity.md`, naming the same change. The guard requires
both or stays red, which is the right shape — setting the hatch costs the same as writing the
truth. Recorded that the change is purely additive *and* that "only additive" is exactly the
argument a content-addressed guard exists to refuse.

Suites: 7126 server, 265 client, 0 failing. Not pushed — architect asked me to hold.

## Round 2 — four blockers, and the one that was measuring the wrong rejection

Codex returned three, claude a fourth. Two of codex's said my round-1 restart fix did not work
end to end, and it was right: I had fixed the 403 the poll returned and the request never got
that far the second time, because it now failed at *authentication*.

The architect's instruction was the thing that made this round work: **write the real restart
test first and let it tell you where it stops.** So I did, before touching anything.

### The path, in the order the test found it

1. **401 at the route table.** `approval-operation` was `authentication: 'human-session'`.
   Sessions are memory-only, so the restart that creates `interrupted` destroys the session — the
   route refused the client before any handler could look at the receipt. Now
   `machine-credential`; the handler reads a session opportunistically and prefers it, and the
   receipt is the second way in. The rationale is recorded at the route.
2. **Wrong machine persisted.** Submission recorded `stored.machine` — this HOST's name — so
   ownership was the same string for every paired device, and the submitting one had no way to
   prove it was the submitter. Now `outcome.machine`, the paired client's name from its
   credential.
3. **Then it went green.** No third rejection.

### The fixtures were doing the concealing

Codex named this and it is the sharper half of the finding: `pair revoke` had a passing test
because the fixture set the host store's `machine` and the device name both to `'ipad'`.
Capabilities are keyed by the verifying host, so `revokeMachine('laptop')` matched nothing — the
command reported `0 capability record(s) revoked`, truthfully, while the device kept a live
capability. It worked only where the operator's laptop and the Tower host share a name, which is
a fixture and never a deployment.

Capability records now carry `pairedMachine` (the device) beside `machine` (the verifying host),
revocation matches the device first and falls back to the host for records predating the field,
and the fixtures use two different names. Both new tests fail if I revert the match.

### Workspace scope, found twice with no contact

Codex's third and claude's independent finding are the same seam: the poll looked an operation up
by id alone, so any workspace URL this host served returned it — gate, project, approving session
and authority, to a client scoped elsewhere. 404 rather than 403, because through the wrong
workspace it does not exist and "forbidden" would confirm that it exists somewhere else.

### The sweep was paying for workspaces that opted out

`requestThreadBackend` answers `ready` / `connecting` / `cooling-down` from memory, but
`not-configured` and `misconfigured` needed the config — and those are the verdicts of every
workspace that never opted in. So Tower's 5s sweep ran a full five-layer `loadConfig` per
unconfigured workspace per pass: 12 reads a minute each, on the event loop, scaling with
accumulated `known_workspaces` rather than with use.

Cached the negative against a **signature**, not a TTL: mtime+size of the layer files plus the
env vars. A TTL makes an operator who just wrote their t3 config wait it out and gives you a
number to argue about; a signature invalidates on the pass after the edit. The layer list is
extracted as `configLayerPaths` and `loadConfig` now walks the same list — a second copy in the
cache would go stale silently the moment a layer is added. Measured at `fs.readFileSync`: 12 → 0
over a simulated minute, and the test fails with 12 if I disable the cache.

### Nothing to do on the two couplings

Claude asked for comments at both source-text coupling sites. Both were already there and both
name their enforcing test — the `handleGateApprove` prefix slice
(`spec-146-phase-11-approval-writes.test.ts`) and the absent poll URL in the 202 body
(`agent-auth.test.ts`). Left as they were rather than re-wording to look responsive.

Criterion 3 is verified against the vendored contract and a driven fake, not a running t3code
server. The spec's own risk table called for exactly this handling; it goes in the PR body.

## Round 3 — a secret in a query string, and a knob only tests could turn

Both lanes, independently, on the same seam: the receipt travelled as `?receipt=`.

That is not an obscure hazard. `agent-auth.ts` already carried the rule, three lines above where
the receipt constant now sits — credentials are headers, "a URL lands in access logs and a
command line lands in `ps` output". I crossed a documented line in the file next door.

Worse than the boot-window log claude found: Tower also logs `req.url` on **every authentication
failure** (`tower-routes.ts:283`), which is precisely when a client polling across a restart
arrives. The leak fired in the exact scenario the receipt was invented for. And reverse proxies
log query strings regardless, so it was never bounded by our own logging.

Fixed as specified: `APPROVAL_RECEIPT_HEADER`, read from `req.headers`, added to the CORS
allow-header list (a header a browser cannot send is a header whose obvious workaround is putting
the value back in the URL). Both log sites carry `req.url` and nothing else on this path copies,
echoes or persists it — checked `req.url` across every server file, including the tunnel.

### The regression test, and the fixture that was measuring the wrong refusal

Four assertions: no source file builds `?receipt=` or reads it from `searchParams`; the query
channel is **refused** at the server while the header is accepted; both log sites still
interpolate `req.url` (which is what makes "no URL contains it" equal "no log contains it"); and
the header is advertised in preflight.

The behavioural half was wrong on the first try and I only caught it by reverting the fix: I sent
the query-string attempt from a *different* machine, so `mayRead` refused it on the machine
mismatch and the test passed with the query channel wide open. Same machine, no session — now the
receipt is the only thing that could authorise, so the status reports the channel and nothing
else. That is the third time this project's fixtures have measured the wrong refusal.

### maxConcurrent: dropped, not wired

A per-call parameter with a hardcoded default of 2 that only tests ever passed. Wiring it means
inventing a config key, and the store is one object serving every workspace while the limit is
per-workspace — so the key would not have an obvious home. Dropped to a named constant. The two
tests that tuned it now exercise the real limit, which they previously could not: they would have
passed with the shipped number set to anything.

### The freshness guarantee is borrowed

Recorded at `DEFAULT_FRESH_FOR_MS`: `observedAt` tracks subscription liveness, not event cadence,
so an entry cannot age into `stale` while the subscription is believed open — and what bounds
that belief is `packages/t3-client`'s 300s stream idle timeout. A silently dead socket reads as
`available` here for up to five minutes, and raising `streamIdleTimeoutMs` in that package
lengthens it with nothing in this file failing. Not fixed: a second timer racing the first is
worse than the borrowed one, and the thing worth having is the note.
