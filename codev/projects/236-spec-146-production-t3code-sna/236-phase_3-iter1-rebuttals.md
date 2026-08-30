# Phase 3 iteration 1 — rebuttals

**opencode: APPROVE** (HIGH, no issues). **claude: COMMENT** (MEDIUM, five non-blocking notes).
No blockers from either lane.

Accepted: 5. Deferred with the reviewer's own agreement: 1. Disputed: none.

Both lanes independently confirmed the phase's criteria — 12, 12b, 13, 14, 15 and 18 — including
the two that decide whether it is real rather than plausible: `revoke` works holding nothing and
with Tower down, and a `client-session` token is driven all the way to a live
`HumanPairedSessionRegistry` session. opencode additionally checked something I had not stated:
`agent-auth.ts` calls `MachineCredentialStore.verify()` on every request, so a tombstone takes
effect on the next request with no restart and no invalidation message.

---

## 1. `pairRevoke` could report a failure for a revocation that had succeeded

**claude.** Non-blocking in their judgement; I am treating it as the most important thing in the
review, because it is the exact defect this command was written to fix, reproduced inside it.

**Verified.** `pairRevoke` writes the machine-credential tombstone first and then reads the
approval capability store. An unreadable approval store threw straight out of the function with
**nothing printed**. So:

- the operator is told the command failed,
- the credential is in fact revoked, and
- a re-run answers `nothing live to revoke`, which reads as *"that machine was never paired
  here"*.

One outcome reported while another occurred, and the follow-up reading as a third thing. In a
command whose entire justification is that withdrawing access should be reliable.

**Changed.** What did happen is printed **before** the failure is raised: the credential half is
named as done, the approval half as `NOT WITHDRAWN`, with the instruction that re-running is safe
and will report the credential as already withdrawn. Then `PAIR_REVOKE_PARTIAL` is raised naming
which half failed. A test drives it and asserts both the output and that the credential really is
revoked — because saying otherwise is precisely what would be false.

## 2. The corruption test table had one row and an unused column

**claude.** Verified, and it is worse than a missing case: it was an `it.each` whose second
element `() => pairList` was never referenced and whose body called `pairList` literally. A table
shaped like coverage that covered one thing — the appearance of a matrix over four
subcommand/store pairs, with one of them exercised.

**Changed.** The table is gone. Four explicit cases now: a corrupt pairing store from `list` and
from `issue`, a corrupt machine store from `list` and from `revoke`, plus the partial-failure case
above. The shared helper asserts the code *and* the "not 'nothing is there'" wording, so the
distinction that matters cannot be asserted in one place and forgotten in another.

## 3. Tests hand-composed the store subdirectories instead of exercising the default root

**claude.** Verified: every test passed `root` and the helper composed `pairing` / `machines` /
`approval` under it, so a change to a default subdirectory name would have left the whole file
green while production wrote somewhere else. That is the "passes its tests, production never
reaches it" shape, one level down from where I had been watching for it.

**Changed.** A test sets `CODEV_AGENT_FARM_DIR`, calls `pairIssue` with **no injected root**, and
reads the token back through a store pointed at the subdirectory the command chose — so the two
have to agree about where the pairing store lives. The env var is restored in a `finally`.

## 4. `stores()` concatenated paths with `/`

**claude, minor.** Changed to `path.join`. It happened to work, which is the reason to fix it now
rather than when it stops.

## 5. `--ttl-minutes abc` surfaced `PAIRING_TTL_INVALID`

**claude, minor.** Verified: `parseInt('abc')` is `NaN`, which reached the store and produced a
code about the store for a typo in an argument. Refused in the command now, naming
`--ttl-minutes`, with the default and the maximum.

## 6. The leak check matched a shape rather than the rest of the stream

**opencode, non-blocking.** Fair: the file walk was thorough but the stdout side asserted the
token matched a full-line regex, which says the token is on its own line and not that it is
absent from every other line.

**Changed.** The secret is now asserted absent from every printed line except the token line
itself, so a future line that echoed it back — a summary, a confirmation, a "you just issued
X" — fails here.

## 7. The `PAIR_*` codes are not in the failure-matrix collector

**claude, raised and then self-deferred:** *"spec criterion 19 is assigned to phases 4 and 7, so
track it there rather than fixing it here."*

**Deferred, and recorded so it is not lost.** `PAIR_STORE_UNREADABLE`, `PAIR_PURPOSE_REQUIRED`,
`PAIR_PURPOSE_UNKNOWN`, `PAIR_AUTHORITY_EMPTY`, `PAIR_MACHINE_REQUIRED` and the new
`PAIR_REVOKE_PARTIAL` all need classifying. Phase 4 registers its own signals in the collector and
phase 7 writes the matrix document; these go in with them. Noting here that phase 7's scope grew
by one item as a result.

## What I did not change

Nothing was disputed.

One observation from opencode that I am leaving as it is, with the reasoning: a missing
`--purpose` at the CLI produces Commander's generic required-option error rather than the
sentence `pairIssue` writes. That is Commander doing its job before the module is reached, the
message does name the missing option, and replacing it would mean dropping `requiredOption` and
re-implementing the check — trading a clear generic message for a duplicated one. The module's own
refusal still fires for every caller that is not the CLI, and it is what the tests drive.

## Verification

`packages/codev`: **7008 passing**, 0 failing, 3 files and 52 tests skipped. Typecheck clean. The
pair file alone is 29 tests.

claude noted its verification was static — no suite run in that session — which is the right thing
to have said rather than implying otherwise.

Beyond the suite, this phase was **driven as the real command** through
`runAgentFarm(['pair', …])` against a scratch `CODEV_AGENT_FARM_DIR`: both purposes issued, `list`
showing outstanding/redeemed/expired tokens and paired machines, `revoke` on a name with nothing
live, and exit code 1 for both a missing and an unknown `--purpose`. That is how the
`parseAsync` defect was found — the command printed nothing, silently, with exit code 0 — and no
unit test in this file would have caught it, because the fault was entirely in the wiring between
Commander and the module.
