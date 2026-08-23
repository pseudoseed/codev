# Specification: v2 server events — push-based status for the v2 hierarchy

## Metadata

- **Issue:** #52
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, pending human approval
- **Depends on:** nothing. This is the first buildable unit of the v2 program.
- **Source:** `codev/research/codev-v2-ui-frd.md` (rev. 5), Option 0, FR-4, FR-41, FR-42

## Problem Statement

FR-4 requires every node in the v2 hierarchy — machine, workspace, architect, builder — to show live status, **updated by push and never by timer refetch**. No server implementation exists for that today.

Tower's only SSE emitter is `broadcastNotification` (`tower-server.ts:259`), whose payload is `{ type, title, body, workspace? }` — a notification bus built for the VS Code extension. It carries no structured state. The one SSE route, `GET /api/events` (`tower-routes.ts:192`), emits those notifications and a `connected` frame, and nothing else.

The current dashboard closes the gap by polling a full state snapshot every 1000ms/2500ms. That is the specific inefficiency v2 exists to remove, and Part 5 sets the target it violates: **under 1 KB/s per environment with nothing happening.**

Two more requirements have no implementation at all and are explicitly server-derived:

- **FR-41** — every builder carries an activity trace, a sparkline of output volume over time, so working and stalled are distinguishable at a glance without reading.
- **FR-42** — a builder producing no output for a threshold period is shown as **stalled**, distinct from idle and from gate-waiting. Derived server-side, not inferred by each client.

Every client-side story in v2 either depends on this or degrades to polling. It goes first.

## Current State

| Piece | Where | What it does |
|---|---|---|
| `broadcastNotification` | `tower-server.ts:259` | Fans `{type,title,body,workspace?}` to all SSE clients |
| `GET /api/events` | `tower-routes.ts:192` | The only SSE route. Emits `connected`, then notifications |
| SSE client cap | `tower-routes.ts:~1425` | Refuses with 503 and `Retry-After: 5` past capacity |
| Reconnect directive | `tower-routes.ts:~1443` | `retry: 5000`, added by Bugfix #1124 to damp reconnect churn |
| State of record | `~/.agent-farm/global.db` | Single user-global SQLite. `architect` and `builders` keyed by `workspace_path` |

## Desired State

A v2 client opens **one** stream per environment and receives a correct, current picture of the whole hierarchy without ever polling, including after a network drop or an iOS backgrounding.

## Goals

1. One typed event stream per environment carrying hierarchy state.
2. A snapshot-then-delta contract, so a client is correct from its first frame.
3. Server-derived `stalled` (FR-42) and output-volume buckets (FR-41).
4. Idle cost under the Part 5 target.
5. Correct resumption after a drop, without a full refetch.
6. Zero modification to any upstream file beyond one mount block.

## Non-Goals

- Any client rendering. No `apps/v2` work in this spec.
- Terminal data. PTY sockets stay exactly as they are; spike 1 (#38) settled that boundary.
- Multi-machine pairing and credentials (FR-16). A later spec.
- Replacing or altering `broadcastNotification`. The VS Code extension keeps working untouched.
- Gates UI, tiling, mobile.

## Constraints

### C1 — Additive only, and this governs every other decision

Per Part 0 of the FRD, this repository is a fork of an active upstream. Edits to hot upstream files are merge conflicts paid at every sync, forever.

- All logic in new fork-owned `v2-*.ts` modules under `agent-farm/servers/`.
- Mounted through **one** `if (url.pathname.startsWith('/v2/'))` block in `tower-routes.ts`'s existing path chain.
- **Forbidden:** modifying `broadcastNotification`, `handleSSEEvents`, `tower-server.ts`, `pty-session.ts`, or any existing route handler.

Spike 1 proved a v2 wrapper can solve a problem the upstream layer owns without editing it. Spike 2 proved a fork-owned process can front Tower entirely. This spec follows the same shape.

### C2 — Never hand-modify state

`global.db` is read through existing accessors. This spec adds no schema and writes no state.

### C3 — Degradation is per-environment

FR-15: one environment being unreachable degrades that subtree only. The stream must fail in a way a client can render as "this machine is dark" rather than as an empty hierarchy.

## Locked Structural Decisions

### D1 — Snapshot, then deltas, on one stream

The stream opens with a **full snapshot** of the hierarchy for that environment, then emits deltas. A client is never required to make a separate fetch to be correct.

Rejected: deltas-only with a companion REST fetch. It creates a race between the fetch and the first delta, and the reconciliation logic is the kind of thing that is wrong for months without anyone noticing.

### D2 — The schema is the contract, not the transport

Per Part 6 Q3, on which both FRD reviewers converged independently: the library worth having is the schema, not the transport. Every frame is validated against a declared schema at both ends. No tRPC, Socket.IO, Convex, Zero, ElectricSQL or Yjs.

### D3 — Every frame carries a monotonic sequence number

A reconnecting client sends its last sequence number. The server either resumes from there or answers with a fresh snapshot and says so explicitly.

**A client must be able to tell "nothing changed" from "I could not tell you."** Those must not be spelled the same way. A resume that cannot be honoured returns a snapshot flagged as a snapshot, never an empty delta list.

### D4 — `stalled` is computed once, on the server

FR-42. One definition, one place. Clients render what they are told and never re-derive it from timestamps, because two clients deriving it independently will disagree and the disagreement will be blamed on the UI.

### D5 — Output volume ships as pre-bucketed counts

FR-41's sparkline needs volume over time, not raw output. The server emits fixed-width buckets. Raw terminal bytes never enter this stream; that is what the PTY sockets are for.

## Success Criteria

### Functional

1. A client connecting to a v2 event stream receives a snapshot containing every machine, workspace, architect and builder visible to that environment, with the status of each.
2. Spawning a builder produces a delta on every connected client within 500ms, with no client-side timer involved.
3. A builder entering a gate-waiting state produces a delta carrying that state.
4. A builder producing no output for the stalled threshold is reported as `stalled`, distinct from `idle` and from `gate-waiting`.
5. Every builder in a snapshot carries output-volume buckets sufficient to render FR-41's sparkline.
6. A client that disconnects and reconnects with a sequence number either resumes cleanly or receives a snapshot **explicitly flagged as a snapshot**.
7. Two clients connected to the same environment see identical state.

### Non-functional

8. **Idle cost under 1 KB/s per environment** with nothing happening, measured over 60 seconds with no builders active. This is Part 5's target and it is the number that decides whether this was worth building.
9. Delta latency p95 under 200ms from state change to frame written.
10. An unreachable or erroring environment does not block, slow, or error any other environment's stream.

### Non-regression

11. `GET /api/events`, `broadcastNotification`, and the VS Code extension's behaviour are byte-for-byte unchanged. Proven by the existing test suite passing untouched.
12. `git diff --stat` shows **no** modification to `tower-server.ts`, `pty-session.ts`, or any existing handler in `tower-routes.ts` beyond the single mount block.

## Security Considerations

- The stream authenticates with the same mechanism as existing Tower routes. This spec introduces no new auth path, and FR-16's pairing flow is a later spec.
- **The stream carries state, never terminal content and never secrets.** Builder names, phases and statuses only.
- Tower currently runs in `BRIDGE_MODE` bound to `0.0.0.0` with the shared key travelling in cleartext over plain HTTP, per its own startup warning. This spec does not worsen that and does not fix it. Noted because a v2 stream is one more thing on that wire.
- Spike 2 (#39) established that Tower is never publicly routed. Nothing here assumes otherwise.

## Open Questions

1. **Stalled threshold.** The FRD's mockup shows `NO OUTPUT 6 MIN`. Is six minutes the default, and is it configurable per workspace? Recommend six minutes, fixed, until someone complains.
2. **Bucket width and history depth for FR-41.** How many buckets does a sparkline need to be worth the bytes? Recommend deciding against the mockup's rendered width rather than in the abstract.
3. **Does the stream reuse the existing SSE client cap accounting, or hold its own?** Reusing risks a v2 client starving a VS Code client. Recommend separate accounting, since shared limits across unrelated consumers is how the 6-connection problem happened the first time.

## What This Unlocks

The v2 client shell, which is the next spec. Nothing in `apps/v2` can render live state until this exists, and the alternative is that v2 ships polling and reproduces the problem it was built to solve.
