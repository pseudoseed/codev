# Issue #146: t3code Porch Execution-Model Proof

Date: 2026-08-28

Runtime: Node 22.22.2, `t3@0.0.35`, Codex provider, `gpt-5.6-luna`

Harness: `codev/experiments/146-t3code-porch-proof/proof.mjs`

## Decision

**GO for the execution-model assumption tested here.** A t3code thread supports Porch's
check-then-advance turns, survives a real idle-session reap and resumes with durable
conversation context, and provides lossless sequence replay after a WebSocket disconnect.

This is a proof spike, not production integration. It does not prove operational behavior
under repeated/crash recovery, database corruption, multi-day load, provider rate limiting, or more
than six concurrent threads.

## 1. Multi-turn with external work between turns — PROVEN

The harness created one t3 project/thread in an isolated temporary Git repository and waited
for each turn by observing a non-null `activeTurnId` followed by `activeTurnId: null`. It did
not use `status: interrupted` as a completion condition.

Evidence:

- Turn 1 settled at thread sequence 14 and returned
  `TURN1_READY_CTX_1787893516594`.
- Outside the t3 thread, the harness ran this shell command with the thread's own
  `worktreePath` as its `cwd`:

  ```sh
  printf '%s\n' "d0f81b84" > proof-external.txt
  ```

- The external shell independently read the new file back as `d0f81b84`.
- Turn 2 was asked to read the file, settled at thread sequence 27, and contained the
  externally written value in `EXTERNAL_SEEN_d0f81b84_CTX_1787893516594`.

This is the Porch seam: settle, perform orchestration work outside the provider thread, then
advance the same provider thread.

## 2. Gate pause and resume after one real idle-session reap — PROVEN

The same thread was left without any dispatched command for **2,160,041 ms
(36 minutes, 0.041 seconds)**, from `2026-08-28T05:05:29.621Z` to
`2026-08-28T05:41:29.662Z`.

The live server's configured reaper was not merely inferred; it actually ran:

```text
provider.session.reaped
threadId: 76debac9-6328-46e5-908f-16ed0274b5f8
provider: codex
idleDurationMs: 2094232
reason: inactivity_threshold
```

That is a reap after about 34 minutes 54 seconds of provider inactivity. The server's startup
log reported `inactivityThresholdMs: 1800000` and `sweepIntervalMs: 300000`, explaining why
reap time is threshold plus up to one sweep interval.

After the reap, turn 3 was started on the **same t3 thread ID**. t3 started a new Codex
app-server process and accepted and settled the turn normally. The initial turn-3 marker is
not treated as context evidence because its prompt supplied the expected values.

A corrected follow-up then restarted the t3 server against the same retained data directory
and sent another turn on that same thread. Its prompt did **not** contain the answer: it asked
for the exact filename requested before the gate, without tools. That filename occurred only
in the pre-reap conversation. The agent returned:

```text
PRE_REAP_FILENAME_proof-external.txt
```

It settled normally with `activeTurnId: null` at sequence 151. This corrected check proves
that the provider conversation before the actual reap remained available after reap and a
subsequent t3 server restart.

The local read-only t3 checkout at `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`
matches the live result:

- `ProviderSessionReaper.ts` skips active turns and background work, then calls
  `providerService.stopSession` for an inactive binding.
- `ProviderService` preserves the persisted binding and resume cursor when stopping.
- `CodexSessionRuntime` reopens with the persisted provider thread ID on the next turn.

The live artifact was published `t3@0.0.35`; the source observations above came from the
identified local checkout, not a source-map proof that the npm artifact is byte-identical.

Therefore an hours- or days-long Porch gate does not require the provider child process to
remain alive. The durable t3 thread and provider resume cursor are the continuity boundary.
The tested bound is one actual reap/36 minutes plus a server restart. Multi-day retention was
not literally elapsed and remains outside this proof.

## 3. Reconnect by sequence — PROVEN

A control subscription stayed connected while a second WebSocket was deliberately closed
mid-turn after observing sequence 45 with a non-null active turn. The agent continued an
eight-second command while that second socket was absent.

After the turn settled at sequence 54, a fresh WebSocket subscribed using
`afterSequence: 45` and `requestCompletionMarker: true`.

Evidence:

- Control connection sequences after the drop: `46,47,48,49,50,51,52,53,54`.
- Reconnected stream sequences: `46,47,48,49,50,51,52,53,54`.
- All nine replayed event IDs matched the control connection in the same order.
- The replay included the completion `thread.session-set` with `activeTurnId: null`.
- The completed assistant response was `RECONNECT_TURN_DONE`.

No completion event was lost. Porch can persist the last applied thread sequence and resume
the stream with `afterSequence`.

## Resource cost

These are process RSS totals, so shared pages may be double-counted. They are useful capacity
figures, not allocator-precise measurements.

| State | Total RSS | t3 data directory |
|---|---:|---:|
| One provider session after two turns | 574,128 KiB (560.7 MiB) | 5,664 KiB (5.5 MiB) |
| Same thread just after reap/resume turn | 367,840 KiB (359.2 MiB) | 8,172 KiB (8.0 MiB) |
| Six simultaneously active turns (barrier rerun) | 1,304,112 KiB (1.24 GiB) | 11,640 KiB (11.4 MiB) |

Before the reap, the one-thread process tree included roughly 340 MiB for the npm/t3 server
pair and 221 MiB for Codex app-server plus code-mode host. The reaper removed the idle Codex
process; a later turn created a new one. An idle reaped thread therefore retains database,
event, transcript, Git worktree, and provider resume-cursor disk state, but not a dedicated
provider process.

The measured t3 data directory includes its SQLite data, caches, seed repository, and Git
worktrees. The temporary repository contained only a tiny seed file. Real worktree disk cost
will depend on the checked-out repository and generated/untracked files, so the 8–12 MiB
measurements must not be generalized as the cost of a Codev worktree.

## Six threads on one server

**No functional failure was observed at six.** A barrier rerun created six distinct threads
and worktrees, made every turn run `sleep 10`, and asserted that all six current
`activeTurnId` values were non-null at the same instant. All six then settled to null and
contained their `SIX_OK_0` through `SIX_OK_5` markers. That barrier sample used 1.24 GiB RSS.

What becomes constraining:

- Provider memory is approximately per-live-thread and dominated the 1.24 GiB observation.
- Worktree disk usage scales with repository checkout and each thread's generated files.
- Only the Codex provider was exercised. Claude, Cursor, Grok, and OpenCode were not tested.
- Provider/API concurrency and rate limits were not stressed by these short turns.
- The single t3 server, SQLite database, event projector, and host are shared failure and
  contention domains. This spike proves six short concurrent turns, not saturation behavior.
- Reaping protects idle memory after 30–35 minutes. It deliberately does not reap an active
  turn or a thread reporting background liveness, so long-lived active/background work can
  keep all six provider processes resident.

## Reproduction

```sh
cd codev/experiments/146-t3code-porch-proof
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm install --ignore-scripts
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" node proof.mjs
```

The default pause is 36 minutes so it crosses both the 30-minute inactivity threshold and the
five-minute sweep cadence. The harness uses an isolated temporary Git repository and t3 data
directory; it does not modify `/Users/chris/dev/t3code` or any pre-existing t3 server. It
retains the temporary directory so raw database/server evidence remains available; remove it
manually after evidence is no longer needed.
