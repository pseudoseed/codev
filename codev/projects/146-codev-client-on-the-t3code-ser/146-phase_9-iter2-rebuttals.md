# Phase 9, iteration 2 — rebuttals

**Nothing is disputed this round.** codex returned REQUEST_CHANGES with two findings; claude
returned APPROVE with two non-blocking ones. **Every one of them was right, and all three
actionable ones are fixed** in `f798e705a`. This file records what was verified, what changed,
and the one place a reviewer's claim was true but incomplete in a way that changes the fix.

Both codex findings were verified against the tree and against the pinned t3code checkout
**before** being acted on, rather than taken on the review's word.

## codex 1 — the global `WebSocket` does not exist on the Node we support. **Accepted.**

**Verified, not relayed.** `packages/codev/package.json` declares `engines.node: ">=20.0.0"`.
`node v20.19.2` reports `typeof WebSocket === 'undefined'` — I ran it. That version is also what
this workspace itself runs on. So `connectDispatcher` threw `ReferenceError` on the project's
own declared minimum runtime.

The sequencing is the damaging part and the review named it correctly: the throw happens
**after** `exchangeBootstrapToken` has already succeeded. A configured spawn therefore consumed
its bootstrap credential and *then* failed, which for a one-time credential means the failure is
not even retryable.

**This is the function this phase's own verification doc had recorded as deliberately uncovered**
— "it opens a real WebSocket to a real server, and mocking the module under test into a shape
that passes proves nothing about the real one". That reasoning was sound and the conclusion was
still wrong: the uncovered function was broken. A gap that is honestly declared is still a gap.

Fixed: `webSocketCtor()` returns the platform global where it exists and falls back to `ws`,
which was already a runtime dependency of this package (`ws: ^8.18.0`), so the fix adds nothing
to the dependency tree.

**It is a compatibility shim, not a switch to `ws`.** A newer Node keeps its own implementation,
and a test asserts that, so the shim cannot quietly become a replacement.

Three tests, and the pin is on the **condition**, not on the runner:

- `engines.node` is asserted to allow 20, and `thread-backend.ts` is asserted to contain no bare
  `new WebSocket(`. This cannot drift when the runner's Node changes.
- The no-global case is **forced** by deleting `globalThis.WebSocket`, rather than waiting for a
  runtime that happens to lack it, and the resolved constructor is checked for the surface this
  code actually uses (`addEventListener`, `send`, `close`).
- The platform global is asserted to win when present.

## codex 2 — the bootstrap token is re-exchanged every process. **Accepted, with a correction that changes the fix.**

**Verified in `PairingGrantStore.ts` at the pin.** `consume` decrements `remainingUses` and
**deletes the grant** when it is `<= 1`, after which the next exchange returns
`UnknownBootstrapCredentialError`. Every `afx` invocation is a fresh process with no session to
reuse, so the token is exchanged again on every spawn. The review is right that this breaks.

**Where the review is incomplete: it is not true of all credentials, and which kind you have
decides whether anything is broken at all.**

- `issueOneTimeToken` — the pairing path — is one-time. Configure one of these and thread-backed
  spawning works exactly once.
- A config-seeded `desktopBootstrapToken` is issued with `remainingUses: "unbounded"`,
  **deliberately**, with a comment in t3code explaining that the renderer must be able to
  re-exchange the seed after a reload.

So the correct statement is not "the bootstrap flow is broken" but "**thread-backed spawning
requires a credential that survives repeated exchange, and t3code issues both kinds**". Had the
finding been taken at face value, the fix would have been a token cache — solving a problem that
does not exist for the credential this field is meant to hold.

Two changes:

1. **The constraint is stated where the token is read**, on `ThreadBackendConfig.bootstrapToken`,
   naming both credential kinds and which one this field requires. A documented constraint, not
   a silent one.
2. **A refusal is no longer spelled the same way as an unreachable server.** The old handler
   wrapped every connect failure as "the t3code server could not be reached" — so a server that
   answered, parsed the request, and *refused the credential* sent the reader to check the
   network. It now separates the two, and the refusal names the likely cause.

Two tests against a real local HTTP server that returns `400 UnknownBootstrapCredentialError` —
which is exactly what a second spawn sees — **with a control** asserting that an unreachable
server still reads as unreachable. Without that control the first assertion would pass just as
well if every failure were relabelled a refusal, which is the same defect pointing the other way.

**What was deliberately not done:** caching an access token across processes. That would remove
the constraint entirely, and it means writing a credential to disk — a storage decision outside
this phase's scope. It is recorded in the code rather than left as an implicit omission.

## claude 1 — `spawnWorktree` drops the role on the thread path. **Accepted.**

Confirmed by reading `spawn.ts`: the function loads a role and bakes it into the PTY launch
script, and its `launchSpawnedBuilder` call was the only one of the five passing neither
`roleContent` nor `roleFilePath`. A thread-backed worktree spawn came up with no role while the
PTY spawn had one. `DriverThread` holds a pending role and joins it onto whichever turn starts
first, so forwarding it works even though this call site has no initial prompt.

**The more useful half of this finding is the guard, and the reviewer named it: the guard could
not have caught this.** It required `prompt` **or** `launchScript`, and this site has
`launchScript` — so a test written to prevent exactly this class of defect had no way to fail
for the one call site that differed from the others. That is the house defect appearing inside
the guard built to stop it.

The guard now also requires `roleContent:` at every call site, which has no exception: a
worktree spawn legitimately has no prompt, but every spawn form has a role. Mutation-checked —
removing the two lines from `spawnWorktree` fails it.

## claude 2 — `ThreadRecord.merged` is never updated. **Accepted as recorded, unchanged.**

Still true, still not fixed, and the reviewer agreed with the reasoning: the
`vcs.removeWorktree` refusal response shape has not been observed here, and a branch written
against a shape I have not seen would be a guess presented as a fix. Nothing reads the field
today — `cleanup.ts` uses `isWorktreeMerged` — and `afx cleanup` parity sits outside items 1
and 2. It stays recorded in the verification doc.

## Verification

All three fixes were **mutation-checked individually**: restoring `new WebSocket(` fails the
Node-20 test, removing the refusal branch fails the refusal test, and removing the two role
lines from `spawnWorktree` fails the call-site guard. Tests in
`spec-146-phase-9-thread-backend.test.ts` went 17 → 22.

Full suite green: 6669 passed | 50 skipped across 342 files, plus 180 in `apps/v2`.

Out of scope and untouched on the architect's instruction: `tunnel-client.ts:500` has the same
global-`WebSocket` bug and is pre-existing on `main`, filed separately.
