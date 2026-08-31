# Review — Spec 250: t3code is the front end

Written incrementally as phases land, not reconstructed at the end. Sections are added by the
phase that produced them.

---

## Phase 1 — Two-identity vendoring harness

### `acquire` wrote to the read-only clone

`acquire()` runs `git checkout --detach` against `T3CODE_ROOT`, and both `tools/t3-server/smoke.mjs`
and `packages/t3-client/live/integration.mjs` call it. Left on `pin.commit`, it would have checked a
**fork** sha out into the **upstream** clone the moment the fork diverged — from an ordinary test
run, not a deliberate invocation. The upstream clone exists precisely to stay reproducible at
`upstreamBase`; every piece of spec 146 and 236 evidence verifies against it.

Rewiring only `verify` would have left the one verb that *writes* still pointing at the fork. So
`acquire`, `start` and `status` are pinned to `upstreamBase`, and the test for it does not read the
source: it builds a throwaway repository with two commits, points `upstreamBase` at the earlier and
`commit` at the later, runs `acquire`, and asserts which sha the tree landed on.

### `verifyCheckout` reported "clean" for a checkout it could not read

Inherited from the spec 146 version, comment and all. The `git status` catch fell through to
`dirty = ''`, and an empty string is how "clean" is spelled — while the comment above it claimed
the case was reported as undetermined. It had been answering "fine" to "I could not look" for as
long as the file existed.

Found by a review lane reading the new file, not by any test. The test that now covers it triggers
the condition for real (`chmod 000` on `.git/index` leaves `rev-parse HEAD` working and makes
`git status` exit 128) and refuses to pass vacuously if the platform ignores the mode.

### Three exit codes, and the cases that were collapsed into the wrong one

Adding a second identity multiplied the "could not determine" cases and several were initially
answered as `1`:

| Case | Was | Is |
|---|---|---|
| Fork checkout absent | — | `3` `NO_FORK_CHECKOUT` |
| Fork HEAD unreadable | — | `3` `NO_FORK_HEAD` |
| `git status` failed | `0` **clean** | `3` `NO_<ID>_STATUS` |
| Merge-base uncomputable | — | `3` `NO_FORK_MERGE_BASE` |
| Contract commit absent from the fork | `1` wrong commit | `3` `NO_FORK_ANCESTRY` |
| Fork does not descend from `upstreamBase` | — | `1` `FORK_BASE_MISMATCH` |

The last row is the one worth keeping: "I could not compute a merge-base" and "the merge-base is
wrong" are different facts, and collapsing them would let a corrupt or mis-pointed checkout read as
a deliberate rebase.

---

## Phase 2 — Thread hierarchy in the fork's contract and projection

### The plan's wiring premise was wrong, and the wrong version would have passed its own test

**This is the most important finding in the project so far.**

The plan said to sequence the schema guard after `MigrationsLive` (`persistence/Migrations.ts:173`).
`MigrationsLive` is exported and **nothing in the tree builds it** — every reference is its own
definition or its own docstring. The real boot path is `persistence/Layers/Sqlite.ts`'s `setup`,
which calls `runMigrations()` directly and is what both `makeSqlitePersistenceLive` and
`SqlitePersistenceMemory` provide.

A guard hung off `MigrationsLive` would therefore **never have run in production**. And it would
not have looked broken: a test that constructs `MigrationsLive` itself and asserts the columns
appear passes perfectly. The layer works. Nothing builds it. Those are different claims and only
one of them was being tested.

This is #222's exact shape, and it is the failure mode that cost this program thirteen phases of
invisible plumbing. What caught it was reading the real boot path instead of trusting the plan's
premise — a grep for who actually constructs the thing, before wiring anything to it.

The guard is called from `setup`, and the ordering assertion reads that production file rather than
any layer the test assembles:

```
const migrations = sqliteLayerSource.indexOf("yield* runMigrations()");
const guard = sqliteLayerSource.indexOf("yield* codevSchemaGuardStep()");
assert.ok(migrations < guard, ...);
```

A second assertion pins the guard inside `setup` specifically, because both persistence layers
provide `setup` — if it ever moves into only one of them, the other boots silently without the
columns.

### Two spellings for the same two fields, and why a rebase must not "tidy" them

`ThreadCreatedPayload` uses `Schema.NullOr(...).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`.
`OrchestrationThread` and `OrchestrationThreadShell` use `Schema.optional(Schema.NullOr(...))`.

**This asymmetry is deliberate and load-bearing. Do not unify it.**

The payload keeps a decoding default because the event log is full of `thread.created` payloads
written before the fields existed, a projection rebuild replays every one of them, and the projector
reads `payload.role` unconditionally. Defaulting is what makes that read total; `optional` would
make it `| undefined` and push a branch into the hot path of every rebuild.

The read models use `optional` because that is what `linkedPullRequest` — upstream's own newest
field, sitting one line above — does, and for the same stated reason: cached snapshots from older
servers still decode. Applying the strict form to them produced **32 errors across 11 upstream test
files**. On a fork that must be rebased for the lifetime of the project, that is a recurring cost
paid every rebase, in exchange for removing `undefined` from a read model the server never emits as
`undefined`: every server read path normalizes with `?? null`.

Final upstream test churn for the whole phase: 5 fixture edits across 3 files.

The trap for a future rebase is that the strict form *looks* more correct in isolation. It is more
correct in isolation. It is worse here, and the reason is not visible from the diff.

### The ruling that froze `pin.commit` broke two phase-1 tools, silently

`pin.commit` means "the vendored contract was generated from this commit" and only regeneration
moves it, so it stays at `upstreamBase` until phase 5. Both tools below were written when
`pin.commit` and the fork HEAD were the same commit, and both had the right answer for the wrong
reason until they diverged.

1. **`classify-churn --fork-drift` measured `upstreamBase..pin.commit`.** After the freeze, a fork
   carrying real customization commits reported **zero drift**. The tool whose entire job is
   answering "what have we changed?" answered "nothing", confidently, with exit `0`. Now measures to
   `HEAD`, which is correct on both sides of phase 5.
2. **The first commit in any range was reported `baseline` and never classified**, because
   `git log from..to` excludes `from`. With a single fork commit the mode returned a placeholder
   instead of a verdict. Seeded from the range start, guarded so a `--since` *date* still falls back
   to `baseline` rather than guessing a commit.

The generalizable half is in `lessons-learned.md`: a test written while two values are equal cannot
tell you which one the code reads.

### The fork live suite skips for three phases, and says so

`spec-146-t3-contract.test.ts`'s fork-hash suite compares generated artifacts against the fork
checkout — valid only while that checkout sits ON `pin.commit`. Through phases 2-4 it does not.

Failing for three phases straight would train everyone to ignore a red suite, which is the failure
the ahead-vs-wrong distinction exists to prevent. It is gated on `FORK_AT_CONTRACT` and the suite
name carries which of three reasons it skipped for:

```
spec 250 [live: needs the fork checkout ON pin.commit — fork is at 1a414cee8409,
ahead of contract commit 082e6ea52186 (expected until phase 5 regenerates)]
```

A skip nobody can see the end of is how a suite quietly stops existing, so a test asserts the gate
is the contract commit rather than mere presence, and that it reopens by itself once phase 5 moves
the pin.

### Two acceptance criteria were tested by substitution, and review caught both

Both lanes named the same two, independently, and both were right.

**"A newly introduced upstream migration still runs after the guard"** was tested with a raw
`ALTER TABLE pretend_upstream_column`. That proves SQLite accepts another column. It says nothing
about whether the watermark let the *migrator* execute one — which is the entire question migration
900 got wrong, and therefore the entire point of the test. The fix runs
`runMigrations({ toMigrationInclusive: 41 })` → guard → `runMigrations()` and asserts 42 actually
executed and its column exists, which is upstream's own idiom.

The lesson is narrower than "test the real thing": the substitution was *adjacent* to the
mechanism and produced identical observable state. A column appeared either way. Only the path it
appeared by was in question, and that is exactly what the assertion had dropped.

**Criterion 8b** — "the server is killed partway through applying the columns and the resulting
database still opens against the pre-fork server binary" — was an in-process simulation on an
in-memory database. No kill, no file, no pre-fork binary. Three of the criterion's four nouns were
missing and the remaining one still passed.

It is now exercised, in `tools/t3-fork/criterion-8b.mjs`, recorded to
`codev/research/250-criterion-8b-evidence.json`:

| Step | Result |
|---|---|
| Pinned `t3@0.0.36` creates and migrates a real database | opened and answered |
| Codev columns present before the run | none |
| Child SIGKILLed after the first `ALTER` | `SIGKILL`, `codev_role` alone on disk |
| **Pinned pre-fork server opens the half-applied file** | **opened and answered** |
| Fork's real guard resumes | added `codev_parent_thread_id`, found `codev_role` present |
| Pre-fork server opens the fully applied file | opened and answered |

#### Why `start --keep-data` had to exist

This is the part a future reader of a green 8b most needs, because a passing criterion carries no
trace of having once been unprovable.

Writing the real test failed before it ran, on the harness rather than on the code. Criterion 8b
requires opening a database that a *previous* run left behind, and neither existing verb can:

| Verb | What it does | Why it cannot host 8b |
|---|---|---|
| `start` | wipes the data dir, then starts | deletes the half-applied file the criterion is about |
| `restart` | stop-then-start, keeping data | refuses when nothing is running — and after a kill, nothing is |

So the criterion had **no expressible form**, and had had none for as long as it had existed. That
is the finding, and it outranks the code: the in-memory simulation was not laziness, it was the
only thing the available tools could express. Whoever wrote it had a green check and no way to
learn it was green for free.

Nothing reported the gap. There was no failing test, no error, no skip — the criterion sat in the
plan reading exactly like one that passes, and **it took writing the test to discover the test
could not be written**. That is a rung below "a check that answers when it could not observe": there
was no check, because nothing could host one, and an absence has no output to inspect.

`start --keep-data` closes it. The verb exists solely so a criterion about opening an existing
database can be stated at all, which is why it is worth a line in the harness README and this
paragraph here rather than a one-word changelog entry. Filed as evidence on #199.

---

## Phase 3 — Hierarchy integrity refused at write time

### The engine deleted the entire deliverable, one layer above the tests

Both review lanes found this independently, and it is the sharpest instance yet of the pattern this
project keeps producing.

Phase 3's deliverable is six **reason discriminants**, so a caller can tell a retry ("no such
parent") from a caller bug ("wrong parent role"). `OrchestrationEngine` mapped every error the
decider raised except `OrchestrationCommandInvariantError` onto a generic invariant error reading:

> `Failed to generate an event identifier.`

For a hierarchy refusal that is not lossy, it is **false** — and it did not stop at the response.
The rejected-command receipt records `error.message`, and that receipt is replayed verbatim on any
redispatch of the same `commandId`. The wrong answer was the *permanent* answer.

All fifteen decider tests were green throughout, because they call `decideOrchestrationCommand`
directly. **The decider is not a boundary anyone sees; the engine is.** A discriminant that does not
survive the wrapper does not exist, and no quantity of testing beneath the wrapper can report that.

This is phase 2's `MigrationsLive` finding in a different costume: *testing the layer below the one
production uses*. There it was a layer nothing built; here it is a layer something wraps. Both pass
their own tests while production does something else, and in both cases the passing test is what
made the gap invisible.

The regression test was **verified to discriminate** rather than assumed: with the mapping reverted,
3 of its 4 tests fail; restored, all 4 pass. On this project that check has stopped being optional.

### Two of my own tests asserted nothing

Both caught by review, and both worth recording because they are cheap to write by accident.

**A Set of its own literals.** A test named "every refusal reports a distinct, actionable reason"
built `new Set([...six string literals])` and asserted `size === 6`. That proves six distinct
strings are six distinct strings. Every refusal could have collapsed onto a single discriminant and
it would have passed — while *claiming*, in its name, to guard exactly that. It now collects the
reasons six real dispatches return.

**An assertion against its own input.** A test archived a parent and then asserted on
`model.threads` — the object it had just constructed, which the decider never mutates. It would
have passed whatever the decider emitted. It now asserts the output: one event, one aggregate, no
event mentioning the child.

The common thread is that both tests read as if they were about the system, and both were about the
test. Neither could fail.

### Orphaning by omission

Archiving a parent is a single-aggregate event that says nothing about children. That is what makes
the orphan case work: nobody has to remember *not* to write a cascade. The test asserts the
omission directly — no emitted event mentions the child — rather than asserting a downstream state
that a cascade might also produce.

Creating a builder under an *already archived* architect is accepted. The rule is about the edge's
shape, not the parent's lifecycle; refusing would mean archiving silently changes which commands
are legal, which is a second rule nobody wrote down.

### Two things left deliberately, both recorded rather than fixed

**`parent-not-architect` covers two of the plan's listed cases** — a builder parented to another
builder, and one parented to a `role: null` thread. They share a discriminant because they share a
*reason*: the parent is not an architect. The `detail` distinguishes them for a human. If phase 7
ever needs to word them differently in the UI it will need two discriminants, and that is a cheap
change; splitting them now would have invented a distinction no caller acts on.

**The ws/RPC hop is untested**, raised by review at the close of phase 3 and now a phase 6
acceptance item rather than a note. The reasoning is this project's own history: it has been caught
twice testing below the layer production uses, and the boundary above the engine is the last hop
nothing has exercised. `porch-driver` is the first real client, so phase 6 is where a refusal
dispatched over the wire must still let a caller tell "no such parent" from "wrong parent role". A
discriminant that does not survive serialization does not exist.

### A crashed run destroying passing evidence

`criterion-8b.mjs` was documented as `> evidence.json`. A shell redirect truncates the target the
instant the process starts, so a transiently crashed run left an **empty** evidence file where a
passing one had been — and the suite then failed on a file that said nothing, rather than on the run
that broke. A good record was destroyed before anyone noticed.

`--out <path>` now writes once, at the end, and only when the run passed. A failed run leaves the
previous record untouched and reports itself through its exit code and stdout.

Worth generalizing: **a redirect is not a way to save a result, it is a way to destroy one early.**
Anything that records evidence a test later depends on should write on success, not on start.

---

## Phase 4 — Porch gate block with a server-allocated revision

### The mark has to outlive the thing it described

Criterion 10 — clear an approved gate, deliver a lower revision, the gate does not reappear — is
carried by one design choice: `gateRevision` lives **on the thread, not inside the gate block**, and
the *clear* raises it as well as the set.

Inside the block it would have vanished with the block, the stale write would have been the first
one at that revision, and an answered gate would be back in front of a human. The rule generalizes:
a monotonic guard has to outlive the state it guards, or clearing that state resets the guard.

Two rules that looked contradictory in the plan resolve into one by making `revision` **optional on
the command**: absent means the server allocates, present means apply only if it exceeds the mark.
Equal is refused as well as lower, because two writers that computed the same number are colliding,
not agreeing.

### The same function, the third time

`isRefusal` in `OrchestrationEngine` decides which errors reach a dispatcher intact. Phase 3 fixed
it once, for `CodevHierarchyInvalidError`. Phase 4 added a **third** refusal type and did not extend
it — so every gate refusal, including the stale write that *is* criterion 10, was rewritten as
"Failed to generate an event identifier", and criterion 10 was false at the wire while all eleven
decider tests stayed green.

Both lanes found it independently. What generalizes is narrow and mechanical: **a predicate that
enumerates a category has to be extended whenever the category grows, and nothing in the type system
says so.** The union it feeds is structural; the predicate is a hand-written disjunction. Adding a
member to the union and forgetting the predicate compiles cleanly and silently drops the new member.
A type-level exhaustiveness check would have caught all three occurrences.

### No test saw the projector, and the decider tests could not

The best finding of phase 4, from the claude lane: nothing asserted that the read model applies
either gate event.

Every decider test hand-builds its read model. So a projector that dropped `gateRevision` would pass
all eleven of them — while every write after the first re-allocated revision 1, and criterion 10
became unenforceable. The mechanism's own test suite could not see the mechanism failing.

This is the same family as the `MigrationsLive` and `isRefusal` findings, and worth stating as one
rule: **when a value is produced in one layer and consumed in another, a test that constructs the
intermediate state by hand tests neither.** The decider tests build the read model; the projector
builds it in production. Only a test that lets the projector build it can tell you the two agree.

### Three claims, three tests, all verified to fail

By phase 4 the "revert the fix and confirm the test fails" check had become routine, and it earned
its place three times in one phase: the engine's `isRefusal`, the projector's mark, and the wire's
decoding default. Each was verified by removing the mechanism and watching the specific test go red.

Also caught this way: a test asserting the revision column rejects NULL ran its `UPDATE` against an
**empty table**. Zero rows touched, trivially successful. It was noticed only because the assertion
expected a refusal — written the other way round it would have passed forever.

### A count hardcoded in a driver, failing for a reason unrelated to what it measures

`criterion-8b.mjs` hardcoded a two-element Codev column list. Phase 4 added two more columns and the
driver failed — **while the criterion it exists to protect still held**. The pinned pre-fork server
opened both the half-applied and the fully-applied database exactly as before.

That is a false negative on the thing the driver was built to guard, and it is worse than a plain
bug: the next person sees a red 8b, concludes the crash-safety property broke, and goes looking in
the wrong place. Now derived from what the guard itself reports, asserted as properties rather than
counts.

### A test that could not fail, caught by running it

The first version of "the revision column rejects NULL" ran `UPDATE projection_threads SET
codev_gate_revision = NULL` against an **empty table**. Zero rows touched, trivially successful, and
the assertion that it should have been refused failed — which is the only reason it was noticed. Had
it been written the other way round it would have passed forever while proving nothing.

The fix is one line: insert a row first, so the constraint has something to refuse. The lesson is
that "assert the constraint, not the DDL" is not enough on its own — the assertion also needs
something for the constraint to act on.

## Flaky Tests

`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
Pre-existing and unrelated to spec 250: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is
empty, the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to
`/private/var`. Not skipped and not modified — editing an upstream test we did not break is
gratuitous divergence on a fork that has to rebase.
