# Spec 146, Phase 6, iteration 3 — rebuttal

**Nothing is disputed. No lane blocked.** claude returned **APPROVE**, opencode returned
**COMMENT**. Every non-blocking item from both is fixed anyway, because each one is the same
defect class this phase exists to catch. Build exit 0; tests 6501 passed, 48 skipped, plus 180
in codev-v2, plus 18 in `apps/vscode`.

## Lane accounting

| Lane | Verdict | Ran? |
|---|---|---|
| claude | APPROVE | Yes |
| **codex** | **none** | **No — attempted, usage limit again, exit 0 with no file** |
| opencode (`xai/grok-4.6`) | COMMENT | Yes, as the substitute |

Codex was attempted this iteration rather than skipped. `.p6i3-codex.log`: "You've hit your
usage limit… try again at 5:40 AM." **Sixth silent failure**: exit 0, no output file, which to
porch is indistinguishable from an approving lane (**#168**). Caught by the same file-and-
`VERDICT` check. So phase 6's three iterations were reviewed by two lanes each, and codex
reviewed none of them.

## opencode — COMMENT, fixed

**The VS Code Approve button still routed into the refused call.**
`apps/vscode/src/commands/approve.ts` relayed "please pass it to the builder", and the PIR
prompts I rewrote in iteration 2 name Cmd+K G as a working path. So I had documented a button
whose own message sent the architect back to the builder, where `porch approve` exits 1.

`apps/vscode` is retained unsupported source and phase 13 owns it, which is exactly why this
is a **message and comment change, not a behaviour change**: the relay now names
`porch approve` and the workspace root, and says the builder cannot run it.

One existing test asserted `msg).not.toContain('porch')` — "does NOT name porch or spell out
a command (the builder runs it once relayed)". **Its premise is gone**, so the assertion
changed rather than being worked around: the builder no longer runs it, and saying nothing
about the command left the architect with no route. What survives is the part still true — no
full argument list, which the architect already knows — plus a new assertion that the message
does not contain "pass it to the builder".

## claude — APPROVE, three non-blocking, all fixed

**1. An unreadable store answered "never issued".** `readJsonFile` returned the empty fallback
on a parse failure, so a corrupt `capabilities.json` reported `APPROVAL_CAPABILITY_UNKNOWN`.
That is "I could not tell" spelled as "no", and it is the distinction the codev-agent failure
matrix already draws between `GLOBAL_DB_LOCKED` and `GLOBAL_DB_UNREADABLE`. Both stores now
throw `ApprovalStoreUnreadable` and report `APPROVAL_STORE_UNREADABLE`. A store that has
never been written is still absence and still answers `UNKNOWN` — tested both ways, because
collapsing *those* two would be the same defect in the other direction.

**2. `POST /approval-nonces` minted against any `capabilityId` string.** Harmless — the
secret still has to verify at `porch approve`, and the nonce is capability-bound at
`#inspect` — but an identifier accepted unchecked at one layer is precisely the shape
iteration 1 already found once in this file. The route now requires the capability to exist,
be unrevoked, be unexpired, and belong to **the calling session**. `describe()` returns the
record with the verifier withheld rather than returned-and-ignored.

**3. `withLock` busy-waited for up to 2s.** Now yields between retries with a 10ms
`Atomics.wait`; the path is synchronous by design because the lock spans a read-modify-write
callers do not await.

## Standing disclosure

Phase 5 force-advanced at its iteration-3 ceiling. **Phase 6 did not**: it reached iteration 3
with an APPROVE and a COMMENT, and the fixes above were made on top of a passing review rather
than under a ceiling. The commits carrying no lane review are only those made after this
review — the iteration-3 fix set — and that is stated here rather than left to be discovered.
