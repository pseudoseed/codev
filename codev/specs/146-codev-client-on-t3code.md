# Spec 146 — A Codev client on a self-hosted t3code server

**Issue:** #146
**Status:** draft
**Author:** architect:uiv2

## Problem Statement

Codev's value is its protocol layer: porch's phase state machine, human gates, specs, plans and
reviews, CMAP consultation, and the architect/builder model. None of that exists anywhere else.

Everything underneath it — driving an agent process, knowing when a turn ended, delivering a
message, cleaning up a worktree — Codev implements by simulating a human at a terminal. It types
into a PTY, screenshots the screen, and guesses from pixel geometry whether a prompt is ready.
That approach cannot be made correct, and the bug record shows it: `no-region-end`,
`busy-indicator`, `no-composer-marker`, `geometry-mismatch`, `user-text`. In a single recent
session, six of eight issues worked were this layer (#47, #92, #93, #109, #126, #130) and two
were porch (#102, #113).

Separately, the surface a human uses to see what is happening is inadequate. The Tower dashboard
is unreliable. The v2 client renders a workspace tree but has no tiling, no mobile, and no remote
access. There is no way to watch four builders at once, and no way to check on them from an iPad.

## Current State

**What Codev owns today.** Tower (HTTP + WebSocket server on port 4100), a PTY manager, terminal
session management, a render gate that classifies a terminal screenshot as ready or not, a
durable mailbox with hold-and-retry semantics, worktree lifecycle in `.builders/<id>/`, a harness
registry with three entries, the v2 client, and the legacy dashboard.

**What that costs.** Message delivery is best-effort against a screen the gate may not be able to
read. Interrupting a builder means sending ESC and hoping. A builder that `cd`s out of its
worktree loses its identity (#47). Idle builders hold live PTYs and agent processes.

**t3code.** MIT, `pingdotgg/t3code`, cloned read-only at `/Users/chris/dev/t3code`. A server
runtime owning agent sessions, workspaces, and version control, with web, desktop and mobile
clients talking to it over one authenticated Effect RPC WebSocket. Five provider drivers (Codex,
Claude, Cursor, Grok, OpenCode) behind a common adapter. Event-sourced orchestration.

**What has been verified, not assumed.** Two spikes ran against a live server:

| Claim | Evidence |
|---|---|
| An external process can drive a session end to end | 262-line Node client: OAuth token exchange, worktree-backed thread, `thread.turn.start`, streamed events, `thread.turn.interrupt`. Prompt was `sleep 30; echo SHOULD_NOT_FINISH`; the marker never printed. A real process kill. |
| Porch's check-then-advance loop works | Turn 1 settled, an external shell wrote a file in the thread's own `worktreePath`, turn 2 read the new value back. |
| A gate can pause for hours | A real reap fired — `provider.session.reaped`, `idleDurationMs: 2094232`. After the reap *and* a server restart, an answer-free prompt recalled a filename that existed only in pre-reap conversation. |
| No completion event is lost on reconnect | Socket dropped mid-turn at sequence 45; `afterSequence: 45` replayed 46–54 matching the control connection exactly, completion included. |
| Fully self-hosted | `docs/internals/t3-connect.md`: "T3 Connect is disabled in a fresh clone." The Clerk relay is opt-in. |
| Reachable from an iPad without cloud | `npx t3 pair --tailscale`. |
| Six concurrent builders are viable | Six simultaneous active turns, 1.24 GiB total RSS, no functional failure. |

Full report: `codev/research/146-t3code-porch-execution-proof.md`.

**What t3code does not provide.** No workspace→architect→builder tree; its sidebar is a flat
pinned thread list. No tiling of threads; split view exists only for terminals inside one thread.
**No gate concept at all** — session status is `starting`/`running`/`ready`/`settled`, so a
builder blocked on `plan-approval` is indistinguishable from one that finished.

## Desired State

Codev keeps its protocol layer and stops owning process control. t3code becomes the execution
substrate. Codev ships a client of its own against t3code's server — not a fork of their app, a
second client of the same typed contract.

### Three components

**1. `porch-driver`** — a headless library that maps porch's model onto t3code commands.

| Porch concept | t3code mechanism |
|---|---|
| Spawn a builder | `thread.create` with a worktree |
| Run a phase | `thread.turn.start`, settle on `activeTurnId: null` |
| Run phase checks | shell executed by porch, outside the thread, in its `worktreePath` |
| Interrupt | `thread.turn.interrupt` |
| Gate requested | `thread.meta.update` title + `thread.pin` + `thread.activity.append` |
| Builder finished | `thread.settle` |
| Resume after restart | persist last applied sequence; resubscribe with `afterSequence` |

Porch remains the source of truth for phase and gate state in `status.yaml`. t3code holds no
protocol state; it is told what to display.

**2. `codev-client`** — a web client served by t3code's server or beside it.

- A left sidebar tree: **workspace → architects → that architect's builders**, one row each,
  carrying live status: working, turning, blocked on a named gate, or settled.
- A tiled pane grid inside a workspace, sized so four to six builders are legible at once, plus a
  dedicated pane for the architect.
- On a narrow viewport the grid becomes paged single panes rather than shrinking.
- Reachable over a tailnet from an iPad.
- Connected to more than one machine's server at once, with machine as the top level of the tree.

**3. Deletions.** Once the client is at parity: Tower's PTY manager, terminal session management,
the render gate, the mailbox, the harness registry, the v2 client, and the legacy dashboard.

### What stays exactly as it is

porch, all protocol definitions, gates and their human-approval requirement, specs/plans/reviews,
CMAP, `afx` as a CLI, issue-driven work, and `codev-skeleton/` for adopters.

## Goals

1. A human sees every workspace, architect and builder, with live status, in one tree.
2. Four to six builders are watchable simultaneously on a large screen.
3. The same view works from an iPad over a tailnet, self-hosted, no third-party account.
4. One client manages more than one machine.
5. Message delivery and interrupts become typed commands with acknowledgements, not keystrokes.
6. Codev deletes more code than it adds.

## Non-Goals

- Approving a gate from the UI. Approval keeps requiring `--a-human-explicitly-approved-this` at
  a terminal. The UI shows that a gate is waiting and what it asks; it does not grant it.
- Forking t3code. Codev is a client of a pinned server version.
- Enabling T3 Connect or any cloud relay.
- Replacing `afx` as a CLI.
- Migrating in-flight builders. The cutover is for newly spawned work.

## Constraints

- **Self-hosted only.** No Clerk, no relay, no account.
- **Pin the t3code server version.** Upgrades are deliberate, never ambient.
- Gates and phase state live in porch's `status.yaml`, written only by porch.
- Framework changes land in `codev/` and `codev-skeleton/` both.
- Codev must degrade honestly: if the t3code server is unreachable, the client says so rather
  than rendering an empty tree.

## Assumptions

- The t3code RPC contract is stable enough that a pinned version plus deliberate upgrades is
  cheaper than maintaining a PTY layer. **This is a judgment, not a measurement.**
- Multi-day gate retention behaves like the proven 36-minute case. Only one reap plus one server
  restart was actually elapsed.
- Real Codev worktrees cost more disk than the 8–12 MiB measured against a seed repository.

## Success Criteria

1. `porch-driver` runs a complete BUGFIX protocol end to end on a t3code thread — spawn, phases,
   checks between turns, a gate that pauses at least an hour, PR, merge — with no PTY involved.
2. Porch restarts mid-protocol, resubscribes with `afterSequence`, and loses no completion event.
3. The client renders the tree with correct live status for every row, including a builder
   blocked on a named gate.
4. Six builders tile simultaneously at 1440px and remain legible; the same content pages on a
   phone viewport.
5. An iPad on the tailnet reaches it and drives a builder.
6. One client shows two machines' workspaces in one tree.
7. Tower's PTY manager, render gate, and mailbox are deleted, and the suite is green without
   them.
8. A t3code server that is down produces a stated error, never a blank or stale tree.

## Test Scenarios

1. **Full protocol, no PTY** — BUGFIX start to merge on a thread; assert no PTY code path runs.
2. **Long gate** — a gate held past the reaper's threshold; resume retains context.
3. **Orchestrator restart** — kill porch mid-phase, restart, resume by sequence, assert no gap.
4. **Server unreachable** — stop the t3code server; client states it, tree does not go blank.
5. **Six-pane tiling** — six live builders at 1440px, all legible.
6. **Narrow viewport** — the same six page rather than shrink.
7. **Two machines** — two servers, one client, both trees correct and independently live.
8. **Gate visibility** — a blocked builder is visually distinct from a settled one at a glance.

## Risks and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| t3code makes a breaking contract change | High | Pin the server version; upgrade deliberately; the contract is typed, so breaks are compile errors, not silent |
| t3code is abandoned | High | MIT, cloned locally, and the porch layer is untouched by it — worst case Codev keeps a pinned server it owns |
| Multi-day gates behave differently from a 36-minute one | High | Prove a 24-hour gate before deleting anything |
| Deleting Tower loses something not yet identified | High | Delete only after the client reaches parity, in a separate phase, behind the passing suite |
| Six panes is not enough | Medium | Measured at six; test the real ceiling before promising more |
| Real worktrees blow past measured disk figures | Low | Measure against this repository, not a seed |

## Open Questions

1. Does the Codev client live inside t3code's `apps/` as a sibling, or as a separate app served
   beside it? A sibling gets their build and auth for free but couples upgrades.
2. Does `afx` become a thin CLI over `porch-driver`, or keep its own path?
3. Is the architect itself a t3code thread, or does it stay a plain terminal?

## References

- Issue #146, and the architect ruling recorded on issue #128
- `codev/research/146-t3code-porch-execution-proof.md` — all three proofs
- `/Users/chris/dev/t3code-spike/` — the first spike script and its raw log
- `/Users/chris/dev/t3code/packages/contracts/src/orchestration.ts` — the command and event contract
- `/Users/chris/dev/t3code/packages/contracts/src/git.ts` — worktree and PR contracts
- `/Users/chris/dev/t3code/docs/internals/t3-connect.md` — relay is opt-in
- `/Users/chris/dev/t3code/docs/user/remote-access.md` — tailnet pairing
