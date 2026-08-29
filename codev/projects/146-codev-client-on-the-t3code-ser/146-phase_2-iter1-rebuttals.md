# Spec 146, Phase 2, iteration 1 — responses to the review

Both lanes returned **REQUEST_CHANGES**. Every blocking finding is accepted and
fixed. Nothing is rebutted as wrong; two items are answered with a correction that
goes further than the finding did.

## Accepted and fixed

### 1. A failing handler silently skipped its event — BOTH LANES, blocking

`subscription.ts`. `enqueue` swallowed handler rejections and `queuedThrough` had
advanced at enqueue time, so event 10 failing while 11 succeeded left the cursor
at 11 and event 10 gone, with no signal. One lane reproduced it rather than
inferring it.

Accepted without reservation. It falsified three written claims — `resume.ts`'s
"the cursor does NOT move, so the item is redelivered", `subscription.ts`'s
"at-least-once … load-bearing", and the plan's Phase 3 cursor deliverable.

**Fixed:** a handler failure sets a marker; nothing later in that stream is
enqueued or applied; `onHandlerError` reports it; the transport is closed so the
resubscription redelivers from the last successfully applied sequence.

**Test gap, also accepted.** The existing test failed the handler on the *last*
event before a drop — the one arrangement in which the bug cannot appear. Two
tests added: 10 fails while 11 succeeds in the same stream (asserts the resume
asks for `afterSequence: 0` and 10 is redelivered before 11), and a stream where
nothing after a failed handler is applied at all.

### 2. The envelope did not match Effect 4 beta.103 — codex, blocking

Three errors, all confirmed against
`effect/src/unstable/rpc/RpcMessage.ts` at beta.103:

- `ExitEncoded` (`:257-275`) declares `cause: ReadonlyArray<{Fail} | {Die} |
  {Interrupt}>`. It was typed as a single object, so `cause._tag` was `undefined`
  and `RpcFailureError` carried no kind and no tag — the named error built *for
  Phase 3 to branch on* could not have been branched on.
- `ClientProtocolError` is in `FromServerEncoded` (`:192-197`) and was rejected as
  an unknown tag, turning "your protocol is wrong" into "this connection is
  unreadable".
- `ClientEnd` is in `FromServer` — the *decoded* union — not `FromServerEncoded`,
  and was being accepted.

**Fixed:** `CauseEntry` array, `ClientProtocolErrorFrame` added, `ClientEnd`
removed with a comment saying why it is absent. `RpcFailureError` now takes the
whole cause and exposes `error`, `tag`, `interrupted` and `died`, finding the
first `Fail` rather than assuming there is one entry.

My own tests fed a single-object cause, so they agreed with the code because they
shared its mistake. Rewritten, including a case where an `Interrupt` travels
alongside the `Fail` — the reason the field is an array at all.

**The deliverable said these shapes were "validated against `RpcMessage.ts` as the
reference" and I had ticked it.** The reference was on disk. I cited it without
reading it.

### 3. Named errors became reconnect attempts — codex, blocking

The `catch {}` around the stream caught everything, so a `PayloadShapeError` or an
`RpcFailureError` turned into an endless resubscribe that looked like a quiet
connection.

**Fixed:** known terminal errors (`PayloadShapeError`, `RpcFailureError`,
`UnresolvedRefError`, `UnsupportedKeywordError`) throw `SubscriptionTerminatedError`
from `run()`; anything unrecognised still retries. This is a deny-list where codex
suggested an allow-list ("retry only connection-loss errors"), and the choice is
deliberate: an unrecognised error on a socket is far more often a transport hiccup
than a contract violation, and mis-retrying wastes time while mis-terminating
strands the subscription. `isRetryable` is exposed so a caller wanting the stricter
direction can impose it.

### 4. `packages/t3-client` was never built by the root script — claude

Confirmed. Its `exports` point at `./dist`, the root `build` filtered only
`codev-artifact-canvas` and `codev`, and the only `dist` in existence was a
gitignored artifact of a manual `tsc` in this worktree. A fresh clone or CI would
not have it, and Phase 3 importing `@cluesmith/t3-client/client` would have failed
to resolve. Added to the root `build`.

### 5. Hot resubscribe loop — claude

`delayBetweenAttemptsMs` defaults to 0 and `ManagedSocket`'s backoff only covers a
socket that fails to *open*, so a server ending streams instantly on an open
socket spins. **Fixed:** backoff grows on a streak of streams that delivered
nothing and synchronized nothing, capped at 5s, and resets the moment one
delivers, so an ordinary reconnect pays no penalty.

### 6. The ack could throw inside the message listener — claude

Correct, and it sat directly above the fix for exactly that hazard in
`#checkInbound`. Now best-effort, with the reason recorded: a dropped socket has
already failed every pending request through `#onClose`, so there is no one left
to ack to.

## Answered with a correction

### Scenario B is thin — claude, non-blocking

The finding is that 2 acked against 1 suppressed is not the "more chunks than the
server's buffer" the criterion describes. The evidence is not thin; **the
criterion was wrong.**

`RpcServer.ts:401-404` creates a `Latch` per request. `419-421` and `438-440`
close it after **every** write and await the ack before the next one; `192-193` is
the ack opening it. The window is exactly one chunk. There is no buffer of any
depth to exceed, so an unacked client stalls after its *first* chunk and 2-vs-1 is
the largest difference the mechanism can produce.

The plan's criterion has been corrected to say so rather than the evidence being
padded to meet a description of a mechanism t3code does not have.

### Criterion C deferral needs architect confirmation — claude, non-blocking

Already confirmed, twice, before this review ran. The architect ruled the move on
2026-08-28 and confirmed the disposition again after verifying `ws.ts:1493-1497`
independently. **Criterion D is no longer deferred** — it was discharged live in
this phase once the cursor-ahead-of-head trigger was found, with the *server*
choosing the snapshot path. Only C remains, in Phase 3's exit conditions, and the
architect's wording is recorded in the plan: it stays Phase 2's criterion so it
cannot dissolve into Phase 3's own work.

## One lane's claim that was wrong

claude's "what's solid" section states: *"All ten wire shapes are modelled against
`RpcMessage.ts`."* That is the exact claim codex proved false. One lane
corroborated the error instead of catching it.

Recorded because it bears on the standing order: two lanes agreeing is weaker than
three, and here they did not agree — the disagreement is what surfaced the
envelope. Had only claude run, the `cause` shape would have shipped, and the first
Phase 3 test to branch on `OrchestrationCommandIdConflictError` would have found
`tag` returning null with no obvious cause.

## Verification

- 59 unit tests pass (was 52; +7 for the handler-failure arrangements, the
  terminal-error classification, and the corrected cause shape).
- Six live scenarios re-run against the pinned server with the corrected
  envelope: A, B, D, E, F demonstrated; C groundwork abstains as before.
