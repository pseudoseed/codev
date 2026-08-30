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
