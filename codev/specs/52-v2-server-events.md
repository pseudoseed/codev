# Specification: v2 server events — push-based status for the v2 hierarchy

- **Issue:** #52
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, rev. 10 — **ready for human review**
- **Rev. 10 changes:** empty in-window resume given an explicit frame; `heldMail` joined to
  the mailbox table; workspace-active predicate named; scenario 9j softened and `stalled`
  exempted from the delta-latency criterion, which never applied to a timer-driven
  transition.
- **Rev. 9 changes:** `node` upsert emission rule written, which is what stops `lastDataAt`
  churn from flooding the resume buffer; parent `gone` now reparents and cascades; builder
  id moved to the worktree directory name so it is stable from creation.
- **Rev. 8 changes:** `snapshot.seq` defined as the current cursor rather than a new frame
  in the buffer; `builder_id` in the id scheme pinned to `builders.id` with a stated
  fallback.
- **Rev. 7 changes:** deleted a stale rev.-2 block that still said `stalled == isIdleWaiting`
  and contradicted rev. 6's table; `gone` and `offline` separated by a single rule that
  applies to all three node kinds; architect nodes given a source that can actually produce
  `offline`; `tick` corrected from per-connection to per-scope.
- **Rev. 6 changes:** `idle` dropped as uncomputable; `stalled` defined against the
  threshold constant directly rather than via `isIdleWaiting`, closing a hole where a
  completed builder matched no status; the source of `offline` named precisely
  (`getOverview` without `activeBuilderRoleIds`); `parentId` given an assignment rule.
- **Rev. 5 changes:** the eviction self-contradiction removed; `done` dropped because no
  field on the wire carries it; every remaining `Status` defined against a real
  `OverviewBuilder` field and made mutually exclusive by construction; `counts` emission
  rule fixed so in-scope changes update rollups; `gone` given an emission rule; `buckets`
  confined to `snapshot` so `tick` is the only thing that advances a sparkline.
- **Rev. 4 changes:** builder ids qualified by workspace, because `builders` is keyed
  `PRIMARY KEY (workspace_path, id)` and the unqualified form collides across the spec's
  own two-workspace example; `since` bound to a `streamId` so a scope change cannot
  replay the wrong deltas; `dark` given a target.
- **Rev. 3 changes:** `seq` made a per-scope process-wide cursor, because a per-connection
  counter cannot support `since` resume at all; every `Status` value defined as a predicate
  for all three node kinds; `done` moved above `offline` so it stays reachable; `Counts`,
  the id scheme, `scope` encoding, invalid-parameter handling, the v2 cap and the v2
  eviction interval all written out; bucket unit named.

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
GET /v2/events?scope=<scope>[&since=<seq>&stream=<streamId>]
Header: codev-tower-key: <key>
Accept: text/event-stream
```

`since` and `stream` are resume parameters and travel together. Neither is valid alone.

### `snapshot` and the cursor

**`snapshot.seq` is the current value of the scope's cursor. It does not increment it, and the snapshot is never written into the delta buffer.**

A snapshot is a statement about the state *at* a cursor position, not an event that happened *at* one. If it consumed a sequence number, two clients connecting at different moments would receive different cursor values for identical state, and a client resuming from a snapshot's `seq` would skip the first real delta after it. If it entered the buffer, a resuming client would be served a full snapshot as though it were a delta.

A client that receives `snapshot` with `seq: N` and later resumes with `since: N` must receive every delta from `N+1`, with none skipped and none replayed.

### The empty resume

A resume that is honoured but has **no deltas to send** must still say so. `resumed` is that frame: it carries `from`, the cursor the server resumed at, and is emitted before any deltas — or alone, when nothing changed.

Without it, a successful resume with an idle scope is byte-identical to a connection that opened and hung. The client cannot distinguish "you are up to date" from "I have not answered you yet," and the two demand opposite responses. `resumed` carries the same `seq` as the frame it resumed from, so it does not advance the cursor.

**Transport is SSE consumed via `fetch` + `ReadableStream`.** Not `EventSource`: it cannot set the auth header and will 401. This mirrors `useSSE.ts` exactly.

FR-32 eventually wants one multiplexed control socket per environment. That is a later spec and it **subsumes** this stream rather than discarding it: the frames below are the contract, and moving them onto a WebSocket changes the plumbing, not the schema. That is the point of D2.

### Frames

Every frame is `{ seq, type, ... }`.

**`seq` is a per-scope cursor held by the Tower process, not a per-connection counter, and it is only meaningful together with the `streamId` that identifies the scope it counts.** Rev. 2 said per-connection, which cannot work: after an eviction the old connection is gone and the server has no way to know which sequence space a client's `since` belongs to. One cursor per scope, shared by every connection watching that scope, is what makes `since` meaningful. It resets only when Tower restarts, which is exactly the case that returns a flagged snapshot.

```
{ seq, type: "snapshot", streamId, resumed: false, scope, nodes: Node[], counts: Counts }
{ seq, type: "node",     node: Node }              // upsert
{ seq, type: "gone",     id: string }
{ seq, type: "counts",   counts: Counts }          // whenever any count changes
{ seq, type: "tick",     at: iso, buckets: { [builderId]: number } }
{ seq, type: "dark",     id: string, reason: string }   // this scope path cannot be read
{ seq, type: "resumed",  from: number }                // in-window resume honoured
```

`snapshot` is **always** flagged as such and always carries `resumed`. A resume that cannot be honoured returns `snapshot` with `resumed: false`. **It never returns an empty delta list**, because "nothing changed" and "I could not tell you" must not be spelled the same way.

### Node

```
Node {
  id: string,              // see id scheme below
  kind: "workspace" | "architect" | "builder",
  parentId: string | null, // null for workspace
  name: string,
  status: Status,
  flags: { heldMail: boolean },
  lastDataAt: iso | null,
  buckets?: number[]       // builders only, oldest first, 20 entries.
                           // PRESENT ONLY IN `snapshot`. Never on a `node` upsert.
}

Counts {
  workspaces: number,
  builders: { total: number, byStatus: { [Status]: number } },
  gateWaiting: number      // hoisted: FR-43 needs it without opening the scope
}
```

### Id scheme

Ids must be stable across reconnects, or `gone` frames cannot be matched to anything.

```
workspace:<workspace_path>
architect:<workspace_path>#<architect_id>
builder:<workspace_path>#<builder_id>
```

**`builder_id` is the worktree directory name** — the basename under `.builders/`, for example `experiment-39`.

Rev. 8 said `builders.id` with a worktree-name fallback. **That is unstable**: a builder is discoverable from its worktree the moment it is created, but its `builders` row appears slightly later, so the id would flip mid-flight and every connected client would see one builder become two. Fixing that with a `gone` plus `node` pair is possible and worse — it makes a routine spawn look like a deletion.

The worktree name is the only identifier that exists for the whole life of the node, is what `discoverBuilders` already keys on, and is unique within a workspace because it is a directory name. Qualified by `workspace_path` it is globally unique.

It is **not** `OverviewBuilder.roleId`, which is the basename lowercased and **nullable** for soft-mode builders whose worktree does not match a protocol pattern — a null there would collapse every such builder onto one id. It is also not `builders.id`, which is a different string (`builder-experiment-39` for worktree `experiment-39`) and arrives later.

**`architect_id` is `architect.id`** — the `id TEXT` column of the `architect` table, which is the architect's name (`main`, `uiv2`).

Getting this wrong does not fail loudly. It produces `gone` frames that match nothing and builders that overwrite each other, both of which surface as a confusing tree rather than an error.

**Every id is qualified by `workspace_path`, builders included.** Rev. 3 used a bare `builder:<builder_id>` on the assumption that builder ids are globally unique. They are not: `builders` is declared `PRIMARY KEY (workspace_path, id)` (`db/schema.ts:46`), so the id is unique only within a workspace. Two workspaces each running `experiment-39` would collide, and the scope example in this very spec is a two-workspace one. The collision would have surfaced as builders overwriting each other in the tree, blamed on the client.

The same qualification applies to `tick` bucket keys, which are node ids and not bare builder ids.

These remain the natural keys already in `global.db`. No new identifier is minted, so nothing has to be persisted to keep them stable.

### Status, with precedence

```
Status = "gate-waiting" | "stalled" | "running" | "offline"
```

Computed server-side, once (D4). Clients render what they are told and never re-derive.

**Evaluated in order; first match wins; the list is exhaustive and every input matches exactly one.**

### The source, named precisely

`getOverview(workspaceRoot)` (`overview.ts:862`), **called without `activeBuilderRoleIds`**.

That argument is what filters the payload down to live sessions. `tower-routes.ts:1137` passes it; **this stream must not.** Called without it, `discoverBuilders` returns every builder present in `.builders/`, live or not, which is what makes `offline` a reachable state at all. Rev. 5 named the overview payload as the source without noticing the call site it copied filters out exactly the builders it wanted to describe.

Liveness is then determined the same way `tower-routes.ts:1149-1157` does it: a builder is **live** iff its `roleId` resolves to a session in the terminal registry.

### Every value, against a real field

**Builder** (`kind: "builder"`), in order:

| # | Status | Predicate |
|---|---|---|
| 1 | `gate-waiting` | `blockedGate !== null`. Uses `blockedGate`, not the display-only `blocked` |
| 2 | `offline` | no live session for `roleId`. `lastDataAt` is `null` here by construction |
| 3 | `stalled` | live session and `now - lastDataAt > IDLE_WAITING_THRESHOLD_MS` |
| 4 | `running` | live session and `now - lastDataAt <= IDLE_WAITING_THRESHOLD_MS` |

Rows 2 to 4 partition every non-gated builder: either there is a session or there is not, and if there is, `lastDataAt` is either past the threshold or it is not. Nothing falls through.

### Why `stalled` reuses the constant and not the predicate

Rev. 5 defined `stalled` as `isIdleWaiting(builder)`. That predicate additionally excludes completed builders, so a completed builder with a live session and a stale `lastDataAt` returned `false` for `stalled` and also failed `running`'s freshness test — **matching no status at all**, in direct violation of criterion 4b.

`stalled` now tests the threshold directly. `IDLE_WAITING_THRESHOLD_MS` remains the single source of truth, which was the point of reusing it; the predicate carried extra conditions that belong to a different question.

### Why there is no `idle`

Rev. 5 defined `idle` as a live session with `lastDataAt === null`. **That is unreachable.** `PtySession` initialises `_lastDataAt = Date.now()` at construction (`pty-session.ts:155`), and `tower-routes.ts:1156` only stamps `lastDataAt` for builders that have a live session. So a live builder always has a non-null `lastDataAt`, and a builder without one always has no session — which is `offline`.

There is genuinely no way on the current wire to distinguish "attached but has never spoken" from "attached and just spoke." Both look identical. Rather than define a status that can never fire, `idle`'s useful meaning is carried by `stalled`: a builder that is attached and silent.

### Why there is no `done`

Nothing on the wire carries completion. `phase` is the display sub-phase, `protocolPhase`'s `verify` is a phase a builder is *in* rather than a statement it finished, and `global.db` has no completion column.

**A finished builder reads `offline`** once its session ends, and leaves the tree via `gone` when its worktree is removed by `afx cleanup`. The cost is stated rather than hidden: **a completed builder and a crashed builder look identical.** Open question 3.

**Architect** (`kind: "architect"`): `running` with a live session, `offline` without. `gate-waiting` and `stalled` are never emitted for this kind.

**Source:** the `architect` table in `global.db`, scoped by `workspace_path` — **not** `liveArchitects(entry, terminalManager)` (`tower-routes.ts:1163`). That helper returns only live architects, exactly as its name says, so an architect that exits would vanish from the payload and `offline` would be unreachable for this kind, in the same way passing `activeBuilderRoleIds` breaks it for builders.

The table row persists past the session. Liveness is resolved from the terminal registry via the row's `terminal_id`, the same way builder liveness is resolved from `roleId`.

**Workspace** (`kind: "workspace"`): `running` when the workspace has **at least one terminal**, `offline` when it has none. That is Tower's own definition of active (`tower-instances.ts:297`: `const isActive = terminals.length > 0`), reused rather than restated, so the stream and the rest of Tower cannot disagree about whether a workspace is up.

**FR-4's `needs-attention` is `stalled`.** It is not a fifth value; FR-4 names a UI concept and `stalled` is its server-side spelling.

### `parentId`

FR-3 requires a builder to appear under the architect that spawned it, and under its workspace. `spawnedByArchitect` is nullable, so the rule must cover that:

| Node | `parentId` |
|---|---|
| workspace | `null` |
| architect | its workspace id |
| builder, `spawnedByArchitect` set and that architect is in scope | that architect's id |
| builder, `spawnedByArchitect` null or naming an architect not in scope | its workspace id |

**A builder never dangles.** Falling back to the workspace keeps the tree connected for legacy rows, soft-mode builders, and any case where the spawning architect has exited. A client rendering an orphan is worse than one rendering a builder a tier higher than ideal.

`heldMail` is a **flag, not a status**, because a builder can be running and have held mail at the same time. FR-4 lists it alongside statuses; that is a UI grouping, not an enum member.

**Source:** the `mailbox` table in `global.db`. `flags.heldMail` is true iff a row exists with `workspace_path` matching the node's workspace, `to_agent` matching the node's agent identity, `status = 'held'`, and the row currently deliverable — `not_before IS NULL OR not_before <= now`.

The `not_before` clause matters: a delayed send that is not yet due is held in the table but is not waiting on anyone, and flagging it would show a builder as needing attention before it does. `to_agent` is the right join key rather than `terminal_id`, which the schema itself marks as a last-known hint and not the identity, and which is null for a builder between respawns.

### On the threshold

`IDLE_WAITING_THRESHOLD_MS` (5 minutes, `packages/sdk/src/builder-helpers.ts`) is the single source. The FRD mockup's `NO OUTPUT 6 MIN` is an illustrative label, not a specified threshold, and introducing a second one would create exactly the drift that constant's own comment exists to prevent:

> Co-locating both surfaces' threshold here prevents silent UI drift where one says "waiting" and the other says "active" for the same builder.

**One threshold, one place.** If six minutes is later wanted, change the constant and every surface moves together. Note that `stalled` reuses the *constant* and not the `isIdleWaiting` predicate, for the reason given above.

### Buckets (FR-41)

Fixed **30-second** buckets, **20** retained, giving 10 minutes of trace.

**The unit is the delta in `PtySession.bytesWritten`** (`pty-session.ts:783`) over the bucket window. It is already public, already monotone, and reading it touches no forbidden file. Naming the unit is not pedantry: two clients cannot converge on criterion 7 if each is free to interpret the number differently.

One `tick` frame per bucket interval **per scope**, fanned to every connection watching that scope. Per-connection ticks would give each connection its own frame ordering against a cursor that is per-scope, and two clients on one scope would then disagree about which bucket a `seq` lands in. **Builders with zero output are absent from `buckets`**, and absence means zero. This bounds idle cost at one small frame per 30s regardless of builder count, which is the only shape that survives the idle test below.

The client advances the trace on `tick` and renders absent builders as zero. That is rendering an explicit signal, not deriving state, so it does not violate D4.

**`buckets` appears only in `snapshot`; `tick` is the sole thing that advances a sparkline afterwards.** Rev. 4 put `buckets` on `Node`, which meant every `node` upsert also carried a trace — so a client that received an upsert between ticks would advance its sparkline differently from one that did not, and criterion 7 would fail intermittently. Two writers to one piece of state is one too many.

### Scope (FR-31), reconciled rather than deferred

FR-31 requires scoped subscriptions, not full-state broadcast. Rev. 1's full-hierarchy snapshot contradicted it silently.

**`counts` covers the whole hierarchy, in scope and out.** Rev. 4 described it as an out-of-scope rollup, which leaves the rollup stale whenever an in-scope builder spawns or enters a gate — and two clients with different scopes would then disagree about `gateWaiting`, breaking criterion 7. A `counts` frame is emitted whenever any count changes, whatever the scope of the node that caused it.

### When a `node` upsert is emitted

Without this rule the stream floods. `lastDataAt` changes on **every DATA frame** from every builder, so an upsert per change would exhaust the 500-frame resume buffer in seconds and make in-window resume unreachable in practice.

**A `node` frame is emitted only when one of these changes:**

| Field | Emits |
|---|---|
| `status` | yes |
| `flags.heldMail` | yes |
| `parentId` | yes |
| `name` | yes |
| node first appears | yes |
| `lastDataAt` | **no**, on its own |
| `buckets` | **no**, never on an upsert |

`lastDataAt` rides along on whatever frame is being sent anyway — the `snapshot`, or a `node` frame triggered by one of the fields above. It is a timestamp for display, not an event. A client's `lastDataAt` may therefore be stale between status changes, which is correct: nothing renders off it that `status` does not already say.

**`flags.heldMail` must be wired to the mailbox**, not left to fall out of a status change. Held mail is a state a client acts on, and rev. 8 declared the flag without ever saying what makes it move.

### `gone` versus `offline`, one rule for all three kinds

These two were tangled in rev. 6: it said a workspace deactivating or an architect exiting fires `gone`, while also giving both kinds an `offline` status. Both cannot be true, and as written `offline` was unreachable for anything but a builder.

**The rule: liveness never fires `gone`. Only the disappearance of the underlying record does.**

| Event | Frame |
|---|---|
| Session ends, architect exits, workspace deactivates | `node` upsert with `status: "offline"` |
| Builder worktree removed (`afx cleanup`) | `gone` |
| Architect row deleted from `global.db` | `gone` |
| Workspace unregistered from Tower | `gone` |

A node that still exists but has nothing attached is `offline`. A node that no longer exists is `gone`. This is what makes `offline` reachable for every kind, and it gives `gone` exactly one meaning.

### A parent going `gone` must not orphan its children

`gone` on an architect or a workspace is not a leaf event. Rev. 8 defined the frame and left the children dangling, which contradicts the no-dangle rule stated under `parentId` and would have failed its own scenario 9g.

**Architect `gone`:** before the `gone` frame, emit a `node` upsert for **every in-scope builder whose `parentId` was that architect**, reparenting it to its workspace. This is the same fallback the `parentId` table already specifies for a null `spawnedByArchitect`, applied when the architect disappears rather than when it was never recorded. Builders survive their architect; that is the normal case after an architect exits.

**Workspace `gone`:** a workspace has no parent to reparent to, so this cascades. Emit `gone` for every in-scope architect and builder under it, children first, then the workspace itself. Children-first ordering means a client applying frames in order never holds a node whose parent has already vanished.

**Ordering is part of the contract, not an implementation detail.** A client must be able to apply frames in `seq` order and never observe an orphan at any point.

Emitted for **in-scope** nodes only; out-of-scope disappearances move `counts` instead.

Without this rule and with no eviction to paper over it, a cleaned-up builder would sit in the tree forever on every connected client. Rev. 4 declared `gone` in the frame list and never said when it fires.

`scope` is a comma-separated list of URL-encoded workspace paths, for example
`?scope=%2FUsers%2Fchris%2Fdev%2Fcodev-1455,%2FUsers%2Fchris%2Fdev%2Fpseudoapps`. The snapshot carries **full `Node` detail for in-scope nodes** and a **`Counts` rollup for everything else**. Deltas are emitted for in-scope nodes only; out-of-scope changes move counts.

This satisfies D1 (correct from the first frame) and FR-31 (scoped) together. Changing scope is a reconnect.

### Invalid and missing parameters

Each case gets its own answer, because a request that could not be honoured must never be spelled the same way as one that was.

| Case | Response |
|---|---|
| `scope` missing | 400. There is no safe default; a silent full-hierarchy subscription would violate FR-31 invisibly |
| `scope` names an unknown path | 200, stream opens, that path gets a `dark` frame carrying **its own id** and a reason. Other in-scope paths are unaffected (C3) |
| `since` malformed | 400 |
| `since` valid but outside the buffer | 200, `snapshot` with `resumed: false` |
| `since` from a previous Tower process | 200, `snapshot` with `resumed: false` |

### v2 capacity and eviction, which are not inherited

The 4–6 minute eviction lives on `sseClients` in `tower-server.ts:283-308`, and C1/C4 forbid sharing that list. **The v2 stream therefore does not inherit any of it and must state its own:**

- **Cap: 50 concurrent v2 clients**, accounted separately from the existing `SSE_MAX_CLIENTS = 200` (`tower-server.ts:364`). Over cap: 503 with `Retry-After: 5`, matching the existing route's shape.
- **Eviction: none.** v2 connections are long-lived and are closed by the client or the network, not by a server timer.

Rev. 2 said the resume path would be "exercised constantly" by inherited eviction. That was wrong twice over: the eviction does not apply, and designing a correctness mechanism to be tested by accident is not a plan. **Scenarios 4 to 6 are what exercise resume.**

### Resume

Deltas are buffered in memory per scope, bounded at **500 frames or 5 minutes, whichever comes first**.

**`since` is meaningless without the `streamId` it belongs to.** The server mints a `streamId` per scope per process and returns it on every `snapshot`. A client resumes by sending both. This closes a hole rev. 3 left open: a per-scope counter with no scope binding lets a client that changed scope send a `since` that is a valid integer in a *different* sequence space, and be served deltas describing nodes it is not watching. The corruption would be silent and would look like a client bug.

| Case | Response |
|---|---|
| No `since` (first connect) | `snapshot`, `resumed: false`, with a fresh `streamId` |
| `since` + matching `streamId`, inside the buffer, deltas exist | `resumed` frame, then deltas from `since+1` |
| `since` + matching `streamId`, inside the buffer, **nothing changed** | `resumed` frame and nothing else |
| `since` + matching `streamId`, outside the buffer | `snapshot`, `resumed: false`, same `streamId` |
| `since` + `streamId` from a different scope | `snapshot`, `resumed: false`, new `streamId` |
| `since` + `streamId` from a previous Tower process | `snapshot`, `resumed: false`, new `streamId` |
| `since` without `stream`, or `stream` without `since` | 400 |

**After a Tower restart every buffer and every `streamId` is gone** (C2 forbids persisting them), so every resume returns a flagged snapshot. This is the case a client must not mistake for "nothing changed."

The v2 stream does not evict; see **v2 capacity and eviction** below. Rev. 2 argued that inherited eviction would exercise the resume path for free. That was wrong on both counts — the eviction lives on a list C4 forbids sharing, and a correctness mechanism tested by accident is not tested. Scenarios 4 to 6 are what exercise resume.

## Success Criteria

1. Snapshot on connect carries every in-scope node with status, and a counts rollup for the rest.
2. Spawning a builder emits a `node` frame to every connected in-scope client within **500ms**, no client timer involved.
3. Entering gate-waiting emits a `node` frame carrying that status.
4. A builder with a live session silent past `IDLE_WAITING_THRESHOLD_MS` reports `stalled`. A gate-blocked builder silent for the same period reports `gate-waiting`, proving evaluation order.
4b. **Every builder resolves to exactly one status.** Exercised against the cases that broke earlier revisions: completed-and-live-and-stale, live-and-never-spoken, worktree-present-with-no-session, and gate-blocked-while-stale. No input produces two matches or none.
5. Every in-scope builder carries `buckets` sufficient to render FR-41.
6. Reconnect with `since` either resumes from `since+1` or returns `snapshot` with `resumed: false`. Never an empty delta list.
6b. A client that snapshots at `seq: N`, then resumes with `since: N`, receives every delta from `N+1` with none skipped and none replayed.
6c. A resume honoured against an unchanged scope receives a `resumed` frame and nothing else. It is never silent. Two clients snapshotting at different moments against unchanged state receive the same `seq`.
7. Two clients on the same scope converge to identical state.
8. **Idle under 1 KB/s per connection measured with 20 silent builders in scope**, over 60 seconds.
8b. **Under 1 KB/s with 20 builders producing continuous output and no status changes.** Output volume must not drive frame volume; only `tick` carries it.
9. Delta latency p95 under 200ms from state change to frame written, **for event-driven transitions only**.

   **`stalled` is exempt.** It is not triggered by an event; it is the absence of one, so its latency is bounded by how often the server re-evaluates the threshold rather than by how fast it reacts. Re-evaluation happens on the same 30-second cadence as `tick`, which puts worst-case detection at `IDLE_WAITING_THRESHOLD_MS + 30s`. Holding a timer-driven transition to an event-driven latency target would either fail honestly or force a busy poll to satisfy a number that measures nothing.
10. An unreadable scope path emits `dark` **naming that path**, while the rest of the scope keeps streaming. It does not emit an empty snapshot, and a multi-path scope can always tell which path failed.
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
4. Output volume can be sampled from `PtySession.bytesWritten` without intercepting terminal data. **Verified**: it is a public getter at `pty-session.ts:783` and is documented as monotone.

## Solution Approaches

**A. Chosen — scoped snapshot then deltas over SSE.** Correct from the first frame, scoped per FR-31, bounded idle cost, reuses the proven `fetch`+stream auth pattern.

**B. Deltas only, plus a REST snapshot fetch.** Rejected. Creates a race between the fetch and the first delta. The reconciliation bug is subtle, silent, and lives for months.

**C. Extend `broadcastNotification` with structured types.** Rejected under C1. It is a hot upstream file and the VS Code extension depends on its current shape.

**D. WebSocket now, per FR-32.** Deferred, not rejected. The frames are the contract; moving them to a socket later is plumbing. Doing it now costs a second auth path and a second reconnect story before anything renders.

## Open Questions

Ranked, most consequential first.

1. **Does the VS Code extension eventually want this stream instead of `broadcastNotification`?** Out of scope here, but if yes, C1's "never touch it" becomes cheaper to revisit and this stream's audience doubles. Does not block the build.
2. **Is a 50-client v2 cap right?** Chosen as a quarter of the existing 200 on the reasoning that v2 clients are few and long-lived. Cheap to change, so not worth blocking on.

3. **Should a completion signal be added to the overview payload?** Without one, a finished builder and a crashed builder are both `offline`. Adding it means touching an upstream file, so it is a C1 decision with a real cost. Recommend shipping without it and revisiting once the tree is rendering and the confusion is observable rather than theoretical.

**Closed in this revision:** whether finished builders drop out of scope. The question dissolved with `done` — a finished builder is `offline` and stays in the tree until it is actually removed, at which point `gone` fires.

## Test Scenarios

1. **Spawn latency.** Connect two clients, spawn a builder, assert both receive a `node` frame within 500ms with no timer in the client.
2. **Stalled transition.** Builder silent past `IDLE_WAITING_THRESHOLD_MS` transitions to `stalled`; a gate-blocked builder does not, proving precedence.
3. **Idle cost.** 20 silent in-scope builders, 60 seconds, measure bytes. Assert under 1 KB/s. This is the real idle case; zero builders is the easy one and does not test the tick rule.
4. **Resume inside the window.** Disconnect, reconnect with `since`, assert deltas from `since+1` and no snapshot.
4b. **Snapshot does not consume a sequence number.** Snapshot twice against unchanged state, assert an identical `seq`. Then change state once and assert the next delta is `seq+1`, not `seq+2`.
5. **Resume outside the window.** Exceed the buffer, reconnect, assert `snapshot` with `resumed: false`.
5b. **Empty in-window resume.** Reconnect with a valid in-window `since` against a scope where nothing changed. Assert a `resumed` frame arrives and the connection is not silent.
5c. **Held mail moves the flag.** Send a message that holds; assert `flags.heldMail` goes true on that node. Send one with a future `not_before`; assert the flag does **not** go true until it is due.
6. **Tower restart.** Restart, reconnect with a valid `since`, assert `snapshot` with `resumed: false` rather than an empty delta list.
7. **Dark vs empty, and which one.** With a two-path scope, make one path unreadable. Assert a `dark` frame naming that path, assert the other path still streams, and assert no empty snapshot.
7b. **Id collision.** Two workspaces each with a builder of the same local id. Assert both appear as distinct nodes and that neither `gone` nor a `tick` bucket key matches the wrong one.
8. **Two-client convergence.** Drive 100 random state changes, assert both clients end identical.
9. **Scope isolation.** Change an out-of-scope workspace, assert a `counts` frame and no `node` frame.
9b. **Counts follow in-scope changes too.** Spawn an **in-scope** builder, assert both a `node` frame and an updated `counts`. Two clients with different scopes must report the same `gateWaiting`.
9c. **`gone` on cleanup.** Remove an in-scope builder, assert a `gone` frame carrying its qualified id, and assert it leaves both connected clients' trees.
9d. **Sparkline single-writer.** Drive `node` upserts between ticks on one client and not the other; assert both sparklines are identical after the next `tick`.
9e. **Offline is reachable.** A builder whose worktree exists with no live session appears as `offline` rather than being absent. This fails immediately if the implementation copies `tower-routes.ts:1137` and passes `activeBuilderRoleIds`.
9f. **Builders never dangle.** A builder with `spawnedByArchitect` null, and one naming an architect outside the scope, both parent to their workspace and render in the tree.
9g. **Offline is reachable for architects and workspaces too.** Exit an architect: assert a `node` upsert with `status: "offline"`, **not** a `gone`. Then delete its row: assert `gone`. Repeat for a workspace. This fails immediately if the implementation sources architects from `liveArchitects`.
9h. **Parent `gone` reparents.** Delete an architect row that has two in-scope builders. Assert both builders receive `node` upserts reparenting them to the workspace **before** the architect's `gone`, and that applying the frames in order never yields an orphan.
9i. **Workspace `gone` cascades children-first.** Unregister a workspace with an architect and builders. Assert `gone` for every child before the workspace's own, and no orphan at any point in the sequence.
9j. **Upserts are not driven by output.** Run a builder producing continuous output for 60 seconds. Assert `node` frames are emitted **only** for the field changes in the emission table, and that frame count does not scale with output volume. A status change during the window is legitimate and must not fail the test; what must fail it is a frame per DATA frame.
9k. **Id is stable across the spawn window.** Spawn a builder and capture frames from before its `builders` row exists through to after. Assert one node id throughout, and no `gone`.
10. **Non-regression.** Existing SSE suite passes untouched.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Idle cost scales with builder count | Medium | High — defeats the reason for building this | Absence-means-zero in `tick`; scenario 3 measures 20 silent builders, not zero |
| Resume silently broken because it is rarely hit | Medium | High — corruption looks like a UI bug | Scenarios 4–6 test it directly rather than relying on eviction to trigger it |
| A second stalled threshold drifts from the dashboard | High if not specified | Medium — two surfaces disagree about one builder | Reuse the `IDLE_WAITING_THRESHOLD_MS` constant; define no new threshold |
| `EventSource` reached for, 401s follow | High | Low — loud and fast to diagnose | Stated on the contract with the `useSSE.ts` precedent and the reason |
| Upstream merge conflict | Low | High — the fork constraint is the whole design | One mount block beside the existing `/api/tunnel/` prefix; criterion 12 makes it falsifiable |
| v2 clients starve VS Code clients | Low | Medium | C4: separate cap accounting, 50 v2 clients against the existing 200 |
| Ids unstable across reconnect, `gone` unmatchable | Low | High — silent leaks in the tree | Ids derive from existing natural keys; nothing new is minted or persisted |
| Finished and crashed builders indistinguishable | Certain | Low — both are correctly "nothing attached" | Stated, not hidden. Open question 3 carries the upstream cost of fixing it |
| Implementation copies the filtered `getOverview` call site | High — it is the obvious one to copy | High — `offline` silently never fires and finished builders vanish | Called out on the source, and scenario 9e fails loudly if it happens |
| Same trap for architects via `liveArchitects` | High — also the obvious helper | High — architects vanish instead of going offline | Named on the architect source; scenario 9g fails loudly |
| Builder id collision across workspaces | High if unqualified | High — builders overwrite each other, blamed on the client | Every id qualified by `workspace_path` per `schema.ts:46`; scenario 7b tests it |
| `roleId` used as the id, nulls collapse together | Medium — it is the field liveness uses | High — soft-mode builders merge into one node | `builders.id` named explicitly, with the worktree-name fallback |
| Snapshot consumes a sequence number | Medium | High — silent skipped or replayed deltas on every resume | Stated on the contract; scenario 4b asserts it directly |
| Upserts driven by `lastDataAt` flood the buffer | High — it is the natural implementation | High — in-window resume becomes unreachable and idle cost blows the Part 5 target | Emission table names the triggering fields; scenario 9j asserts zero frames under continuous output |
| Children orphaned when a parent goes `gone` | High if unspecified | High — permanent ghost rows in every client's tree | Reparent-then-`gone` for architects, children-first cascade for workspaces; scenarios 9h and 9i |
| Builder id flips mid-spawn | Certain under rev. 8's rule | High — one builder renders as two | Id is the worktree directory name, which exists for the node's whole life; scenario 9k |
| Successful empty resume looks like a hung connection | High | Medium — clients reconnect in a loop against an idle scope | `resumed` frame; scenario 5b |
| `heldMail` flags a not-yet-due delayed send | Medium | Medium — a builder shows as needing attention before it does | `not_before` clause on the join; scenario 5c |
| Resumed deltas served into the wrong scope | Medium | High — silent corruption | `since` only valid with a matching `streamId`; mismatch returns a flagged snapshot |

## References

- FRD: `codev/research/codev-v2-ui-frd.md` rev. 5 — Option 0, FR-4, FR-15, FR-31, FR-32, FR-41, FR-42, Part 5
- Spike 1: `codev/experiments/38-multi-client-resize/` (#38)
- Spike 2: `codev/experiments/39-https-on-a-phone/` (#39)
- `packages/sdk/src/builder-helpers.ts` — `IDLE_WAITING_THRESHOLD_MS`, `isIdleWaiting`
- `apps/web/src/hooks/useSSE.ts` — why `fetch`+stream rather than `EventSource`
- `packages/codev/src/agent-farm/servers/tower-server.ts:259,283-308,364`
- `packages/codev/src/terminal/pty-session.ts:783` — `bytesWritten`
- `packages/codev/src/agent-farm/db/schema.ts:46` — `PRIMARY KEY (workspace_path, id)` on `builders`
- `packages/types/src/api.ts:147` — `OverviewBuilder`: `blockedGate`, `lastDataAt`, `protocolPhase`, `roleId`, `spawnedByArchitect`
- `packages/codev/src/agent-farm/db/schema.ts` — `mailbox`: `to_agent`, `status`, `not_before`
- `packages/codev/src/agent-farm/servers/tower-instances.ts:297` — `isActive = terminals.length > 0`
- `packages/codev/src/agent-farm/servers/overview.ts:862` — `getOverview`, and the `activeBuilderRoleIds` filter that must not be passed
- `packages/codev/src/agent-farm/servers/tower-routes.ts:1149-1157` — how liveness and `lastDataAt` are resolved today
- `packages/codev/src/terminal/pty-session.ts:155` — `_lastDataAt = Date.now()` at construction, which is why `idle` was unreachable
- `packages/codev/src/agent-farm/servers/tower-routes.ts:192,256,1139,1425,1443`
