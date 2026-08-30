# Spec 250, phase_2, iteration 1 — review responses

**claude** REQUEST_CHANGES, **opencode** COMMENT. Three findings, all accepted, none disputed.
Both lanes named the two substitutions independently.

---

## claude #1 / opencode — "a newly introduced upstream migration still runs" never invoked the migrator — ACCEPTED

> `schemaGuard.test.ts:145` never invokes the migrator, so "a newly introduced upstream migration
> still runs after the guard" is unproven.

Correct, and the citation is exact: `:155` was a raw
`ALTER TABLE projection_threads ADD COLUMN pretend_upstream_column TEXT`.

That statement proves SQLite accepts another column. It proves nothing about whether the
**watermark** let the migrator execute one — which is the entire question migration 900 got wrong,
and therefore the entire reason the test exists. The substitution was adjacent enough to the real
mechanism to produce identical observable state: a column appeared either way. Only the path it
appeared by was ever in question, and that is exactly what the assertion had dropped.

**Fixed.** `runMigrations({ toMigrationInclusive: 41 })` → `applyCodevSchemaGuard()` →
`runMigrations()`, asserting migration 42 executed *and* that its column exists — recorded-as-run
and actually-applied being two claims. That is upstream's own idiom from
`042_ProjectionThreadLinkedPullRequest.test.ts:16-17`, as the lane pointed out.

Added alongside it: a test that the guard writes **no rows at all** to `effect_sql_migrations`, so
every id above 41 stays free for upstream.

## claude #2 / opencode — criterion 8b was simulated, not exercised — ACCEPTED

> No process kill, no file-backed DB, nothing opened against the pinned pre-fork server. Exercise
> it or record the substitution as a deviation.

Correct. The criterion names four things — a kill, a partial application, a resulting database, and
the pre-fork server binary — and the test had one of them. It still passed.

**Exercised, not recorded as a deviation.** `tools/t3-fork/criterion-8b.mjs` runs the real sequence
and writes `codev/research/250-criterion-8b-evidence.json`:

| Step | Result |
|---|---|
| Pinned `t3@0.0.36` creates and migrates a real database | opened and answered |
| Codev columns present beforehand | none — otherwise the run proves nothing |
| Child SIGKILLed after the first `ALTER` | `SIGKILL`; `codev_role` alone on disk |
| **Pre-fork binary opens the half-applied file** | **opened and answered** |
| Fork's real guard resumes | added `codev_parent_thread_id`, found `codev_role` present |
| Pre-fork binary opens the fully applied file | opened and answered |

Seven tests assert the evidence, including one that refuses evidence older than
`criterion-8b.mjs`, `crash-apply-child.mjs` or `t3-server.mjs`.

The resume step runs the **production** `codevSchemaGuardStep` through
`apps/server/scripts/apply-codev-guard.ts`, not a copy of its statements — a script with its own
`ALTER`s would have proved the statements work and nothing about the guard, which is the same
mistake as #1.

### What this uncovered, and it is larger than the finding

**The criterion could not be expressed with the tools that existed.** `restart` is stop-then-start
and refuses when nothing is running — and after a kill, nothing is. `start` wipes the data dir
before starting. Neither can open a database the run did not just create, which is the whole of
criterion 8b.

So the in-memory simulation was not laziness; it was the only form the harness could express. There
was no failing test, no error and no skip to say so. The criterion sat in the plan reading exactly
like one that passes, and it took writing the test to discover the test could not be written.

Fixed by adding `start --keep-data` to `tools/t3-server/t3-server.mjs`. Written up in the review
under "Why `start --keep-data` had to exist", and filed as evidence on #199.

## claude #3 — `forkSkipReason` says "ahead" for any non-matching head — ACCEPTED

Correct. Behind and unrelated were both being reported as "ahead of contract commit", which is the
*tolerated* state for phases 2-4. A genuinely broken checkout would have hidden inside the expected
case for three phases — the exact outcome the ahead-vs-wrong distinction was introduced to prevent,
reintroduced one layer up in the test gate.

**Fixed.** The relation is computed with `merge-base --is-ancestor` in both directions and the skip
reason names which of four cases it is: at, ahead (expected until phase 5), **BEHIND** (not the
expected state, wants looking at), or **UNRELATED** (no ancestry either way).

---

## Not changed

Nothing. No finding in this round was a false positive.

## Verification after the fixes

- Fork `992b781f4314`, pushed. Fork typecheck green; contracts 291 passed; server 2769 passed.
- Codev repo: build green, **7283 passed, 55 skipped, 0 failed**, plus 180 in the v2 suite.
- 73 tests in the spec 250 suite.
- The one fork failure, `entrypoint.test.ts`'s symlink case, remains pre-existing and unrelated:
  byte-identical to the base commit, imports only `node:fs` and `node:url`, fails on macOS's
  `/var` → `/private/var` resolution.
