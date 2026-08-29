# Spec 146, Phase 3, iteration 3 — responses to the review

Split verdicts: **codex REQUEST_CHANGES** with two blocking findings, **claude
APPROVE** with three non-blocking comments. **All of them are accepted and fixed.
Nothing is rebutted as wrong.**

Both of codex's are the same defect in two places: a timeout that does not bound
what it claims to bound. That is the third round in which this phase's timeouts
have been the thing found, and the pattern is worth naming rather than fixing
quietly — see the end.

## Blocking — codex

### 1. `finish()` cancelled the pending SIGKILL escalation

`checks.ts`. On a timeout the code sends SIGTERM to the process group and queues a
SIGKILL for `killGraceMs` later. The shell dies on the SIGTERM, `exit` fires, the
drain grace elapses, and `finish()` ran `clearTimeout(killTimer)` — cancelling the
escalation while a descendant that had ignored SIGTERM was still alive.

So the group kill from iteration 1 closed the escape for descendants that die on
SIGTERM, and left open the one for descendants that do not. The check reported
`timedOut: true` while something it started kept writing to the worktree the next
phase check is about to measure.

**Fixed:** the escalation is spent rather than cancelled — when `timedOut`,
`finish()` signals the group with SIGKILL before clearing the timer. Anything
still in the group at that moment ignored SIGTERM or was backgrounded away from
it, which is precisely what the escalation exists for.

**Test:** a backgrounded subshell with `trap "" TERM` that writes a marker two
seconds later, against a 400 ms budget. The marker must be absent three seconds
after the result returns. Mutation-checked.

### 2. `runTurn`'s deadline started after the dispatch

`thread.ts`. `const deadline = Date.now() + timeoutMs` ran *after*
`#startTurnWithRole` resolved, so a hung `thread.turn.start` sat outside the
budget entirely and `runTurn` could never return at all.

This is the same finding as iteration 1's doubled budget, one call earlier. That
one made `timeoutMs: 60_000` take 120 seconds; this one made it take forever. Both
were invisible to a test whose dispatcher answers instantly, which is what every
test in the file had.

**Fixed:** the deadline is taken at the top of `runTurn` and the dispatch is
wrapped in `#withTimeout` alongside the two waits. **Test:** a dispatcher that
never returns, asserted to reject within the budget. Mutation-checked.

## Non-blocking — claude

### 3. `appendCapped` re-encoded the whole buffer per chunk

`Buffer.byteLength(combined)` then `Buffer.from(combined)` on every `data` event
turned a 4 MiB cap into a 4 MiB scan per chunk — quadratic in the output of
exactly the check most likely to produce a lot of it. The byte count is now
carried in and out, and the full encode happens only on the truncating path.

### 4. `not.toBe('failed')` would also pass on `unchecked`

Accepted without argument: this file spends its length on the rule that "I could
not tell" must not be spelled like an answer, and then asserted a contract check
in a way that let `unchecked` pass as valid. Now `toBe('ok')`.

### 5. `TurnTracker.expectTurn` silently replaced a waiter

A second turn on the same thread replaced the first waiter, and the promises the
first had handed out could then never settle either way. Unreachable through the
current callers, and "nobody will ever tell you" spelled exactly like "still
running" is the failure this phase is about.

**Fixed:** the displaced waiter is rejected with `TurnDisplacedError`. Both
promises get a `catch` attached at construction so a waiter displaced before
anyone awaits it cannot surface as an unhandled rejection, while a caller that is
awaiting still sees the error. Mutation-checked.

### 6. `opencode.json` listed a role file that was never written

From the same lane's analysis section. `instructions: ['.builder-role.md']` was
emitted whether or not `roleContent` was supplied — a config describing
instructions nobody provided, which reads as "the role is installed" to anyone
looking at the worktree. Now listed only when the file is written.

Two of the same lane's observations are **not** fixed, and deliberately:
`writeAtomic` opening the directory descriptor outside its try block, and
`applyWorktreeSetup` resolving paths without a containment check. Both were
recorded as unreachable — the first is a platform path this project does not run,
the second takes only internal inputs — and neither is Phase 3's subject. Naming
them here rather than silently skipping them.

## The pattern, since it is now three rounds old

Every blocking finding in this phase after iteration 1 has been a **timeout that
did not bound what it named**:

| Round | The bound that was not one |
|---|---|
| 1 | The check timeout signalled the shell, not the group, and resolved on `close` |
| 1 | `runTurn` held the full budget twice, so 60 s could take 120 s |
| 3 | The SIGKILL escalation was cancelled at the moment it was needed |
| 3 | The turn budget started after the dispatch, so a hung dispatch was unbounded |

They share a shape: the timeout was tested against the input where the thing it
bounds is trivially bounded anyway — an `exec`ing shell, an instant dispatcher, a
child that dies on SIGTERM. **A timeout test whose subject would finish on its own
is not a timeout test.** That belongs in `lessons-learned.md` at MAINTAIN, next to
the input-shape rule it is a special case of.

## Evidence

- Phase file: **82 tests**, up from 78.
- `codev/research/146-phase3-mutation-check.py`: **41 properties, all red without
  their fix.** No `SKIP`, no `STILL PASSES`. Tree verified clean afterwards.
- Full suite and live evidence regenerated at the fixed commit — see the phase
  commits.

## One thing that happened in this round, disclosed

The mutation harness rewrites source files in place and restores them in a
`finally`. I started it while the claude review lane was still reading the tree,
realised a reviewer could read a mutated file, and stopped it — and the kill landed
inside the try block, leaving one mutation applied: `cursor.ts` persisting the
cursor **before** the handler, which is the exact defect this phase exists to
prevent. It typechecks and would have passed a casual look.

Caught by `git status` showing a file I had not edited, and restored by rewriting
the hunk rather than with a destructive git command. No review lane read a mutated
file: the harness ran only while no lane was live, and this stop is why.

**The harness is not safe to run concurrently with anything that reads the tree,
and it is not safe to interrupt.** Worth a note in its docstring, which it now has.
