# Specification: v2 server events — push-based status for the v2 hierarchy

- **Issue:** #52
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, rev. 2
- **Rev. 2 changes:** wire contract written out; status vocabulary reconciled with the
  existing `IDLE_WAITING_THRESHOLD_MS`; FR-31 reconciled rather than dropped; resume
  window and restart behaviour specified; template headings restored.

## Problem Statement

FR-4 requires every node in the v2 hierarchy to show live status, **pushed, never polled**. No server implementation exists.

Tower's only SSE emitter is `broadcastNotification` (`tower-server.ts:259`), payload `{ type, title, body, workspace? }` — a notification bus for the VS Code extension carrying no structured state. Today's dashboard closes the gap by polling: `POLL_INTERVAL_MS = 1000` (`apps/web/src/lib/constants.ts`) and 2500ms in `useOverview.ts`. That is the inefficiency v2 exists to remove, and it violates Part 5's target of **under 1 KB/s per environment idle**.

FR-41 (activity sparkline) and FR-42 (server-derived stalled) have no implementation and are explicitly server-side.

## Current State

| Piece | Where | Behaviour |
|---|---|---|
| `broadcastNotification` | `tower-server.ts:259` | Fans `{type,title,body,workspace?}` to all SSE clients |
| `GET /api/events` | `tower-routes.ts:192` | Only SSE route. `connected` frame, then notifications |
| SSE client cap | `tower-routes.ts:1425` | 503 + `Retry-After: 5` past capacity |
| SSE eviction | `tower-server.ts:283-297` | **Evicts every 4–6 min** (5 min base ± 1 min jitter, Bugfix #1124) |
| Reconnect directive | `tower-routes.ts:1443` | `retry: 5000` |
| Client auth pattern | `apps/web/src/hooks/useSSE.ts:8-12` | **`fetch` + `ReadableStream`, not `EventSource`** — `EventSource` cannot set headers, so it cannot carry `codev-tower-key` (GHSA-xvjp-7748-v88v) |
| Idle predicate | `packages/sdk/src/builder-helpers.ts` | `IDLE_WAITING_THRESHOLD_MS = 5 * 60 * 1000`; `isIdleWaiting` = silent past it, not gate-blocked, not completed |
| Last-output stamp | `tower-routes.ts:1139` | Overview already stamps `lastDataAt` |
| State of record | `~/.agent-farm/global.db` | `architect` and `builders` keyed by `workspace_path` |

## Desired State

A v2 client opens one stream, declares what it is looking at, and receives a correct picture of that scope without polling — including after the 4–6 minute eviction, a network drop, or an iOS backgrounding.

## The wire contract

This is the deliverable. D2 says the schema is the contract; here it is.

### Endpoint

```
GET /v2/events?scope=<scope>&since=<seq>
Header: codev-tower-key: <key>
Accept: text/event-stream
```

**Transport is SSE consumed via `fetch` + `ReadableStream`.** Not `EventSource`: it cannot set the auth header and will 401. This mirrors `useSSE.ts` exactly.

FR-32 eventually wants one multiplexed control socket per environment. That is a later spec and it **subsumes** this stream rather than discarding it: the frames below are the contract, and moving them onto a WebSocket changes the plumbing, not the schema. That is the point of D2.

### Frames

Every frame is `{ seq, type, ... }` with `seq` a monotonic integer per connection.

```
{ seq, type: "snapshot", resumed: false, scope, nodes: Node[], counts: Counts }
{ seq, type: "node",     node: Node }              // upsert
{ seq, type: "gone",     id: string }
{ seq, type: "counts",   counts: Counts }          // out-of-scope rollup
{ seq, type: "tick",     at: iso, buckets: { [builderId]: number } }
{ seq, type: "dark",     reason: string }          // this machine cannot be read
```

`snapshot` is **always** flagged as such and always carries `resumed`. A resume that cannot be honoured returns `snapshot` with `resumed: false`. **It never returns an empty delta list**, because "nothing changed" and "I could not tell you" must not be spelled the same way.

### Node

```
Node {
  id, kind: "workspace"|"architect"|"builder", parentId, name,
  status: Status,
  flags: { heldMail: boolean },
  lastDataAt: iso | null,
  buckets: number[]        // builders only, oldest first
}
```

### Status, with precedence

```
Status = "gate-waiting" | "stalled" | "running" | "idle" | "done" | "offline"
```

Computed server-side, once (D4). **Precedence, highest first:** `offline`, `gate-waiting`, `done`, `stalled`, `running`, `idle`. Clients render what they are told and never re-derive.

`heldMail` is a **flag, not a status**, because a builder can be running and have held mail at the same time. FR-4 lists it alongside statuses; that is a UI grouping, not an enum member.

### `stalled` is the existing predicate, not a new one

**`stalled` == `isIdleWaiting`**, reusing `IDLE_WAITING_THRESHOLD_MS` (5 minutes) and the predicate in `packages/sdk/src/builder-helpers.ts`.

The FRD mockup shows `NO OUTPUT 6 MIN`, which is an illustrative label rather than a specified threshold. Introducing a second threshold would create exactly the drift that constant's own comment exists to prevent:

> Co-locating both surfaces' threshold here prevents silent UI drift where one says "waiting" and the other says "active" for the same builder.

**One threshold, one predicate, one place.** If six minutes is later wanted, change the constant and every surface moves together.

### Buckets (FR-41)

Fixed **30-second** buckets, **20** retained, giving 10 minutes of trace.

One `tick` frame per bucket interval per connection. **Builders with zero output are absent from `buckets`**, and absence means zero. This bounds idle cost at one small frame per 30s regardless of builder count, which is the only shape that survives the idle test below.

The client advances the trace on `tick` and renders absent builders as zero. That is rendering an explicit signal, not deriving state, so it does not violate D4.

### Scope (FR-31), reconciled rather than deferred

FR-31 requires scoped subscriptions, not full-state broadcast. Rev. 1's full-hierarchy snapshot contradicted it silently.

`scope` is a list of workspace paths the client has open. The snapshot carries **full `Node` detail for in-scope nodes** and a **`Counts` rollup for everything else**. Deltas are emitted for in-scope nodes only; out-of-scope changes move counts.

This satisfies D1 (correct from the first frame) and FR-31 (scoped) together. Changing scope is a reconnect.

### Resume

Deltas are buffered in memory, bounded at **500 frames or 5 minutes, whichever comes first**.

- `since` within the buffer: deltas from `since+1`.
- `since` outside it: `snapshot` with `resumed: false`.
- **After a Tower restart the buffer is gone** (C2 forbids persisting it), so every resume returns `snapshot` with `resumed: false`. This is the case a client must not mistake for "nothing changed."

The existing SSE layer evicts every 4–6 minutes. If the v2 stream inherits that, **the iOS story is frequent reconnect, not a long-lived socket**, and the resume path is exercised constantly rather than being a rare edge. That is a feature: a rarely-exercised resume path is a broken one.

## Success Criteria

1. Snapshot on connect carries every in-scope node with status, and a counts rollup for the rest.
2. Spawning a builder emits a `node` frame to every connected in-scope client within **500ms**, no client timer involved.
3. Entering gate-waiting emits a `node` frame carrying that status.
4. A builder silent past `IDLE_WAITING_THRESHOLD_MS`, not gate-blocked and not completed, reports `stalled`.
5. Every in-scope builder carries `buckets` sufficient to render FR-41.
6. Reconnect with `since` either resumes from `since+1` or returns `snapshot` with `resumed: false`. Never an empty delta list.
7. Two clients on the same scope converge to identical state.
8. **Idle under 1 KB/s per connection measured with 20 silent builders in scope**, over 60 seconds.
9. Delta latency p95 under 200ms from state change to frame written.
10. An unreadable machine emits `dark`; it does not emit an empty snapshot.
11. `GET /api/events`, `broadcastNotification` and VS Code behaviour unchanged, proven by the existing suite passing untouched.
12. `git diff --stat` shows no modification to `tower-server.ts`, `pty-session.ts`, or any existing `tower-routes.ts` handler beyond the single mount block.

## Constraints

**C1 — Additive only.** New fork-owned `v2-*.ts` under `agent-farm/servers/`, mounted through one `if (url.pathname.startsWith('/v2/'))` block. Forbidden: modifying `broadcastNotification`, `handleSSEEvents`, `tower-server.ts`, `pty-session.ts`, or any existing handler. Spike 1 (#38) proved this shape for the terminal layer; spike 2 (#39) proved it for ingress.

**C2 — No state writes.** `global.db` is read through existing accessors. No schema, no writes. The resume buffer is memory-only and dies with the process.

**C3 — Per-machine degradation.** FR-15. A machine that cannot be read emits `dark`, not silence and not an empty snapshot.

**C4 — Separate SSE accounting.** The v2 stream keeps its own client cap rather than sharing the existing one. Sharing a limit across unrelated consumers is how the 6-connection problem happened; a v2 client must not starve a VS Code client.

## Assumptions

1. `lastDataAt` and byte counters are already public and sufficient for FR-41/42 without touching `pty-session.ts`. **Verified**: overview stamps `lastDataAt` at `tower-routes.ts:1139`.
2. `/v2/` is already covered by `isRequestAllowed` (`tower-routes.ts:256`) and is not in `isPublicRoute`, so it authenticates like every other route with no new auth path. **Verified.**
3. This spec is one Tower on one machine. Multi-machine pairing (FR-16) is a later spec, so "environment" here means **this Tower**.
4. Output volume can be sampled without intercepting terminal data.

## Solution Approaches

**A. Chosen — scoped snapshot then deltas over SSE.** Correct from the first frame, scoped per FR-31, bounded idle cost, reuses the proven `fetch`+stream auth pattern.

**B. Deltas only, plus a REST snapshot fetch.** Rejected. Creates a race between the fetch and the first delta. The reconciliation bug is subtle, silent, and lives for months.

**C. Extend `broadcastNotification` with structured types.** Rejected under C1. It is a hot upstream file and the VS Code extension depends on its current shape.

**D. WebSocket now, per FR-32.** Deferred, not rejected. The frames are the contract; moving them to a socket later is plumbing. Doing it now costs a second auth path and a second reconnect story before anything renders.

## Open Questions

1. Should `done` builders drop out of scope after a grace period, or stay until the client changes scope? Recommend staying; disappearing rows are worse than stale ones.
2. Does the VS Code extension eventually want this stream instead of `broadcastNotification`? Out of scope here, but if yes, C1's "never touch it" gets cheaper to revisit later.

## Test Scenarios

1. **Spawn latency.** Connect two clients, spawn a builder, assert both receive a `node` frame within 500ms with no timer in the client.
2. **Stalled transition.** Builder silent past `IDLE_WAITING_THRESHOLD_MS` transitions to `stalled`; a gate-blocked builder does not, proving precedence.
3. **Idle cost.** 20 silent in-scope builders, 60 seconds, measure bytes. Assert under 1 KB/s. This is the real idle case; zero builders is the easy one and does not test the tick rule.
4. **Resume inside the window.** Disconnect, reconnect with `since`, assert deltas from `since+1` and no snapshot.
5. **Resume outside the window.** Exceed the buffer, reconnect, assert `snapshot` with `resumed: false`.
6. **Tower restart.** Restart, reconnect with a valid `since`, assert `snapshot` with `resumed: false` rather than an empty delta list.
7. **Dark vs empty.** Make the state source unreadable, assert a `dark` frame rather than a snapshot with no nodes.
8. **Two-client convergence.** Drive 100 random state changes, assert both clients end identical.
9. **Scope isolation.** Change an out-of-scope workspace, assert a `counts` frame and no `node` frame.
10. **Non-regression.** Existing SSE suite passes untouched.

## Risks and Mitigation

| Risk | Mitigation |
|---|---|
| Idle cost scales with builder count | Absence-means-zero in `tick`; scenario 3 measures the real case |
| Resume path rarely exercised, so silently broken | 4–6 min eviction exercises it constantly; scenarios 4–6 cover it |
| A second stalled threshold drifts from the dashboard | Reuse `IDLE_WAITING_THRESHOLD_MS` and `isIdleWaiting`; do not define a new one |
| Someone reaches for `EventSource` and gets 401s | Stated on the contract, with the reason and the `useSSE.ts` precedent |
| Upstream merge conflict | One mount block; criterion 12 makes it falsifiable |
| v2 clients starve VS Code clients | C4, separate cap accounting |

## References

- FRD: `codev/research/codev-v2-ui-frd.md` rev. 5 — Option 0, FR-4, FR-15, FR-31, FR-32, FR-41, FR-42, Part 5
- Spike 1: `codev/experiments/38-multi-client-resize/` (#38)
- Spike 2: `codev/experiments/39-https-on-a-phone/` (#39)
- `packages/sdk/src/builder-helpers.ts` — `IDLE_WAITING_THRESHOLD_MS`, `isIdleWaiting`
- `apps/web/src/hooks/useSSE.ts` — why `fetch`+stream rather than `EventSource`
- `packages/codev/src/agent-farm/servers/tower-server.ts:259,283-297`
- `packages/codev/src/agent-farm/servers/tower-routes.ts:192,256,1139,1425,1443`
