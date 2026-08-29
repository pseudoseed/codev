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
