# air-220 — Spec 146 Phase 11: codev-client tree and live status

## Slice 1 (checkpoint): scaffold, tree, live status

Built `apps/client` on the `apps/v2` stack (React 19, Vite 6, Vitest 4, Playwright), reusing v2's
`tokens.css` verbatim so the client inherits the established design language rather than inventing
one. v2 is slated for deletion in phase 12, which is why the tokens are copied rather than imported.

**Three server-side changes were unavoidable, and each is a "could not tell" fix.**

1. `ThreadRegistrySnapshot.t3code` — the snapshot carried no indication of whether session state
   was observable. Without it, "t3code says every thread is settled" and "t3code was never asked"
   are the same payload. `ThreadIdentity.sessionState` carries the live state when there is one.

2. **Terminal-backed identities are now published.** The registry only emitted rows carrying a
   `thread_id`, and on 2026-08-29 *every* architect and builder row in `global.db` is
   terminal-backed — phase 8's writer is not in production use. So the registry reported this
   workspace, with a live architect and two live builders, as EMPTY. `ThreadIdentity.backing` is
   `'thread' | 'terminal'` and terminal-backed rows are published and labelled. This is what made
   the first real screenshot non-blank.

3. **An SSE heartbeat.** Snapshots are emitted only on change, so a healthy quiet workspace sends
   nothing for hours and a client can set no staleness deadline against that. Found by killing the
   server behind a proxy: the socket stayed open, the browser's `read()` never settled, and the
   tree sat on LIVE indefinitely. The server now writes a `: heartbeat <iso>` comment every 10s and
   the client races each read against a 32s deadline (three missed beats).

`builders.spawned_by_architect` is projected onto the identity so the tree groups builders under
their architect. A builder whose recorded architect is not present renders under an explicit
"builders with no architect recorded on this machine" group — never silently under the first one.

## The second server

Criteria 7, 8 and 15 need two machines. A second Tower against the live `~/.agent-farm` would share
global.db, cron, delayed-send and the PTY manager with the one driving real builders, so instead
`tools/codev-agent-host/` mounts the same route table, registry and status reader over a **database
snapshot** and a scratch credential root. It prints its minted credential as one JSON line on
stdout. Started, stopped and revoked freely; touches nothing real. This is also the two-server e2e
harness for slice 3.

The vite dev server proxies each machine under a path prefix (`/m/alpha`, `/m/beta`), so the browser
reaches every server same-origin and `connect-src 'self'` stays closed.

## Verified by looking, not only by tests

Ran against a live host over a snapshot of the real `global.db`, workspace
`/Users/chris/dev/codev-1455`. First screenshot rendered as unstyled raw HTML: `style-src 'self'`
blocked Vite's injected `<style>`. `script-src` stays `'self'` — script execution is the
credential-theft path — and `style-src` now allows inline, with `default-src 'none'` plus
`img-src 'self' data:` closing the CSS-exfiltration route. Also caught `builder/builder-air-220`:
`builders.id` carries its own `builder-` prefix.

`frame-ancestors` was removed from the meta CSP. A `<meta>` CSP silently ignores it, and a
directive that does nothing reads as protection. It is a response header now.

Killed the host with the page open and watched it: DISCONNECTED band, relative *and* absolute
last-live timestamp, "retrying", the reason, and the retained subtree dimmed under "Showing the
last state received. It is not current."

## Slice 2: the gate derivation bug, two missing routes, approval, multi-machine

### The gate bug the architect caught by looking

Both builders read `GATE PR` while both were mid-implementation. Settled against porch's own
predicate rather than against what looked right: porch treats a gate as awaiting a human only when
`status === 'pending'` **and** `requested_at` is set — `next.ts:363`, `index.ts:407`, `1267`,
`1332`. Porch declares a project's gates at init, so every AIR project carries
`gates.pr.status: pending` from its first commit until the PR merges. Reading `pending` alone made
the tree's central claim false on every row.

### Two routes criterion 9b needed that did not exist

Phase 6 built the approval capability. Phase 7 built the route table. Between them there was no way
for a browser to obtain the human-paired session that gates issuance — `completePairing` had no
caller outside its own file — and no way to spend a capability, because porch reads it from an
environment only a server-side caller can set. Both shipped green.

- `POST /api/agent/v1/human-sessions`, a new auth mode `machine-credential-and-pairing-token`. A
  fresh pairing token is required on top of the machine credential, because that credential is a
  file a same-uid builder can read — and the standing argument for why a declared principal is only
  defence in depth is that a builder "has no human-paired session".
- `POST /api/agent/v1/workspaces/<ws>/gates/approve`, which calls porch's own `approve` in-process.
  porch stays the only writer of `status.yaml`.

`approve()` gained `onRefusal: 'exit' | 'throw'` (default `'exit'`, so every existing caller is
unchanged). Its three `process.exit(1)` sites plus the failing-checks exit would have ended Tower
and answered the request with nothing.

`agent-approval-path.test.ts` is the test whose absence let this happen: one journey over a real
HTTP server with the real `fetch`, from a client holding nothing to a gate approved in a real
`status.yaml`. Every step is a request; nothing is called directly.

### Also fixed while building it

- Capability issuance accepted a client-supplied `machine`, and `verify` compares that against the
  HOST's identity — so it minted capabilities that could never verify anywhere, and the caller only
  found out at the moment of approval, where it reads as a revocation. Refused at issuance now.
- The approval result lived inside `GatePanel`. A successful approval removes the gate, the stream
  delivers the new snapshot in milliseconds, and the panel unmounts — so the confirmation a human
  had just earned flashed and vanished. The row owns the result now.
- `handleGateApprove` passes `CODEV_AGENT_FARM_DIR` through, so a host running over a database
  snapshot cannot send porch's post-approval notification at the operator's real Tower.

### Criterion 15

A revoked credential is not a generic disconnect: `DisconnectWhy` gained `revoked`, the client
carries the server's own signal verbatim, and the subtree renders a distinct band saying
reconnecting will not help. `MACHINE_STORE_UNREADABLE` stays `auth`, because "I could not check"
is not "you were withdrawn".

### The e2e harness, and two ways it lied before it worked

Four Playwright tests against two live `codev-agent-host` processes, real workspaces, real git
repositories with real remotes (porch commits every state write), and porch's own `approve`.

1. `route.fetch` BUFFERS. Proxying the machines through Playwright's route table delivered an SSE
   stream that was live on the wire and empty in the page — a harness failure that reads exactly
   like a broken client. The proxy moved into the fixture's own server.
2. `tsx <file>` spawns the server as a CHILD. Killing the process the harness held killed a
   wrapper and left the server listening, so the test watched a client stay LIVE against a host it
   believed it had stopped. Now `node --import tsx`, and `stop()` waits for the port to actually
   close before it returns.

Both are the same shape as the defects this initiative keeps finding, one layer down: a thing that
reported success while the thing it named had not happened.


## Slice 3: the review round on #224

Four blockers, all fair, and two of them found defects of the same shape this
whole initiative is about.

### 1. Criterion 3 is UNMET, and now says so

`tower-server.ts` calls `initAgentRoutes` with no `t3codeSnapshot`, so the
registry always takes its `not-provided` branch and no row from a real Tower can
ever derive to working, turning or settled. Blocked rows work, because gates come
from porch. My tests injected session states, so they passed — the fourth
instance of the pattern, inside the PR asked to record it.

Not wiring a provider, and the reason is a real constraint rather than an excuse:
`t3codeSnapshot` is synchronous and a t3 connection is not, so a provider needs a
cached background subscription plus per-workspace t3 config Tower does not hold.
Phase 10 or 12.

`spec-146-phase-11-production-wiring.test.ts` reads the real `initAgentRoutes`
call and asserts it passes no provider, so the gap is a tripwire rather than an
assumption. The client states the cause **once per machine** now; three identical
sentences under three rows had buried the rows with something specific to say.

### 2. A stale tree could be labelled LIVE forever

`protocol-state-error` emitted a message and continued, so status stayed `live`,
heartbeats kept the silence deadline from firing, and the strip did not render
the message in its live branch. A persistent read failure showed an old tree
under a LIVE badge indefinitely — the exact property the disconnected state gets
right, one branch over. There is a `degraded` status and a STALE band now, and
`lastLiveAt` is not advanced by a failed read.

### 3 and 4. CI, and a client only I could run

Neither `apps/client` unit tests nor its Playwright suite ran anywhere: the root
`pnpm test` filters to `@cluesmith/codev`. 95 tests existed and CI had never seen
one. Added both, plus `check-types` for `tools/codev-agent-host`, whose import of
`AgentRouteContext` would otherwise rot the two-machine harness silently.

`vite.config.ts` named a `scripts/pair-dev.ts` that did not exist, the proxy
hardcoded two ports, and the built bundle asked for a `machines.json` no server
answered. Now: `scripts/dev-servers.mjs` (two real hosts and a written
`.dev-machines.json` in one command), `scripts/pair-dev.mjs` (pair with a real
Tower), `scripts/serve.mjs` (serve the built bundle with the `frame-ancestors`
header a meta CSP cannot carry), a proxy derived from the machines file rather
than a port table, and a README with the file's shape.

### Found while screenshotting, same class again

`MACHINE_STORE_UNREADABLE` was rendering as a permanent fail-closed, and then as
a bare "the server answered 503" with the signal dropped — because only 401 and
403 were read for their signal, and an unreadable store answers 503 deliberately.
"I could not check" is transient: it retries now, under a third band (CANNOT
VERIFY), so withdrawn, unverifiable and unreachable are three appearances,
asserted pairwise distinct.

## Slice 4: review round 2

### The security one

`MachineConfig.towerKey` was on the **production** config type, written into
`.dev-machines.json`, served to the page, and sent as a header by production
client code. Tower's shared host secret is all-or-nothing — it cannot be revoked
for one machine without rotating it for all — so a page holding it kept host-wide
access to every workspace even after criterion 15's revocation. Phase 7's whole
trade, inverted.

It was never needed. `isRequestAllowed` returns true for `isCodevAgentRoute`
before any key check, precisely so a paired device reaches the surface holding
only what pairing gave it. Verified in the source before removing rather than
assumed. Two guards now: a grep over `src/` for the secret's names, and a header
assertion.

### The other three

- **Shallow validation.** `validateSnapshot` checked top-level containers and
  cast the rest, so a malformed nested identity, gate or choice threw in
  `buildTree` or mid-render — and a throw there takes the whole tree, not the
  subtree it came from. Deep now, with a test asserting a healthy machine renders
  beside one sending nonsense.
- **Machine ids.** Everything is keyed by id, so duplicates impersonate each
  other. Constrained, deduplicated conservatively, counted when dropped.
- **A successful approval reported as a refusal.** `writeStateAndCommit` shared
  one catch across write, commit and push. Push failure is `StatePushFailed` now
  and the route answers 200 with a caveat — success first, caveat second, which
  is the difference between a caveat and a retry.
- **Checks inside Tower.** Refused before starting rather than bounded with a
  timeout: a client that gives up does not stop porch, so a timeout abandons a
  call that goes on to approve the gate anyway. Uses porch's own post-override
  computation. The e2e now covers both branches.

### The 9 server failures — comparative, not absolute

Scratch worktree at the merge base, one file on each ref, same machine, same
contention: **8 failed / 83 passed on both**, identical failure site, and the
test file is byte-identical between the refs. The branch is not the cause. That
is not the same as the tests being fine — issue #200 already reads the
phenomenon correctly, and 12 of that file's tests are `skipIf(CI)` so CI never
settles it either.

Correcting my own earlier report: I called them flaky after one clean re-run.
Two consecutive full runs showed the same 9. One clean run is not evidence of
flakiness; it is one clean run.

## Slice 5: review round 3

### The security one, and why it could not be fixed the way it was framed

`PairingStore.issue()` needed nothing but write access to the store. A builder
runs as the operator, so it can mint a token, redeem it, hold a session, and
approve its own gate through the advertised path. The threat model said a builder
was stopped by *having no paired session*. It was not.

The architect offered two ways out — real out-of-band authority, or stop claiming
human presence — and said the first was better. **I could not build the first
honestly.** On a single-uid host every channel available to the operator is
available to a builder: a file, a TTY, a spawned process, an env var. Inventing a
mechanism that *looks* like authority would have been a second false guarantee on
top of the first, and harder to see.

So: enforce what can be enforced, record the rest.

- `purpose` is **enforced** — a token minted to pair a device cannot open a
  session, and the reverse. That also closes the round-1 item about one token
  serving two ceremonies with nothing binding it. A token refused for the wrong
  purpose is *not* consumed, or anything reaching one route could destroy tokens
  minted for the other.
- `authority` is required at mint and carried verbatim through token → session →
  capability → `status.yaml`. `authorization: 'capability'` now says in its own
  doc that it means verified *credential*, never verified *human*.

The residual is pinned by a test that completes the ceremony as a builder would
and asserts the recorded authority reads `a builder minted this for itself`. A
future phase that adds real authority fails it — which is the point of putting it
there rather than only in prose.

### Criterion 9b, narrowed

Approving runs porch's phase checks, which for an AIR `implement` phase are the
repository's build and test suite. The architect's own ruling against a timeout
still holds — a client that gives up does not stop porch — so refusing before
starting is right, and the consequence is that the client cannot approve an
ordinary gate. Narrowed rather than dropped or quietly ticked, with the async
approval named for phase 12. Both branches tested; neither ticked on the other's
evidence.

### The backoff that never reset

`state.status === 'live'` after `openOnce` returned, and `openOnce` always sets
`disconnected` before returning. Unreachable, so the delay only grew. Keys off
whether the attempt received a snapshot now.

### Two things worth keeping

The e2e log now shows `afx send` refusing inside the harness — "global.db not
found … Refusing to send with an unverified identity". That is round 1's
`CODEV_AGENT_FARM_DIR` scoping working: a snapshot host's approvals cannot reach
the real Tower. A side effect that proves itself is worth more than the comment
that claims it.

Three of the six blockers across rounds 2 and 3 were the same shape as the
finding this PR set out to record: `towerKey` on a production type nobody had
followed to the browser, a validator guarding only the envelope, and a threat
model asserting a property its code never had. The pattern is not something that
happened to earlier phases.
