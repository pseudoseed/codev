# Phase 7 — iteration 3 rebuttals

Lanes: **claude APPROVE**, **codex REQUEST_CHANGES**.

Nothing disputed. Codex's finding is accepted and fixed in `5583e8fc3`.

---

## Tree check, with its own weakness stated

Run before counting either verdict, as this phase's rule now requires:

- `HEAD` before and after: `031193b589eb4857d86b1ccb843ad0b01614320e` — **unchanged**.
- **No tracked file modified**, in either capture.
- Untracked set identical between captures.

**The caveat, because the check is only worth what it actually proves.** The BEFORE capture
already listed the two lane log files, and its mtime says it was written after those
redirect targets existed. So the *untracked* half of that comparison does not prove those
files were absent beforehand — they are this builder's own redirect targets in any case. The
HEAD comparison and the no-tracked-modification check stand on their own; nothing more is
claimed here. **Next round: capture the baseline before creating any redirect target.**

## An open stream kept access after its credential was revoked — ACCEPTED, fixed

**Finding:** `workspace-stream` authenticates only when the SSE connection opens.
`openAgentStateSse` then streams indefinitely without rechecking, so a revoked, expired or
replaced credential retains protocol-state access through any existing stream. The e2e only
revoked and then made a new `/state` request, so it misses this path.

**Verified against the files before acting**, and correct in every part.

**Authentication at the handshake is not authentication for the connection.** A stream that
checks once and then runs for hours is a credential that cannot be revoked. Success
criterion 15 says the revoked machine's subtree fails closed, and an already-open stream
**is** that subtree. The existing coverage exercised the path that already worked — revoke,
then make a new request — which is why nothing caught it.

**The fix, and why it is two schedules rather than one.** `stillAuthorized` is re-checked
before every write *and* on a timer, and it needs both:

- before every write covers a **busy** stream promptly;
- the timer covers an **idle** one. A revoked device holding a quiet stream is still holding
  a live channel, and an event-driven check alone would never see it.

Deleting either leaves a real gap, which is why the reason is in the code rather than here.

**Losing authorization is announced before the socket closes**, carrying the code that says
why. A stream that simply goes silent is indistinguishable from a network failure, and "your
access was withdrawn" is not the same instruction as "your connection dropped". An
unreadable store terminates the stream too: "I could not tell" is not a reason to keep
delivering protocol state.

**The test opens the stream first and revokes underneath it** — the path that was broken,
against a live server. It takes 5012ms, which is the re-authorize interval, so the timer is
demonstrably what closed the stream rather than a coincident write.

**One bug found while writing it**, and the comment stays in the file: `watchAgentState`
emits its opening snapshot **synchronously**, so termination can run before the
`subscription` binding exists. A credential already revoked when the stream opens hits
exactly that dead zone.

## What codex found across this phase

Three real security defects, in three iterations:

1. **The keyless-route gap** — a paired device could reach nothing, so the documented
   bootstrap could not run.
2. **A process-exit crash reachable from an unauthenticated request** — pairing redemption
   threw out of an uncaught promise, and Tower answers that with `process.exit(1)`, taking
   every builder terminal on the machine with it.
3. **This un-revocable stream.**

**Every one was a path no test covered, because the existing coverage exercised the path
that already worked.** That is the pattern, and it is the same one this spec has hit
repeatedly under other names: a check that agrees with the assumption it was written to
challenge.

## State

Build exit 0. **6621 tests passed**, 50 skipped, plus 180 in codev-v2. The e2e suites are
excluded from `npm test` and run separately: 6 in the phase-7 suite, 7 in bridge-mode.
Everything committed and pushed.
