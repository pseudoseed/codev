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
