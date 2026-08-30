# The pinned t3code server harness

Spec 146. Phases 1 through 4 all test against "a live server on the pinned commit", and before
this existed nothing supplied one — and, more importantly, nothing checked which server a phase
had actually reached.

## Why `verify` is the point

A pin that nothing enforces is a comment. `verify` fails loudly when the checkout is not at
`pin.json`'s commit, or is at it but dirty. That is the architect's explicit instruction for this
phase: do not let a later phase quietly test against whatever server happens to be running.

Exit codes are three, not two:

| Code | Meaning |
|---|---|
| `0` | verified against the pin |
| `1` | mismatch — wrong commit, or a dirty checkout |
| `3` | could not determine — no checkout, unreadable git |

`3` exists because "I could not tell" must not exit the same way as "checked and fine". A CI job
that treats a missing checkout as a pass reports green for tests that never ran.

## Commands

```bash
node tools/t3-server/t3-server.mjs acquire   # fetch the pinned commit
node tools/t3-server/t3-server.mjs verify    # assert checkout == pin.json, and clean
node tools/t3-server/t3-server.mjs start     # verify, then serve on 127.0.0.1 (COLD: wipes the data dir)
node tools/t3-server/t3-server.mjs restart   # stop and start again, KEEPING the data dir
node tools/t3-server/t3-server.mjs status    # what is running, does it match
node tools/t3-server/t3-server.mjs stop
```

## `restart` exists because `stop` + `start` is not one

`start` deletes the data dir before spawning, and that is correct for the cold-start evidence
below: a start-twice proof is only a proof if each run begins with an empty database. It means
`stop` then `start` is a **new server**, not the same one restarted.

Spec 146 phase 9's item 4 — "an architect thread survives a server restart and resumes with
context" — cannot be evaluated that way at all. The harness would delete the thread, and the
result would read as the criterion failing.

`restart` keeps the data dir, and refuses with exit `3` (`NO_DATA_TO_KEEP`) when there is none
to keep, rather than silently performing a cold start under a restart's name.

Each server lifetime prints **one** pairing token, and a pairing grant is one-time, so a client
that reconnects after a restart needs the new token `ready` reports.

Environment: `T3CODE_ROOT` (default `/Users/chris/dev/t3code`), `T3_HARNESS_PORT` (default 3799),
`T3_HARNESS_DIR` (default `tools/t3-server/.runtime`), and required `T3_NODE` (the Node binary used
for the server).

Binds loopback only. Spec 146's Security constraints make loopback the default and exposing an
interface an explicit act; a test harness never exposes one.

## Cold-start evidence

`smoke.mjs` brings the server up from cold twice and records what happened. Phase 1's criterion
is that it comes up twice from cold, and a test refuses the evidence once `t3-server.mjs` or
`smoke.mjs` is newer than it.

```bash
export T3_NODE=/absolute/path/to/node
"$T3_NODE" tools/t3-server/smoke.mjs --runs 2 \
  > codev/research/146-harness-coldstart-evidence.json
```

**The redirection is part of the command.** `smoke.mjs` prints to stdout and writes nothing, so
running it without one re-does the entire cold start and leaves the evidence exactly as stale as
it was — a slow no-op that looks like work.

## The server interpreter is explicit

`start` never inherits the test process's Node from `PATH`. `T3_NODE` is resolved once and that
absolute interpreter launches the pinned CLI. The checkout's `engines.node` range is recorded and
an out-of-range interpreter produces an advisory, not a skip: Node 26 has been measured serving
this checkout even though the declared range is `^24.13.1`. Server readiness is the gate.

`start` also confirms the child is still alive after `spawn` and surfaces its log's error lines.
`spawn` succeeding means a process was created, not that it stayed.

## The CLI is pinned too

`pin.json` records both the checkout commit and the exact published CLI version used to serve it.
`start` invokes `t3@<that version>` rather than re-resolving `t3@latest` on every run.

## Live test opt-in

`T3_NODE` configures the harness; it does **not** opt the default unit suite into a real provider
turn. The Phase 9 live tests additionally require `T3_LIVE=1`:

```bash
pnpm --filter @cluesmith/codev-types build
pnpm --filter @cluesmith/t3-client build
T3_NODE=/absolute/path/to/node T3_LIVE=1 pnpm --filter @cluesmith/codev exec vitest run \
  src/agent-farm/__tests__/spec-146-phase-9-live-harness.test.ts
```

The build steps are required because the live block imports the packages' `dist` artifacts. A
plain `pnpm test` never dispatches this paid provider turn, even when `T3_NODE` is configured.

The second live test — issue #219, `#179` items 3 and 4 — starts, **restarts** and stops a server,
so point it at a port nobody else is using:

```bash
T3_NODE=/absolute/path/to/node T3_HARNESS_PORT=3801 T3_LIVE=1 \
  pnpm --filter @cluesmith/codev exec vitest run \
  src/agent-farm/__tests__/spec-146-phase-9-live-architect-thread.test.ts
```

## CI

CI does not have this checkout. The rule is:

- If `T3CODE_ROOT` resolves and `verify` exits `0`, run the live-server tests.
- Otherwise **skip them and say so in the run output** — never silently pass. The test in
  `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` follows this: it warns explicitly
  that a missing checkout is "could not check", not "checked and fine".

Provisioning t3code in CI is deliberately not attempted in Phase 1. Doing it badly — a shallow
clone at whatever HEAD happens to be — would produce a green pipeline testing the wrong contract,
which is worse than an honest skip.
