# Phase 6, iteration 1 — response to the 2-way review

**claude: APPROVE (HIGH). opencode: REQUEST_CHANGES (HIGH).** Four findings between them, all
accepted, all fixed in phase. Nothing rebutted.

Per the standing order, the stricter lane is binding: opencode's finding is a real leak and it
decides the iteration.

## opencode — the gate watch is not torn down on reconnect

`gateWatches.set(key, ...)` dropped the previous closer on the floor, and the gate socket's close
handler was empty.

**Correct, and the teardown I did write does not cover it.** `closeThreadBackend` stops the watch,
but a reconnect never goes through `closeThreadBackend`: `ensureThreadBackendReady` re-initialises a
workspace whose engine was evicted, which is exactly what a t3code restart causes. So Tower — which
runs for days — leaked a live `fs.watch` and a WebSocket per reconnect.

Two halves, because there are two ways to leak one:

1. The block now stops any existing watch **before** installing a new one.
2. The gate socket gets a close handler that evicts its own entry, guarded on the entry still being
   the one it belongs to so a handler firing late cannot evict the watch that replaced it. Nothing
   else would do it: this socket carries no engine, so the engine's close handler never sees it.

**And it now has a test**, which the first fix did not. Reverting either half fails a named
assertion; verified both directions. A fix with no test is one line from regressing silently, and I
had written one.

## claude — three non-blocking

**`spawn.ts` claims "THREE ANSWERS" for a two-member union and lists `unowned` twice.** True. The
union has two members and `unowned` carries its reason in `detail`; the comment is rewritten to say
that, and to name the three ways `unowned` happens rather than pretending they are separate cases.

**The serialized publish queue has no direct test.** Also true. The integration walk catches a
dropped cycle indirectly — the watcher fires on the same write a caller reacts to — but indirectly
is not deliberately. There is now a test that blocks the writer mid-cycle, changes the gate while
the first cycle is in flight, queues a second request behind it, and asserts BOTH gates reached the
server in order. Reverting the serialization fails it.

It asserts on the writes rather than on which promise carries which result: `watchAgentState`
queues a cycle of its own when it subscribes, so which cycle publishes what is an implementation
detail. What the serialization must guarantee is that the gate which opened during the in-flight
write is not the one that goes missing.

**The evidence freshness guard does not watch the client's read path.** Right, and it is the half
that matters most: the whole claim is that a *client* can read the discriminant, and `envelope.ts`
is where `RpcFailureError` decides what `error` and `tag` mean. `envelope.ts` and `client.ts` are
now in the guard alongside the live script and the harness.

## Not changed

Neither lane disputed the fork-side fix, the `start-fork` verb, or the gate publisher's design.
claude verified patch 0013 independently against the fork.
