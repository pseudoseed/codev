# pir-241 — the production thread subscriber

## Plan phase (2026-08-30)

Confirmed the issue's claim against the tree, and found one thing the issue did not say:
there IS a production `orchestration.subscribeThread` in Tower already —
`T3codeSessionCache.#ensureSubscribed` (`servers/t3code-session-cache.ts:625`). It is a
display subscriber: it folds frames into `entry.session`, uses the raw `streamer.stream`
with no cursor, and its `watching`/`stale` vocabulary is built on a stream that ENDS.
A `ResumingSubscription` deliberately never ends, so folding the two together is a
semantics change with its own tests to rewrite. Plan keeps them separate and records the
cost (two streams per watched thread) plus a follow-up.

Two hazards found while reading, both in the plan:

1. `ResumingSubscription` hands the snapshot frame to `onValue`, and `asThreadEvent`
   returns null for it — so anything the server compacted into the snapshot is never
   observed. A turn dispatched before the subscription attaches can lose its `running`
   transition into that snapshot. `air-235-full-protocol.mjs` solves it with
   `awaitAttached` and its comment records the probe passing under claude and timing out
   under opencode/grok-4.6. So the engine must await attachment before the first turn.
2. `subscription.ts:410` closes the transport in the `finally` of EVERY attempt, not just
   on stop. Tower has one socket for commands and streams, so `close` must cancel the
   stream's request id, not the socket. The `air-235` helper made it a no-op and
   documented the cost; this plan closes it instead via `T3Client.cancel`, whose
   request-id capture `connectDispatcher` already does for its `ThreadStream`.

Third gap the issue implies but does not name: nothing re-adopts threads after a Tower
restart. `engine.attach` has exactly one production caller (`mailbox-wiring.ts:529`),
reached only on delivery. Without an adoption sweep the persisted cursor is never read,
so "resumes rather than resubscribes cold" would be untestable in production. Plan adds
a sweeper on Tower's interval, next to the session cache's.

Not touching `.builders/air-235`. Expecting one rebase against builder-air-227 on
`thread-backend.ts` — its edits are in interrupt/cleanup, mine in `connectDispatcher`'s
return shape and `initialiseThreadBackend`'s registration block.

## Implement phase (2026-08-30)

Plan approved and recorded by the architect (I cannot run `porch approve` from a
`.builders/` worktree — from here it only prints the `--a-human-explicitly-approved-this`
instruction, and that flag is the string the guard stopped enforcing).

Filed #251 for folding `T3codeSessionCache` onto the new subscription. Two read-only
streams per watched thread until then; the module header says so rather than leaving it
implied, and #251 records that the cost was never measured.

Shipped:

- `agent-farm/thread-subscriptions.ts` — `ThreadSubscriptionPool` (one
  `ResumingSubscription` per adopted thread, `PersistentCursor` under
  `.codev/thread-cursors/<threadId>`) plus `ThreadAdoptionSweeper`.
- `ThreadEngine.observe(value)` on the interface; `createPorchThreadEngine` routes by
  `aggregateId` to the `DriverThread`, falling back to `tracker.observe` for an unadopted
  aggregate so `lastSequence` keeps moving. `createMemoryThreadEngine.observe` is a
  deliberate no-op with the reason written down.
- Engine awaits `ensure()` in `create` (before the first `beginTurn`), `attach` and
  `startTurn`; `stop()` in `removeWorktree`.
- `connectDispatcher` returns a third view of the same socket, `subscriber`, shaped for
  `ResumingSubscription`. Pool built before the engine and stopped by the socket's close
  handler and by every `abandonConnection` path.
- Tower starts/stops the sweeper next to `T3codeSessionCache`.

One change outside the plan: `SubscriptionTransport.client` in `packages/t3-client` was
typed as the concrete `T3Client`, which overstated what `ResumingSubscription` uses (only
`stream`). Tower's transport is a per-attempt wrapper whose `close` cancels a request id
rather than the socket, and a `T3Client` cannot express that — the wide type forced a cast
at exactly the seam the distinction lives at. Narrowed to a `SubscriptionClient` interface;
`T3Client` still satisfies it structurally, so nothing that passed one before changes.

Tests: 21 behavioural + 7 source-wiring assertions + a live one gated on
`T3_LIVE=1` + `T3_NODE`. The wiring file exists because every behavioural test builds its
own pool and would stay green if production stopped passing one — which is the exact shape
of this bug.

Known collision: PR #253 (#227) touches `thread-backend.ts`, `porch-thread-engine.ts`,
`thread-runtime.ts`, moves `canonicalWorkspaceKey` to `workspace-key.ts`, adds a
`workspaceRoot` argument to `chooseSpawnPath`/`allocateSpawnThread`, and adds a `defaults`
accessor to `ThreadEngine`. It merges first; rebasing after rather than anticipating.

## PR gate — CMAP (2026-08-30)

PR #258. Three real verdicts, from three lanes that actually ran:

| Lane | Verdict |
|---|---|
| codex | REQUEST_CHANGES |
| claude | COMMENT |
| opencode (grok-4.6) | COMMENT |

gemini SKIPPED — `agy` exited 1 on quota. That is `LANE_DID_NOT_REVIEW`, not an
approval, so it is not counted as one of the three; opencode took the slot per the
fallback rule in CLAUDE.md.

### The finding that mattered

codex and claude found the same bug independently, and it defeated the guard the whole
PR is built on. `ResumingSubscription` calls `onResume` with a `gap` from the `finally`
of an attempt that ended BEFORE the server signalled catch-up was complete. That attempt
never came up — `#everSubscribed` stays false, the cursor stays put, so the next attempt
is another COLD subscribe whose snapshot carries no observable events. The pool marked it
attached, `ensure()` resolved, and a turn could dispatch into exactly the snapshot race.

**Not fixed the way either lane proposed.** Both said gate on `outcome.kind !== 'gap'`.
That is wrong in the other direction: `classifyResume` returns a legitimate `gap` when
the server SYNCHRONIZED and declined to resume from the cursor — that subscription is up,
and the caller reconciles rather than waits. Gating on kind would turn a recoverable
condition into a permanent refusal to dispatch turns on that thread.

So the two gaps were made distinguishable instead: `onResume`'s info object gains a
`synchronized` flag in `packages/t3-client`, true at the sync marker and false in the
`finally`. The pool keys on that. One regression test per direction.

### Also fixed

- `attach()` returned an existing record before calling `start()`, so a subscription the
  pool dropped on a terminal failure could never be recreated by a later sweeper pass —
  while the log claimed one would adopt it. A record and a subscription are two different
  things and only one was being checked. (codex)
- `ThreadAdoptionSweeper.start()` set an interval and ran no first pass, leaving every
  unmessaged thread unsubscribed for a full sweep after Tower boots — the exact window a
  Tower restart lands in, which is the event the sweeper exists for. (opencode)
- Three comments that overclaimed. `startTurn`'s `ensure` cannot guard a stream that
  dropped after attaching, because `isAttached` is monotonic. The await DOES lengthen the
  drain loop's worst case, to 30s + 30s. And `attach`'s comment said the subscription
  makes `activeTurnId` knowable; only `track()` writes that field. (claude, opencode)

All in `01d51a233`. Full suite after: 7184 passed, 0 failed.

### Still open

Both lanes flagged the missing `codev/reviews/241-*.md` and `status.yaml` reading
`dev-approval: pending`. Same fact: `porch approve 241 dev-approval` has not been run.
`review` is the phase BEHIND that gate in `pir/protocol.json`, so the artifact cannot be
written until it clears. The PR was opened one phase early on the architect's explicit
instruction; porch recorded it in `pr_history`.

Merge order flipped by the architect: #258 goes first, #227 rebases onto it. No rebase
on my side.
