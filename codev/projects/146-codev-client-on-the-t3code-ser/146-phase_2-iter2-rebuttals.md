# Spec 146, Phase 2, iteration 2 — responses to the review

codex: **REQUEST_CHANGES**. claude: **COMMENT**. Nine findings between them,
**all nine accepted and fixed**. Nothing is disputed. Two are answered with the
verification that turned a suspicion into a measurement, and one is a mistake of
mine that the review caught and that I want recorded plainly rather than folded
into a list.

## The one that matters most: the reviewed code was never committed

claude, non-blocking, and it should have been blocking.

`envelope.ts`, `client.ts`, `subscription.ts`, the test file and the root
`package.json` were **modified-not-staged** through two porch runs and a push.
Every commit I made in iteration 2 was a `docs:` commit. I had reported the
iteration-1 fixes as committed and pushed. They were not.

**The checks were not wrong.** `porch check` and `porch done` read the working
tree, so build and tests genuinely covered that code and genuinely passed. The
*branch* did not have it. Anyone cloning `builder/spir-146` would have got the
iteration-1 defects alongside iteration-2 documentation describing them as fixed
— a worse artifact than either half alone, because the documentation would have
been read as evidence the code was there.

Fixed: all five committed (`088f8e109`). The architect filed **#153** for the
framework half — `porch done` answers "does the working tree build and pass",
while a phase transition is a claim about the **branch**, and those coincide only
when the tree is clean. Porch never checks that they are.

## Accepted and fixed — codex

### 1. `ClientProtocolError` left every pending request to time out

Confirmed. It fell to the `default:` case and went to `onOutOfBand`, so each
in-flight call waited out its own timeout on a connection the server had already
declared broken. Malformed frames had the same problem twice over: with
`onMalformed` the handler returned and the calls sat; without it the throw
happened inside the socket's message listener, where it reached no call site at
all.

Both now fail every pending request immediately — `ClientProtocolError` with a
named `ProtocolError`, malformed frames with the decode error itself. Two tests.

### 2. `decodeFrames` validated only `_tag`

Confirmed. A `Chunk` with no `values` and an `Exit` with a non-array `cause`
passed decoding and then threw deep inside dispatch, in the listener. `assertFrameShape`
now checks each known frame's required structure at the boundary, where the
failure has somewhere to go. Four tests, including the non-array cause — the
exact shape that iteration 1 corrected in the type and left unvalidated on the
wire.

### 3. `ManagedSocket` never noticed an established socket closing

Confirmed, and it contradicted the class's own documentation. `socket.ts`'s
listeners returned early once the open promise had settled, so `onDrop` never
fired for a live connection loss and `state` stayed `'open'` on a dead socket —
while `onDrop`'s doc says it fires "BEFORE any reconnect attempt, so a caller can
mark its subscriptions stale", which is the case it was written for and the only
one it did not cover.

It reports the drop now. It does **not** silently reopen: a t3code WebSocket
ticket is single-use and the caller is already holding the socket, so reopening
is the caller's decision — `ResumingSubscription` is the caller that does it. The
class comment said "a socket that reconnects", which over-claimed in the
direction that mattered; it now says what it does.

## Accepted and fixed — claude

### 4. The retry storm, measured at 88 reconnects in 100ms

The sharpest finding of the phase, and the lane measured it rather than asserting
it. My iteration-1 backoff reset the streak on `synchronized`, the sync check runs
*before* the handler-failure guard, and a handler-failure stream does synchronize
— so the guard exempted the exact path the same iteration introduced. Against a
real server each of those is a WebSocket ticket issuance plus an upgrade.

Fixed: an attempt counts as fruitless if it made no progress **or** ended in a
handler failure. Three tests — both spinning paths bounded, and one asserting a
*progressing* subscription is not throttled, because a backoff that slows healthy
reconnects is its own defect and would otherwise ship unnoticed.

### 5. The iteration-1 backoff had no test

Correct — grep for `streak` returned nothing. Covered by the three above.

### 6. The stream timeout was total-duration, not idle

Confirmed and consequential beyond this phase. A healthy subscription under
continuous traffic was torn down and resubscribed every 300 seconds, and gave up
without sending `Interrupt`, leaving server-side work running with nothing reading
it. Success criterion 11 is a gate held open at least 24 hours; a 300-second
teardown would have made that impossible **and would not have surfaced until
Phase 10 tried one**, ten phases after the cause was written.

Fixed: `streamIdleTimeoutMs`, rearmed on every chunk, sending `Interrupt` when it
fires. Tested with fake timers — five chunks 800ms apart under a 1000ms budget do
not time out; 1500ms of silence does, and emits exactly one `Interrupt`.

Named explicitly in **Phase 3's exit conditions**, because it is fixed and
unit-tested but not yet demonstrated live.

### 7. A past-the-head gap had no in-band recovery

Confirmed. The snapshot carries no sequence, so the cursor never advanced and
every attempt re-sent the same stale cursor for the same snapshot. That is
criterion D's own live scenario — a cursor surviving a restore of the server's
database — so it is the case most likely to be met, not a corner.
`reconcileTo(sequence)` moves the cursor after the caller reconciles, forward
only: accepting a lower value would redeliver applied events and let a stale
snapshot walk the cursor backwards.

### 8. The live evidence could not tell a re-run from a stale file

Correct, and the standard is one I had already applied elsewhere in this project
and not here. `146-phase2-live-evidence.json` was byte-identical whether freshly
produced or left over, so my claim to have re-run it after the envelope fix was
unverifiable from the artifact. It now carries `ranAt`, `clientCommit`,
`clientTreeDirty` and `nodeVersion`, emitted by the run rather than added
afterwards. Current file: commit `088f8e109`, clean tree, node v22.22.2.

### 9. The export map and `dist` were never exercised

Correct. Every test imports `../../../t3-client/src/*.ts` by relative path, so
Phase 3's `porch-driver` importing `@cluesmith/t3-client/client` would have been
the first thing to load them.

**Not fixed the way the finding suggests.** Adding `@cluesmith/t3-client` to
`packages/codev`'s dependencies would be wrong: codev does not use t3-client, and
`@cluesmith/codev` is published while t3-client is `private: true`, so it would
make a published package depend on an unpublishable one. Two tests instead —
every source module has an export entry, and every export target resolves to a
real source with the root `build` genuinely building the package. That second half
had already been broken once: `dist` existed only as a gitignored artifact of a
manual `tsc` in one worktree.

The packaging decision itself belongs to Phase 3 and is recorded for it:
`porch-driver` either declares its own dependency and t3-client stops being
private, or both stay internal.

## Verification

- 74 unit tests (was 59 at the start of this iteration).
- Six live scenarios re-run against the pinned server after the fixes, stamped
  with the commit they ran against: A, B, D, E, F demonstrated; C groundwork
  abstains, as it has throughout, and is discharged in Phase 3's exit conditions.
- `porch check`: build and tests pass, on a clean tree this time — verified with
  `git status`, not inferred from a green check.
