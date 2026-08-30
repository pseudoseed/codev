# Phase 2 iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH`: **claude** and **opencode**
(`xai/grok-4.6`). They found the same two bugs independently, and both were real.

Accepted: 2 blocking, 3 lesser. Disputed: none.

Both confirmed what landed: the split between the background maintainer and the synchronous
reader, the reader touching neither the connector nor the database, the connector's kinds
reaching the wire as themselves, `observedAt` as liveness rather than event cadence, the thread
set re-read each sweep, the phase-11 tripwire inverted in place with both assertions, and the
README matching.

---

## 1. An unobserved thread was published as `available`

**Both lanes, blocking.** opencode's phrasing is the one to keep: *"A placeholder is not an
observation."*

**Verified in my own source.** `#sweepWorkspace` created the cache entry at the moment it opened
the subscription and seeded `observedAt` with the creation time. `#observed` then computed
`ageMs ≈ 0` for it, so between opening a subscription and the first frame arriving, `snapshot()`
answered `available` — the machine claiming to have observed a thread that nothing had observed.

claude added the sharper detail: because the entry is created unconditionally, this is not a
startup transient. Any thread whose subscription is slow, or whose `stream()` throws, sits in
that state.

**Changed.** `observedAt` is now `observedAt?: number`, `undefined` until a frame lands, and
`#observed` skips an entry that has none.

One thing neither lane named, which fell out of the fix and is the same bug in the mirror: the
drop path stamped `observedAt = now()` unconditionally. A subscription that ended *without ever
delivering a frame* would therefore have stamped one, turning "never seen" into "seen just now,
then lost" — and then aged that fiction into `stale`. It stamps only when something was actually
observed, and there is a test for it.

## 2. A ready backend with no threads reported `connecting` forever

**Both lanes, blocking.** This is the more serious of the two, because it is not an edge case:
it is the state *every real workspace is in today*.

**Verified.** `#observed` returned `null` for an empty result and the caller fell through to
`{ status: 'connecting' }` for anything that was not `cooling-down`. No row in `global.db`
carries a `thread_id`, so a connected, healthy, correctly configured Tower would have reported
"this server is still connecting to t3code" (`derive.ts`'s wording) for as long as it ran.

opencode put the principle exactly: *"`connecting` is the connector's word for a connect in
flight. Using it when the connector already said `ready` is the collapse the eight-status set
exists to prevent."* I built the eight statuses to stop precisely that and then did it myself in
the provider that feeds them.

**Changed.** A `ready` backend with no thread ids reports `available` with an empty thread list —
connected, and there is nothing here to watch, which is an observation this process made when it
read the thread set. Each row then says why *it* has no session, which is the honest place for
that answer.

The distinction between the two empty cases is kept: threads that exist but have not answered
yet stay `connecting`, because that one resolves on its own.

**And the fix I got wrong first.** I keyed "nothing to watch" on `cache.threads.size`. That is a
different number from the thread-id count, because `#observed` deletes an entry when its content
is discarded for age — so a workspace that HAS a thread whose content had aged out would have
reported having none, converting a discarded observation into an assertion that there is nothing
to observe. The discard test caught it within a minute. Keyed on the count the sweep read, with a
comment saying why the two are not interchangeable.

## 3. Two plan-named tests were missing

**claude named both; opencode named the second and its consequence.**

**Verified, and the consequence is the part worth recording.** Both lanes observed that the
`buildAgentProtocolSnapshot` integration test the plan called for *would have caught both bugs
above*. That is not a coincidence — it is the one test that asks what a client actually receives,
and its absence is why two false statuses shipped past a suite of 26 passing tests. The recurring
defect in this initiative is code that passes its tests and that production never reaches, and I
skipped the test that closes that gap while writing tests about the gap.

**Changed.** Added both:

- **The real connector.** Every other test injects `availabilityFor`, which proves nothing about
  `requestThreadBackend`. The new one drives a temp workspace with no `threads` block through the
  real connector and asserts `not-configured` **and** that the streamer was never reached — no
  subscription, no connect, which is the plan's deliverable stated as "asserted by no connect
  attempted, not by the status alone".
- **`buildAgentProtocolSnapshot`.** Three cases: an observed session reaching the row that
  carries the thread, a terminal-backed row getting no session even while t3code is observed
  (criterion 3's bound, asserted rather than described), and `not-configured` travelling through
  the route — which is where it and `not-provided` used to be one fact.

## 4. `unreachable` cannot be produced by this provider

**claude.** Verified: `ThreadBackendAvailability` has no `unreachable` kind — a failed connect
becomes `cooling-down` — so Tower's provider can never emit it, while the README listed it in
the same breath as the statuses Tower does emit.

**Changed, not dropped.** The status stays: `tools/codev-agent-host` and any future host may
observe unreachability another way, and `thread-registry.ts` still signals on it. What was wrong
was the README implying Tower produces it. It now carries a table of the seven Tower emits and
says plainly that `unreachable` is not one of them, with the reason — a failed connect becomes
`cooling-down`, which says more.

## 5. "The 6967/205 suite claim remains the builder's, unverified by me"

**claude, stated as a limit on its own review.** Recorded because it is the right thing to have
said rather than implying execution it did not perform.

For the record after these fixes: `packages/codev` is **6975 passing, 0 failing**, 3 files and 52
tests skipped; `apps/client` is **205 passing**. Both typecheck clean. The phase-2 cache file
alone is 34 tests.

## What I did not change

Nothing was disputed.

One non-blocking observation from opencode I am leaving as-is with the reasoning recorded rather
than acted on: re-subscription after a drop happens on the next sweep rather than through
`packages/t3-client`'s `ResumingSubscription`, and only the ageing is tested. That is deliberate.
`ResumingSubscription` resumes with `afterSequence` to avoid losing events, which is the right
tool for a consumer that must not miss any; this consumer holds a *current-state* cache, so a
full snapshot on reconnect is not a loss — it is the better content. Using it would also require
each subscription to own a transport, and opening one costs a bootstrap-token exchange that a
pairing-issued token only permits once. opencode reached the same conclusion ("fine for session
state"), and the module header says so.
