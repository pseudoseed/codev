# Spec 146, Phase 3, iteration 2 — responses to the review

Both lanes returned **REQUEST_CHANGES**. Seven findings across the two, counting
the four one lane marked non-blocking. **Every one is accepted and fixed.
Nothing is rebutted as wrong.**

Two of them are the same finding reached independently, and it is the one that
matters most.

## The blocking one, found by both lanes

### 1. `recoverPendingCommands` recorded every failure as `failed`

Iteration 1 split refusal from unanswered in `dispatchCommand`. Twenty lines
below it, the recovery loop kept journalling `failed` for any error at all.

`pending()` drops any `commandId` that has an outcome, so a `NotConnectedError`
during recovery marked the intent settled and it was never re-dispatched again.
One lane went further than reading it: a scratch test seeded one pending intent,
ran recovery against a dispatcher throwing `NotConnectedError`, and re-read the
journal — `pending()` returned `[]` where it had to return `['cmd-1']`.

The sharper half of the finding is *where* this sits. Recovery runs immediately
after a crash, which is exactly when the server may still be coming up. A dead
socket there is the expected case, not the exotic one — so the loop whose entire
job is not to drop a command was the one most likely to drop it.

**Fixed:** the same `isServerRefusal` split, in the same shape, with the reason
written where the code is rather than only in the sibling function. Two tests,
because the two outcomes are different facts: a refusal settles the intent, an
unanswered command stays pending and a second recovery re-dispatches it under the
same id. Both are mutation-checked.

**What this says about the iteration-1 fix.** The split was applied where the bug
was reported and not where the same reasoning applied. Reviewing my own diff for
"the other caller" is the step that was missing, and grepping for the predicate —
`isServerRefusal` had exactly one call site — would have found it in seconds.

## Accepted and fixed — codex

### 2. Role injection was not implemented

Correct, and the comment made it worse: `turn.ts` said the role prompt is
delivered as the first turn's text, while `DriverThread` took `roleContent`,
wrote it to `.builder-role.md`, and never sent it anywhere. The live harness's
first turn carried only `TURN1_READY`, which is the evidence that the deliverable
was half-met — the human-readable half.

**Fixed:** the thread holds the role from `create` and composes it into the text
of whichever turn starts first (`#startTurnWithRole`), covering `runTurn` and
`beginTurn` both. `roleDelivered` exposes whether it has gone.

**The ordering decision, since it is not obvious.** The role is consumed only
*after* the start command is accepted. Of the two ways to be wrong — an agent that
receives its role twice, or an agent that never receives it — only the second
leaves a builder working with no instructions, so a turn that failed to start
leaves the role pending for the retry. There is a test for exactly that.

### 3. `observe()` was not idempotent

Correct, and my comment asserted the opposite: it claimed `assistantText` would
tolerate a duplicate "because it filters by sequence range". A range filter admits
*both* copies of the same sequence. So a replay during a turn returned the
assistant's text twice and burned two slots of the retention cap for one event —
`textTruncated` could go true without a single event having been lost.

This is not an edge case in this design. The cursor advances after the handler by
construction, which makes at-least-once delivery the contract the class is built
on, and every replay crosses that line.

**Fixed:** `observe` discards a redelivered event rather than tolerating it, keyed
on `eventId` when the server sent one and the sequence otherwise. The key set is
evicted alongside the events, so it stays bounded by the cap rather than by the
session's lifetime. Two tests: the text is applied once, and the cap is not
consumed twice.

**A comment that states a property the code does not have is worse than no
comment**, because it tells the next reader the case was considered. Both of the
last two rounds have turned up one. Where a comment claims a property, there
should be a test named for it.

## Accepted and fixed — claude, non-blocking

### 4. The plan record was stale

It said 57 tests and 21 mutations; the tree had 69 and 29. Now 78 and 37, written
from the tree. The line also now says why it keeps moving, so the next reader
knows to distrust a count from an earlier round rather than treating it as a claim
about coverage that someone made deliberately.

### 5. `maxOutputBytes` capped UTF-16 code units, not bytes

`combined.length`, so a 4 MiB cap held about 8 MiB of astral output — wrong in the
direction that matters, and only for the output most likely to be large. Now
`Buffer.byteLength`, with the tail cut on a character boundary so a truncated log
does not open with a replacement character.

**The test size is the test, again.** My first version used 200 emoji and passed
against the bug: the *trim* was already byte-based, so at that size both readings
truncate. A code-unit cap only escapes in the window where the units still fit and
the bytes do not — 40 emoji is 80 units against a cap of 100 and 160 bytes against
the same 100. The mutation harness caught the green that meant nothing; that is
the third instance of this rule across three phases, and it is why the harness
exists.

### 6. `chunk.toString()` could split a multi-byte sequence

Correct. A `data` chunk is a byte boundary, not a character boundary. Now
`StringDecoder`, which holds the partial sequence until its remaining bytes
arrive.

Same problem with the test, and the same fix: 64 KiB of ASCII followed by an emoji
splits nothing — the emoji arrives whole in its own chunk and the test passes
either way. The command now writes the first two bytes of the sequence, waits for
the reader to consume them, and writes the last two. Mutation-checked.

### 7. A JSON merge failure was silent from `DriverThread.create`

`applyWorktreeSetup` leaves an unparseable `opencode.json` alone rather than
destroying a user's config, and reports it through `onWarning` — which `create`
never passed. So the module's own rule, that an absent guard is reported and never
silently skipped, was not applied one call up.

**Fixed:** `create` collects the warnings onto `thread.setupWarnings` and forwards
them to an optional `onSetupWarning`. Retained either way, so the skip is never
silent in both places at once.

## Evidence

- `npm test`: see the phase commit; the phase file is **78 tests**, up from 69.
- `codev/research/146-phase3-mutation-check.py`: **37 properties, all red without
  their fix.** No `SKIP`, no `STILL PASSES`. Tree verified clean afterwards.
- `codev/research/146-phase3-live-evidence.json` regenerated from a clean tree at
  the fixed commit, so the first turn it records is the one that now carries the
  role.

## Nothing landed mid-round this time

Both lanes had finished and written their verdicts before the first edit. The
disclosure sections in the last two rounds exist because that was not true then.
