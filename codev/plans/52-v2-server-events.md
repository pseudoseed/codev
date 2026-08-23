# Plan: v2 server events — push-based status for the v2 hierarchy

**Specification**: [codev/specs/52-v2-server-events.md](../specs/52-v2-server-events.md)

**Approval:** 2026-08-23 by architect:uiv2 under the human's standing delegation of protocol gates, recorded as such rather than as a human reading it. Plan review had **2 genuine lanes, not 4**: Claude and opencode both REQUEST_CHANGES (addressed). Gemini artifact carries `LANE_DID_NOT_REVIEW` (agy quota). Codex is quota-exhausted.

## Executive Summary

Approach A from the spec: one scoped SSE stream, snapshot then deltas, consumed via `fetch` + `ReadableStream`.

All new runtime lives in fork-owned `v2-*.ts` modules under `packages/codev/src/agent-farm/servers/`. `tower-routes.ts` gains exactly one prefix branch after the `ROUTES` table and before `/api/tunnel/`:

```ts
if (url.pathname.startsWith('/v2/')) {
  return await handleV2Route(req, res, url, ctx);
}
```

No edits to `tower-server.ts`, `pty-session.ts`, `broadcastNotification`, `handleSSEEvents`, or any existing handler. Auth is already applied: `isRequestAllowed` runs before dispatch (`tower-routes.ts:256`) and `/v2/` is not in `isPublicRoute`.

Change detection cannot hook PtySession or the notification bus (C1/C4). The sampler is a fork-owned compare loop over existing read APIs, woken by `fs.watch` on `.builders/` and by a 30s tick. That is server-side observation, not client polling. Clients still receive only push frames.

`getOverview` is the spec's *semantic* source (every worktree, no `activeBuilderRoleIds`). The hot path must not call `getOverview` itself: it also fetches PRs, issues, and the current user (`overview.ts:925-932`). Use the same discovery function `getOverview` uses, `discoverBuilders` (`overview.ts:558`), plus `getArchitects`, mailbox eligibility, and the in-memory terminal registry.

## Grounded seams (verified)

| Need | Use | Do not use |
|---|---|---|
| Builder list, including offline | `discoverBuilders(ws)` — no second arg filter | `getOverview(ws, activeBuilderRoleIds)` |
| `spawnedByArchitect` | `getBuilders(ws)` (`state.ts:279`). Join `row.worktree === discovered.worktreePath` (full path, not basename). `discoverBuilders` hardcodes this field `null` at all three push sites (`overview.ts:602,662,697`); `getOverview` is the only production enricher today (`:891-898`) | `lookupBuilderSpawningArchitect` (keys on `builders.id`, not the worktree path) |
| Architect list, including offline | `getArchitects(ws)` (`state.ts:517`) | `liveArchitects` (private, live-only, `tower-routes.ts:1087`) |
| Held mail flag | `heldSummaryForWorkspace` / `findHeldForAgent` eligibility (`not_before IS NULL OR not_before <= now`). Compare `to_agent` case-insensitively (overview already lowercases `roleId` at `:907`) | `listHeld` (includes pre-due rows) |
| Liveness + `lastDataAt` + `bytesWritten` | `getWorkspaceTerminals().get(ws)` then `getTerminalManager().getSession(id)`; public getters at `pty-session.ts:783` and `:823` | `getWorkspaceTerminalsEntry` (creates empty entries); editing PtySession |
| Workspace set | Injected `listWorkspaces()` defaults to `getKnownWorkspacePaths()` (`tower-instances.ts:212`) minus `/.builders/` paths | Inventing an unregister write |
| Stalled threshold | `IDLE_WAITING_THRESHOLD_MS` from `@cluesmith/codev-sdk/builder-helpers` | `isIdleWaiting` (excludes completed builders) |
| Builder node id | worktree directory name (`entry.name`) | `OverviewBuilder.id`, `builders.id`, `roleId` |
| Agent identity for mailbox / session map | `roleId` / `builders.id` (e.g. `builder-spir-52`) | worktree basename |

**Workspace `gone` in production.** There is no `unregisterKnownWorkspace`. `stopInstance` leaves `known_workspaces` and is `offline`, not `gone`. The projection treats membership in `listWorkspaces()` as the record. Tests inject that list (or delete the `known_workspaces` row) to fire the cascade. Do not add an unregister API.

## Module split

```
packages/types/src/v2-events.ts          wire types only (no runtime values)
packages/types/src/index.ts              re-export those types
packages/codev/src/agent-farm/servers/v2-ids.ts
packages/codev/src/agent-farm/servers/v2-status.ts
packages/codev/src/agent-farm/servers/v2-projection.ts
packages/codev/src/agent-farm/servers/v2-events.ts      per-scope cursor, buffer, fan-out
packages/codev/src/agent-farm/servers/v2-sampler.ts     compare loop, tick, watch, held-mail wake
packages/codev/src/agent-farm/servers/v2-routes.ts      HTTP + SSE, cap 50, no eviction
packages/codev/src/agent-farm/servers/tower-routes.ts   one import + one if block
```

Runtime string constants (`V2_EVENTS_PATH = '/v2/events'`, frame type names) live next to the handler. Same reason `command-relay.ts:24-31` redeclares `COMMAND_ROUTE`: codev runs unbundled and cannot runtime-import values from `codev-types`.

## Shared implementation rules (every phase)

**Cursor.** Per-scope, process-wide. `snapshot`, `resumed`, and `dark` read it and do not increment it. None of those three is written into the delta buffer. `resumed.seq` equals the `since` it honoured. `node` / `gone` / `counts` / `tick` increment, then append.

**`dark` is a per-connection handshake**, like `snapshot`. Emit it on each connect for every unknown or unreadable path in that request's `scope`. Do not emit-on-observe (the next connector would miss it) and do not increment (that would break 6c: two clients on unchanged state must share `seq`).

**Connect ordering (criterion 6b).** Subscribe first with outbound frames queued and not flushed. Then compute the snapshot (including any `getRehydratedTerminalsEntry` await). Write `snapshot` at the cursor as it stood at subscribe time. Flush queued frames with `seq > snapshot.seq`. Snapshot-then-subscribe drops frames across the await; subscribe-then-snapshot without a queue delivers deltas ahead of the snapshot.

**Do not pause the compare loop.** Start it on the first `/v2/events` and run until process exit. Pausing when the last client drops, while keeping the buffer, makes a later in-window resume report "nothing changed" across a last-client gap (network drop / iOS background). Tick frames fan only to scopes with a live connection; the compare still updates last-emitted maps so resume is honest.

**Rehydrate only known in-scope workspaces.** `getRehydratedTerminalsEntry` calls `getWorkspaceTerminalsEntry`, which creates a map entry. `getKnownWorkspacePaths` unions that map. Rehydrating a dark or unknown path would mint a ghost workspace and move `counts`. Never call it for a path that is not already in `listWorkspaces()`.

**Buffer.** Per scope, 500 frames or 5 minutes, whichever comes first. Survives zero clients. Dies with the process (C2). `streamId` is minted once per scope per process.

**Emission table.** A `node` upsert fires only on `status`, `flags.heldMail`, `parentId`, `name`, or first appearance. `lastDataAt` rides along; it never triggers. `buckets` never appear on a `node` frame.

**`gone` vs `offline`.** Liveness never emits `gone`. Session end / deactivate → `node` with `status: "offline"`. Record disappearance → `gone`. Architect `gone`: reparent in-scope builders to the workspace, then `gone`. Workspace `gone`: `gone` for builders, then architects, then the workspace. Ordering is part of the contract.

**Counts.** Always the whole hierarchy. Any count change emits `counts` to every live scope, including the scope that caused it.

**Tick.** One frame per scope per 30s. `buckets` keys are qualified node ids. Zero-output builders are absent. `tick` is the only writer that advances a sparkline after the snapshot.

**Cap.** 50 v2 clients, counted on a list this module owns. Over cap: 503 + `Retry-After: 5` before headers. No eviction timer.

**Clock.** Every time-dependent function takes `now`. Tests inject it.

**Deps.** Projection and sampler take an injected `V2Deps` so tests do not touch `global.db` or live PTYs.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Hierarchy projection"},
    {"id": "phase_2", "title": "Scoped event bus and SSE route"},
    {"id": "phase_3", "title": "Change sampler and live deltas"},
    {"id": "phase_4", "title": "Idle-cost and convergence proof"}
  ]
}
```

## Phase Breakdown

### Phase 1: Hierarchy projection

**Dependencies**: None

#### Objective

A pure function turns the existing read APIs into the spec's `Node[]` + `Counts`. Status, ids, `parentId`, and `heldMail` are correct before any bytes hit the wire.

#### Files to Create / Modify

- `packages/types/src/v2-events.ts` — `V2Status`, `V2Node`, `V2Counts`, `V2Frame` union (`snapshot` / `node` / `gone` / `counts` / `tick` / `dark` / `resumed`)
- `packages/types/src/index.ts` — type-only re-exports
- `packages/codev/src/agent-farm/servers/v2-ids.ts` — `workspaceId`, `architectId`, `builderId`; parse/qualify
- `packages/codev/src/agent-farm/servers/v2-status.ts` — `statusForBuilder` / `statusForArchitect` / `statusForWorkspace`
- `packages/codev/src/agent-farm/servers/v2-projection.ts` — `projectHierarchy(now, deps) → { nodes, counts }`
- `packages/codev/src/agent-farm/__tests__/v2-projection.test.ts`

`V2Deps` for this phase: `listWorkspaces`, `discoverBuilders`, `getBuilders`, `getArchitects`, `heldByAgent`, `sessionForRole`, `sessionForTerminal`, `terminalsForWorkspace`, `bytesWritten`, `lastDataAt`.

#### Deliverables

- [ ] Wire types match the spec's `Node` / `Counts` / frame shapes
- [ ] Ids: `workspace:<path>`, `architect:<path>#<architect.id>`, `builder:<path>#<worktree-dir-name>`
- [ ] Builder status, in order: `blockedGate !== null` → `gate-waiting`; no live session → `offline` (`lastDataAt` null); live and `now - lastDataAt > IDLE_WAITING_THRESHOLD_MS` → `stalled`; else `running`
- [ ] Architect: live session → `running`, else `offline`. Never `gate-waiting` / `stalled`
- [ ] Workspace: at least one terminal → `running`, else `offline` (same predicate as `tower-instances.ts:297`)
- [ ] `parentId`: workspace null; architect → workspace; builder → spawning architect if that architect node exists in the projection, else workspace. `spawnedByArchitect` comes from `getBuilders`, joined on `row.worktree === discovered.worktreePath` (full path)
- [ ] `flags.heldMail` from eligible mailbox rows joined on `to_agent` case-insensitively (builder: `roleId`; architect: `architect.id`; workspace: false)
- [ ] `name`: workspace basename, architect id, builder worktree directory name
- [ ] `buckets` omitted here (snapshot assembly is phase 2/3)
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 4b's status cases (completed-and-live-and-stale, live-and-never-spoken, worktree-present-with-no-session, gate-blocked-while-stale) each resolve to exactly one status
- [ ] Scenario 7b: two workspaces, same local builder dir name, two distinct ids
- [ ] Scenario 9e: worktree with no session is `offline`, not absent
- [ ] A builder whose `getBuilders` row has non-null `spawnedByArchitect` matching an architect **in the projection** has `parentId` equal to that architect's id, **not** the workspace id. Assert the parent is the architect node. 9f (null → workspace) still cannot catch a skipped join
- [ ] Scenario 9f: null `spawnedByArchitect`, and an architect not in the projection, both parent to the workspace
- [ ] Scenario 9g (projection form): architect/workspace with no session is present as `offline`
- [ ] Scenario 5c (projection form): eligible held row → `heldMail: true`; future `not_before` → false
- [ ] Build and unit tests pass

#### Test Plan

Table-driven unit tests with a fake `V2Deps` (`listWorkspaces`, `discoverBuilders`, `getArchitects`, `heldByAgent`, `sessionForRole`, `sessionForTerminal`, `terminalsForWorkspace`, `bytesWritten`, `lastDataAt`). No HTTP, no real db, no real PTY.

Freeze `now`. Do not import `isIdleWaiting`.

### Phase 2: Scoped event bus and SSE route

**Dependencies**: Phase 1

#### Objective

A client can open `GET /v2/events`, get a flagged snapshot or an in-window resume, and be rejected honestly when the request cannot be honoured. Deltas can be injected in tests; the live sampler is phase 3.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/v2-events.ts` — `ScopeBus`: cursor, `streamId`, ring buffer, subscribe/unsubscribe, `emit`, `resume(since, streamId)`, `snapshotFrame(...)`
- `packages/codev/src/agent-farm/servers/v2-routes.ts` — `handleV2Route`; parse `scope` / `since` / `stream`; 400/503/SSE; own client list (cap 50); `dark` for unknown/unreadable paths
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — import `handleV2Route`; one `if (url.pathname.startsWith('/v2/'))` immediately after the `ROUTES` lookup, before `/api/tunnel/`
- `packages/codev/src/agent-farm/__tests__/v2-events.test.ts`
- `packages/codev/src/agent-farm/__tests__/v2-routes.test.ts`

#### Deliverables

- [ ] Scope key = sorted decoded workspace paths. One cursor + one `streamId` per key per process
- [ ] `snapshot.seq` is the current cursor; snapshot is not buffered; two snapshots against unchanged state share `seq`
- [ ] Resume table from the spec, including empty in-window `resumed` and 400 when `since`/`stream` travel alone
- [ ] Missing `scope` → 400. Malformed `since` → 400. Unknown path → 200 + `dark` naming that path's workspace id (handshake, no seq increment); other paths still snapshot
- [ ] Connect path follows subscribe-then-snapshot-then-flush (shared rules)
- [ ] Snapshot builders carry `buckets` of length 20 (criterion 5); zeros until the sampler exists
- [ ] Cap 50, 503 + `Retry-After: 5`, no eviction, cleanup on `req`/`res` close/error once
- [ ] SSE via `res.write('data: …\n\n')`. Do not call `ctx.addSseClient`
- [ ] Unknown `/v2/...` → 404 from this module (the prefix consumes the request)
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenarios 6, 6b, 6c, 5, 5b (bus + route, frames injected)
- [ ] Scenario 7 (`dark` vs empty, which path)
- [ ] Scenario 10: existing `GET /api/events` tests in `tower-routes.test.ts` still pass
- [ ] Criterion 12 on this commit: `git diff` against the branch base touches `tower-routes.ts` only at the import and the one `if` block
- [ ] Build and unit tests pass

#### Test Plan

Bus tests: inject `node` frames; snapshot twice; resume at `N`; overflow the 500-frame / 5-minute bounds; mismatch `streamId`; `since` without `stream`.

Route tests: copy `makeReq` / `makeRes` / `makeCtx` into `v2-routes.test.ts`. They are module-private in `tower-routes.test.ts`; do not import them and do not extract them from that file (scenario 11 wants it untouched). Stub the bus and a snapshot projector. Cover the invalid-parameter table, cap, handshake `dark`, and subscribe-then-flush. Do not start a real Tower.

### Phase 3: Change sampler and live deltas

**Dependencies**: Phase 2

#### Objective

A connected client receives `node` / `gone` / `counts` / `tick` when the hierarchy actually changes, with the emission table and parent-`gone` ordering enforced.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/v2-sampler.ts` — compare loop, `fs.watch` on each known `.builders/`, 30s tick, `not_before` wake, bucket rings
- `packages/codev/src/agent-farm/servers/v2-routes.ts` — start/stop sampler with the first/last client; snapshot reads current projection + bucket rings
- `packages/codev/src/agent-farm/__tests__/v2-sampler.test.ts`

#### How the sampler works

1. `projectHierarchy(now, deps)` for the full workspace set (counts need out-of-scope nodes).
2. Diff against the last emitted node map per live scope, using only the emission table.
3. Appear → `node`. Emission-table change → `node`. Disappear → `gone` (reparent/cascade first). Count change → `counts` to every live scope.
4. Loop every **100ms** from the first `/v2/events` until process exit. Do not pause when the last client drops. `fs.watch` on `.builders/` wakes the loop immediately (spawn/cleanup). A timeout at the next mailbox `not_before` wakes `heldMail`.
5. Every 30s, one `tick` per **connected** scope from `bytesWritten` deltas, then a status pass so `stalled` cannot wait longer than the spec's bound. The 100ms loop may emit `stalled` sooner; do not add a second delayed path. With zero clients the tick is computed into the bucket rings but not fanned.

Default `V2Deps` bind to `discoverBuilders` (no filter), `getBuilders` (for `spawnedByArchitect`, join on full `worktree` path), `getArchitects`, `heldSummaryForWorkspace`, `getWorkspaceTerminals().get` (never `getWorkspaceTerminalsEntry`), `getTerminalManager().getSession`, `listWorkspaces` → `getKnownWorkspacePaths` minus `/.builders/` paths. Snapshot-on-connect may call `getRehydratedTerminalsEntry` once per **already-known** in-scope workspace so the first frame is not stale after a Tower restart. Never rehydrate a dark or unknown path. The loop stays on the in-memory map.

#### Deliverables

- [ ] Spawn / gate / held-mail / cleanup / offline / gone / reparent / cascade / tick
- [ ] Continuous output does not emit `node` frames
- [ ] Builder id is the worktree name from the first frame, including before the `builders` row exists
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenarios 1 (spawn ≤500ms, two subscribers), 2, 3 (unit form: 20 silent builders → only ticks), 4 / 4b (against a live bus), 5c, 9, 9b, 9c, 9d, 9e, 9g, 9h, 9i, 9j, 9k
- [ ] Criterion 9: event-driven emit p95 < 200ms from the compare that observed the change to `res.write`. `stalled` is not in this budget
- [ ] Build and unit tests pass

#### Test Plan

Fake deps + fake clock + a `ScopeBus`. Mutate the fake world, run one compare, assert frame types, ids, order, and seq.

- 9h: two builders under an architect; delete the architect; expect two `node` reparents then `gone`; applying in order never orphans
- 9i: unregister workspace (drop it from `listWorkspaces`); children-first `gone`
- 9j: raise `bytesWritten` every compare for 60 virtual seconds; zero `node` frames unless an emission-table field changes
- 9k: add a worktree with no `builders` row, then add the row; one id, no `gone`
- 5c: insert held row; later insert a future `not_before` row; fire the due timer
- Last-client gap: disconnect the only client, mutate the world, reconnect with in-window `since`+`streamId`. Expect `resumed` plus the missed deltas, not an empty honour
- Snapshot `buckets` length 20 on every in-scope builder (criterion 5)

`fs.watch` coverage: create a temp `.builders/x` and assert the loop wakes (or unit-test the wake callback if watch is awkward in CI).

### Phase 4: Idle-cost and convergence proof

**Dependencies**: Phase 3

#### Objective

Prove the Part 5 idle bound, two-client convergence, resume after a process restart, and C1/C4 non-regression on a stream that is actually running.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/__tests__/v2-scenarios.test.ts`
- No production edits unless a phase-3 hole surfaces; if one does, fix it here and say so in the commit body

#### Deliverables

- [ ] Scenario harness that opens two in-process SSE consumers against `handleV2Route` (no `startTower` unless already cheap)
- [ ] Idle-cost and continuous-output measurements
- [ ] Two-client 100-change convergence
- [ ] Process-restart resume (new `ScopeBus` = new process)
- [ ] Existing SSE suite + criterion 12 rechecked
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 3: 20 silent in-scope builders, 60s of ticks (fake clock: two `tick` frames), serialized bytes / 60 < 1024
- [ ] Scenario 8b: 20 builders with rising `bytesWritten` and no status change; same bound; frame count does not scale with output
- [ ] Scenario 8: two clients, 100 random emission-table mutations, identical final node maps and counts
- [ ] Scenario 6: new bus, valid `since` + old `streamId` → `snapshot` with `resumed: false`, not an empty delta list
- [ ] Scenario 11: `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` SSE cases pass untouched
- [ ] Scenario 12: `git diff <branch-base> -- packages/codev/src/agent-farm/servers/tower-server.ts packages/codev/src/terminal/pty-session.ts` is empty; `tower-routes.ts` diff is the import plus the one `/v2/` block
- [ ] Build and unit tests pass

#### Test Plan

Keep this file off the network. Drive the same fake deps as phase 3. Measure byte length of frames actually written to the mock `res`. For scenario 8, seed a PRNG and apply 100 mutations from {spawn, cleanup, gate enter/leave, hold/release mail, session attach/detach, architect insert/delete, workspace drop}.

Do not wait 60 wall-clock seconds. Advance the fake clock 30s twice and divide measured bytes by 60.

## Spec scenario → phase

| Scenario | Phase |
|---|---|
| 1 spawn latency | 3 |
| 2 stalled + gate precedence | 3 |
| 3 idle cost (20 silent) | 4 (unit form in 3) |
| 4 / 4b / 5 / 5b resume + snapshot cursor | 2, rechecked in 3/4 |
| 5c held mail | 1 (projection), 3 (movement) |
| 6 Tower restart | 4 |
| 7 dark | 2 |
| 7b id collision | 1 |
| 8 two-client convergence | 4 |
| 8b continuous output cost | 4 |
| 9 / 9b scope + counts | 3 |
| 9c gone on cleanup | 3 |
| 9d sparkline single-writer | 3 |
| 9e / 9f / 9g offline + parentId | 1 + 3 |
| 9h / 9i parent gone | 3 |
| 9j upserts not driven by output | 3 |
| 9k stable id across spawn | 3 |
| 10 / 11 existing SSE | 2 and 4 |
| 12 C1 git diff | 2 and 4 |

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Calling `getOverview` on the 100ms loop hits GitHub | High if copied | High — idle CPU and flake | Call `discoverBuilders` + `getBuilders` only; state this in the module comment |
| `discoverBuilders` leaves `spawnedByArchitect` null | Certain if the join is skipped | High — every builder parents to the workspace; 9f still passes | `getBuilders` join on full `worktree` path; Phase 1 AC requires a non-null parent |
| Pause + keep-buffer lies on resume | High as previously written | High — iOS background / last-client drop reports "nothing changed" | Never pause the compare loop |
| `dark` increment or emit-on-observe | High if treated as a delta | High — hides `dark` or breaks 6c | Handshake frame; no increment; not buffered |
| Rehydrate of an unknown path mints a workspace | High if copied | Medium — ghost node + `counts` drift | Rehydrate only paths already in `listWorkspaces()` |
| Compare loop itself blows the idle *CPU* budget | Medium | Medium | Watch-wake; keep the body to a map diff; tick does not fan with zero clients |
| `getWorkspaceTerminalsEntry` creates ghost workspaces | High if copied | Medium — false `offline` nodes | Use `Map.get` only |
| Workspace `gone` has no production write | Certain | Low — `offline` covers deactivate | Injected `listWorkspaces()` over `getKnownWorkspacePaths()`; do not invent unregister |
| `fs.watch` misses events on some platforms | Medium | Medium — 100ms loop is the backstop | Tests do not depend on watch alone for correctness |
| 500-frame buffer exhausted by a buggy emit | High if `lastDataAt` triggers | High — resume dies | Emission table + scenario 9j |
| Types runtime import from `codev-types` | Medium | Medium — boot crash | Types only in types; constants in `v2-routes.ts` |
| Existing SSE suite broken by the mount | Low | High | Mount is a prefix after `ROUTES`; scenario 10 |

## Documentation Updates

None beyond `packages/types/src/v2-events.ts`. The wire contract is the spec. `arch.md` / lessons wait for the review phase, once the stream has been run.
