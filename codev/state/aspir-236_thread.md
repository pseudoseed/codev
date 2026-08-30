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
