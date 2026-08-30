# Spec 146 — driver parity for the full protocol

Phase 10's third deliverable: run the whole BUGFIX protocol on a **second, non-Codex driver**,
and record any behavioural difference here **rather than working around it silently**.

Only Codex was exercised in the spike, so "it works" was a claim about one driver. This is the
record of what changed when two more were asked to do the same thing.

## Which drivers ran, and why not Codex

| Codev harness | t3code `driverKind` | Model | Ran the full protocol |
|---|---|---|---|
| `claude` | `claudeAgent` | `claude-haiku-4-5` | yes |
| `opencode` | `opencode` | `xai/grok-4.6` | yes |
| `codex` | `codex` | `gpt-5.6-luna` | **no — account quota exhausted** |

**Codex was quota-exhausted for the whole of this phase**, with a reset roughly sixteen hours
out. Phase 9 hit the same wall and answered it the same way: the criteria here are claims about
*threads* — that one spawns on a worktree, survives a porch restart, and resumes after an
idle gate — and nothing in any of them is specific to a provider.

That makes the substitution stronger than the deliverable asked for, not weaker. The deliverable
wants a second driver that is *not* Codex; both of these are, so the pair contains two
independent non-Codex observations rather than one. What is genuinely lost is a *third* data
point on the driver already known to work, which is the least informative of the three.

Every run records the driver that produced it, and every "could not tell" message names it, so
no outcome here can be read without knowing which driver produced it.

## The runs

Server: pinned checkout `082e6ea52186`, pinned CLI `t3@0.0.36`, Node 26.4.0, loopback only, one
server and one data directory per run. Reproduce with:

```
T3_NODE=/absolute/path/to/node tools/t3-server/full-protocol-run.sh 3803 claude   claude-haiku-4-5 3600 claude-1h
T3_NODE=/absolute/path/to/node tools/t3-server/full-protocol-run.sh 3804 opencode xai/grok-4.6    3600 opencode-1h
```

Raw evidence: `codev/research/146-phase10-live-evidence.json`, regenerated from the run outputs
by `tools/t3-server/collect-phase10-evidence.mjs`, which also fills the table below. It exits 3
— not 1 — when a named run is missing: "the run has not finished" and "the run failed" are
different facts, and the collector never gets to make the second claim on the strength of the
first.

<!-- results:begin -->

| Run | Driver kind | Gate | Criteria | Wall clock |
|---|---|---|---|---|
| `claude` / `claude-haiku-4-5` | `claudeAgent` | 3600s | 10/10 met | 3961s end to end |
| `opencode` / `xai/grok-4.6` | `opencode` | 3600s | 10/10 met | 4004s end to end |

Every criterion above is `met`. The runner records `met`, `not-met` and `undetermined`
separately and the test accepts only `met`, so a criterion that could not be evaluated cannot
hide inside this table.

<!-- results:end -->

## Differences found

### 1. t3code ships opencode OFF, and the refusal was spelled as a timeout

This is the finding of the phase, and it is two findings stacked.

**The driver difference.** `OpenCodeSettings.enabled` defaults to `false` at the pinned commit,
by design and with the reason written down (`packages/contracts/src/settings.ts:501-507`):

> Off by default (like Cursor and Grok): the binding is not yet stable enough to probe on every
> install. Users opt in from Settings.

`ClaudeSettings` does not default off. So a harness that gives every run its own `--base-dir` —
which this one does, because the runs are concurrent — hands every run a state directory nobody
has opted in for, and every opencode turn is refused at `startSession`:

```
ProviderValidationError: Provider validation failed in ProviderService.startSession:
Provider instance 'opencode' is disabled in T3 Code settings.
```

`full-protocol-run.sh` now writes `{"providers":{"<driverKind>":{"enabled":true}}}` into the
state directory **it owns**, after `start` (which wipes that directory) and before a `restart`
that loads it. The user's own T3 Code settings are never touched. With the opt-in, the same
opencode run that had produced nothing in ten minutes wrote its investigate file in 36 seconds.

**The defect that made it expensive.** The server emitted that refusal **twelve milliseconds**
after the dispatch, as `status: "error"` with the sentence in `lastError`. `TurnTracker` read
`activeTurnId` and nothing else — and the refusal event carries `activeTurnId: null`, which
falls through the `seenRunning` latch and does nothing at all. So the caller waited out its
entire budget and reported:

```
Timed out after 599950ms waiting for the turn to start on thread 5f789e7f-...
This is "I stopped waiting", not "the turn finished" — the turn may still be running.
```

Every word of that is true and the whole of it is wrong. The turn was not still running. The
server had answered, by name, before the sentence was composed.

**This is the project's own rule running backwards.** The standing rule is that "I could not
tell" must never be spelled like "no". Here "no" was spelled like "I could not tell", and that
is the more expensive direction, because it looks like patience: the timeout message is careful,
hedged, and correct about its own uncertainty, so nobody suspects it of hiding a definite answer.
It cost roughly ninety minutes of this phase and produced four falsified hypotheses — worktree
shape, cold-versus-warm data directory, a settling delay before the first dispatch, and machine
memory pressure — every one of which was investigated because the real answer was on the wire
and unread.

Fixed in `packages/porch-driver/src/turn.ts`: `sessionFailureOf` reads `status` and `lastError`,
and a session that fails **before the turn is running** abandons the waiter with
`SessionStartFailedError` carrying the server's own sentence. Three-valued, because there are
three facts — `undefined` is "this event says nothing about failure", `null` is "it failed and
the server gave no reason" (WHY unknown, THAT it failed known), and a string is the reason.
Scoped to before `seenRunning`, because a session error *after* the turn starts is the turn
ending and the caller wants its result. Mutation-verified: neutering `sessionFailureOf` restores
the hang and fails two of the four tests.

### 2. Speed, and what it exposes rather than what it costs

opencode/grok-4.6 completes a trivial turn in **11-14 seconds**. claude-haiku-4-5 takes
noticeably longer for the same work. That is not itself a parity problem — but it is why the
first probe written for this phase passed under claude and timed out under opencode.

The probe fired the thread subscription and dispatched the first turn without waiting for the
subscription to attach. Under claude the stream was live before the turn reached `running`;
under opencode the turn had already transitioned, so the waiter was waiting for something that
had already happened.

**The bug was in the harness, not in either driver.** It is recorded because the general form
matters: *a fast driver is where ordering bugs surface, and a slow one is where they hide.*
Phase 3 learned the same lesson one level down — `turn.ts` registers its waiter before dispatch
for exactly this reason — and this is that hazard reappearing at the subscription rather than at
the waiter. The runner now blocks on the subscription's `onResume` before any dispatch.

### 3. Session-set events before the turn starts

Under opencode the server emits several `thread.session-set` events carrying
`activeTurnId: null` while `status` is `starting`, before the one that carries a turn id:

```
41 thread.session-set activeTurnId=null      (status "starting")
42 thread.session-set activeTurnId=null
43 thread.session-set activeTurnId=null
44 thread.session-set activeTurnId=null
45 thread.session-set activeTurnId="opencode-turn-8599d532-..."   (status "running")
```

A settle detector keying on "activeTurnId is null" reports settled four times before the turn
begins. `TurnTracker` is already correct here — it latches `seenRunning` first — and this is
that latch earning its place against a real driver rather than against the created-thread case
its comment cites.

**No code change.** The existing guard covers it; recording it is the point.

### 4. Recovery from a restart is identical, and it is a real restart

`air-235-resubscribe.mjs` is a second process that shares nothing with the runner — no
`DriverThread`, no `TurnTracker`, no waiter promises, no journal instance. It is handed a URL, a
token, a thread id and the **path to a cursor file**, and works out where to resume by reading
it. Both drivers behave the same: the completion event emitted while nothing was subscribed comes
back in the catch-up replay rather than live after the synchronization marker, which is the
distinction the criterion turns on.

The first version of this step rebuilt the subscription inside the same process, and review was
right that it demonstrated stream reconnection rather than recovery. Recorded here because the
correction changed what the evidence means, not just how it was gathered.

### 5. Worktree setup files differ by driver, and both were laid down correctly

`planWorktreeSetup` writes per-driver files into the worktree. Under `opencode` that is
`opencode.json`. Under `claudeAgent` it is the write-guard's `.claude/settings.local.json` when
guard content is supplied — this harness supplies none, so the plan records `guard: 'absent'`
with a reason rather than skipping silently. Each driver received its own file and neither
received the other's.

## Differences NOT found

Worth stating, because each was suspected and tested rather than assumed:

- **Worktree shape.** A three-case repro — plain directory, ordinary git repository, linked git
  worktree (`.git` is a file) — behaves identically. The hypothesis that opencode could not start
  inside a linked worktree is **falsified**: all three failed together while the provider was
  disabled, and all three pass with it enabled.
- **Cold versus warm server state.** A cold `start` wipes the state directory, and the earlier
  successes looked like they needed a warm one. They did not: what they needed was the opt-in,
  which happened to survive in one directory and not the others. Neither driver needs provider
  state accumulated by an earlier run.
- **A settling delay before the first dispatch.** Dispatching immediately after `thread.create`
  versus five seconds later makes no difference on either driver.
- **The opencode CLI, the account, and the model inventory.** `opencode run -m xai/grok-4.6`
  answered in 7 seconds and `opencode models` in 0.9 seconds throughout the period when every
  t3code opencode turn was being refused. The constraint was never the provider.
- **The protocol itself.** Spawn, the three phases, the checks between turns, the
  `afterSequence` replay after porch is restarted as a fresh process, the idle gate, and the merge behave the
  same on both. No step needed a per-driver branch, so `packages/porch-driver/src/drivers/`
  — which the plan listed for "per-driver quirks, if any are found" — **was not created**. There
  were none to put in it.

## What this does not tell you

- Nothing about **Codex** beyond the spike. The full protocol has still never run end to end on
  it, and this phase could not change that.
- Nothing about `cursor` or `grok`, the two t3code driver kinds with no Codev harness.
- The pr phase pushes to a **local bare origin** and merges with `git merge --no-ff`. It is not
  `gh pr create` and not `gh pr merge`, so the GitHub half of the pr phase is untested here on
  any driver. `gh` is a process porch spawns identically in both the thread and PTY worlds,
  which is a reason to expect it unaffected — not evidence that it was checked.
