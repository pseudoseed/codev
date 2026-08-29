# Spec 146, Phase 2, iteration 3 — responses to the review

codex: **REQUEST_CHANGES**, four findings. claude: **REQUEST_CHANGES**, one
blocking and three non-blocking. **Eight findings, all eight accepted and
fixed. Nothing disputed.**

Two rounds now with no rebuttals, which is worth naming rather than letting it
read as a good sign by default. Every finding this round named a file and a line
range, and I opened each one before accepting it: three were wrong about nothing,
and the two that made claims about the *server* (`ws.ts:1492-1526`,
`RpcMessage.ts:232` and `:256-273`) I checked against the vendored source rather
than against the review text. A round is only "good" if the findings were
checkable, and this one's were.

## The blocking one: the recovery added in iteration 2 could not run

claude, and it reproduced it against the real module rather than asserting it.

`reconcileTo` was added in iteration 2 to make a past-the-head gap recoverable in
band. It is forward-only. The past-the-head gap is, by construction, the case
where the server's head is **below** the cursor — `ws.ts:1492-1526` computes
`replayGap = headSequence - afterSequence` and takes the snapshot path when that
is negative. So every value a caller could reconcile to is below `applied`, the
early return fires, and the call is a no-op. **The recovery could not run in the
one scenario its own doc comment names.**

The second half is worse than a failed recovery. `queuedThrough` starts each
attempt at `#cursor.applied`, so with the cursor stuck at 5,000,000 every live
event a restored server emits is discarded as already-queued: no `onValue`, no
`onHandlerError`, no second gap, because the stream is synchronized and healthy.
One gap reported, then permanent silence that looks like a quiet thread. That is
"I could not tell" spelled exactly like "nothing happened", in the module written
to keep those two apart.

Fixed with `resetTo(sequence)`: allowed to move in either direction, persists the
reconciled position, and closes the in-flight transport so `queuedThrough` is
re-derived on the next attempt. Kept **separate** from `reconcileTo` and
deliberately named, because a backwards move must be something a caller chooses,
never something a late snapshot does to it by accident. `reconcileTo` stays
forward-only and the test that pins that behaviour stays.

**This is the third shape again** — a fix that made an unreachable defect
reachable — and it is the second time in two iterations that `reconcileTo` is the
thing that did it. The first was `SequenceCursor.apply`, which had been
non-monotonic forever behind a caller that filtered duplicates. The catching
question stays the same: what does this fix make newly possible?

The covering test was pointed one case to the left, exactly as the lane says: it
reconciled 5,000 → 9,000, which is the `replayGap > 1000` branch, while its
comment claimed it was criterion D's ahead-of-head scenario. **A test can be
correct, run, pass, and still be pointed away from the bug** — and a comment
naming the right scenario over a test exercising the wrong one is the version of
that which survives review, because the reader checks the comment.

## Accepted and fixed — codex

### 1. `onResume` fired before the handlers it describes had run

Confirmed. It was called synchronously inside the stream callback the moment the
synchronized marker arrived, while every `onValue` — the snapshot's included —
was queued on the chain. A caller reacting to a `gap` by reconciling therefore
moved the cursor before the snapshot handler had run, and a failure in that
handler left the cursor past data never applied.

Fixed by computing the outcome where it is final (`catchUp` stops growing once
`synchronized` is set) and delivering it through `enqueue`, so it lands behind the
handlers and is suppressed when one has already failed. This also closes claude's
non-blocking finding 3: `lastSequence` on the non-resume path is now read at
delivery instead of at synchronization, so it can no longer report 0 with items
present.

### 2. `ProtocolError` and `MalformedFrameError` were retryable

Confirmed. Both say the connection cannot be **read**, not that it was lost, so
resubscribing re-runs the same decode against the same server and fails the same
way. That is the quiet reconnect loop iteration 1 removed for validation errors,
reintroduced by the failure paths iteration 2 added — `ClientProtocolError` now
fails the stream with `ProtocolError`, and the subscription retried on it.

Both added to `TERMINAL_ERROR_NAMES`, one test each.

### 3. `stop()` during backoff hung `connect()` forever

Confirmed. `stop()` cleared the retry timer and nothing resolved the promise the
connect loop was awaiting. Not a rejection — a hang, which is invisible to any
caller without a timeout of its own.

Fixed: the backoff sleep's resolver is held, `stop()` resolves it, and the loop
re-checks `#stopped` after the delay and throws.

### 4. The envelope still accepted shapes `RpcMessage.ts` excludes

Confirmed against the vendored source, not against the review text.
`ResponseChunkEncoded.values` is `NonEmptyReadonlyArray<unknown>`
(`RpcMessage.ts:232`), so an empty array is not a chunk that carried nothing — it
is a frame the contract does not allow, and accepting it means acking a delivery
that never happened. Cause entries are `Fail{error} | Die{defect} |
Interrupt{fiberId}` (`:256-273`), so `[{}]` passed the array check and then
produced an `RpcFailureError` with no kind and no tag: **the exact symptom
iteration 1 fixed in the type and left unenforced on the wire.**

Both now rejected at the boundary. `Interrupt` is checked on `_tag` alone,
because `fiberId` is `number | undefined` and JSON drops an undefined field, so
requiring the key would reject a valid frame.

## Accepted and fixed — claude, non-blocking

### 5. `reconcileTo` never persisted the reconciled position

Correct. A crash after reconciling resumed from the stale cursor and repeated the
whole snapshot cycle. Both `reconcileTo` and the new `resetTo` persist now.
Phase 3 persists cursors and would have inherited this.

### 6. A shape-check-rejected stream sent no `Interrupt`

Correct, and it is the hazard the idle-timeout fix closed one branch over. We
abandon the request precisely because we cannot read what is arriving, so there
is no prospect of it fixing itself; leaving it uninterrupted keeps the server
producing for a reader that has gone.

### 7. Non-resume `onResume` could report `lastSequence: 0` with items present

Correct, and fixed by the same change as finding 1.

## Verification

- 86 unit tests (75 before this iteration).
- Every fix in this round is checked by
  `codev/research/146-phase2-mutation-check.py`: revert one fix, run its test,
  restore. A test that stays green without its fix is reported as such.
- Live scenarios re-run after the envelope was tightened, because a stricter
  boundary is exactly the change that can reject something a real server sends.
