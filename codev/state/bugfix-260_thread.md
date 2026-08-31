# bugfix-260 — a session refusal is raised and logged but nothing acts on it

## Investigate (phase 1)

**Reproduced.** Wrote `packages/codev/src/agent-farm/__tests__/bugfix-260-spawn-refusal.test.ts`,
driving the real `createPorchThreadEngine` + real `ThreadSubscriptionPool` against a scripted
subscriber (the shape `spec-241-thread-subscriptions.test.ts` established). The dispatcher emits
the production refusal — `thread.session-set` with `status: "error"`, `lastError: "Provider
instance 'opencode' is disabled in T3 Code settings."` — 5ms after it sees `thread.turn.start`.

`engine.create` **resolved with a thread id**:

```
AssertionError: promise resolved "'a3e97534-7f18-4785-8b55-056ab41d69af'" instead of rejecting
```

That is the bug exactly as #260 states it.

**Root cause.** `porch-thread-engine.ts:219`:

```ts
if (input.prompt) track(record, await thread.beginTurn(input.prompt));
return thread.threadId;
```

`track()` (lines 103–146) *follows* both `started.running` and `started.settled` rather than
awaiting them — deliberately, since its caller asked to start a turn, not to wait for one. Its
rejection handler (lines 115–139) logs `SessionStartFailedError` and returns. Nothing in the
chain turns that rejection into a failure of `create`, so the spawn path continues:

`create` → `allocateSpawnThread` → `launchSpawnedBuilder` (`commands/spawn.ts:215-249`) →
caller runs `persistSpawnedBuilder` → a builder row exists for an agent the server will never run.

**The builder row.** It is written by the *caller*, after `launchSpawnedBuilder` returns
(`commands/spawn.ts:681,697`). So throwing from `create` is sufficient: no row is written at
all. Nothing extra is needed there.

**Scope.** Well under 300 LOC. One bounded race in `create`, an options knob for the bound so
tests need not wait it out, plus the engine-local cleanup (`threads`/`records`/subscription) so a
refused thread leaves nothing behind in the engine.

**Setup note.** The worktree had no `node_modules`; `pnpm install` plus
`pnpm --filter @cluesmith/porch-driver... build` are needed before vitest can resolve
`@cluesmith/porch-driver/thread`.

## Fix (phase 2)

`packages/codev/src/agent-farm/porch-thread-engine.ts`, +103 lines:

- `SESSION_REFUSAL_GRACE_MS = 2_000` and `refusalWindow(running, boundMs)` — resolves on
  a started turn OR on the timer, rejects only on a rejection. The asymmetry is the design:
  "the server refused" fails the caller; "nothing has been said yet" must not be spelled
  the same way.
- `create` now races `started.running` through that window after `track(record, started)`.
  On rejection it drops its own `threads`/`records` entries and calls
  `subscriptions.stop()`, then rethrows the original error (so `SessionStartFailedError`
  keeps its name, its server sentence and its "this is a refusal, not a timeout" line).
- `refusalGraceMs` option, so tests need not sit out 2s. Production never passes one.
- `track()`'s comment about the remaining gap is corrected rather than left stale: `create`
  now acts on a refusal; `startTurn` still only logs one, and that is stated.

**The builder row.** No compensating delete is needed. `persistSpawnedBuilder` runs in
`launchSpawnedBuilder`'s *caller*, after `create` returns, so a throw means no row is
written at all. What did need cleaning is engine-local: a record left behind is adopted by
`attach`'s early return, which would hand back a thread that can never run.

`startTurn` is deliberately untouched. A refusal there is the same class of bug, but a
mailbox delivery runs on Tower's sequential drain and a new per-message wait is a cost this
change did not measure. Filed as a follow-up in the review rather than smuggled in.

## Tests

`bugfix-260-spawn-refusal.test.ts`, 7 tests, real engine + real `ThreadSubscriptionPool`
(no in-memory engine — it would agree with itself here). The refusal is emitted from inside
the dispatcher when it sees `thread.turn.start`, which is where the server emits it: while
`create` is still in flight. Emitting it from the test afterwards would measure a refusal
that arrived too late to be raced, which is a different thing.

**Revert-check (a test that cannot fail is not a test).** With the `try/refusalWindow` block
removed: `3 failed | 4 passed`. The three that fail are the refusal assertions; the four
that pass are the guards against over-fixing (slow start, fast start, no-prompt architect
create, the bound's ceiling), which is the correct split.

- `npx vitest run src/agent-farm` — **217 passed | 1 skipped, 4269 tests passed**.
- `pnpm --filter @cluesmith/codev build` — clean.

The first `src/agent-farm` run showed 14 failures with `Roles directory not found in
.codev/roles/, codev/roles/, or embedded skeleton`. Not the change: `packages/codev/skeleton`
is a build artifact (`copy-skeleton`) and a fresh worktree has none. They pass after the build.
