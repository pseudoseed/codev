### Iteration 1 Reviews
- claude: APPROVE — Phase 1 two-identity harness is complete and correct; the destructive acquire path, merge-base check, and three-code exit semantics are all implemented and tested.
- opencode: REQUEST_CHANGES — ready/smoke/integration still run both-identity verify, so an upstream server start dies once the fork HEAD leaves pin.commit.

### Builder Response to Iteration 1
# Spec 250, phase_1, iteration 1 — review responses

Two lanes: **claude** (APPROVE) and **opencode / grok-4.6** (REQUEST_CHANGES).

The opencode lane timed out at 360s on its first attempt and produced no verdict. `consult` has
no timeout flag — `OPENCODE_TIMEOUT_MS` is a hard-coded 6 minutes in
`packages/codev/src/commands/consult/index.ts:1561` — so the run was retried and completed. The
first failure was loud and exited 1, which is the lane behaving correctly; it is recorded here
rather than left as an unexplained gap.

---

## opencode #1 — `ready()` still runs full `verify()` — ACCEPTED

> `start()` only calls `verifyUpstream()` so a spec 146 run does not need the fork. `ready()`
> then calls `verify('CHECKOUT_MOVED_DURING_RUN')`, which requires fork HEAD == `pin.commit`.

Correct, and it made `start()`'s upstream-only exemption buy nothing: `smoke.mjs` calls
`acquire`, `verify`, `start`, `ready` in sequence, so the fork requirement came back one call
later. `packages/t3-client/live/integration.mjs:202` had the same shape.

The consequence is not hypothetical. Phases 2 through 4 commit to the fork while `pin.commit`
stays at `upstreamBase` until phase 5. On the first fork commit, a correct upstream server would
have failed `ready` with `CHECKOUT_MOVED_DURING_RUN` — a signal about the checkout the *server*
runs from, reported for a checkout the server never touches.

**Fixed.** `ready()` now calls `verifyUpstream('CHECKOUT_MOVED_DURING_RUN')`. Two new subcommands,
`verify-upstream` and `verify-fork`, assert one identity each; `smoke.mjs` and
`live/integration.mjs` use `verify-upstream`. Bare `verify` still asserts both, which is what the
phase's acceptance criterion requires.

Four tests: `verify-upstream` passes with no fork checkout at all, `verify-fork` passes with no
upstream root, bare `verify` still stops at `3` on a missing fork, and the three callers are
asserted to use the upstream-only verb.

The cold-start evidence was re-collected after the `smoke.mjs` change.

## opencode #2 — `verifyCheckout` treats a failed `git status` as clean — ACCEPTED

> The catch comment says undetermined; the code returns success. Same "could not tell" as pass.

Correct. The catch fell through to `dirty = ''`, and an empty string is how "clean" is spelled.
The comment claiming otherwise was inherited from the spec 146 version, which had the same bug —
the reviewer found it in the new file, and it was there before.

**Fixed.** The catch now `die(UNDETERMINED, 'NO_<IDENTITY>_STATUS: could not check: ...')`.

The test triggers it for real rather than asserting on source: `chmod 000` on `.git/index` leaves
`rev-parse HEAD` working (it reads only the ref) and makes `git status` exit 128, which lands the
failure exactly between the two checks. The test refuses to pass vacuously — if the platform
ignores the mode, it fails with a message saying so rather than skipping quietly.

## claude #1 — `FORK.md` overstates "nothing re-derives it" — ACCEPTED

`packages/t3-client/live/integration.mjs` deliberately reads `process.env.T3CODE_ROOT` directly
and keeps it **required** (#214). The sentence was stronger than the code.

**Fixed.** `FORK.md` names the exception and why it is one.

## claude #2 — test heading says "the seventh readers" over six — ACCEPTED

**Fixed.** Renamed to "the root readers".

## claude — items it could not verify from its session

The lane had no shell. All three are now checked:

| Claim | Result |
|---|---|
| `pnpm -w test` | 7263 passed, 54 skipped, 0 failed, with both live suites executing |
| `gh repo view pseudoseed/t3code` | `visibility: PRIVATE`, `isFork: false`, default branch `codev` |
| MIT `LICENSE` unmodified in the fork | `diff` against the upstream clone reports identical |

## Not changed

**When `pin.commit` moves to the fork head.** Both lanes brushed against it; neither asked for a
change. The plan puts it at phase 5, so phases 2 through 4 will run with a fork checkout ahead of
`pin.commit` and bare `verify` will report `FORK_CHECKOUT_MISMATCH` in that window. That is the
plan's sequencing, not a phase 1 defect, and the per-identity verbs above mean it no longer blocks
an upstream server. Flagged to the architect rather than resolved here.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
