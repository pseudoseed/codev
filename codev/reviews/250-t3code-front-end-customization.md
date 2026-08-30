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

This needed a new harness verb. `restart` is stop-then-start and refuses when nothing is running;
`start` wipes the data dir. Neither can open a database the run did not just create, so a criterion
about opening an existing file could not be expressed at all. `start --keep-data` closes that gap.

That absence is itself worth recording: the criterion had been unprovable with the tools available
for as long as it had existed, and nothing said so. A criterion nobody can run reads exactly like a
criterion that passes.

## Flaky Tests

`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
Pre-existing and unrelated to spec 250: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is
empty, the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to
`/private/var`. Not skipped and not modified — editing an upstream test we did not break is
gratuitous divergence on a fork that has to rebase.
