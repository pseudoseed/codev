# Phase 5, iteration 1 — review context

Hand-written, because porch generates a context file only from iteration 2 onward.

## Who wrote this and who is asking

**I did not implement this phase.** `builder-task-uxln` wrote the bulk, the architect
committed it by hand when that harness hit its quota mid-phase, and `builder-air-156`
finished the failure matrix and tests. My role on phase 5 is **reviewer and
integrator**, so treat my claims below as a reviewer's notes to check, not as an
author's account of their own work.

It is already merged to `main` as `e710c97d6` (PR #161, issue #156).

## An architecture ruling shipped inside this phase — verify it, do not assume it

`watchAgentState` could **permanently miss a state change**. Evidence was 8 full
agent-farm suite runs, 7 clean, 1 failure that named its own cause:
`WATCHER_NEVER_FIRED diagnostics={watchStarted:2, watchErrors:0, scheduleCalls:0,
snapshotCalls:1}`. Both watchers created, no errors, callback never fired. On macOS,
`watch()` returning is not FSEvents being live; arming is async and unobservable from
Node.

I ruled: **server-side reconciliation backstop, plus an immediate reconcile after
arming.** Full reasoning in `codev/research/146-phase5-state-stream-ruling.md`.

Two parts of that ruling are worth attacking rather than accepting:

1. **Does a server-side poll violate "no polling"?** I ruled it does not. Both
   statements are the *plan's*, not the spec's, and both are client-scoped: *"so the
   client does not poll"*, *"a connected client receives the change without polling"*.
   The constraint protects the client-to-server link — an iPad over a tailnet must not
   hammer a Mac to learn nothing changed. **If you think that reading is
   self-serving, say so.** It is the load-bearing sentence of the ruling.
2. **Is auto-repair consistent with "disagreement is reported, never auto-resolved"?**
   I ruled that rule governs `status.yaml` vs *thread state* — two authorities, where
   resolving means picking a winner. The stream vs `status.yaml` is a cache and its
   source. Check that distinction holds; if it does not, the reconciler is a spec
   violation and I got it wrong.

## What I verified myself, so you can spend your effort elsewhere

Checked in the code at HEAD, not taken from commit messages:

- `rebuildWatchers` now runs **before** `emitSnapshot`, and `reconcile()` fires
  immediately after arming. The previous ordering snapshotted *then* armed, which
  opened a guaranteed gap on every connect independent of the macOS lag.
- `RECONCILE_INTERVAL_MS = 5_000` is a named constant; the interval is `unref()`d.
- `PROTOCOL_STATE_RECONCILED` is a distinct event type from
  `PROTOCOL_STATE_SNAPSHOT`, so a silent repair is distinguishable from a working
  watcher.
- The failure matrix has **12 rows**, covering all 9 the plan requires plus
  `ROOT_MISSING` and `STREAM_PROJECTION_REPAIRED`. Each states signal, client
  rendering and whether it auto-resolves. `THREAD_ID_DISAGREEMENT` is **Never**.
- `status-reader.ts` path containment is real: direct
  `codev/projects/<project>/status.yaml` children only, symlinks rejected,
  `realpathSync` re-checked after resolution, 1 MB cap.
- The human-paired session is genuinely defined — human-client principal only, hashed
  verifier compared with `timingSafeEqual`, dies on restart, 8 h ceiling / 1 h default
  / 30 min idle, six distinct recognition reasons.

## A GAP I FOUND, disclosed rather than left for you to catch me on

**The `status.yaml` unreadable row has no test that fails when it collapses.**

The matrix says *"`status.yaml` unreadable → `STATUS_UNREADABLE`, named project marked
unreadable, not missing"*. I disabled the `EACCES`/`EPERM` branch in
`readScopedStatus` — so an unreadable file falls through to `STATUS_MALFORMED` — and
**all 3619 agent-farm tests still passed.**

The test named `status.yaml unreadable emits STATUS_UNREADABLE` chmods the **projects
directory**, which exercises `readStatusesFromArtifactRoot`'s `readdir` branch. That
is a different code path from reading the file. So the row's actual claim is
uncovered, and an unreadable `status.yaml` would render as *malformed* — telling an
operator their file is corrupt when it is a permissions problem. Different diagnosis,
different fix.

I have not fixed it; routing is with the architect. **Check whether any other row has
the same shape** — a test whose name matches a row while its body exercises a
neighbouring path. That is the failure mode I most want a second pair of eyes on,
because it is invisible to a green suite.

## How I verified the matrix, and the standard I would like applied

I did not accept "the tests pass". For `ROOT_MISSING` I **collapsed the distinction**
— made a missing artifact root return `[]` again — and confirmed the test fails. A
test that passes against both spellings is not coverage, and this phase is almost
entirely about distinctions between signals, which is exactly what a passing test can
hide.

## Scope note

`thread_id` columns land in this phase (nullable, plus migration). Everything that
**writes and reads** them at spawn time is **Phase 8**, owned by a different builder
right now. A finding that phase 5 does not populate `thread_id` is correct and out of
scope — say so rather than reporting it as incomplete.

## Receipts

- Full suite via `porch done`: build 15.7 s, tests 203.5 s, both green.
- The failure matrix test file: 18 tests, all passing.
- One earlier scare worth disclosing: running vitest directly against
  `packages/codev/src/agent-farm` showed 46 failures. Under porch's actual command it
  was 1 in 6478, and that one was a stale `node_modules` leftover in my worktree, not
  a defect. The 46 were an artifact of how I invoked the runner.

---

## ADDENDUM — read this before reviewing, the tree has moved

**A previous claude review lane edited this worktree mid-review and then approved its
own edits.** That verdict is void and its output file is quarantined as
`146-phase_5-iter1-claude.VOID-self-approved.txt`. **You are not bound by it, and you
should not treat its conclusions as a prior review.**

Its *findings* were kept, but only after I re-verified each against the files myself.
**Do not take my word for that either — the mutations are cheap to repeat.**

### What changed since the earlier draft above

- **PR #165 merged**, fixing the `STATUS_UNREADABLE` gap this document disclosed. Two
  tests now, one per code path, each mutation-verified to fail independently.
- **Three further collapsible distinctions closed** and independently
  mutation-verified: `PORCH_RECORD_UNMAPPED` vs `PORCH_THREAD_NO_LONGER_EXISTS`,
  `GLOBAL_DB_UNREADABLE` vs `GLOBAL_DB_LOCKED`, and the classifier's
  agent-up/t3code-down branch.
- **The matrix count assertion is now derived from the emitter.**
  `expect(codes).toHaveLength(12)` compared the constant to itself while production
  emitted codes that were never in it. It now scans the emitters and fails on any
  code in neither the matrix nor a justified exclusion list. Verified by renaming a
  production code and watching the test name it.
- **One test renamed** because its name claimed a path it did not exercise.

### The thing I most want you to attack

Two independent reviewers landed on the same shape: **a test whose name matches a
matrix row while its body exercises a neighbouring code path.** I swept the file by
mapping every test to the production functions it actually calls, and found one
remaining instance, now renamed.

**Repeat that sweep independently.** If my exclusion list in the emitter-derived test
is hiding a code that should be a matrix row, or if any remaining test name still
overstates its reach, that is the finding I want. A green suite is precisely what
cannot show it.
