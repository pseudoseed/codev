# Phase 1 iteration 1 — rebuttals

Two lanes, both `REQUEST_CHANGES`, both `HIGH`: **claude** and **opencode** (`xai/grok-4.6`).
Both blocked on the same two items, and both were defects in my implementation rather than
readings of it.

Accepted: 2 blocking, 3 lesser. Disputed: none.

Both lanes independently confirmed what did land: the eight-status union with its payloads, the
sibling `t3codeObservation` (older servers still validate, `snapshotRejection` still keys
`older-server` on absence), the structured `ThreadIdentity.session`, attach-on-`stale`, the
precedence-correct mapping with exactly `STOPPED` and `ERROR` added, the stale rule, the
contract-derived enumeration test, and the untouched phase-11 tripwire.

---

## 1. Criterion 5 had no code

**Both lanes, blocking.**

**Verified in my own source.** `deriveRowStatus` read `identity.session === undefined` and
went straight to `sessionUnobservable`. It never looked at `threadId` or `backing`, both of
which the client type carries.

**Why this mattered more than a missing branch.** A terminal-backed row has no t3code thread, so
no session can ever be attached to it — and *every architect and builder row in `global.db` is
terminal-backed today*, a fact the spec itself records. On a machine reporting `available`,
every one of those rows rendered **"t3code returned no state for this thread"** about a thread
it does not have. That is not a missing answer, it is a wrong one: it sends a reader to look for
a thread t3code lost when nothing is lost and nothing is wrong. opencode put the timing exactly
right — phase 2 marking a workspace `available` is what would have made this visible, so it
would have shipped as a phase-1 gap discovered in phase 2.

**Changed.** A branch before the session check, keyed on `identity.threadId` — the field a
session is joined on server-side — carrying its own `why` and `whyIsRowSpecific: true`.

Placed **after** the porch gate, deliberately, and there is a test for that ordering: a
terminal-backed row can still be blocked on a gate, and today that gate is the only live signal
such a row has. Reporting it as merely thread-less would hide the one current thing about it.

**And the fixture that was hiding it.** Claude's verification pass found the sharper half:
`multi-machine.test.tsx` built the suite's only terminal-backed rows and gave each one a
`session` while omitting `threadId` — **a shape the server cannot produce**, because
`readThreadRegistry` attaches a session by joining on the thread id. The one fixture modelling
production's actual row was masking the gap rather than exposing it. Fixed, and `derive.test.ts`
gained a `terminalRow()` helper so the case is constructible at all; five tests now cover it,
including that its reason is distinct from all six machine-level reasons *and* from the
row-specific "returned no state for this thread".

## 2. `t3codeObservation` dropped `message` and `since`

**Both lanes, blocking.** Claude framed it as a plan deviation, opencode as a payload that
"still dies at the registry". Both are accurate; the plan said to carry them and I did not.

**Verified.** `observationOf` returned `{}` for every status except `available` and `stale`, and
`T3codeObservation` had no `message` field. So `cooling-down` reached the client as a bare word
— waiting, with no when and no why — and `misconfigured`'s account of *which* half of the
`threads` block is written reached it nowhere at all, since the registry deliberately emits no
`T3CODE_UNREACHABLE` signal for it. An operator told only "your configuration is incomplete" has
to go and diff the file to learn what this process already knew.

**Changed.** Every member of `T3codeObservation` is now optional, because different statuses
have different things to say and a status with nothing to add carries no observation at all —
which is not the same as carrying an empty one. `observationOf` emits `message` for
`unreachable` and `misconfigured`, and `message` plus `since` for `cooling-down`.
`MachineSubtree` renders them.

One decision inside the fix that neither lane specified: **`observedAt` and `ageMs` validate as
a pair.** Half of them is a payload the client cannot read, not a partial answer to make the
best of — an age with no time it was taken cannot be sanity-checked, and a time with no age
would invite the client to subtract it from its own clock, which is a different clock and the
whole reason the server computes the age. `agePhrase` keys on `ageMs === undefined` so a missing
age still reads as "an unknown length of time ago" rather than as zero.

## 3. No render tests for the new notes and stamps

**claude, non-blocking ("consider").** Taken, because the property at stake is one this phase
argued for rather than a nice-to-have: each unobservable status must send a reader somewhere
different, and that only holds if the six sentences are actually different.

**Changed.** `fidelity.test.tsx` gained tests asserting all six notes are pairwise distinct,
that `available` prints none, that `cooling-down` carries its when and why, that `misconfigured`
names the half-written part, that `stale` reports its age, and that a missing age reads as
unknown. Plus a test that `STOPPED` and `ERROR` render as their own stamps with different
classes, and that an errored session on a **settled** thread still reports `error` — the
laundering case.

Worth recording how that test first failed: it passed on **one sentence repeated six times**,
because `renderMachine` leaves earlier renders in the document and a `document.querySelector`
returns the first. Scoped to the returned container. A test that would have passed while proving
nothing is the same defect class this phase is about, one layer up.

## 4. `apps/client/tsconfig.json` leaves `__tests__` untypechecked

**claude, non-blocking.** Verified: `include: ["src"]`, so `tsc --noEmit` in `apps/client` says
nothing about the test fixtures — and several annotated `ThreadIdentity` while omitting the
required `backing` field.

**Changed the fixtures, not the config.** Every fixture now carries `backing`, so it is a shape
the server can emit. I did not widen the tsconfig `include`: that is a build-configuration
change with unknown blast radius across a suite this phase does not own, and it is the sort of
thing that belongs in its own change rather than smuggled into a feature phase. Recorded in the
thread so the next person knows a green `tsc` there is not a statement about the tests.

## 5. "Not verified: no test suite was executed"

**claude, stated as a limit on its own review rather than a finding.** Recorded here because it
is the right thing to have said: that lane read source and said so instead of implying it had
run anything.

For the record on this side: `apps/client` is **203 passing**, and the two server files touched
(`spec-236-snapshot-vocabulary.test.ts`, `spec-146-phase-11-production-wiring.test.ts`) are
**33 passing**. The full `packages/codev` suite ran green through porch's own `build` and
`tests` checks before this iteration, and runs again on `porch done`.

One thing that cost real time and is worth leaving behind: a fresh builder worktree has no
`node_modules` and no build outputs, and **the absence of `packages/codev/skeleton/` fails 18
test files / 80 tests** that have nothing to do with any change — protocol resolution silently
falls back, and it surfaces as `Unknown review type "pr" ... protocols available here: "impl"`.
`packages/codev/dist/` similarly fails the shellper integration tests and the publish-scrub
test, the latter of which at least names itself as a missing build artifact. `pnpm install` then
`pnpm -w run build` clears all of them. I nearly reported those 80 as a regression.

## What I did not change

Nothing was disputed. Both lanes were correct on every point.
