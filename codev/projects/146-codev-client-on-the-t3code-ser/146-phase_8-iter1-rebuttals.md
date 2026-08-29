# Phase 8, iteration 1 — rebuttals

**Round shape: two reviewing lanes, one void.**

| Lane | Verdict | Artifact |
|---|---|---|
| `codex` | **REQUEST_CHANGES**, 3 findings | `146-phase_8-iter1-codex.txt` |
| `opencode` (substitute, `xai/grok-4.6`) | **COMMENT**, 2 issues | `146-phase_8-iter1-opencode.txt` |
| `claude` | **VOID** — wrote to the worktree, never reviewed | `146-phase_8-iter1-claude.txt` |

The `claude` lane wrote to the worktree and posted a public GitHub comment instead of
reviewing, and never produced a verdict. Its artifact spells the void out rather than sitting
empty, because an absent lane artifact and a rejected one are different things porch cannot
otherwise tell apart (#168).

**The opencode substitute took three attempts, and each failed differently.** Run 1 was killed
externally at ~20s. Run 2 hit `OPENCODE_TIMEOUT_MS`, hardcoded at 360s with no flag, while
still reading files — it had spent its budget re-reading a **truncated** prompt, which is the
expensive path the truncation forces and the cap then guarantees it cannot finish. Filed as
**#188**. Run 3 completed and returned COMMENT.

Recorded distinctly on purpose: **VOID** (ran, rejected), **TIMED_OUT** (ran, never concluded),
**absent** (never ran), **COMMENT** (ran, concluded, non-blocking). None of the first three is
an APPROVE and none may be recorded as one.

**The two lanes agree.** Opencode independently reached the same conclusion as codex on
findings 1 and 3 — "same as iter1, still checkable" — and independently confirmed finding 2 is
resolved, naming the #170 sentinel shape and the five characterization tests. Two lanes on
separate accounts converging on the same two unmet criteria is the strongest evidence in this
round that they are real and not an artifact of one reviewer's reading.

**Phase 8 was verified, not implemented** — it merged off-band as PR #166 while this builder
was in phase 7, on the architect's instruction to verify against the plan's criteria and
advance. So these findings are answered against merged code plus my verification record, not
against a change of mine.

## Finding 1 — `installThreadSpawnFactory` has no production caller — ACCEPTED

Codex is right and it is checkable in one grep: the only callers of
`installThreadSpawnFactory`, `setSpawnThreadFactory` and `setThreadEngine` outside
`thread-identity.ts` itself are test files. With no factory registered, `chooseSpawnPath`
returns `pty` unconditionally in production, so phase 8's spawn branch is unreachable outside
a test that injects a fake.

This is already filed as **#179 item 2** against phase 9, where it is described as deliberate.
What no issue said, and what this finding adds, is that it also **unmakes phase 8's own
acceptance criterion** "a new spawn takes the thread path". That criterion is now recorded as
NOT MET in `146-phase_8-verification.md` rather than ticked.

No code change. The fix is phase 10's premise problem, not a defect in the merged work.

## Finding 2 — the `cmd` sentinel — ACCEPTED AS A FINDING, RESOLVED AGAINST THE PLAN

Codex is right on both halves: `architectWriteValues` returns `cmd: architect.cmd` where the
plan specifies `cmd` `''`, and the function had **zero** test coverage. Both confirmed against
the file before answering.

The architect ruled on **#170** that the plan is wrong and the code is right. `pid`, `port`
and `terminal_id` are genuinely PTY-specific and carry no meaning for a thread-backed row;
`cmd` is *how the architect was launched* and an architect restart reads it, so blanking it
discards live information.

Acted on:

- The plan's phase_8 deliverable is amended to name two sentinels, not three, with the #170
  rationale recorded inline — and it says plainly that the test is **added by the amendment**,
  not inherited, because a plan claiming coverage that does not exist is the same defect this
  spec has been cataloguing all along.
- Five characterization tests added under `Spec 146 Phase 8 — architect sentinels (#170)`.
- **Mutation-checked**: setting `cmd: ''` in `architectWriteValues` makes the first of them
  fail. The test can fail, so it is holding something. A test that cannot fail reports coverage
  that does not exist.

## Finding 3 — two acceptance criteria are simulated, not exercised — ACCEPTED

Codex is right. The plan asks for the migration "against a copy of a **real** `global.db`" and
for "the **previous** release" to open the restored database. The tests build the pre-v21 shape
from `PRE_V21_ARCHITECT` / `PRE_V21_BUILDERS` string literals, and stand in for the previous
release by issuing SQL that does not name `thread_id` **on the current handle**.

That proves the migration is additive at the SQL level, which is worth having. It does not
prove a real database survives, and it does not run the previous release at all. The plan's
integration case — a thread-backed builder driven alongside a running PTY builder — is likewise
unrun, and cannot run until finding 1 is fixed.

Recorded as NOT MET rather than ticked. This is the same discipline #179 applies to phase 9:
a phase verified against a criterion nothing exercises is a tick with nothing behind it.

## What changed in the tree this round

| Path | Why |
|---|---|
| `codev/plans/146-codev-client-on-t3code.md` | #170 amendment, `cmd` dropped from the sentinel set |
| `packages/codev/src/agent-farm/__tests__/spec-146-phase-8-thread-identity.test.ts` | 5 characterization tests added; 17 → 22 |
| `codev/projects/.../146-phase_8-verification.md` | findings 1 and 3 recorded NOT MET, finding 2 resolved |

Commits: `dd2a72873`, `a5722928b`. Every path above was recorded in the edit ledger **as it was
written**, so the after-diff attributes by construction rather than by recollection — anything
in the diff not in the ledger is a lane. On this round the two sets matched exactly.

The ledger replaced a live watcher that produced one true kill and one false one; the false
one killed a clean lane because "the tree moved" stops attributing to anything once the builder
is also working. The ledger does not have that failure mode: it is written as the edits happen,
so it cannot be reconstructed wrongly afterwards.
