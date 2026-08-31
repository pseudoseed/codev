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
