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

### The one defect, in five costumes — read this before wiring phase 6

#### The remedy, first, because the diagnosis is the easy half

**Assert the call site, not the module.**

Every one of the five below was caught by that single move, and every one of them would have been
prevented by it. Look at what the passing tests actually asserted:

| The test said | The question it never asked |
|---|---|
| the provisioner writes a token | does the server ever run the provisioner? |
| the guard alters a column | does anything build the layer the guard hangs off? |
| the decider refuses, with a reason | does that reason survive the wrapper the caller talks to? |
| the projector applies an event | do the decider's tests use a projected model, or one they built? |
| the scope map has a row | does the transport read that row? |

All green. All meaningless — not because the assertions were wrong, but because each asked whether
the code *works* and none asked whether production *reaches* it. Those are different questions and
only the second one was ever in doubt.

So the remedy is mechanical and cheap: when the risk is "production may not reach this", the
assertion goes on the caller. Read `serverRuntimeStartup.ts` and require the provisioner to appear
in it. Read `Layers/Sqlite.ts` and require the guard to run after the migrator. Read `ws.ts` and
require the scope lookup to wrap every RPC. These read as crude tests and they are the only ones
that could have failed.

#### And the diagnosis

Five findings across phases 2, 3 and 4 are the same defect wearing different clothes. Every one of
them passed its own tests. Every one was found by review or by a compiler, never by the suite that
was supposed to cover it.

| # | Costume | What was tested | What production did |
|---|---|---|---|
| 1 | **A layer nothing builds** | `MigrationsLive` constructed by the test, columns appear | `MigrationsLive` is exported and nothing builds it; the real path is `Layers/Sqlite.ts`'s `setup` |
| 2 | **A layer something wraps** | the decider's six discriminants, called directly | `OrchestrationEngine` rewrote them all as "Failed to generate an event identifier", then persisted it |
| 3 | **A decider tested without its engine** | gate revision rules, decider-only | `isRefusal` dropped the new refusal type; criterion 10 was false at the wire |
| 4 | **A read model every test hand-builds** | eleven decider tests, each building its own read model | a projector that dropped `gateRevision` would pass all of them while every write re-allocated revision 1 |
| 5 | **A module nothing calls** | the gate credential's scopes, path and write, all unit-tested | nothing in the server provisioned it; written one commit *after* this table |

The single sentence they share: **a test that supplies the boundary itself cannot tell you the
boundary exists.** Constructing the layer, calling under the wrapper, hand-building the read model —
each substitutes the thing whose absence or misbehaviour is the actual risk.

The rule that follows, and the one phase 6 needs: **when a value is produced in one layer and
consumed in another, test the seam, not the two ends.** That sentence is now the hot-tier lesson at
slot 8, which previously read *"a test that constructs the collaborator itself proves the
collaborator works, never that production constructs it"* — the same idea, one costume wide. The
collaborator case survives as an example clause. Phase 6 wires `porch-driver` across the
ws/RPC boundary — the last untested hop, and already an acceptance item — and it is the fifth place
this can happen. A `porch-driver` test that constructs its own transport would be costume five.

Costume 3 is now closed by construction rather than by care: see below.

**And then phase 4 produced costume five, one commit after writing this table.** The
`codev:gate-write` credential module named its scopes, named its on-disk path, tested the write —
and nothing in the server called any of it. Both review lanes found it. Its own tests were green and
every one of them was meaningless for the only question that mattered.

That is worth keeping rather than quietly fixing, because it says something the table alone does
not: **knowing the pattern does not prevent it.** The table was written, committed, and the same
defect went in beside it within the hour. What caught it was review, and what stops it recurring is
the test that now asserts the *call site* — `serverRuntimeStartup.ts` imports the provisioner and
runs it as a named phase — rather than asserting the module works.

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
A type-level exhaustiveness check would have caught all three occurrences — so phase 4 added one
rather than filing a follow-up, on the reasoning that a follow-up issue is a promise to hit it a
fourth time.

`dispatchErrorKind` now classifies **every** member of `OrchestrationDispatchError` in a switch whose
`default` assigns to `never`. `isRefusal` reads that classification instead of keeping its own list,
so there is one place to update. Adding a member without classifying it **does not compile**, and the
error names the forgotten type:

```
src/orchestration/Layers/OrchestrationEngine.ts(122,13):
  error TS2322: Type 'ProbeUnclassifiedError' is not assignable to type 'never'.
```

Verified the way everything else on this project now is: a fourth member was added, the build was
confirmed to fail, and it was removed. At runtime an unrecognised error classifies as `internal` —
the safe direction, because a refusal misclassified as internal is a worse message, while an
internal error misclassified as a refusal is a lie about whose fault it was.

This is worth more than the three fixes it replaces: it converts a recurring runtime falsehood into
a build error.

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

## Phase 5 — The vendored contract, regenerated from the fork

### The undecidable verdict, and why it was neither a pass nor a break

`classify-churn.mjs --fork-drift` returns three commits as `consumed-change-undecidable`. The
classifier sets `unknown` the moment a union's emitted JSON differs at all, additive or not, and
says so instead of guessing. The named input for this phase was one of them; running it against
the finished fork found three:

| Commit | Method | Classifier |
|---|---|---|
| `1a414cee8409` (phase 2) | `orchestration.subscribeThread` | union shape changed; not decidable here |
| `e1b7f7b04af5` (phase 3) | `orchestration.dispatchCommand` | union shape changed; not decidable here |
| `3a1780bbf66f` (phase 4) | `orchestration.subscribeThread` | union shape changed; not decidable here |

Deciding them means matching union members by their discriminant literal and comparing the matched
pairs, which is exactly the step the classifier declines to take. Done that way over the whole
range `upstreamBase..pin.commit`:

```
subscribeThread  output   <kind=snapshot>/snapshot/thread/{role,parentThreadId,codevGate,gateRevision}: added
                          <kind=event>/event<type=thread.created>/payload/{role,parentThreadId}: added
                          <kind=event>/event: alternative added codev.gate-set
                          <kind=event>/event: alternative added codev.gate-cleared
dispatchCommand  input    <type=thread.create>/{role,parentThreadId}: added, neither required
```

Ten findings, and not one removal, narrowed type, newly-required property, lost enum member, or
tightened `additionalProperties`. Nine of the ten are non-breaking under the rules the classifier
already states. **The tenth is not, and it is the reason the phase exists.**

On an *output*, a new union alternative is a shape the client must now handle. A client
shape-checking the `subscribeThread` stream against the pre-regeneration contract does not ignore a
`codev.gate-set` frame — it *rejects* it, because the frame matches no member of the union that
client knows. Phase 4 shipped the server side of gate writes into a repository whose vendored
contract could not decode the events they produce.

So the verdict is: **non-breaking in every respect but one, and that one is breaking against the
upstream-generated contract and non-breaking against the regenerated one.** Regenerating is the
fix, not a formality that follows it.

`spec-250-generated-contract.test.ts` holds both halves. The second half is the one that matters:
it rebuilds the pre-regeneration union by removing the two `codev.*` alternatives and asserts the
frame fails against it. Without that, "the contract accepts the frame" would be a claim about
nothing — the frame would have passed against a union that never rejected anything.

### `codev.gateWrite` would have been vendored as nothing at all

`generate.mjs` iterates `Object.entries(pin.methods)`, not the contract's RPC map. A method that
exists in the fork and is missing from `pin.methods` is not an error: it produces no schema, no
`methods.json` entry, and `checked.ts` then answers `unchecked` for every one of its payloads —
which is the "I had nothing to look with" signal working exactly as designed, arriving for a reason
nobody would have gone looking for.

The precedent was already in the file. `vcs.*` are recorded by hand precisely because their method
strings live in the unvendored `rpc.ts`; `codev.gateWrite` is the same situation. What did not
transfer was the resolution: the non-`OrchestrationRpcSchemas` branch resolved schema names from
`git.ts` and nothing else, and `CodevGateWriteInput` lives in `orchestration.ts`. The branch now
takes the module from `spec.source`, and reverting that change makes generation fail with
`pin.json names CodevGateWriteInput for codev.gateWrite, but git.ts does not export it.` rather than
silently emitting nothing.

`classify-churn.mjs` carried the same hardcoding and is fixed with it. Left alone it would have
reported `codev.gateWrite: <absent>` at every commit — "the method is not in the contract" spelled
identically to "this tool looked in the wrong file".

### The checker threw on the payload it was vendored to check

The round-trip test for the new method did not fail an assertion. It raised
`UnsupportedKeywordError: shape-check does not implement JSON Schema keyword "minItems"`.

Phase 4 bounded the gate's `choices` to one-to-five entries, which is the first schema in the
vendored closure to emit `minItems`/`maxItems`, and `shapeCheck` throws rather than passing on a
keyword it has not implemented — a refusal to report a match for something it did not check. So
`checked.ts` would have thrown at the call site on every gate-write payload, having been given a
schema it could not walk.

Implementing the two keywords is a strengthening, not the relaxation the phase deliverable forbids:
nothing that passed before fails now, nothing that failed before passes, and the checker's stated
semantics — lower bound on branded ids, excess ignored to mirror the decoder — are untouched. Both
halves were verified by reverting: dropping the keywords from `SUPPORTED` makes the round-trip throw
again, and keeping them supported while deleting the two bound checks makes only the bounds test
fail.

This is the fourth time on this project that a thing was wired and its call site was not exercised.
The test that caught it is the one that constructs the payload a caller would send and runs the
production checker over it, rather than asserting that the schema contains a `minItems` key.

### The cold-start evidence had to be re-scoped, and its collector with it

`spec-146-t3-contract.test.ts` asserted `evidence.pinnedCommit === pin.commit`. That held only while
the two identities were equal. This phase moves `pin.commit` onto the fork head, and the evidence
describes the **upstream** harness starting the **upstream** server from the read-only clone, so the
commit it should be checked against is `pin.upstreamBase`.

Re-collecting it against the fork would have been the wrong fix — it changes what the evidence is
evidence *of* while every assertion stays green, and spec 146's criteria about the pinned harness
would quietly stop meaning what they said.

Re-scoping only the test would have been half a fix. `smoke.mjs` still wrote `pinnedCommit:
pin.commit`, so the next collection would have recorded a fork sha as the provenance of an upstream
run. The field is therefore **renamed** — `pinnedCommit` to `upstreamCommit` — and reads
`pin.upstreamBase`. A rename rather than a re-point, so evidence written under the old meaning
cannot be read as though it were written under the new one; the test asserts the old key is absent,
which is what makes that true rather than merely intended. `collect-phase10-evidence.mjs` carried
the same expression and is fixed the same way.

### A gate that had to reopen without being touched

The fork-hash live suite is gated on `FORK_AT_CONTRACT` — fork HEAD equals `pin.commit`. It was
false by design for three phases and the suite skipped, naming its reason. Moving the pin makes it
true again with no edit to the gate.

That is worth asserting because the failure is silent in the other direction: a regeneration that
put `pin.commit` somewhere the checkout is not would leave the suite skipping forever, reported as a
skip reason nobody reads, while `contractSource` claimed the contract was fork-sourced. The
assertion lives **outside** the gated block, because a gate cannot assert that it opened.

### The flip, asserted against what actually ships

Phase 1 built `FORK_AHEAD_OF_CONTRACT` exiting `0` under `contractSource: "upstream"` and `1` under
`"fork"`, with fixture repositories proving both. Those fixtures build their own pin, so they would
have kept passing if the shipped pin never flipped. The phase adds two assertions they cannot make:
one reading `pin.contractSource` from the file that ships, and one running the harness against the
**real** fork checkout with a pin whose `commit` is the real HEAD's parent — a genuine ancestor,
which makes the real checkout genuinely ahead, with the same run repeated under `"upstream"` so the
test cannot pass against a harness that simply exits 1 on every ahead-ness.

### Two lanes, one finding, and the enumeration that let it through

Both reviewers landed on the same line. `generated/schema.ts:2` still read `Source:
<upstream repo> @ <fork commit>` — a commit that exists nowhere in the repository the line names.
`ATTRIBUTION.md` and `types.d.ts` had been corrected; `schema.ts` had not, and it is the module
that ships.

The three headers were three separate emissions of one claim, the third written as a standalone
string in a different part of `generate.mjs`. Fixing the third copy would have left the shape that
produced the miss, so there is one `PROVENANCE` constant now and every emitter reads it.

The sharper half of the finding is the test. The attribution case named two files by hand, so the
artifact not on the list was the one that drifted — and the suggested remedy, extend the list to
three, would have caught this instance and not the next. The test is derived from the directory
instead: **every generated artifact naming the upstream repository must also name the fork and the
base**, read from `readdirSync`, with an assertion that it found artifacts at all so it cannot pass
vacuously. Verified by reverting the header and confirming only that test fails.

### What can a human see or do now that they could not before

Nothing yet. This is infrastructure. What changed is that `porch-driver` and `codev-agent` can now
send `role`, `parentThreadId` and `codev.gateWrite` against a vendored contract that knows them, and
a `codev.gate-set` frame arriving on the stream shape-checks instead of being rejected as
unrecognized. Phase 7 is still the first that renders.

## Phase 6 — Hierarchy and gate state published by the Codev side

### The finding, and it needed a server the harness could not start

The plan's acceptance criterion for this phase is a live round trip: dispatch an
illegal hierarchy edge over a socket and assert the client can still tell "no such parent" from
"wrong parent role". The reason it is written that way is the record. Phase 2's schema guard was
wired to a layer nothing builds. Phase 3's six discriminants were rewritten by
`OrchestrationEngine` into a message that was not merely lossy but false. Both were green in every
test beneath the layer that broke them.

**The harness could not run it.** `t3-server.mjs start` runs the published `t3@<pin.cliVersion>`
CLI against the upstream checkout — that is what every spec 146 measurement is about, and that
server has no `codev.*` anything. `parentThreadId` is not in its contract, so an illegal edge is
not illegal there; it is an unknown field the decoder strips. A "wire test" against it would have
passed and proved nothing.

So the harness gained `start-fork`, which runs the fork's `apps/server/src/bin.ts` directly under
the same interpreter. There is no build step because there does not need to be one — the server
runs from source under Node's type stripping, the same way the codegen does — and adding a bundle
would put a build artifact between the source we changed and the server under test. It is a
separate verb rather than a flag on `start`, and it takes its own `T3_HARNESS_DIR` and
`T3_HARNESS_PORT`: the two bring up different servers from different checkouts, and a caller who
means one must not get the other by dropping a flag.

**The first run failed on all four cases.** Every refusal arrived as
`OrchestrationDispatchCommandError` with the reason inside `message`, as English, behind a `cause`
holding a serialized `Error`. A client could not tell `parent-not-found` from
`parent-not-architect` without parsing a sentence. Phase 3 fixed the ENGINE deleting these; the ws
layer was flattening them one hop further out — the same shape, a third time, in the layer nothing
had yet crossed.

### The fix, and the two things it taught

`OrchestrationDispatchCommandError` gains an optional `refusal` carrying the refusing error's tag
and its machine-readable reason. `bootstrapThreadDisposition`, one field above it, is the
precedent: an optional machine-readable field so a client branches without reading prose. Optional
for the same reason — most dispatch errors are internal and have no reason to give, and
`refusal: null` on all of them would be a claim rather than an absence.

`CodevHierarchyInvalidReason` **moved into the contract**, because it travels. A vocabulary that
reaches a client and is declared only in `apps/server` means every client keeps its own copy of six
string literals and checks it by hand against a file it does not import. Once it was in the
contract it could be vendored, and `porch-driver`'s copy is now checked against
`generated/schema.json` unconditionally rather than against a fork checkout the test had to skip
without.

**Four wrapping sites, not one.** The test that asserts them found two the first fix missed —
including one that rebuilds an existing dispatch error in order to add a field, and would have
deleted the discriminant while adding it. That site is the more instructive of the two: it is not a
place that forgot to lift the reason, it is a place that copies three fields by name and therefore
drops every field nobody remembered to add.

**The second run failed too, differently.** The live script read `domain.reason` — a true reading
of the old server and the wrong one for the new. That is worth recording because it is the shape of
a false negative: a test that was right about the world at the moment it was written, and whose
failure after the fix looks exactly like the fix not working.

### Losing the question is better than losing the gate

Codev bounds a gate request in BYTES (`GATE_REQUEST_LIMITS`); the fork bounds `CodevGate` in string
length, and tighter — a 1024-byte question porch accepts can exceed the fork's 500-character cap.
The fork refuses an oversize gate WHOLE, because a gate that partially applied would leave a human
looking at half a question.

So the publisher narrows, and it narrows only the optional content: the question is dropped, the
choices capped at five, a second recommendation demoted, a terminal excerpt kept tail-first behind
a truncation marker. `gateName` and `requestedAt` always travel, because they are what say a human
is needed. Every drop is named to the caller — a silently shortened question reads as the whole one.

The single case where the gate IS dropped is an unusable gate name. A name cannot be shortened
without changing which gate it names, and showing a human a gate they cannot match to their
protocol is worse than showing none.

### The publisher invents no revision, and that is what makes a restart safe

`codev.gate.set` takes an optional `revision` and this never sends one. A counter held in a
writer's memory resets when the writer restarts, and a reset counter makes every later write stale
— which renders as "no gate pending" exactly where a human is waiting.

The corollary is that reconnect republishes CURRENT state rather than replaying history, and the
publisher gets that for free by living with the connection: a new socket builds a new
`GatePublisher`, which remembers nothing. Spec test scenario 4 — kill and restart mid-gate — is
therefore not a special case in the code at all, and the test models it by building a second watch
over the same workspace after changing `status.yaml` while nothing was running.

**Only a confirmed write updates the publish memory.** A memory updated on failure would suppress
the retry, and for a gate waiting on a human "the next change to `status.yaml`" is forever.

### A dropped cycle, spelled like nothing to do

The first version of the publish cycle skipped a request while one was in flight and returned `[]`.
That is "I did nothing" spelled exactly like "there was nothing to do", and it is worse than it
sounds: the watcher fires on the same file change a caller is reacting to, so the dropped request
was reliably the caller's. Found by an integration test whose explicit `publishNow` silently did
nothing. Cycles are chained now, so every request runs, in order.

### An unreadable status.yaml publishes nothing

It does not clear. Clearing would spell "I could not read the file" like "no gate is pending", on
the one thread where a human may be waiting.

### What can a human see or do now that they could not before

Still nothing rendered — phase 7 is the first that renders. What is now true is that a spawned
builder lands on the fork with `role: "builder"` and its architect's thread id, a porch gate
reaching `pending` appears on the thread within one publish cycle, and a client that dispatches an
illegal edge gets back a discriminant it can branch on instead of a sentence it would have to parse.

## Phase 7 — Workspace to architect to builder, in t3code's own sidebar

### The seam check found two defects before a call site existed

`hierarchy.ts` is a pure function and its tests build their own row type. Both of those are right —
that is what makes them tests of the grouping — and together they cannot tell you the module fits
anything the sidebar holds. Two assignments at the top of the test file are the whole check:

```ts
const _sidebarRowsFit: (rows: readonly SidebarThreadSummary[]) => unknown = buildCodevHierarchy;
const _threadsFit: (rows: readonly Thread[]) => unknown = buildCodevHierarchy;
```

They failed, twice, on a module whose own suite was green:

- it keyed on `threadId`, the **command** spelling, while both read models call it `id`;
- `role?: X` does not accept `undefined` under `exactOptionalPropertyTypes`, so the interface
  described a shape no caller has until `| undefined` was written out.

Neither is a runtime error and neither would have thrown. Both would have shipped as
`buildCodevHierarchy(threads)` quietly returning no hierarchy, which on screen reads as an empty
workspace rather than as a bug. This is the "assert the call site, not the module" rule working
**prospectively** rather than forensically: the previous five instances were found after the code
shipped, by running it; this one was found before a caller existed, by the compiler.

### The section boundary, and the reason that was a lie

t3code splits a project into Pinned / Active / Snoozed / Settled before any grouping runs, so the
tree is built over ONE of those lists. A builder whose architect the user has pinned is therefore
looking at a list its parent is not in — and the first draft answered `parent-missing`, three rows
below the architect the user can see.

`buildCodevHierarchy` now takes `alsoVisible`, the rest of the sidebar, and answers
`parent-elsewhere`. Role still outranks section: a non-architect parent stays
`parent-not-architect` wherever it sits, because letting a section boundary change what a thread IS
would make the reason a fact about the sidebar rather than about the data.

Reading that lookup was itself a bug, and its test caught it. `elsewhereRoleById.get(id) !==
undefined` cannot distinguish "not in another section" from "in another section, with no role" —
because a roleless thread's role *is* `undefined`, and the second of those is exactly the
`parent-not-architect` case the branch exists to name. It reads `has` now. Verified by reverting to
`get`: the test fails.

### The render order is also the keyboard's order

`orderedThreads` is not only a render order. Shift-range-select and jump-hint labels are both
assigned from it. A component that reordered rows into a tree while leaving that list alone would
draw every row in the right place and send the keyboard to the wrong ones — a defect no screenshot
shows and no component test that renders one list would see. So `buildCodevSidebarOrder` returns one
order, and the caller renders in it **and** derives `orderedThreads` from it.

### Nothing changes for a project with no Codev roles

`hasCodevHierarchy` is false there, and the renderer takes the loop it has always had: same rows,
same order, no wrappers, no headings, no divider. An empty tree's chrome would be new furniture in
every upstream user's sidebar for a feature they do not have. Asserted directly — the no-hierarchy
branch returns the input list unchanged, in input order.

### Four reasons, four sentences

The orphan group carries a sentence per row rather than one "could not be placed". A reader opens
that group to find out which of four things happened, and one string for four states is the shape of
"I could not tell" spelled like an answer — the same rule that produced `parent-elsewhere` in the
first place.

### The e2e is a browser against the real stack, and it proved it can fail

`packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts` drives the FORK's web app against a
server built from the fork's source, with threads created over the wire. Not a component harness: a
component test supplies the shells itself, which is the step whose absence is the risk.

The orphan is made the way a real one is made — an architect archived after its builder exists — and
not by writing an illegal edge, because phase 3 refuses those at write time and a fixture that
produced one would be testing a state the server cannot reach.

Verified to fail: with the render branch forced to the no-hierarchy path, all eight rows still
render and every hierarchy selector goes to zero. The assertions fail; they do not pass on a flat
list.

### Screenshots are the deliverable, and there is no reference to compare them to

Committed to the fork at `docs/codev/spec-250/phase-7/`, at 390, 1440x900 and 1920, two per width
(the page, and the sidebar list at its full height — the sidebar is its own scroll container, so a
900px window clips the orphan group). Measured at every width rather than eyeballed: no horizontal
overflow, every thread title at or above 13px, zero console errors after pairing.

**There is no mockup or design reference for this tree.** The nesting is drawn in t3code's own
idiom — the same row cards, an indent and a hairline rail in the token the sidebar's other dividers
use, and a group heading in the shape of the existing Snoozed and Settled shelves. Nothing was
ported from `apps/client`. But "it matches the host app's conventions" is a claim about the
conventions, not a ruling on the appearance, and a green suite cannot make that ruling. Raised to
the architect with the screenshots rather than assumed.

### Writing the screenshots had to become opt-in

`t3-server.mjs start-fork` refuses a dirty fork checkout. A suite that wrote new PNG bytes into the
fork on every run therefore passes once and SKIPS forever, each run leaving behind the modification
that stops the next one — and the skip is correct behaviour, which is what makes it easy to miss.
Ordinary runs write into Playwright's output directory; `SPEC_250_WRITE_SCREENSHOTS=1` refreshes the
committed copies deliberately.

### The screenshots found a criterion gap the tests could not

The suite was green, every acceptance criterion had an assertion behind it, and the render was
still missing one of criterion 1's three levels. "Project, architect, that architect's builders" —
the tree had architect and builders, and the project was present only as a caption repeated on all
eight cards. Every test that could have caught it was written against the two levels that existed.

That is the project's own lesson arriving on schedule: a green suite cannot detect design
infidelity, and here it could not detect a missing *requirement* either, because the tests and the
render were built from the same reading of the plan. The screenshot is what made the gap visible,
and it took a human looking at it.

Two more came from the same review. Nothing said which row was an architect — it was carried by one
level of subtle indent plus test data that happened to be called "Architect beta" and "Builder alpha
one", and real threads are called `builder/spir-250`. And the orphan group was amber, which says
something is broken, on a state this project deliberately ruled legal.

All three are fixed, and the assertions now exist for the first two: a project heading above the
tree, no row inside the tree repeating the project name, rows outside it still carrying it, the
architect row captioned and its builders not. The third is a colour, and the screenshot is its
evidence.

### The tree covers the Active section only, and phase 8 inherits that

Named here because it is an unstated narrowing of "the sidebar renders the tree", and the only other
place it is written down is a code comment.

t3code splits a project into Pinned / Active / Snoozed / Settled before any grouping runs. The tree
is built over **Active**; the other three keep the flat rendering they have always had and reach the
grouping as `alsoVisible`, which is what lets a builder whose architect is pinned say
`parent-elsewhere` instead of `parent-missing`. That is the right scope for this phase — the split
is t3code's own and predates us — but a phase that assumes "every Codev thread is in the tree" will
be wrong for any thread the user has pinned, snoozed or settled. Phase 8's gate panel should read
gate state off the thread rather than off a position in the tree.

### Live per-row status is t3code's, and it is not a gap

Every row in the screenshots reads "now" with no working/turning indicator, which looks like spec
146 criterion 3 going unowned. It is not. `resolveSidebarThreadStatus` already returns
`approval` / `input` / `working` / `monitoring` / `failed` / `ready` from `session.status` and
`backgroundLiveness`, and the sidebar already renders it as a pill — spec 250 does not touch any of
it. The fixture's threads read "now" because they have never taken a turn: nothing is running on
them, so `ready` is the correct answer. The half spec 250 owes is **blocked on a named gate**, which
is phase 8's criterion 3.

### What can a human see or do now that they could not before

**This is the first phase with a non-empty answer.** Open t3code's sidebar and the threads Codev
created are a tree: the project as a heading, each architect below it captioned as one and above the builders
that name it, two architects side by side as two subtrees, threads Codev did not create in the flat
list they have always had, and a builder whose architect is gone named as orphaned with the reason
it could not be placed — instead of one flat list in which none of those things is distinguishable
from the others.

## Phase 8 — A porch gate, rendered from the gate block

### The gate has to be written by the credential that writes gates

The e2e fixture could not seed a gate the way it seeds everything else. A bootstrap exchange asking
for `codev:gate-write` is refused with `invalid_scope` — phase 4's design holding, not a bug to work
around. Gate writes come from ONE credential, `codev-agent`, scoped to `orchestration:read` and
`codev:gate-write` and nothing else, provisioned by the server rather than derived from whatever
token a client happens to hold.

So the fixture reads that credential from `<serverBaseDir>/codev/gate-writer.token`, where the
fork's server writes it at start, and opens its own connection with it — exactly what
`thread-backend.ts` does in production, and for the reason that file already records: the seeding
socket carries `orchestration:operate`, and putting gate writes on it is precisely what phase 4
gave the method its own scope to prevent.

A fixture that had obtained the ability another way — widening the scope, writing the column — would
have been testing a path no writer uses.

### The third state, and why it is a union rather than a nullable object

`porch gate <id>` without `--request-file` is legitimate and common, so a gate can be pending with
no question and no choices. Rendering that as "no gate" hides a human who is waiting. Rendering it
as `pending` with an empty question shows a heading with nothing under it, which reads as a broken
gate rather than an absent request. It is `pending-unstructured`, it says
"Gate pending, no structured request", and both the derivation and the panel have tests that fail
when it collapses into either neighbour.

"Structured" means there is something to READ, not that a field was sent: a gate carrying only
choices, or only a question, is structured. A gate carrying neither is not.

### It is not folded into session status, and the hue matters

`starting` / `running` / `ready` / `settled` describe what the AGENT is doing, and none of them can
say "a human has to decide". `hasPendingApprovals` cannot stand in either — that is provider TOOL
approvals, and the contract already records why the two must stay apart.

The row marker therefore has its own derivation and its own colour. Amber is Pending Approval,
indigo Awaiting Input, sky Working, violet Plan Ready, emerald Completed; reusing amber would
collapse exactly the distinction the gate block exists to make, so the gate is rose. A test asserts
the pill uses none of the five taken hues, which is the only way that claim survives a later
refactor.

It also sits OUTSIDE the status slot, which fades to make room for the row's hover actions. A gate
that vanished when someone reached for the row would be missing precisely when it was being acted
on, and no screenshot taken at rest would show it.

### The XSS test that gets quieter as the defect gets worse

Gate text — the question, every label, every consequence, the terminal excerpt — is written by a
builder agent into `status.yaml` and carried over a socket. A panel that rendered any of it as
markup would let a repository under review script the page reviewing it.

The obvious test renders a payload and asserts the markup contains no `<img`. It passes on the
current code and it would keep passing on a version that escaped the question and handed only the
terminal excerpt to `dangerouslySetInnerHTML` — that one field would simply stop matching the
escaped-count assertion, and a check that reports LESS as the defect grows is worse than no check.
So there is a second test that reads `GatePanel.tsx` and fails on any use of the escape hatch. It
matches a use (`dangerouslySetInnerHTML=` or `:`) and not a mention, because the file's own doc
comment names the thing it does not do, and a bare substring check would train the next reader to
delete the sentence rather than the risk.

### A case the plan asked for that cannot exist

The test plan asks for "a choice with no consequence". `consequence` is a required non-empty string,
so a choice without one is refused whole at the schema boundary and cannot reach a renderer. Left in
as a test that asserts the refusal, rather than dropped, so the next reader can see the case was
checked and found unrepresentable instead of assuming it was forgotten. Same shape as phase 4's
`CODEV_GATE_SCOPE_REQUIRED`.

Every fixture in both suites is DECODED through `CodevGate` rather than written as an object
literal, which is what makes that finding possible: six choices, two recommendations and a
multi-line question all fail in the fixture instead of being asserted about as though they could
arrive.

### Screenshots poisoning the suite, the second time

Phase 7 found that writing screenshots into the fork makes `start-fork` refuse the next run, and
answered it with an opt-in flag. Phase 8 added a second spec file and found the flag did not cover
it: with two files, the first writes PNG bytes and the second SKIPS, in the same run, and the skip
is correct behaviour. Screenshots now always write outside the fork and are copied in afterwards.

### Two review findings, and one of them had no good answer at first

The terminal excerpt had no caption. Unlabelled, a mono block under the choices is just trailing
output: a reader cannot tell the builder's reasoning from the failure that caused the gate from
unrelated log noise, and those need three different responses. It says "Terminal excerpt" now, which
is the name the gate request itself uses, so the caption and the field a builder fills in are the
same word.

The second was a question — does a gated ARCHITECT render the role caption AND the gate? — and the
answer was worse than yes. Both rendered, on the same line, competing for the same ~230px, so the
caption truncated to `A…`. Moving the marker to the title line fixed that and truncated the title
instead, on every gated row. Neither placement was acceptable, and the fix was not a placement: the
label dropped `Gate: ` and took the panel's gavel instead, which bought back six characters and let
the caption, the gate name and the title all survive.

A clip remains and is deliberate. A 15-character gate name on a gated architect still shows
`Archit…`; the gate name and the title are intact. That is the right order — an architect at a gate
is the row a human most needs to find — and it is recorded here rather than left for a reviewer to
notice in a screenshot.

### What can a human see or do now that they could not before

Open a builder that porch has stopped at a gate and t3code says which gate, when it was requested,
what it is asking, what each choice would do, and which one the builder recommends — instead of a
thread that looks settled. From the sidebar, that builder is marked as blocked on a person rather
than as finished. And a gate with nothing attached says so, instead of looking like no gate at all.

Nothing here approves anything: that is phase 10. This is the reading half.

## Phase 9 — Builder tiling

### The port was a re-measurement, and the difference is 228px

`apps/client/src/responsive/layout.ts` computes every column count from `viewportWidth`, because its
grid **was** the page. This one is a route inside t3code's chat shell, behind a sidebar that is
232px at rest, narrower when dragged, and gone at 390. Carrying the constants across unchanged would
have produced numbers that are right about a page nobody is looking at.

Every function takes the AVAILABLE width now, and the grid measures its own container with a
`ResizeObserver` — a window listener would miss a collapsed sidebar entirely, which changes the
space without changing the window. Six panes at 1440 have 1176px of it, not 1404.

Three columns fit either way, so **criterion 5 would have passed on the viewport version by luck.**
That is worth saying plainly: the acceptance criterion the plan leads with cannot detect the bug the
plan asks the port to avoid. Criterion 5b can, which is why it exists.

`PAGE_PADDING` dropped 18 → 12 (t3code's shell already pays for horizontal inset); `GRID_GAP` stayed
at 12 (already t3code's rhythm). Both recorded in the file with the measurement.

### The rendered columns are counted from the browser, not from the component

The grid publishes `data-codev-grid-columns`, and an assertion on that alone would be asking the
component to confirm its own arithmetic — the same defect as phase 7's builder count, which the
review caught there. So the Playwright spec counts distinct rendered x-positions of the pane boxes,
and asserts the attribute too. They have to agree.

### Two defects the screenshots caught that the tests did not

**Pane text was 12px.** `text-xs` is t3code's own secondary-label size and it is right in a sidebar
row, read from a foot away with one thread in focus. A pane is a tile in a grid of seven, scanned
rather than read, and criterion 5 puts the floor at 13 for that reason. The type went up. The
alternative — narrowing the assertion to "body text only" and declaring the labels out of scope — is
how a grid passes its tests and is unusable, which is the failure this project already has on record
from spec 83.

**At 390 the shell's floating sidebar toggle sat on the first pane's own label.** No test could see
it: every pane was over the floor, nothing overflowed, and the toggle is not part of the grid. The
route has a header now, which clears it at every width and names a screen that was otherwise seven
unlabelled cards.

### The pane says what it cannot see, and the first version of that was FALSE

Two of the four things the plan asks a pane to show — the porch phase and the last three messages —
are not on the thread. The first draft called them "not published" and asked the architect to choose
between adding a contract field, subscribing per pane, or shipping without them.

All three options were wrong, and the architect checked rather than ruling from the framing:
`codev-agent` **already publishes both**, workspace-scoped, in ONE request for the whole grid —
`GET /api/agent/v1/workspaces/<b64>/state` carries `porch.phase` and the last three messages per
identity. That is where `apps/client` reads them. So the plan's ban on six continuous subscriptions
was never in tension with showing them, and no contract change was needed.

The lasting correction is the wording. "Phase not published" is a claim about the world and it is
false; the true sentence is that this page cannot reach codev-agent yet, which phase 10 fixes. A
pane asserting data does not exist when the pane simply cannot see it is this project's most-caught
defect, and it nearly shipped again in the words rather than in the code.

### A criterion the spec dropped, restored because a screenshot argued for it

Spec 250 restated spec 146's criteria 5 and 5b and never restated 4b — the architect does not take
an equal tile where that makes a ragged row. Nothing in this plan was broken by the omission, and
the first 1440 screenshot was the argument: six builders and an architect at three columns is
3 + 3 + 1, one lonely card beside two empty slots. It is in the plan as a criterion now, so the next
reader checks it rather than remembering it.

The interesting part is the number. Spec 146 states 4b as "1920 or wider", and implementing that
literally here would have been **wrong**: `apps/client` owns the whole viewport, so its viewport
width and its available width are the same number, while this grid sits behind a sidebar where 1920
of viewport is 1688 of grid. A viewport threshold would offer the tile at 1920 with the sidebar
dragged wide enough that only three columns fit — the exact defect the criterion exists to prevent.

So it is stated as "four columns fit", which is not a proxy for the reason but the reason itself:
seven items at four columns is 4 + 3, the ordinary shape of any grid. It gives what 4b names at both
viewports 4b names, and it is right at a 1600px window with a collapsed sidebar, where the literal
reading would wrongly withhold the tile. Spec 146's wording stays as it is — `apps/client` is frozen
and still owns its viewport, so it is still true there.

Raised before building rather than after, and the architect ruled on the departure rather than on
the framing.

### A test that could not fail, and the fixture that fixed it

The architect asked whether an architect TILE stays distinguishable from a builder tile in the
multi-architect case, where there is no strip, no indent and no rail — the role prefix is the whole
distinction. It could be clipped: the prefix lived inside the truncating span, so a long enough
title in a narrow enough pane would eat it.

Two things about the check that catches it. It measures `scrollWidth` against `clientWidth` rather
than reading text, because `text-overflow: ellipsis` is invisible to a text assertion — the DOM
still holds `builder/`, so `toContainText("builder/")` passes on a prefix rendered as `buil…`. And
it could not have failed as first written: six short fixture titles never fill a pane, so a prefix
that COULD be clipped never was.

One fixture builder is named long enough to truncate now. Verified by reverting: that pane clips its
prefix by 22px, and the text assertion still passes. Real threads are named `builder/spir-250 gate
rendering in t3code` and worse, so the long title is the realistic case rather than a contrivance.

### What can a human see or do now that they could not before

Open one screen and watch six builders at once inside t3code, each pane naming the agent by role,
its status, and the gate it is stopped at if it has one — a clean 3x2 at 1440x900 with every pane
over 340x240 and the architect on a strip below it that expands on demand, seven equal tiles in four
columns at 1920 where that is not ragged, and on a phone pages of two rather than seven panes
squeezed under the readable floor.

## Phase 10 — Approval from t3code over the same-origin proxy

### The guarantee is structural, and the test the plan first proposed would have passed vacuously

The spec's Security section and the plan's first draft both said `connect-src 'self'` "stays
closed". t3code sends `Content-Security-Policy` on `.svg` asset responses only
(`apps/server/src/http.ts`), and `apps/web/index.html` carries no meta tag. **There is no
page-level CSP and therefore no `connect-src` directive to keep closed.** A test asserting one
would have been green against a header nobody sends — a check that cannot fail, on the security
property of the phase.

What actually holds is narrower and stronger: the page never *makes* a cross-origin request,
because it has no absolute URL to make one with. `agentUrl` returns a path, and
`pairing.test.ts` asserts that with `expect(() => new URL(url)).toThrow()`. The browser test
then records **every request the page issues** while it pairs, reads workspace state and
approves, and asserts each one is on t3code's origin — plus one assertion that it reached the
proxy at all, without which the first would pass on a page that made no agent request.

Adding a page-level CSP is deliberately not done. It changes how every t3code page loads, which
is far wider than this spec's diff, to obtain a guarantee already held.

### The target is configured, and a route-path allowlist would not have been enough

The plan's own most consequential item, found in review round 1: the deliverable said the web app
"holds the `codev-agent` origin", and a server proxy forwarding to a browser-named origin is an
SSRF primitive. A path allowlist does not constrain the *host*.

So the operator configures `T3CODE_CODEV_AGENT_ORIGINS` as `id=origin` entries and the browser
selects by **id**. The origins never reach the page — `/api/codev/agent-targets` answers ids
only, and the e2e asserts the agent's port does not appear in the body. A URL arriving where a
path belongs gets its own refusal (`CODEV_AGENT_PATH_ABSOLUTE`) rather than falling off the end
of the allowlist, because "this is not a path" and "this path is not carried" send a reader to
two different places.

Three unconfigured/misconfigured states get three signals, ported from `client-static.ts`'s
lesson: `CODEV_AGENTS_UNCONFIGURED`, `CODEV_AGENTS_ALL_REJECTED`, and a usable list with the
rejected entries reported beside it. An operator who typed a bad origin and one who configured
nothing need opposite next actions.

### An allowlist for headers, and the `Connection` subtraction on top of it

`client-static.ts` builds its strip set from a fixed hop-by-hop list *plus the tokens the
request's own `Connection` header names*, because that header names headers that are themselves
hop-by-hop. This port inverts the default — an **allowlist** of what may travel, since this hop
sees credentials and a denylist forwards everything nobody thought of — and still subtracts the
`Connection` tokens, because an allowlist alone forwards a header a request declares
connection-scoped, and here that header is the machine credential. Both mechanisms are exercised;
removing the subtraction fails the test named for it.

`authorization` and `cookie` are absent from the allowlist and that absence is a deliverable:
t3code's own session gates USE of the proxy and is never handed to another server.

### Two failure signals, and a redirect that is refused rather than passed on

An unreachable host and one that accepted the connection and said nothing keep separate signals,
driven against real sockets — a closed port and a server that accepts and never answers. A 3xx
from the configured origin is refused (`CODEV_AGENT_REDIRECT_REFUSED`): forwarded to the page,
the browser would follow it, cross-origin, with the request's credentials, which is the escape
the configured-target rule closes one hop earlier.

Three of `codev-agent`'s routes are deliberately not carried. The SSE stream, because this proxy
buffers and a buffered stream is live on the wire and empty in the page. Both revocation routes,
because `afx pair revoke` is the operator path and a browser that could revoke could deny a human
their own gate.

### Three defects the browser caught and the tests could not

Every unit test in this phase was green through all three.

**The page read the agent store once and froze.** Pairing succeeded, the credential reached
browser storage, the poll ran and returned 200 — and the panel still said this browser holds no
codev-agent credential. A hand-rolled subscription (a `useState` tick pushed from a module-level
listener set) rendered the first snapshot and never followed the store again. `useSyncExternalStore`
is the primitive for this shape, with a snapshot **replaced** rather than mutated so its identity
is the change signal. This cost more time than anything else in the phase, and nothing but a
browser could have found it: every function involved is individually correct.

It also could not be debugged from inside the fork. `start-fork` refuses a dirty checkout — by
design, and the right design — so instrumenting the component for a browser session is not
available without committing. The fix came from replacing the mechanism rather than from
observing it.

**A gated pane dropped the phase it had just gained.** The gate replaced the phase line, which
was right in phase 9 when there was no phase to show and wrong the moment `codev-agent`'s
projection arrived. A reader who has found the pane that wants them still needs to know what it
was doing. The gate leads in rose with its gavel; the phase follows.

**`Send a message to start the conversation.` printed across `Waiting on you: <gate>`.** On a
thread with no turns, t3code's empty-timeline placeholder is centred over the whole content column
and lands on the gate panel. **Present since phase 8** — the phase 8 panel-only screenshot could
not show it, and the full-page one did. Hidden through upstream's own `hideEmptyPlaceholder`
rather than moved, because it is also wrong advice: a thread waiting on a human approval is not
waiting for a message.

That is the second time in this spec that a cropped screenshot passed something a full-page one
would have caught, and the lesson is the screenshot's framing, not the reviewer's attention.

### Pane content landed here, and the contract was not extended for it

The architect's ruling, recorded in the plan because the phase's file list predates it. Phase 9's
panes said "Phase not read here yet — published by codev-agent", which was true: `codev-agent`
has published the porch phase and the last three messages workspace-scoped since phase 6, in ONE
request for the whole grid, and no page could reach it. The proxy is the way in, so the panes read
it here.

The project id the approval needs comes from that same snapshot, which is why the two arrived
together. A project id on the gate block would have been a second copy of a fact `codev-agent`
already owns, and two copies can disagree.

Every branch that still cannot show a phase names which one it is: not paired, the agent could not
be reached, the agent answered and does not publish this thread, or it published no porch project.
A blank line for all four would be a claim about the builder rather than about what reached the
browser. The message log keeps its three states too — an agent predating the field HAS messages it
is not sending, and that is not "no messages".

### Testing the seam, twice, because one test cannot make both claims

`spec-250-t3code-approval.e2e.test.ts` drives the REAL fork server's proxy in front of a real
`agent-routes` host, over `fetch`, ending in a real `status.yaml` — criterion 4. Nothing is
imported and no proxy function is called: the test reaches the route the only way a browser can,
so a route registered nowhere fails it. The unit tests can prove `forwardableHeaders` strips a
header; only this can prove anything is wired to `forwardableHeaders`.

`spec-250-approval.spec.ts` makes the claim a `fetch` cannot: what a real page asks for.

Both share `spec-250-agent-host.ts` rather than each building a host, so they cannot drift into
testing two different services. It seeds identities AFTER start, because the order is a circle
broken in one place: the fork server needs the agent's port in its environment at start, and the
thread ids the identities carry do not exist until that server is running.

### Falsifiability, and the one that is about configuration rather than code

Reverting five mechanisms — the `Connection`-token subtraction, the header allowlist, the redirect
refusal, the credentials-in-URL rule and the anchored route pattern — fails five unit tests.

The e2e's check is different in kind and worth naming: pointing the configured allowlist at a dead
port fails 4 of its 7 tests. That is what proves the ceremony travels the configured proxy and not
some other path that happens to work — a shape the unit tests cannot express, because the thing
under test is the wiring.

### What can a human see or do now that they could not before

Approve a porch gate from t3code, on a phone or an iPad, without a terminal: pair the browser once
with a token from `afx pair issue`, spend a session token, and press Approve — and porch writes the
approving session id, machine and timestamp into `status.yaml`, all three read back from the server
rather than invented in the page. And on the Builders screen, see what each builder is actually
doing — its porch phase, its plan phase and the last three messages its architect sent it — where
three phases of panes had said only that the data existed somewhere else.

## Flaky Tests

`packages/codev/src/terminal/__tests__/session-manager.test.ts > stderr tail logging (integration) >
no stderr tail logged for file-based stderr (Bugfix #324)` timed out at 30s once during phase 9,
in a full-suite run. It spawns a real process, nothing in spec 250 goes near `src/terminal/`, and it
passed alone immediately afterwards and in the next full run (7370 passed, 0 failed). Recorded
rather than skipped: a test that passes on its own and once timed out under load is a timing
sensitivity, and annotating it as skipped would remove coverage to hide a slow machine.


`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
Pre-existing and unrelated to spec 250: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is
empty, the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to
`/private/var`. Not skipped and not modified — editing an upstream test we did not break is
gratuitous divergence on a fork that has to rebase.
