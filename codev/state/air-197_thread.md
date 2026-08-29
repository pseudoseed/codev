# air-197 — opencode render-gate profile: capture, diagnose, guard

## Task 1 (capture + diagnose) — COMPLETE. Architect's drift hypothesis FALSIFIED.

### Measured facts

1. **No version drift.** `opencode 1.18.18`, symlink installed 2026-08-19 12:46,
   binary dated 2026-08-12. The committed fixtures were captured from 1.18.18 (Issue #4).
   No opencode release landed between fixture capture and the 2026-08-29 incident.

2. **All four `bottomAnchor` patterns still match.** Six frames captured live from that
   binary under a PTY at 110x32 (`scratchpad/cap/live-*.txt`) classify exactly as
   `OPENCODE_PROFILE` designs:

   | frame | verdict |
   |---|---|
   | live-boot | busy / `no-idle-indicator` |
   | live-boot-draft | busy / `no-idle-indicator` |
   | live-draft | busy / `user-text` |
   | live-idle | **clean / `empty`** |
   | live-idle2 | **clean / `empty`** |
   | live-midturn | busy / `busy-indicator` |

   Zero glyph drift. `rulePattern`, `bodyPattern`, `topEdgePattern`, `minContentRows`
   are all still correct. **There is no profile edit to make.**

### Actual mechanism: a ROWS-direction geometry mismatch

opencode's composer is bottom-anchored. When the gate mirror's viewport is **shorter**
than the height opencode painted at, the whole box is clipped out of the viewport,
`rulePattern` matches nothing, and the gate returns `no-composer-marker`.

Measured cliff on the real 32-row idle capture (cols fixed at 110, rows swept 10..60):

```
busy/no-composer-marker   rows 10..29
busy/no-idle-indicator    rows 30
CLEAN/empty               rows 31..60
```

It is opencode-specific under identical conditions — which reproduces the field
asymmetry exactly (claude/codex delivered first try, opencode never did):

| idle fixture | verdict across mirror heights 10..40 |
|---|---|
| claude | CLEAN at every height |
| agy | CLEAN at every height |
| codex | holds below 20, CLEAN 20+ |
| **opencode** | **`no-composer-marker` at every height below 31** |

### Root cause of the mismatch: the mirror height is never reconciled with the PTY

1. `createSessionRaw` builds every shellper-backed `PtySession` at
   `defaultSessionOptions()` = **80x24** (`pty-manager.ts:196`, `terminal/index.ts:2-3`).
2. `attachShellper` (`pty-session.ts:216`) hydrates `lastDataAt` from the client but
   **never touches cols/rows**.
3. The only thing that ever changes session rows is `resize()`, and it is called solely
   from a connected browser client (`tower-websocket.ts:80`, `pty-manager.ts:421`) or the
   REST resize route (`pty-manager.ts:528`).
4. The shellper's live PTY geometry **is already on the wire** in the WELCOME frame
   (`WelcomeMessage.cols`/`.rows`, `shellper-protocol.ts:73-76`) — and is discarded.

So after any Tower restart or reattach the mirror is 24 rows while the shellper PTY keeps
whatever a browser last set it to. An **unattended** builder has nobody to send a resize,
so the clip is permanent and every message holds forever. Opening the terminal tab sends a
resize and clears it — which is why some holds eventually delivered and one never did.

Secondary path (already documented in the fixtures README): `resize()` shrinks the mirror
unconditionally, then drops the app-side resize on the `status !== 'running'` branches.

**UNVERIFIED LINK:** that the browser client in the incident had in fact resized the PTY
taller than 24. Near-certain (every real terminal window is), but the sessions are gone and
I have not measured it.

## Task 2 (fix)

Two parts, deliberately split:

- **Root fix — mail actually delivers.** Adopt the shellper's real PTY geometry on attach.
  Hydrate `cols`/`rows` onto `ShellperClient` from WELCOME (the exact pattern `lastDataAt`
  already uses), then align the session + gate mirror in `attachShellper` *before* the
  screen seed is fed. One place; fixes all 8 `attachShellper` call sites. Adopt-only, no
  RESIZE frame back to the shellper — we align our mirror to the app's truth rather than
  commanding a repaint into a live TUI.
- **Honest signal — a hold that names the right thing.** A rows-direction detector so a
  clipped composer reports `geometry-mismatch`, not `no-composer-marker`. This does NOT
  make mail deliver (`mailbox-hold-policy.ts` maps all three details to `escape-screen`);
  it stops the next operator losing hours to a glyph hunt. Both directions of the same
  defect class this repo keeps hitting: "I could not tell" spelled the same as "no".

**Detector discriminator (structural, measured, not a text heuristic):** at correct
geometry opencode leaves its **last viewport row blank**; when the taller frame is clamped
into a shorter viewport every overflow row piles onto the last row, which becomes non-blank.

```
live-idle @110x20   rule=n lastRowLen=104   <- clipped
live-idle @110x24   rule=n lastRowLen=104   <- clipped
live-idle @110x30   rule=Y lastRowLen=104   <- clipped (footer lost -> no-idle-indicator)
live-idle @110x32   rule=Y lastRowLen=  0   <- healthy
dialog    @110x32   rule=n lastRowLen=  0   <- genuine no-composer
boot      @110x32   rule=Y lastRowLen=  0   <- genuine
wrapper   @110x32   rule=n lastRowLen=  0   <- genuine
```

Blank-last-row holds across all 5 committed fixtures and all 6 live captures at correct
geometry. `screenLines` already `trimEnd()`s, so the test is exactly `lines[rows-1] === ''`.
The single check subsumes both the `no-composer-marker` (rows <=29) and `no-idle-indicator`
(rows 30) mislabels, and leaves genuine no-composer frames alone. It is a profile-level
fact, so it gets declared on the profile rather than hardcoded. If a future opencode fills
its last row, the idle fixture flips clean->busy and CI says so — the fail-safe direction,
and exactly the "make the next drift loud" property task 3 asks for.

## Task 3 (guard)

Commit the 6 live captures as fixtures, sweep them across widths AND heights, and give the
fixture suite a self-reach assertion so a zero-fixture run fails instead of passing green
(#190, #193, #194).

## Constraints honoured

- No edits to `commands/spawn.ts` / `spawn-worktree.ts` (spir-146 owns them).
- Architect hold 17:43: all vitest stopped. Hold 17:45 extended to PTY spawns; one capture
  session had already completed at 17:44, so nothing was in flight and no further captures
  are needed.
- `heldRecoveryKeystroke` mapping `cancel-draft` -> `\x03` is bugfix-196's. Not touched.

---

## Outcome

Committed `f82f4dc68`. ~25 lines of production code across 5 files; the rest is fixtures,
tests and the measurement write-up.

### What shipped

1. **Root fix — mail delivers.** `ShellperClient` hydrates `ptyGeometry` from the WELCOME
   frame (the pattern `lastDataAt` already uses) and keeps it current on a successful
   `resize`. `attachShellper` adopts it onto the session and the gate mirror *before* the
   screen seed is fed. Adopt-only, no RESIZE frame back. An older shellper that reports
   nothing leaves the geometry untouched — "unknown" is not a licence to overwrite.
2. **Fact-based geometry check** in `classifyAgentScreen`: compare the mirror's geometry
   against the shellper's, both known. Catches the residual case adoption cannot — a
   dropped app-side resize. **Scoped to `bottomAnchor` profiles.**
3. **Frame-based geometry check** in `classifyBuffer` via `finalRowAlwaysBlank`.
4. **Guards:** 4 live captures as fixtures, a height sweep (10..40) beside the width sweep,
   a fail-safe test that no short mirror reads a busy opencode screen as empty, a test that
   claude/codex/agy are identical at every height, and a fixture suite that asserts its own
   reach (throws on a missing *or empty* directory, with a test for each).

### Two things I nearly got wrong, both caught by measuring rather than reasoning

**The frame-based detector would not have caught the incident.** It fires when the mirror is
short. When the mirror is short *and* narrow the screen re-wraps until no structural signal
survives — and 80x24 against a 110x32 agent, the real field shape, is exactly that. Measured
across a cols x rows matrix, not deduced. That is why the fact-based check exists; without
the matrix I would have shipped a detector that named the right cause in the lab and the
wrong one in production.

**The fact-based check silently widened the blast radius.** As first written it applied to
every harness, which is a *live behaviour* change (a claude session with a mismatched mirror
that delivers today would start holding) that **no fixture would have caught**. "Fixtures
green" would have been a proof-shaped thing rather than a proof. Scoped to `bottomAnchor`
and raised with the architect instead. Widening it is filed separately: a mismatched mirror
could hand claude a false CLEAN, which is the delivering-into-a-live-turn direction the gate
exists to prevent. A false hold costs minutes; a false CLEAN corrupts a turn.

### One synthetic fixture edited, no real capture touched

A synthetic opencode screen went from 29 box rows to 28 so its 32-row screen keeps the blank
final row every real frame has; otherwise it trips the new check before reaching the
upward-scan branch it exists to test. 28 still far exceeds `maxLookback` (20). Every
committed byte stream is exactly as captured.

### Verification status

- `tsc --noEmit`: clean.
- `render-gate` + `pty-session-geometry` + `pty-session-attach` + `shellper-client`: 127 passed.
- Full suite: **NOT YET RUN.** Architect asked air-197 to yield the port 13999 lock to
  spir-146 indefinitely (its branch predates the 900s lock-wait fix, so it loses every race).
  PR is held until the full suite passes; it will not be opened on partial verification.

### Lock etiquette log

- 17:43 architect halted all vitest; air-197 had run none.
- 17:45 hold extended to process spawns; the single capture session had already finished.
- 17:51 fully cleared.
- 18:02 asked to yield the lock to spir-146. Killed my own wait-then-run poller — it polled
  every 15s and would have taken the lock in the gap between spir-146's runs, which is
  racing, not queueing. Nothing of mine ever held the lock; the one attempt timed out at
  ~120s without executing a test.

---

## PR #203 — opened as a DRAFT, deliberately

https://github.com/pseudoseed/codev/pull/203

Base merged from `origin/main` at `e845574fa` before opening — this branch was cut from a
stale local `main` (`4aade761a`) and was missing #191 and #192, including #189's `CODEV_*`
scrub and #192's 900s suite-lock wait. Clean merge, no conflicts, none in any file this PR
touches. `tsc --noEmit` re-run against the new base: clean.

### A thing I had backwards

I was holding the PR closed because the full local suite had not run, treating "not fully
verified" as a reason not to publish. The architect's correction: the defect is publishing
without *saying* so. Opening a draft that states exactly what has and has not run is the
opposite of the defect — and CI runs the full suite on GitHub's machines with **no dependence
on port 13999 at all**, so it is an independent full-suite result, sooner, at no cost to
spir-146 or bugfix-196. The local lock constrains porch's bookkeeping, not the truth of
whether the suite passes. I had conflated the two.

### Verification as published

| check | status |
|---|---|
| `pnpm --filter @cluesmith/codev build` | green, exit 0 |
| `tsc --noEmit` | clean, re-run post-merge |
| render-gate + pty-session-geometry + pty-session-attach + shellper-client | 127 passed |
| full `packages/codev` suite, locally | NOT RUN — lock yielded |

Stated in the PR body as a table, not buried in prose.

### Remaining

Undraft once CI is green and the local suite has run. Lock order set by the architect:
bugfix-196 first (120 failures across 23 files, cannot move at all), then air-197.

---

## CI green, PR undrafted

All 8 CI jobs pass against the merged base `e845574fa`, including **Unit Tests (2m58s) —
the full `packages/codev` suite**. #203 is out of draft and ready for review.

The result I was holding the PR closed to obtain arrived without anyone touching port 13999.
That is the concrete payoff of the correction: the local lock constrains porch's bookkeeping,
not whether the suite passes, and CI is an independent full-suite run. Holding the PR bought
nothing and cost the reviewers time.

PR body updated to match, rather than left stale — the verification table now records CI
green with the job list, and the "NOT RUN" row is gone. The local run is still outstanding
and the body says so; it is a formality for porch's criteria now, not evidence anyone waits on.

### Consultation config

`porch.consultation.models` changed workspace-wide from `['codex','claude']` to
`['claude','opencode']` while this was in flight — codex is quota-exhausted account-wide and
the agy/gemini lane is rate-limited, and both return no review at all. Checked my own
`status.yaml` rather than assuming: `history: []`, no consultation record, no baked lane
list. Nothing to work around, and no slot anyone could be tempted to rename.

Worth recording because it is the same defect as the two above, in a third costume: **a lane
that did not review is not an approval**, exactly as a fixture directory that swept zero
files is not a pass, and "I could not tell" is not "no". Three spellings of one bug, all met
in a single afternoon.

### Remaining

- CMAP verdicts (claude + opencode), running.
- `porch check 197` / `porch done 197` once bugfix-196 clears the 13999 lock. Bookkeeping.

---

## The review round, and the retraction that mattered

Integration review requested changes. Two blocking findings, and my first fix for the more
serious one **did not work** - I said it did, then found otherwise before CI could.

### Blocking 1: a new way to corrupt a live turn

Both geometry checks ran before the `busy-indicator` check. `heldRecoveryAction` maps
`geometry-mismatch` to `escape-screen` (an ESC) and deliberately maps `busy-indicator` to
nothing, because it proves a live turn. So the change routed the exact screen that policy
protects into the exact keystroke it withholds.

The review credited the frame-based check with inheriting the safe pre-existing ordering.
It had not: `resolveRegion` runs *after* the busy check and my check ran *before* it, so I
had introduced the defect in **both** places, not one. Found by reading my own diff.

**Reachability was disputed between lanes.** claude said reachable; opencode said not, because
a resize only fails when the session is non-writable and those already hold as `no-live-pty`.
Resolved from source, not by preference: the divergence is only ever *created* while
non-writable, but writability **returns without a re-attach** via `startRestartWait` (#1264) -
`exitCode` is set, the client and WebSocket clients survive, a resize in that window moves the
mirror alone, and the respawned child's first byte clears `exitCode`. No `attachShellper`, so
adoption never re-syncs. `_connected = true` appears at exactly one place, inside `connect()`,
so every *other* recovery route requires a new client and therefore a re-attach.

opencode reasoned about the instant. The bug lives in the interval.

### The retraction

I reported blocking 1 as closed by reordering. Then I ran my new test's assertions through
`tsx` - no vitest, no lock - instead of waiting for CI, and the byte assertion failed: one ESC
byte had gone to a live turn *after* my fix.

Measured on the committed mid-turn capture:

| mirror | verdict |
|---|---|
| 110x32 (capture geometry) | `busy-indicator` |
| 110x24 | `geometry-mismatch` |
| 80x32 | `geometry-mismatch` |
| 80x24 | `geometry-mismatch` |

On a smaller mirror the reflow carries opencode's interrupt-hint footer off-screen. **The
liveness proof is read off the same frame whose geometry we have just declared untrustworthy.
It is not outranked - it is destroyed.** Ordering can never fix this, so neither of the two
options the review offered was viable as framed.

### The actual fix, in two halves that are not separable

1. `heldRecoveryAction` returns nothing for `geometry-mismatch`. Two **independent** grounds,
   either sufficient: **futility** - no byte sent to the agent resizes Tower's mirror, so ESC
   was a no-op dressed as a repair, true even for a provably idle agent; and **danger** - a
   mismatched frame cannot prove the agent is idle, true even if a keystroke could help.
2. `geometry-mismatch` joins `isClassifierStuck`. Without this, half 1 alone would have traded
   an unsafe act for a **silent** starvation - the exact defect this whole issue is about,
   introduced while fixing another one. Caught in my own change before shipping.

### Also this round

- `issue-92-stuck-hold-recovery.test.ts` had `geometry-mismatch` in its it.each table of
  details WITH a bounded recovery action. Found by grepping for tests encoding the old
  mapping, not by CI failing.
- Two false claims in my own comments: "every harness" beside "scoped to bottomAnchor", and a
  log line promising the mirror "realigns on next attach" - false for the restart path, which
  is precisely the path that makes the check reachable.
- PR body corrected: the earlier "neither changes a delivery outcome" was wrong, contradicted
  by the README in the same diff (the cliff moves 31 to 32).

## State at the second review round

CI **fully green on HEAD `2181ef0bd`**, all 8 jobs, Unit Tests 3m01s - the full suite, on a
machine with no dependence on the local lock.

**Not settled, and must not be treated as settled.** Both review lanes saw the design where
the fact-based check fired and `geometry-mismatch` still mapped to `escape-screen`. The
central safety decision has changed since - no keystroke at all, plus escalation. A fresh
claude lane is running on current HEAD against the delta. Green CI plus two stale approvals is
not a pass: CI proves the tests I wrote agree with the code I wrote, and neither lane was
asked whether removing the recovery action was right.

**Do not merge until that verdict and the architect's read land.**

Two open questions deliberately left for that lane to answer independently:
1. Whether `geometry-mismatch` joining `isClassifierStuck` gives a USEFUL escalation or a
   noisy one. It is permanent-until-resize, so it hits the streak threshold every time rather
   than occasionally.
2. Whether anything else in the recovery table has the same defect mine did - an action that
   cannot fix the state it is mapped to. ESC cannot fix geometry; nobody has asked whether
   `cancel-draft` can always fix `user-text`.

Lock discipline held throughout: yielded to spir-146 and bugfix-196 all afternoon, never
raced, never killed anything. The window-taker required two consecutive FREE polls 20s apart
so it would not fire on a gap between another builder's runs, and it opened at 12:26:13 when
spir-146 released for its merge.

---

## Second review round (fresh lane on current HEAD): REQUEST_CHANGES

The fix was sound at the seam. Everything blocking was on the **human-facing surfaces the
telemetry fix did not reach** — the same hole this issue is about, on the other side.

1. **`inbox.ts` promised an ESC that can never fire.** Its paragraph named
   `geometry-mismatch` among the details that get "one automatic ESC after the starvation
   window". This PR made that false. Worse, the filter above it keys on
   `heldRecoveryAction(...) === 'escape-screen'`, so it correctly *excluded* those rows — and
   they therefore printed **no guidance at all** while the prose beside them promised a
   keystroke. #190's exact shape, introduced by the change that fixed its telemetry twin.
   Fixed by removing the hand-maintained detail list from the prose (the filter already
   decides membership) and giving `geometry-mismatch` its own block.

2. **`heldRemedy` had no `geometry-mismatch` branch**, so the one detail with a non-obvious
   remedy was the one the operator was told nothing specific about. Added a branch naming
   what actually works: open the terminal tab, because a connected client's resize realigns
   the mirror, and it self-clears on the next re-attach. Deliberately a branch, **not** a
   second detail list — keying on `heldRecoveryAction` is why this degraded gracefully at all.

3. **An inverted claim in the record, and the correction matters more than the code.** The
   `codev terminal` case was written up as "an honest hold, but a permanent one". It is not a
   hold — it is a **false negative**. Verified in `shellper-process.ts:429`: `handleResize`
   sets `this.cols/rows` and resizes the PTY but **broadcasts nothing**, so when a second
   client resizes, Tower's mirror and its `_ptyGeometry` both stay at the old value and stay
   EQUAL. The fact-based check compares them, sees agreement, and passes — while both are
   wrong relative to the grid the agent now paints at.

   The consequence for anyone writing the follow-up: the spec has to **push geometry to
   clients on RESIZE**. Softening a hold would be fixing a symptom that does not exist.

Nits, also fixed: two comments still quoted the pre-change cliff as "clean at 31+" against an
assertion of `rows >= 32`; and the byte-assertion tests had **no positive control**, so
`expect(writes).toEqual([])` would have passed just as well against a harness that could not
observe a write at all — the empty-fixture-directory defect again, in my own new tests. Added
a control asserting `user-text` still produces its Ctrl+C where the assertions look for it.

### Still open, still not answered by me

1. Whether `geometry-mismatch` joining `isClassifierStuck` gives a useful escalation or a
   noisy one, now that the condition is permanent-until-resize rather than occasional.
2. Whether anything else in the recovery table has an action mapped to a state it cannot fix.
   ESC cannot fix geometry; nobody has asked whether `cancel-draft` can always fix `user-text`.

### Lock rule dissolved

All three worktrees now carry `WAIT_TIMEOUT_MS = 900_000` — bugfix-196 picked up #192's long
wait when it merged `origin/main` at `01330f801`. Nobody can be timed out by anyone else's
run, so the yield rule has no remaining purpose and it is first-come from here.

## Flaky test observed (not skipped, not touched)

`spec-146-phase-9-porch-engine.test.ts` — "every relative import in packed dist/ resolves
inside the @cluesmith/codev tarball" — failed once during a local `porch done` with
`Test timed out in 5000ms`, alongside 6533 passing tests.

Timing-fragile by construction: it runs `execFileSync('npm', ['pack', ...])` **synchronously**
under vitest's default 5000ms timeout, no override, on a package that packs a vendored
three.js and a copied skeleton.

Evidence it is load rather than this diff: it passed in an earlier clean `porch check` on this
branch (tests 211.6s, all green); it passed on isolated re-run (16 passed, 1 skipped); CI is
green on it across every run of this PR; and it exercises `npm pack`, which this diff does not
touch.

The load was mine. I had two of my own vitest runs contending — a full suite and a targeted
run launched without checking I was competing with myself. The lock serialises the runners but
the `pack` subprocess still ran on a busy machine. Same class of mistake as racing the lock,
just against myself.

Arming condition worth knowing: `it.skipIf(!distBuilt)` means it only runs when
`packages/codev/dist` exists, and porch's own `build` criterion creates it — so running
`porch check` / `porch done` is exactly what arms it. In the isolated re-run it skipped.

**Left alone deliberately.** It is Spec 146 Phase 9's file and `builder/spir-146` is active in
that area; annotating around a sibling's test is not this project's call. Reported to the
architect instead. If it is worth hardening, the fix is an explicit timeout on that `it()`,
not a skip.

## Both open questions closed (by the architect, from source)

1. **The escalation is useful, not noisy.** `mailbox-delivery.ts:946` tests
   `next === LIVENESS_STREAK_THRESHOLD` — equality, not `>=`. The streak resets only on a
   delivered or empty pass, so under a permanent `geometry-mismatch` it grows monotonically
   past 10 and the condition is true for exactly one tick. Alarms once per starvation.
2. **Yes, and the whole table fails the test.** `cancel-draft` cannot always fix `user-text`:
   opencode's only non-fatal clear is `ctrl+u` (`input_delete_to_line_start`), so a multi-row
   draft cannot be cleared by any safe byte — the keystroke lands, the composer does not
   empty, the hold latches. Filed as #198, independently, from the other side of the table.

   So the general test — *does this action fix the state it is mapped to* — was asked of both
   rows and **both failed**. That makes it a property of how the table was built rather than
   two coincidences: entries were chosen for what they do to a terminal, not for whether they
   repair the state they are keyed to.
