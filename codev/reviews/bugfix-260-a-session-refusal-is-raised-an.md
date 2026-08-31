# Bugfix #260: A session refusal is raised and logged but nothing acts on it

## Summary

`afx spawn` onto a harness the t3code server refuses now **fails**, with the server's own
sentence, in about the time the refusal takes to arrive. Before this it succeeded: the
thread was created, the builder row was written, and the only trace of the refusal was a
line in Tower's log. The operator's experience was a builder that spawned fine and then did
nothing, forever.

This closes the chain #238 started. `SessionStartFailedError` was **raised** (#241 supplied
the subscription that feeds `TurnTracker.observe`), **visible** (#258 replaced `track()`'s
`() => {}` rejection handler with a log line), and **not acted on**. It is now acted on.

## Root Cause

`packages/codev/src/agent-farm/porch-thread-engine.ts`, in `create`:

```ts
if (input.prompt) track(record, await thread.beginTurn(input.prompt));
return thread.threadId;
```

`track()` *follows* `started.running` and `started.settled` rather than awaiting them —
deliberately, since its caller asked to start a turn, not to wait for one. Its rejection
handler logs and returns. No code path converted that rejection into a failure of `create`,
so the spawn continued:

`create` → `allocateSpawnThread` → `launchSpawnedBuilder` (`commands/spawn.ts:215-249`) →
the caller runs `persistSpawnedBuilder` → a builder row exists for an agent the server had
already refused to run.

The motivating case is real and specific: t3code ships `OpenCodeSettings.enabled` defaulting
false, so a thread on the opencode driver is refused at `startSession` with
`ProviderValidationError: Provider instance 'opencode' is disabled in T3 Code settings.` The
server emits it as `status: "error"` roughly 12ms after the dispatch — a sentence naming the
exact misconfiguration and how to fix it, delivered promptly, and thrown away.

## Fix

One file, +103 lines.

**A bounded race, not an await.** `create` now passes `started.running` through
`refusalWindow(running, boundMs)`, which resolves when the turn starts **or** when the timer
expires, and rejects **only** on a rejection. Awaiting `running` outright was rejected as a
shape: it does not resolve until the server actually starts the turn, which is
provider-latency-bound, so it would have traded an invisible failure for a slow success and
reintroduced exactly the wait `track` exists to avoid.

**Why 2 seconds is enough.** The window does not measure how long a turn takes to start. It
measures how long a *refusal* takes to arrive, and a refusal is prompt by construction — the
server has decided before it started anything. Expiring is not a verdict: it means nothing
has been said yet, and the spawn falls through to the follow-and-return behaviour it had
before.

**What a refusal does to the builder row.** Nothing needs undoing. `persistSpawnedBuilder`
runs in `launchSpawnedBuilder`'s *caller*, after `create` returns, so a throw means no row is
ever written. What did need cleaning is engine-local: `create` drops its own `threads` and
`records` entries and calls `subscriptions.stop()`, because a record left behind is adopted
by `attach`'s early return — which would hand a caller a thread that can never run, with a
stream still open for it.

The original error is rethrown unchanged, so it keeps its name, the server's sentence, and
its "This is a refusal, not a timeout" line.

## Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/porch-thread-engine.ts` | `SESSION_REFUSAL_GRACE_MS`, `refusalWindow()`, the race and cleanup in `create`, `refusalGraceMs` option; corrected `track()`'s now-stale note about the remaining gap |
| `packages/codev/src/agent-farm/__tests__/bugfix-260-spawn-refusal.test.ts` | 7 regression tests |

## Tests

Driven against the **real** `createPorchThreadEngine` and the **real**
`ThreadSubscriptionPool`, the shape `spec-241-thread-subscriptions.test.ts` established and
for its reason: an in-memory engine records what it is handed and would agree with itself
here. What is under test is the seam between the tracker's rejection and `create`'s return,
and only the production engine has one.

The refusal is emitted from inside the dispatcher when it sees `thread.turn.start` — where
the server emits it, while `create` is still in flight. A test that emitted it afterwards
would be measuring a refusal that arrived too late to be raced, which is a different thing.

| Test | Pins |
|---|---|
| `create rejects with the server sentence…` | The headline: `create` fails instead of returning an id |
| `the rejection carries the server reason…` | `SessionStartFailedError`, the server's sentence, "not a timeout" |
| `the refused thread is not left in the engine or subscribed to` | `get`, `worktreePath`, `pool.threadIds` are all clean |
| `a start slower than the window is not a refusal` | The fall-through — no refusal emitted, spawn still returns |
| `a turn that starts inside the window returns without waiting the window out` | The window is a ceiling, not a delay |
| `a create with no prompt starts no turn and pays no window` | `createArchitectThread`'s shape is unaffected |
| `the production bound is short enough…` | The 2s ceiling |

**Revert-check.** With the `try`/`refusalWindow` block removed: **3 failed, 4 passed.** The
three that fail are the refusal assertions; the four that pass are the guards against
over-fixing. That split is the point — a test that cannot fail is not a test, and a test
that fails for the wrong reason is worse.

## Test Results

- `npx vitest run src/agent-farm` — **217 files passed, 1 skipped; 4269 tests passed, 40 skipped**
- `pnpm --filter @cluesmith/codev build` — clean

An initial `src/agent-farm` run showed 14 failures reading `Roles directory not found in
.codev/roles/, codev/roles/, or embedded skeleton`. Not the change: `packages/codev/skeleton`
is a build artifact (`copy-skeleton`) and a fresh worktree has none. They pass after a build.

## What This Does NOT Do

Stated here rather than left to be discovered, which is the whole reason this issue exists.

**`startTurn` still only logs a refusal.** It is the same class of bug — a mailbox delivery
onto a refused session reports `delivered` and delivers nothing. It is not fixed here because
`startTurn` runs on Tower's sequential mailbox drain, where a new per-message wait is a cost
this change did not measure, and BUGFIX is the wrong protocol to measure it under. `track()`'s
comment now says this out loud instead of claiming no caller acts on a refusal.

**The refused thread is left on the server.** Deleting it is not this fix's business, and its
events are the evidence for the sentence the operator is about to read.

**The worktree is left behind.** A failed spawn leaves its worktree today for every other
failure reason too; this changes nothing there.

## Lessons

1. **A section is not a mechanism.** #258's review named this gap accurately in its *What This
   Does NOT Do* section, and a section gets read once. The gap closed when it became an issue
   with a number.
2. **"Certain" and "unknown" deserve different code paths, not just different messages.** A
   refusal is the one failure that is definite. Racing it against a short bound — rejecting on
   rejection, resolving on expiry — is what lets the definite case fail fast without forcing
   the uncertain case to wait.
