# The private t3code fork

Spec 250. `t3code` is the front end; Codev integrates with it. Every change we make to
t3code is a **private customization** — it does not go upstream to `pingdotgg/t3code`, and
we do not ask for their buy-in.

## The two checkouts

| | Upstream | Fork |
|---|---|---|
| Repository | `https://github.com/pingdotgg/t3code` (public) | `https://github.com/pseudoseed/t3code` (**private**) |
| Branch | `main`, read-only | `codev` |
| Checkout | `/Users/chris/dev/t3code` | `/Users/chris/dev/t3code-codev` |
| Env override | `T3CODE_ROOT` | `T3CODE_FORK_ROOT` |
| Pinned to | `pin.upstreamBase` | `pin.commit` |
| Written to by us | **never** | yes, one commit per plan phase |

The fork's remotes: `origin` is the private repository, `upstream` is `pingdotgg/t3code`.

## Why it is a created repository and not a GitHub fork

`gh repo fork` was not used and must not be. **A GitHub fork inherits the visibility of the
repository it forks**, so forking a public repository cannot produce a private one. The
repository was created with:

```bash
gh repo create pseudoseed/t3code --private
```

and the history was pushed into it. `gh repo view pseudoseed/t3code --json visibility` reports
`PRIVATE` and `isFork: false`; that is asserted rather than inferred from the create command
having exited zero.

The MIT `LICENSE` and its attribution travel with the copy, unmodified.

## Why the upstream clone must never move

Every piece of spec 146 and spec 236 evidence — the cold-start runs, the recorded source
hashes, the live contract suite — reproduces against `/Users/chris/dev/t3code` at
`upstreamBase`. Moving it off that commit does not break a test; it makes recorded results
unreproducible while every test still passes.

That is why `t3-server.mjs`'s `acquire`, `start` and `status` are pinned to `upstreamBase`
rather than to `pin.commit`. `acquire()` runs `git checkout --detach` against the upstream
clone, and both `smoke.mjs` and `packages/t3-client/live/integration.mjs` call it, so an
ordinary test run would have written a fork sha into the read-only clone the moment
`pin.commit` diverged.

## Which tool reads which checkout

| Reader | Identity | Why |
|---|---|---|
| `tools/t3-server/t3-server.mjs` | both | it is the verifier; `verify` asserts each, other verbs are upstream-only |
| `tools/t3-codegen/generate.mjs` | fork | generation is fork-sourced from phase 5; also hashes upstream for comparison |
| `tools/t3-codegen/classify-churn.mjs` | both | one identity per mode, and the mode is mandatory |
| `tools/t3-codegen/transform-blindness-probe.mjs` | fork | it probes what we emit |
| `tools/t3-server/smoke.mjs` | upstream | keeps the spec 146 cold-start evidence reproducible |
| `packages/t3-client/live/integration.mjs` | upstream | spec 146 / #241 live tests, meaning unchanged |
| `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` | both | upstream suite asserts upstream, fork suite asserts fork |

The mapping is resolved in one place, `tools/t3-fork/identities.mjs`. The one deliberate
exception is `packages/t3-client/live/integration.mjs`, which reads `T3CODE_ROOT` directly and
**requires** it (#214): a missing input there must read as a sentence rather than as a failure
inside the server, and keeping it required also means the fork's path cannot arrive by accident.
It never reads `T3CODE_FORK_ROOT`, and a test asserts that.

## Verifying

```bash
node tools/t3-server/t3-server.mjs verify            # both identities
node tools/t3-server/t3-server.mjs verify-upstream   # upstream only
node tools/t3-server/t3-server.mjs verify-fork       # fork only
```

The per-identity verbs exist so an upstream-only caller does not acquire a dependency on the
fork. `smoke.mjs` and `packages/t3-client/live/integration.mjs` use `verify-upstream`, and so
does `ready` — a fork that has moved ahead of `pin.commit` says nothing about the upstream
process answering on the port, and gating an upstream server start on it would break every
spec 146 run the moment we commit a customization.

Exit `0` with both checkouts clean on their pins. Exit `1` names which identity failed. Exit
`3` is "could not determine" — a missing checkout, an unreadable HEAD, an unresolvable
merge-base — and it is never spelled the same way as `1`.

### Ahead of the contract is not the same as on the wrong commit

`pin.commit` means **the vendored contract was generated from this commit**, and only
regeneration moves it. Phase 5 is where regeneration happens, so from the fork's first
customization commit until then the checkout is legitimately ahead of the pin. `pin.contractSource`
records which state we are in:

| `contractSource` | Fork HEAD descends from `pin.commit` | Fork HEAD does not descend |
|---|---|---|
| `upstream` (phases 1-4) | `FORK_AHEAD_OF_CONTRACT`, exit `0` | `FORK_CHECKOUT_MISMATCH`, exit `1` |
| `fork` (phase 5 onward) | `FORK_AHEAD_OF_CONTRACT`, exit `1` | `FORK_CHECKOUT_MISMATCH`, exit `1` |

The tolerated case is reported, not silenced — it prints on every run. It is spelled differently
from a real error on purpose: a signal that fires for three phases straight is one people learn to
ignore, and then it fires for a real reason and nobody looks.

A contract commit the fork repository does not contain at all is `NO_FORK_ANCESTRY`, exit `3`.
Whether HEAD descends from a commit that is not there is not a question git can answer.

`verify` also asserts `git merge-base <commit> <upstreamBase> == <upstreamBase>`. A rebase or
a squash that drops the base leaves a fork that is clean at a commit nothing can be measured
against, and without that check it verifies green.

## Do not "tidy" these on rebase

Two things in this fork look like inconsistencies and are not. Both are cheap to "fix" and both
fixes are wrong.

**1. `role` / `parentThreadId` are spelled two different ways.**

| Schema | Spelling | Why |
|---|---|---|
| `ThreadCreatedPayload` | `Schema.NullOr(...).pipe(Schema.withDecodingDefault(...))` | The event log holds `thread.created` payloads written before the fields existed. A rebuild replays every one and the projector reads `payload.role` unconditionally, so that read must be total. |
| `OrchestrationThread`, `OrchestrationThreadShell` | `Schema.optional(Schema.NullOr(...))` | Matches `linkedPullRequest` one line above — upstream's own newest field, optional so older cached snapshots decode. |

Unifying on the strict form produces **32 errors across 11 upstream test files**, paid again at
every rebase, to remove `undefined` from a read model the server never emits as `undefined` (every
read path normalizes `?? null`). The strict form looks more correct in isolation, and the reason it
is worse here is not visible from the diff. Endorsed by the architect on 2026-08-30.

**2. The schema guard is not wired to `MigrationsLive`.**

`MigrationsLive` is exported from `persistence/Migrations.ts` and **nothing builds it**. Wiring the
guard there would look tidier and would mean it never runs in production — while a test that
constructs `MigrationsLive` itself passes. It is called from `persistence/Layers/Sqlite.ts`'s
`setup`, which is the path that actually boots the database, and a test asserts the ordering
against that file rather than against a layer it assembles.

## Phase log

| Phase | Fork commit | What landed |
|---|---|---|
| 1 | `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6` | Branch `codev` created at `upstreamBase`. No customization yet — the two identities exist and are equal on purpose, so every new assertion has a known answer. |
| 2 | `1a414cee8409a407977ff6c6505fad1ab82f2ec8` | `role` and `parentThreadId` on the thread record, through the contract, the projector and both persistence paths. Columns applied by `apps/server/src/codev/schemaGuard.ts`, outside upstream's migration registry. |
| 2 | `992b781f4314ec1df1abb752c7c9c5378ec13c26` | Review fixes: the "upstream migration still runs" test goes through the migrator instead of a raw `ALTER TABLE`, and `apps/server/scripts/apply-codev-guard.ts` runs the real guard against a file-backed database for criterion 8b. |

### Migration 900 is abandoned, and must stay abandoned

The first draft of phase 2 planned a numbered migration at id 900, reasoning that a large gap
below upstream's next id was safe. **Under a watermark migrator it is the opposite of safe.**

`effect_sql_migrations` records the highest id that has run and the runner skips everything at or
below it. Once 900 runs, the watermark is 900 and upstream's `043` is below it — so every future
upstream migration is silently skipped, forever, on every Codev database. Nothing errors. The
schema simply stops keeping up, and the first symptom arrives months later as a query failing
against a column upstream added and we never got.

A low id is no better: upstream takes the number we took, and a database that ran ours is then
told it already ran a migration it has never seen.

So Codev's columns are applied outside the registry, in upstream's own idiom — `PRAGMA
table_info` then `ALTER TABLE … ADD COLUMN` for what is absent, the same shape as
`042_ProjectionThreadLinkedPullRequest.ts`. Nothing Codev writes ever touches
`effect_sql_migrations`. `apps/server/src/codev/schemaGuard.test.ts` asserts that, and asserts
that schema work landing after the guard still takes effect.

The one real cost is that the columns are absent from the migration history. The mitigation is
that the guard logs `CODEV_SCHEMA_GUARD_APPLIED` (with the columns it added) or
`CODEV_SCHEMA_GUARD_NOOP` on every start. Two signals, because "added two columns" and "had
nothing to do" are different facts.

**Where it is wired:** `apps/server/src/persistence/Layers/Sqlite.ts`, in `setup`, immediately
after `runMigrations()`. Not after `MigrationsLive` — that export exists and nothing builds it,
so a guard hung there would never run in production while a test that constructed the layer
itself passed.
