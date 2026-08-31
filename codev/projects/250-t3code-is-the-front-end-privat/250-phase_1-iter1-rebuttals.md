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

---

# Iteration 2 review responses

Both lanes APPROVE. claude raised two non-blocking notes; opencode raised none.

## claude — `--since` bypassed the ref-resolution guard — ACCEPTED

The guard ran over `range.from` before `--since` replaced it, so an unresolvable `--since` ref
slipped past and surfaced as a raw git error: exit 1 doing exit 3's job.

**Fixed.** The guard now runs after `from` is computed, over the refs actually used. Tested with a
throwaway checkout and a `--since` naming a sha that does not exist.

## claude — no direct test for the `NO_UPSTREAM_MOVEMENT` named zero — ACCEPTED

Its `NO_FORK_DRIFT` twin was tested; the upstream one was not, because upstream has genuinely
moved on this machine (3 closure commits between `upstreamBase` and `origin/main`), so the real
pair cannot produce the zero.

**Fixed.** The test builds a throwaway checkout whose `refs/remotes/origin/main` sits exactly where
the range starts. A real empty range, not a mocked one.

## claude — items it could not verify without a shell

`gh repo view pseudoseed/t3code --json visibility,isFork,nameWithOwner,defaultBranchRef` returns
`{"defaultBranchRef":{"name":"codev"},"isFork":false,"nameWithOwner":"pseudoseed/t3code","visibility":"PRIVATE"}`.
`pnpm -w test`: 7263 passed, 54 skipped, 0 failed, plus 180 in the v2 suite. Both re-run after
these two fixes.
