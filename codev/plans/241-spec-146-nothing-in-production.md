# PIR Plan: The production thread subscriber

Issue: #241 — Spec 146: nothing in production subscribes to a thread, so no turn ever settles.

## Understanding

`TurnTracker` is the only thing that resolves a turn's `running` and `settled`
promises, and it resolves them from `thread.session-set` events fed to
`TurnTracker.observe` (`packages/porch-driver/src/turn.ts:219-267`). Nothing in
production ever calls it.

Verified in the tree:

- `DriverThread.observe` (`packages/porch-driver/src/thread.ts:417`) is called from
  exactly two places, both test helpers:
  `packages/codev/src/agent-farm/__tests__/helpers/air-235-full-protocol.mjs:309` and
  the two spec-146 test files. No production caller.
- `ResumingSubscription` (`packages/t3-client/src/subscription.ts:147`) is
  constructed only in `air-235-full-protocol.mjs:285`.
- `createPorchThreadEngine` is registered in Tower at
  `packages/codev/src/agent-farm/thread-backend.ts:798`, with
  `tracker: new TurnTracker()` — a tracker nothing ever feeds.

The consequences are exactly as the issue states:

- `porch-thread-engine.ts:82-98` (`track`) sets `record.activeTurnId` at dispatch and
  attaches to `started.running` / `started.settled`. Neither ever resolves, so every
  record that has started a turn reads permanently active.
- `DriverThread.runTurn` (`thread.ts:472`) would never return.
- `SessionStartFailedError` (`turn.ts:159`) is raised only from `TurnTracker.observe`,
  so the named refusal is unreachable in production.

### The one production subscription that exists, and why it is not this

`T3codeSessionCache` (`packages/codev/src/agent-farm/servers/t3code-session-cache.ts:625`)
*does* call `orchestration.subscribeThread` in Tower, once per thread found in
`global.db`. It is not the missing subscriber:

- its handler folds frames into `entry.session` for display
  (`t3code-session-cache.ts:680`) and never reaches the engine;
- it uses the raw `streamer.stream`, so there is no cursor and no `afterSequence` —
  every reconnect resubscribes cold;
- its `watching` / `stale` vocabulary is built on a stream that *ends*
  (`#ensureSubscribed`'s `settle`), which is precisely what a `ResumingSubscription`
  is designed never to do.

So this plan adds the control-plane subscriber and leaves the display path alone.
Folding the two onto one stream is real work with its own semantics change; it is
listed under Alternatives with a follow-up issue, not smuggled into this PR.

### Two things that must be got right, found while reading

**1. The snapshot frame drops events.** `ResumingSubscription` hands the snapshot to
`onValue(value, null)` (`subscription.ts:353`), and `asThreadEvent` returns `null` for
it (`turn.ts:40`), so `DriverThread.observe` ignores it. Anything the server compacted
into the snapshot is therefore never observed. A turn dispatched before the
subscription has attached can have its `running` transition inside that snapshot, and
then the waiter waits for a transition that already happened. `air-235-full-protocol.mjs`
handles this with `awaitAttached` (line ~330) and its comment records that a probe
written without it passed under claude and timed out under opencode/grok-4.6. The
production engine must not dispatch a turn before its subscription has attached.

**2. `transport.close()` fires on every attempt, not just on stop.**
`subscription.ts:410` closes the transport in the `finally` of each attempt. The
subscription shares Tower's single command socket, so a `close` that closed the socket
would take the dispatch path down with it. The `air-235` helper made `close` a no-op and
documented the cost: a failing handler does not end the stream promptly. This plan
closes that gap instead of inheriting it — `close` cancels **this stream's request id**
via `T3Client.cancel`, which `connectDispatcher` already captures for its `ThreadStream`
(`thread-backend.ts:315-332`).

## Proposed Change

A `ThreadSubscriptionPool`: one `ResumingSubscription` per adopted thread, owned by the
same code that owns the engine — Tower's `initialiseThreadBackend`, keyed by
`canonicalWorkspaceKey`, per #221's ruling.

### 1. `ThreadEngine.observe(value)`

Add `observe(value: unknown): void` to the `ThreadEngine` interface
(`thread-runtime.ts:50`). `createPorchThreadEngine` implements it by routing on
`asThreadEvent(value)?.aggregateId` to the matching `DriverThread`. When no
`DriverThread` is held for that aggregate, the value still goes to
`options.tracker.observe` so `lastSequence` stays correct for a thread this process has
not adopted — a value that arrives for an unknown thread is not evidence of nothing.

### 2. `packages/codev/src/agent-farm/thread-subscriptions.ts` (new)

`createThreadSubscriptionPool({ client, workspaceRoot, observe, log })` returns:

- `ensure(threadId)` — idempotent; opens a `ResumingSubscription` if none is held, and
  returns a promise that resolves when it has **attached** (first `onResume`), rejecting
  with a named error on a bounded timeout. Idempotent because `attach` is called on
  every mailbox delivery.
- `stop(threadId)` / `stopAll()` — `subscription.stop()` and drop the entry.
- `attached(threadId): boolean` — for status reporting.

Per subscription:

| Option | Value |
|---|---|
| `method` | `orchestration.subscribeThread` |
| `payload` | `{ threadId }` |
| `sequenceOf` / `isSnapshot` / `isSynchronized` | the `porch-driver/turn` helpers |
| `onValue` | `observe(value)` |
| `startAfter` | `PersistentCursor.load(cursorPath).applied` |
| `persist` | `cursor.reset(sequence)` |
| `onResume` | resolve the attach promise; log a `gap` at WARN with the requested range |
| `onHandlerError` | log at ERROR — a silent failing handler retries forever |
| `delayBetweenAttemptsMs` | 250 |

`connect()` returns a transport over Tower's existing `T3Client` whose `close()` cancels
only that stream's request id (see Understanding, point 2).

**Cursor path**: `<workspaceRoot>/.codev/thread-cursors/<threadId>`, beside the existing
`.codev/commands.jsonl` journal. The thread id comes from a server and from `global.db`,
so it is rejected unless it matches `/^[A-Za-z0-9_-]{1,128}$/` before being used as a
filename — a path traversal here writes anywhere Tower can write.

`CursorUnreadableError` from `PersistentCursor.load` is **not** swallowed into a cold
start: `ensure` fails with it named, because resubscribing from 0 on a damaged cursor is
"I could not tell" spelled as "nothing happened".

### 3. Wiring in `thread-backend.ts`

`connectDispatcher` additionally returns a `subscriber` — `{ stream(method, payload,
onValue, timeoutMs) }` plus the `onRequestId` hook — over the same `T3Client`. One
socket, as today; opening a second would spend the bootstrap token.

`initialiseThreadBackend` builds the pool from that subscriber before
`createPorchThreadEngine`, passes it in, and evicts it with the engine in the socket
`close` handler (`thread-backend.ts:687-698`) and on every `abandonConnection()` path —
a pool outliving its socket is the dead-engine bug one layer out.

### 4. The engine opens and closes subscriptions

`createPorchThreadEngine` takes an optional `subscriptions` (the pool). Optional so the
existing unit tests, which construct an engine with a fake dispatcher and no server,
keep working unchanged.

- `create()` — `await subscriptions.ensure(threadId)` **before** the initial
  `beginTurn(input.prompt)`. This is the attach race from Understanding point 1.
- `attach()` — `await subscriptions.ensure(threadId)` before returning the record. The
  `activeTurnId: null` comment at `porch-thread-engine.ts:178-184` ("whether a turn is
  running on the server right now is not knowable from here — this process holds no
  subscription") stops being true and is rewritten to say what it now means.
- `startTurn()` — `await subscriptions.ensure(threadId)` as a cheap idempotent guard, so
  a turn is never dispatched onto a thread whose subscription dropped and has not come
  back.
- `removeWorktree()` — `subscriptions.stop(threadId)`, alongside the existing map
  deletes.

### 5. Adoption after a Tower restart

Nothing re-adopts threads on restart today: `attach` has one production caller,
`mailbox-wiring.ts:529`, reached only when a message is delivered. So a thread whose
turn was in flight when Tower died stays unsubscribed until somebody messages it, and
the persisted cursor is never read.

`ThreadAdoptionSweeper`, in the same new module, driven by an interval Tower starts next
to `new T3codeSessionCache` (`tower-server.ts:751`) and stops next to
`t3codeSessionCache?.stop()` (`tower-server.ts:251`). Each pass:

1. lists workspaces from `global.db` (the same query `#workspaces` uses);
2. skips any workspace whose `requestThreadBackend(workspaceRoot).kind !== 'ready'` —
   never `getThreadEngine`, which throws;
3. reads `architect` and `builders` rows with a non-null `thread_id`, taking
   `worktree` / `branch` / `harness` / `model` from the builder row, and
   `workspaceRoot` / `''` for an architect (the shape `createArchitectThread` writes);
4. calls `engine.attach(...)`, which is idempotent and which opens the subscription.

A failed `global.db` read keeps the previous set rather than reporting an empty one, the
rule `#threadIds` already follows (`t3code-session-cache.ts:589-611`).

Interval: 5s, matching the session cache's sweep.

## Files to Change

- `packages/codev/src/agent-farm/thread-subscriptions.ts` — **new**. The pool, the
  per-stream transport, the cursor policy, the adoption sweeper.
- `packages/codev/src/agent-farm/thread-runtime.ts:50-100` — add `observe` to
  `ThreadEngine`.
- `packages/codev/src/agent-farm/porch-thread-engine.ts` — implement `observe`; take the
  optional pool; `ensure` before the first turn in `create`, in `attach`, and in
  `startTurn`; `stop` in `removeWorktree`; rewrite the stale `activeTurnId` comment at
  `:178-184`.
- `packages/codev/src/agent-farm/thread-backend.ts:201-330` — return a `subscriber` from
  `connectDispatcher`; `:683-812` — build the pool, pass it to the engine, evict it with
  the engine on close and on every abandon path.
- `packages/codev/src/agent-farm/servers/tower-server.ts:251,751` — start and stop the
  adoption sweeper.
- `packages/codev/package.json` — no change; `@cluesmith/porch-driver` and
  `@cluesmith/t3-client` are already dependencies (`:49-50`) and both export
  `./cursor` and `./subscription`.

Tests:

- `packages/codev/src/agent-farm/__tests__/spec-241-thread-subscriptions.test.ts` — new,
  in-memory: a scripted stream drives the pool.
- `packages/codev/src/agent-farm/__tests__/spec-241-engine-settles.test.ts` — new: the
  engine's record clears `activeTurnId` when the settle event is observed, and
  `SessionStartFailedError` reaches a caller.
- `packages/codev/src/agent-farm/__tests__/spec-241-live-settle.test.ts` — new, gated on
  `T3_LIVE=1` + `T3_NODE` like `spec-146-phase-9-live-harness.test.ts`.

## Risks & Alternatives Considered

**Risk: two subscriptions per thread.** `T3codeSessionCache` keeps its own stream, so a
watched thread now has two. Two read-only streams on one socket; no correctness problem,
since `TurnTracker.observe` is idempotent by construction. Mitigation: state it in the
module header and open a follow-up to fold the cache onto the pool. Doing it here would
change the cache's `watching`/`stale` semantics — they are keyed on a stream that ends,
and a `ResumingSubscription` does not end — and its tests encode those semantics.

**Risk: `create` now awaits attachment before the first turn.** A spawn can no longer
report success before the subscription is up, so a server that accepts a subscription
slowly makes spawn slower. Mitigation: bounded with a named error that says the
subscription did not attach, never a generic timeout. Not doing it reintroduces the
grok-4.6 race the `air-235` helper documents.

**Risk: rebase against builder-air-227.** #227 also edits `thread-backend.ts`. Its
changes are in `interrupt`/`cleanup` paths; mine are in `connectDispatcher`'s return
shape and `initialiseThreadBackend`'s registration block. One rebase expected.

**Alternative: subscribe from `T3CodeSessionCache` and fan out to the engine.** One
stream, no duplication — the end state. Rejected for this PR: display code would own the
control plane's liveness, and the cache's freshness vocabulary would have to be
rewritten at the same time. Follow-up issue.

**Alternative: one subscription per project rather than per thread.** Rejected because
the vendored contract has none — `orchestration.subscribeThread` takes a single
`threadId` and `orchestration.searchThreads` is a text search
(`t3code-session-cache.ts:36-44`).

**Alternative: keep the cursor in `global.db`.** Rejected: `PersistentCursor` already
exists, is tested, writes atomically with an fsync'd rename, and refuses to read a
damaged file as zero. A second cursor implementation would drift from the one the
resubscribe proof uses.

**Alternative: no adoption sweeper — attach lazily on delivery.** Rejected: it is what
makes "the cursor resumes rather than resubscribes cold" untestable in production. A
thread whose turn was in flight when Tower died would settle only if somebody happened
to message it.

## Test Plan

**Unit — the pool** (`spec-241-thread-subscriptions.test.ts`, in-memory, no server):

- A scripted stream emits `thread.session-set` with a non-null `activeTurnId`, then one
  with null. The engine's `ThreadRecord.activeTurnId` goes id → null. This is the
  issue's headline symptom, failing before the change.
- `ensure` twice returns the same subscription and opens one stream.
- A drop and resubscribe sends `afterSequence` equal to the last applied sequence, read
  from the cursor **file** rather than from memory.
- A cursor file written by one pool instance is picked up by a second one constructed
  fresh — the Tower-restart property, in the shape `air-235-resubscribe.mjs` proves it.
- A corrupt cursor file surfaces `CursorUnreadableError` from `ensure`; it is not read
  as 0.
- A thread id that is not `[A-Za-z0-9_-]{1,128}` is refused before any file is opened.
- `close()` on the transport cancels the stream's request id and does **not** close the
  shared socket.
- A `gap` outcome is logged at WARN with the requested range.

**Unit — the engine** (`spec-241-engine-settles.test.ts`):

- `SessionStartFailedError` reaches a caller: feed a `thread.session-set` with
  `status: "error"` after `create`, and the awaited turn rejects with the named error
  rather than timing out. This is #238's latent path, made reachable.
- A replayed refusal at or below the waiter's `startSequence` does **not** kill a healthy
  turn (the guard at `turn.ts:227-245`, now exercised through the production path).
- `removeWorktree` stops the subscription.

**Unit — the sweeper**:

- Threads in `global.db` are attached; a workspace whose backend is not `ready` is
  skipped without throwing; a failed database read leaves the previous set standing.

**Live** (`spec-241-live-settle.test.ts`, `T3_LIVE=1` + `T3_NODE`, skips with a named
reason otherwise):

- Against `tools/t3-server`, `DriverThread.runTurn` returns with assistant text. That is
  the end-to-end statement the issue makes and the thing no in-memory test can make.

**Manual, at `dev-approval`** — the reviewer runs the worktree with a t3code server
configured (`.codev/config.local.json` `threads` block, or `CODEV_T3_URL` /
`CODEV_T3_TOKEN`):

1. `afx spawn` a thread-backed builder. `afx status` shows it with a turn active, and
   the turn goes inactive when the agent finishes — today it never does.
2. `afx send <builder> "..."` and watch the turn settle.
3. Restart Tower mid-turn. `.codev/thread-cursors/<threadId>` holds a non-zero sequence;
   after the restart the Tower log reports the resubscription resuming from it, and the
   turn that finished during the restart settles from the replay rather than being lost.
4. Point `threads.harness` at a driver that is disabled in t3code settings. The spawn
   reports `SessionStartFailedError` with the server's own sentence in seconds, not a
   ten-minute timeout.

**Not covered.** Whether two subscriptions per watched thread cost anything measurable
on a real server is not measured here; it is recorded as a follow-up.
