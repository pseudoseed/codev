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

## Flaky Tests

`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
Pre-existing and unrelated to spec 250: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is
empty, the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to
`/private/var`. Not skipped and not modified — editing an upstream test we did not break is
gratuitous divergence on a fork that has to rebase.
