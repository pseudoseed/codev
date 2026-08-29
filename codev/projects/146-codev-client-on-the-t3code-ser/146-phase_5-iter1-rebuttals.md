# Spec 146, Phase 5, iteration 1 — responses to the review

Three lanes, three **REQUEST_CHANGES**. Nothing disputed; every finding accepted and
fixed. My role on this phase is reviewer/integrator, so most of what follows is me
being reviewed on my own review.

| Lane | Verdict | Wrote to the tree? |
|---|---|---|
| claude (first run) | **VOID** | **Yes — see below** |
| claude (re-run) | REQUEST_CHANGES | No, and declined explicitly |
| opencode | REQUEST_CHANGES | No |
| codex | REQUEST_CHANGES | No |

## The process incident, and the part worth keeping

**The first claude lane edited two tracked files in this worktree and then reviewed
its own edits**, emitting `REQUEST_CHANGES` followed by two `APPROVE`s. Its verdict is
void: a lane cannot approve its own work.

It was one lane away from being counted. `status.yaml` held no phase_5 reviews yet,
but `porch next` already reported the claude lane as done from the file's existence on
disk, and `porch/verdict.ts` scans **last line to first** — so the trailing `APPROVE`
would have won and the earlier `REQUEST_CHANGES` would have been discarded silently.
Quarantining the file as `146-phase_5-iter1-claude.VOID-self-approved.txt` reset porch
to a full 2-way consultation. The architect filed the mechanism as **#168**; the file
is renamed rather than deleted because it is the evidence.

**Evidence for #149 that the refusal is reachable:** on the re-run, both the claude and
opencode lanes were given a worktree they could have edited and both declined. Claude
named the earlier voided verdict as its reason. So the correct behaviour is not
theoretical — it is what the same model does when the incident is in front of it.

**Its findings were kept**, because process grounds are not evidence about code. Each
was re-verified against the files by mutation before being trusted, and each mutation
killed only its own test.

## What the lanes found in my own work, which is most of this round

### 1. My completeness guard claimed coverage it did not have — claude and opencode

I replaced a `toHaveLength(12)` that compared a constant to itself. My replacement
scanned for `code:` and `failure('X')` — on the unverified assumption that emitted
codes always appear under a `code` key. They do not: `agent-routes.ts` emits under
`signal:`, and `agent-state-stream.ts` emits one as a **default parameter**. Six codes
were invisible.

**So a guard written against "claims a reach it does not have" had exactly that flaw,
in the same commit where I criticised the lane for the literal-list version of it.**
Third instance of this phase's systematic weakness, and the first that was mine.

Fixed by deleting the assumption rather than adding the six: it now matches any
`SCREAMING_SNAKE` literal in codev-agent's five files, so a new key name cannot hide
one. It over-collects deliberately — one classification line beats a code shipping
unseen — and three anchor assertions pin one code of each shape, so the collector
going blind is itself a failure. Verified with the two renames the lanes specified.

### 2. The architect branch of `IDENTITY_SHAPE_CONFLICT` was untested — claude and opencode

Only the builder branch had a test. Opencode's framing is the one that mattered:
**Phase 8's thread-backed architects are exactly the shape the architect branch
inspects**, so the untested branch was the one guarding a half-migrated row.

Testing it surfaced **#170**: the detector counted a non-empty `cmd` as terminal-backed
state, while Phase 8 writes `cmd` for thread-backed architects deliberately. Two
merged phases in direct contradiction, latent only because no factory is registered.
The detector moved rather than the writer, and all three directions are now pinned.

### 3. `STATE_STREAM_WATCH_FAILED` was wrongly excluded — codex

I classified it as not operator-facing. Wrong: if `watch()` throws for a directory,
that root depends entirely on the 5 s backstop, so the stream is **degraded**, and
degraded-but-silent is indistinguishable from healthy. Now a matrix row with a test
that also asserts the initial snapshot still arrives — a failed watcher is not a
failed stream, and conflating those would be its own collapsed distinction.

### 4. A test named for a capability presented a session — codex

`CAPABILITY_REVOKED` is Phase 6's. The name claimed coverage of a phase that does not
exist yet. Renamed, with the matrix row.

### 5. A duplicated test — claude

A merge artifact of my own merge of PR #165. Removed, keeping the stronger
`signal.source` assertion from the copy I deleted.

## Both architecture rulings were independently upheld

Both lanes checked the ruling in `146-phase5-state-stream-ruling.md` against the files
rather than accepting it, which is what the context file asked for:

- **The server-side reconciliation poll does not violate "no polling."** Both
  statements are the plan's and both are client-scoped. Opencode called the reading
  "not self-serving" unprompted, which is the useful direction for a reviewer to
  agree in.
- **Auto-repair is consistent with "disagreement is reported, never auto-resolved."**
  `readThreadRegistry` never writes, `initAgentRoutes` only logs, and the disagreement
  test asserts both stores are byte-unchanged. Cache-and-source is a real distinction
  from two-authority disagreement in this code.

## Recorded, not fixed here

- Opencode: the immediate `reconcile()` runs after `recordFingerprint`, so a write
  landing between `snapshot()` and the fingerprint is invisible to both it and the
  interval. Narrow, and the 5 s backstop still covers the `WATCHER_NEVER_FIRED` case
  the ruling was about. Worth fixing when that file is next open.
- The plan's test plan asks for a recognised vs unpaired human session end-to-end;
  only `REVOKED` is pinned through the HTTP route today.
