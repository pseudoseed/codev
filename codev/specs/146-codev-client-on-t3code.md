# Spec 146: a Codev client on a self-hosted t3code server

**Issue:** #146
**Status:** draft (revision 2, after CMAP)
**Author:** architect:uiv2

## Problem Statement

Codev's value is its protocol layer: porch's phase state machine, human gates, specs, plans and
reviews, CMAP consultation, and the architect/builder model. None of that exists anywhere else.

Everything underneath it, Codev implements by simulating a human at a terminal. Driving an agent
process, knowing when a turn ended, delivering a message, cleaning up a worktree. It types into a
PTY, screenshots the screen, and guesses from pixel geometry whether a prompt is ready. That
approach cannot be made correct, and the bug record shows it. The render gate's own reason codes
are `no-region-end`, `busy-indicator`, `no-composer-marker`, `geometry-mismatch` and `user-text`
(`packages/codev/src/agent-farm/servers/render-gate.ts`). In one recent session, six of eight
issues worked were this layer (#47, #92, #93, #109, #126, #130) and two were porch (#102, #113).

Separately, what a human looks at to see all this is inadequate. The Tower dashboard is
unreliable. The v2 client renders a workspace tree but has no tiling, no mobile, and no remote
access. There is no way to watch four builders at once, and no way to check on them from an iPad.

## Current State

**What Codev owns today.** Tower (HTTP and WebSocket on port 4100), a PTY manager, terminal
session management, a render gate that classifies a terminal screenshot as ready or not, a
durable mailbox with hold-and-retry semantics, worktree lifecycle in `.builders/<id>/`, a harness
registry with three entries, the v2 client, the legacy dashboard, and two extensions
(`apps/vscode`, `apps/streamdeck`) that reach terminals directly.

**What that costs.** Message delivery is best-effort against a screen the gate may not be able to
read. Interrupting a builder means sending ESC and hoping. A builder that `cd`s out of its
worktree loses its identity (#47). Idle builders hold live PTYs and agent processes.

**t3code.** MIT, `pingdotgg/t3code`, cloned read-only at `/Users/chris/dev/t3code`. A server
runtime owning agent sessions, workspaces and version control, with web, desktop and mobile
clients over one authenticated Effect RPC WebSocket. Five provider drivers (Codex, Claude,
Cursor, Grok, OpenCode) behind a common adapter. Event-sourced orchestration.

### What has been verified

Two spikes ran against a live server. The full report is
`codev/research/146-t3code-porch-execution-proof.md`, landing on `main` via PR #147; until that
merges the evidence lives on `builder/task-dUsB`.

| Claim | Evidence |
|---|---|
| An external process can drive a session end to end | 262-line Node client: OAuth token exchange, worktree-backed thread, `thread.turn.start`, streamed events, `thread.turn.interrupt`. Prompt was `sleep 30; echo SHOULD_NOT_FINISH`; the marker never printed. |
| Porch's check-then-advance loop works | Turn 1 settled, an external shell wrote a file in the thread's own `worktreePath`, turn 2 read the new value back. |
| A gate can pause past the reaper | A real reap fired: `provider.session.reaped`, `idleDurationMs: 2094232`. After the reap *and* a server restart, an answer-free prompt recalled a filename that existed only in pre-reap conversation. |
| No completion event is lost on reconnect | Socket dropped mid-turn at sequence 45; `afterSequence: 45` replayed 46-54 matching the control connection exactly, completion included. |
| Fully self-hosted | `docs/internals/t3-connect.md`: "T3 Connect is disabled in a fresh clone." The Clerk relay is opt-in. |
| Reachable from an iPad without cloud | `npx t3 pair --tailscale`. |
| Six concurrent builders are viable | Six simultaneous active turns, 1.24 GiB total RSS, no functional failure. |

Only the Codex provider was exercised. Nothing here covers Claude, Cursor, Grok or OpenCode
drivers.

### What t3code does not provide

No workspace-architect-builder tree; its sidebar is a flat pinned thread list. No tiling of
threads; split view exists only for terminals inside one thread. **No gate concept at all.**
Session status is `starting`/`running`/`ready`/`settled`, so a builder blocked on `plan-approval`
is indistinguishable from one that finished.

### Distribution reality

`@t3tools/contracts` is marked `"private": true` at version `0.0.33` and returns 404 from npm.
The only published artifact is the `t3` CLI at `0.0.35`. The newest tag in the clone is a nightly.
There is no stable published contract package to depend on. This changes the shape of the
mitigation and is handled in Constraints.

## Desired State

Codev keeps its protocol layer and stops owning process control. t3code runs the agent processes.
Codev ships a client of its own against t3code's server. Not a fork of their app, a second client
of the same contract.

### Three components

**1. `porch-driver`.** A headless library mapping porch's model onto t3code commands.

| Porch concept | t3code mechanism |
|---|---|
| Spawn a builder | `thread.create` with a worktree |
| Run a phase | `thread.turn.start`, settle on `activeTurnId: null` |
| Run phase checks | shell executed by porch, outside the thread, in its `worktreePath` |
| Interrupt | `thread.turn.interrupt` |
| Gate requested | `thread.meta.update` title, `thread.pin`, `thread.activity.append` |
| Builder finished | `thread.settle` |
| Architect session | `thread.create` rooted at the workspace, not a builder worktree |
| Human approves a gate | authenticated client session calls porch; porch writes `status.yaml` |
| Resume after restart | persist last applied sequence; resubscribe with `afterSequence` |

**2. `codev-client`.** A web client served by or beside t3code's server.

- A left sidebar tree: machine, then workspace, then architects, then that architect's builders.
- Every row carries live status: working, turning, blocked on a named gate, or settled.
- A tiled pane grid inside a workspace for four to six builders, plus a pane for the architect.
- **Architects are threads too.** One model for both: an architect is a t3code thread whose
  worktree is the workspace root rather than a builder worktree. Talking to an architect is
  `thread.turn.start` on its thread. This is what makes the architect reachable from an iPad,
  and it removes the last reason to keep a PTY.
- On a narrow viewport the grid pages rather than shrinks.
- Reachable over a tailnet from an iPad.
- Connected to more than one machine's server at once.

**3. Deletions**, only after parity: PTY manager, terminal session management, render gate,
mailbox, harness registry, v2 client, legacy dashboard.

### The authoritative data model

**Porch is authoritative for protocol state.** `status.yaml` holds phase, gates and their
content, and is written only by porch. t3code holds no protocol state.

**t3code is authoritative for session state.** Thread existence, `activeTurnId`, session status,
worktree path, sequence numbers.

The client joins them on a `threadId` that porch records in `status.yaml` at spawn. Titles, pins
and activity entries are **display projections** of porch state, never a source of truth. Where
the two disagree, porch wins and the client shows porch's value. A thread with no matching porch
record renders as unmanaged rather than being hidden.

### Relationship to #128

Spec 146 **absorbs** #128 and does not supersede it. #128's ruling stands: porch grows a
structured gate-request block carrying question, choices and consequences. Phases 1 and 2 of
#128, which build that record, are prerequisites of this spec. Phases 3 to 5 target the v2
client and are dropped, their intent moving to `codev-client`. Success criteria here require the
structured content, not a bare gate name.

### Gate approval

Approving from the UI is in scope, and the reasoning is worth stating because it reverses an
earlier non-goal.

`--a-human-explicitly-approved-this` was never a strong control. It is a string, and any agent
with shell access can type it. It works today because agents are told not to, not because they
cannot. A button in a client behind a single-use pairing token and a per-machine revocable
session is a *stronger* guarantee that a human acted, not a weaker one.

So the control moves from a flag to the session:

- `porch approve` grows an authenticated path that records **who** approved, from which client
  session, and when. The approval is written to `status.yaml` by porch as it is today.
- The existing flag stays for terminal use. It is not the security boundary and the spec stops
  describing it as one.
- An agent-held credential cannot approve. Approval requires a session minted by human pairing,
  and porch records the distinction.
- Every approval is auditable after the fact: session id, machine, timestamp, gate.

The UI shows the gate's structured question and choices from #128, and the human picks one.

### Extensions and adopters

`apps/vscode` and `apps/streamdeck` both reach terminal APIs directly and break when terminal
session management is deleted.

**Ruled: both are retired, not migrated.** The owner does not use the VS Code extension and has
never used the Stream Deck plugin. Migrating them would cost more than the client itself and
serve nobody. Retirement is explicit and lands *before* the deletion phase, so neither is
discovered broken after the fact. Recent Stream Deck work (specs 1463, 1465) is written off.

`codev-skeleton/` gains an optional t3code dependency. An adopter without a t3code server keeps
the existing behavior until the deletion phase, at which point running a server becomes a
documented install requirement.

## Goals

1. A human sees every machine, workspace, architect and builder, with live status, in one tree.
2. Four to six builders are watchable simultaneously on a large screen.
3. The same view works from an iPad over a tailnet, self-hosted, with no third-party account.
4. One client manages more than one machine.
5. Message delivery and interrupts become typed commands with acknowledgements, not keystrokes.
6. Net lines of Codev-owned code fall, counting `codev-client` as added.

## Non-Goals

- Approving a gate from an *unauthenticated* surface, or by any agent. Approval requires a human
  acting in an authenticated client session. See "Gate approval" below.
- Forking t3code.
- Enabling T3 Connect or any cloud relay.
- Replacing `afx` as a CLI.
- Migrating in-flight builders. Cutover is for newly spawned work.

## Solution Approaches

### Approach 1: headless provider SDKs, keep Tower

Replace PTY driving with each provider's own headless SDK. Codev already drives the Codex SDK and
the Claude Agent SDK inside `consult`, so the pattern is proven in-repo.

Kills the render gate and the mailbox's reason for existing. Keeps Tower, worktrees and the
harness registry. **Costs:** Codev writes and maintains one integration per provider, plus
remote access, mobile, multi-machine and tiling. Every provider that lacks a headless SDK is
unsupported. This is the largest amount of code to own.

### Approach 2: t3code for process control, keep the v2 client

Adopt t3code underneath, keep building v2 on top of it.

**Costs:** v2 has no tiling, no mobile and no remote access. Those are the requirements that
started this. Building them into v2 means writing the client work anyway while carrying two
event models. Rejected because it pays the integration cost without buying the UI.

### Approach 3: t3code plus a new Codev client — recommended

What this spec describes.

**Why:** the half Codev would otherwise write (process control, remote, mobile, multi-machine,
auth) exists and is proven working. The half Codev writes is a tree and a tile grid over an
event stream already demonstrated end to end.

**Costs, stated plainly:** a dependency on a pre-1.0 project whose contract package is
unpublished, a vendoring obligation, and a new client to build and maintain.

### Approach 4: vendor t3code's provider adapters only

Lift `apps/server/src/provider/` into Codev and leave the rest.

**Costs:** a permanent fork of the fastest-moving part of someone else's codebase, with none of
the remote, mobile or multi-machine benefit. Rejected.

## Constraints

- **Self-hosted only.** No Clerk, no relay, no account.
- **Vendor the contract.** `@t3tools/contracts` is unpublished, so Codev vendors the schema types
  from a pinned t3code commit into `packages/types`, with a documented refresh procedure and a
  test that fails when the vendored copy drifts from the pinned server. "Breaks become compile
  errors" is only true once this exists.
- **Pin the server by commit**, not by tag. Upgrades are deliberate.
- Gates and phase state live in `status.yaml`, written only by porch.
- Framework changes land in `codev/` and `codev-skeleton/` both.
- The client degrades honestly. An unreachable server never yields a blank or silently stale
  tree.

### Security

The server executes arbitrary agent shell in worktrees, so reaching it is equivalent to shell
access. A tailnet is transport, not an authentication model.

- Authentication uses t3code's pairing and session tokens. Pairing tokens are single-use with a
  bounded TTL and are never written to a repository, a log, or a shell history file.
- Per-machine credentials are stored separately and are individually revocable. Revoking one
  machine does not disturb another.
- All remote transport is HTTPS/WSS. Loopback-only binding is the default; exposing an interface
  is an explicit action.
- `npx t3 pair --tailscale` leaves a Tailscale Serve mapping that persists until
  `tailscale serve --https=443 off`. Teardown is documented and is part of the runbook.
- The client holds credentials for N servers, so it is an XSS target. No `dangerouslySetInnerHTML`
  on agent output, a restrictive CSP, and explicit origin rules.

### Message delivery semantics

The mailbox is replaced only if these hold, otherwise it stays:

- Messages to one builder are delivered in the order sent.
- A message sent while a turn is active is queued and delivered when the turn settles, never
  dropped and never interleaved.
- Every send returns an acknowledgement that means the server accepted it durably, not that the
  agent read it.
- Commands carry caller-generated idempotency keys so a retry after an ambiguous failure cannot
  double-send.
- With the server unreachable, a send fails loudly at the call site. It does not silently queue.

### Crash and recovery

- Every command carries a `commandId` generated by porch and persisted before dispatch, so a
  crash between dispatch and acknowledgement is recoverable without duplicating work.
- Porch persists the last applied thread sequence before acting on an event, so replay is
  at-least-once and each handler is idempotent.
- If `afterSequence` replay returns a snapshot instead of the requested range, porch treats it as
  a gap, reconciles from the snapshot, and logs it. It never assumes continuity.
- `status.yaml` advancement and thread state are reconciled at startup. Disagreement is reported,
  never auto-resolved.

## Assumptions

- Multi-day gate retention behaves like the proven 36-minute case. One reap plus one server
  restart was actually elapsed.
- Real Codev worktrees cost more disk than the 8-12 MiB measured against a seed repository.
- Contract churn is survivable. **Now measured, and it is high.** `orchestration.ts` has 89
  commits since 2026-02-07, against 2,812 commits repo-wide, so roughly 14 commits a month land
  on the single file this integration depends on most. That count is commits, not breaking
  changes; classifying them is still a pre-deletion gate. But it is enough to say the vendoring
  constraint and the drift test are load-bearing rather than precautionary, and that a pinned
  commit will go stale in weeks, not years.

## Success Criteria

- [ ] 1. `porch-driver` runs a complete BUGFIX protocol end to end on a t3code thread with no PTY
  involved: spawn, phases, checks between turns, a gate that pauses at least one hour, PR, merge.
- [ ] 2. Porch restarts mid-protocol, resubscribes with `afterSequence`, and loses no completion
  event.
- [ ] 3. The tree renders correct live status for every row, including a builder blocked on a gate
  showing #128's structured question and choices, not only a gate name.
- [ ] 4. Six builders tile at 1440x900 with every pane at least 400x300 CSS px, body text at 13px
  or larger, and each pane showing builder id, status, and the last three lines of output.
- [ ] 5. The same six page one-per-screen at 390px wide with no horizontal scroll.
- [ ] 6. An iPad on the tailnet reaches the client and drives a builder to completion.
- [ ] 7. One client shows two machines' workspaces in one tree, each independently live.
- [ ] 8. With one server stopped, its subtree is marked disconnected with a last-updated
  timestamp. Other machines stay live. Nothing renders blank and nothing renders stale without
  saying so.
- [ ] 9. `apps/vscode` and `apps/streamdeck` are retired, with their removal landed before the
  deletion phase.
- [ ] 9b. A human approves a real gate from the client, and porch records the approving session
  id, machine and timestamp in `status.yaml`.
- [ ] 9c. An agent-held credential is refused when it attempts the same approval.
- [ ] 10. At least two provider drivers pass criterion 1, not only Codex.
- [ ] 11. A 24-hour gate resumes with context. **Gates the deletion phase.**
- [ ] 12. Contract churn is measured and recorded. **Gates the deletion phase.**
- [ ] 13. PTY manager, render gate, mailbox, terminal session management, harness registry, v2
  client and legacy dashboard are deleted, and the suite is green without them.
- [ ] 14. Net Codev-owned line count is lower than the pre-migration baseline, recorded in the
  review.

## Test Scenarios

1. **Full protocol, no PTY.** BUGFIX start to merge on a thread; assert no PTY code path runs.
2. **Long gate.** A gate held past the reaper's threshold; resume retains context.
3. **Twenty-four hour gate.** The same, elapsed for real, before any deletion.
4. **Orchestrator restart.** Kill porch mid-phase, restart, resume by sequence, assert no gap.
5. **Crash between dispatch and acknowledgement.** Kill porch after dispatch; restart; assert the
   command is not applied twice.
6. **Replay returns a snapshot.** Force a gap; assert porch reconciles and logs rather than
   assuming continuity.
7. **Server unreachable.** Stop one server; its subtree marks disconnected with a timestamp;
   other machines stay live.
8. **Message ordering under load.** Ten messages during an active turn arrive in order after it
   settles.
9. **Duplicate send.** Retry with the same idempotency key; assert one delivery.
10. **Six-pane tiling.** Six live builders at 1440x900 against criterion 4's measurements.
11. **Narrow viewport.** The same six at 390px, paged, no horizontal scroll.
12. **Two machines.** Two servers, one client, both trees correct and independently live.
13. **Gate visibility.** A blocked builder is visually distinct from a settled one, with its
    structured question visible without navigation.
14. **Second provider.** Criterion 1 against a non-Codex driver.
15. **Credential revocation.** Revoke one machine's token; that subtree fails closed; others are
    unaffected.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| t3code makes a breaking contract change | High | High | Pin by commit; vendor the schema types with a drift test; upgrade deliberately |
| The contract package is never published | High | Medium | Already true. Vendoring is a constraint, not a contingency |
| t3code is abandoned | Medium | High | MIT, cloned locally, porch untouched. Worst case Codev keeps a pinned server it owns |
| Multi-day gates behave differently from 36 minutes | Medium | High | Criterion 11 gates deletion on a real 24-hour test |
| Deleting Tower loses something not yet identified | Medium | High | Criterion 9 forces the extensions into scope; deletion is a separate phase behind a green suite |
| A non-Codex driver behaves differently | Medium | High | Criterion 10 requires a second driver before deletion |
| Six panes is not enough | Medium | Low | Measured at six; test the real ceiling before promising more |
| Credential theft from the client | Low | High | Per-machine revocable tokens, CSP, no raw HTML injection of agent output |
| Real worktrees blow past measured disk figures | Low | Low | Measure against this repository, not a seed |

## Open Questions

**Resolved by the architect, recorded here:**

1. **Where `codev-client` lives: a separate app in the Codev repo, served beside the t3code
   server.** Not a sibling in their `apps/`. The churn measurement decides it: 89 commits to
   `orchestration.ts` in six months means living in their tree turns every upgrade into a merge
   conflict on someone else's release cadence. Beside it, Codev owns its own build, release and
   auth wiring, and pays only for the vendored types, which the drift test already covers.
2. **`apps/vscode` and `apps/streamdeck`: retired.** See Extensions and adopters.
3. **The architect is a thread.** See Desired State.

4. **`afx` stays, as a thin CLI over `porch-driver`.** Same commands, same flags, new engine.
   It is the one interface consistent across every repo the owner works in, and the afx skill
   documents it for both agents and humans. Replacing it would mean retraining every workflow to
   buy nothing. `afx spawn`, `send`, `status`, `interrupt`, `cleanup` and `dev` keep their
   contracts; what changes underneath is that `send` becomes a queued command with an
   acknowledgement instead of a keystroke into a screenshot.

5. **The coexistence window is defined below, in "Cutover and drain".**
6. If the architect is a thread, what happens to `afx send architect` and sibling-architect
   addressing? Likely a turn on the target architect's thread, but the multi-architect naming in
   #47 needs a mapping.

## Cutover and drain

This is ruled from the dependency shape, not chosen as a date.

**What the code says.** 33 non-test files reference the mailbox. The PTY manager reaches
`tower-routes.ts`, `tower-websocket.ts`, `tower-terminals.ts`, `tower-tunnel.ts` and
`session-log-sweep.ts`. `global.db` has a `terminal_sessions` table, and `builders` carries a
nullable `terminal_id` alongside `harness` and `model`, both added the same way by an earlier
migration. So a second nullable column is the established pattern here, not a new one.

That shape rules out a flag-day switch and rules in dual-write.

**Five steps, each independently revertible:**

1. **Add `thread_id` to `builders`, nullable.** Nothing reads it yet. Matches how `harness` and
   `model` were introduced. Old rows stay valid with no backfill.
2. **New spawns take the thread path.** `afx spawn` writes `thread_id` and no `terminal_id`.
   Existing builders keep running on PTY untouched. Both paths live simultaneously; a builder's
   path is a property of its row, never a global mode.
3. **Drain the builders.** The condition is checkable, not a guess: zero rows where
   `terminal_id IS NOT NULL AND thread_id IS NULL AND status != 'complete'`. `afx status` reports
   the count so the drain is visible. The longest protocol is SPIR, and spec 128 has taken more
   than two days start to present, so the realistic drain is measured in days, not hours. No
   in-flight builder is ever migrated across paths.
4. **Cut over the architects, explicitly.** This is the step that costs something and it must not
   be described as a drain. An architect session is long-lived; the `uiv2` architect that wrote
   this spec has been alive for days. Moving it to a thread means ending that conversation and
   starting a new one. There is no migration path for an in-flight conversation, so this is a
   deliberate act per workspace: save architect state with `/arch-save`, stop the PTY architect,
   start the thread-backed one, re-init from the saved state. Do one workspace first and live
   with it before doing the rest.
5. **Delete.** Only once steps 3 and 4 are complete for every workspace, and only behind success
   criteria 11 and 12. The `terminal_sessions` table and `terminal_id` column go last, in their
   own migration, after a release has shipped with them unused.

**What forces a rollback.** Any of: a drain that will not reach zero because a builder is wedged
on the thread path, an architect cutover that loses state the saved file did not capture, or a
provider driver that fails criterion 10. Rollback at steps 1 through 3 is reverting one nullable
column. After step 4 it is restoring an architect from `/arch-save` state, which is why step 4
comes late and one workspace at a time.

**The mailbox goes with step 5, not before.** Until then it stays live for PTY-backed builders,
and the thread path uses queued commands. Two delivery systems coexisting is the intended state
during the window, not a defect.

## References

- Issue #146, and the architect ruling on issue #128
- `codev/research/146-t3code-porch-execution-proof.md`: all three proofs (landing via PR #147)
- `/Users/chris/dev/t3code-spike/`: the first spike script and its raw log
- `/Users/chris/dev/t3code/packages/contracts/src/orchestration.ts`: the command and event contract
- `/Users/chris/dev/t3code/packages/contracts/src/git.ts`: worktree and PR contracts
- `/Users/chris/dev/t3code/docs/internals/t3-connect.md`: relay is opt-in
- `/Users/chris/dev/t3code/docs/user/remote-access.md`: tailnet pairing
- `packages/codev/src/agent-farm/servers/render-gate.ts`: the reason codes cited above
