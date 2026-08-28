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
node tools/t3-server/t3-server.mjs start     # verify, then serve on 127.0.0.1
node tools/t3-server/t3-server.mjs status    # what is running, does it match
node tools/t3-server/t3-server.mjs stop
```

Environment: `T3CODE_ROOT` (default `/Users/chris/dev/t3code`), `T3_HARNESS_PORT` (default 3799),
`T3_HARNESS_DIR` (default `tools/t3-server/.runtime`).

Binds loopback only. Spec 146's Security constraints make loopback the default and exposing an
interface an explicit act; a test harness never exposes one.

## What this harness does NOT pin

**The server binary.** `start` runs the published `t3` CLI against the pinned checkout. The
checkout is pinned; the CLI is not. If the two diverge, `verify` cannot see it — it only knows
about the source tree.

This is stated here rather than left to be discovered because it is the harness's real limitation.
Closing it means either building the server from the pinned tree, or pinning the CLI version in
`pin.json` too. Neither is done in Phase 1, and no later phase should assume otherwise.

## CI

CI does not have this checkout. The rule is:

- If `T3CODE_ROOT` resolves and `verify` exits `0`, run the live-server tests.
- Otherwise **skip them and say so in the run output** — never silently pass. The test in
  `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` follows this: it warns explicitly
  that a missing checkout is "could not check", not "checked and fine".

Provisioning t3code in CI is deliberately not attempted in Phase 1. Doing it badly — a shallow
clone at whatever HEAD happens to be — would produce a green pipeline testing the wrong contract,
which is worse than an honest skip.
