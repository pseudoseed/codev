# Review: v2 server events — push-based status for the v2 hierarchy

## Summary

Four implement phases shipped an additive `GET /v2/events` SSE stream: hierarchy projection, scoped bus + route, change sampler, idle/convergence proofs. Net: a client gets a snapshot then `node`/`gone`/`counts`/`tick` deltas without touching `tower-server.ts`, `pty-session.ts`, or the existing SSE list. Phase 4 force-advanced at the 3-iteration consult ceiling; the last two defects (vacuous C1 git cwd, vacuous scenario 8 empty-equals-empty) are fixed on HEAD.

## Spec Compliance

- [x] Snapshot on connect with in-scope nodes + whole-hierarchy counts (Phase 2)
- [x] Spawn emits `node` to two subscribers in the same compare, well under 500ms (Phase 3)
- [x] Gate-waiting and stalled precedence (Phase 1 status + Phase 3 movement)
- [x] Exactly one status per 4b case (Phase 1)
- [x] Snapshot builders carry 20 buckets (Phase 2/3/4)
- [x] Resume table: in-window deltas, empty `resumed`, mismatch/restart → flagged snapshot (Phase 2/4)
- [x] Two snapshots share seq; next delta is seq+1 (Phase 2/3)
- [x] Held mail + future `not_before` (Phase 1 + 3)
- [x] Dark names the unknown/unreadable path (Phase 2)
- [x] Id collision across workspaces (Phase 1)
- [x] Idle < 1 KB/s with 20 silent builders over two ticks (Phase 4)
- [x] Continuous output does not scale frame count (Phase 3 9j + Phase 4 8b)
- [x] Two-client convergence after 100 mutations, non-empty final maps (Phase 4)
- [x] Scope isolation and in-scope counts (Phase 3)
- [x] `gone` on cleanup; architect reparent-then-gone; workspace children-first (Phase 3)
- [x] Stable builder id across the spawn window (Phase 3)
- [x] Existing `tower-routes.test.ts` SSE suite 101 passed, file untouched (Phase 2/4)
- [x] C1: `tower-server.ts` and `pty-session.ts` untouched; `tower-routes.ts` is one import + one `/v2/` block (Phase 2/4)

## Deviations from Plan

- Sampler never stops on last client (standing order overrode plan "start/stop with first/last").
- Production `V2Deps` bind on first `/v2/events` inside `v2-routes.ts`, not `tower-server.ts` (C1).
- Consult was 2 genuine lanes (Claude + opencode). Gemini skipped (agy). Codex quota-exhausted until 2026-08-27 16:01.
- Phase 4 force-advanced after 3 REQUEST_CHANGES rounds. Last fixes (`4bda8ae9d` scenario 8 non-empty; `9c4215c42` C1 git cwd; `6464f9fc4` filter union) landed at/after the ceiling.

## Consultation Feedback

### Plan (Round 1)

#### Gemini
- **LANE_DID_NOT_REVIEW** → **N/A**

#### Codex
- **LANE_DID_NOT_REVIEW** (quota) → **N/A**

#### Claude
- **Concern**: `discoverBuilders` leaves `spawnedByArchitect` null; must join `getBuilders` → **Addressed** in the plan. ParentId AC requires the architect id.

#### opencode
- Same join + do not pause + dark is a handshake → **Addressed** in the plan.

### Phase 1 (Round 1)

No blocking concerns on the projection after tests landed. Gemini/Codex skipped.

### Phase 2 (Round 1)

#### Claude / opencode
- **Concern**: snapshot seq at write time → **Addressed** (`036ab2617`): pin snapshot/dark to subscribe-time seq.

### Phase 2 (Round 2)

#### Claude / opencode
- **APPROVE**. Non-blocking notes (double-decode, `lastWrittenSeq`, `setV2RouteDeps`) → **Addressed** in Phase 3.

### Phase 3 (Round 1)

#### Claude
- **Concern**: unscoped tick buckets → **Addressed**
- **Concern**: case-sensitive terminal lookup → **Addressed** (`lookupBuilderTerminal`)
- **Concern**: per-node mailbox GROUP BY → **Addressed** (memoize per workspace per `now`)

### Phase 3 (Round 2)

#### Claude / opencode
- **APPROVE**. Non-blocking: dark path still received deltas → **Addressed** in Phase 4 (`watchScope`/`seedScope` key + filter split).

### Phase 4 (Rounds 1–3)

#### Claude
- **Concern**: scenario 12 git pathspecs relative to vitest cwd → **Addressed** (repo-root cwd, non-empty routes diff)
- **Concern**: `seedScope` overwrote shared filter → **Addressed** (union)
- **Concern**: scenario 8 empty-equals-empty → **Addressed** (`4bda8ae9d`: restore workspace, assert `nodes.size > 0`, strip buckets)

#### Gemini / Codex / opencode
- Skips or timeout → **N/A**. opencode APPROVE on iter 2.

### Review / PR #61 (Round 1)

#### Claude
- **Concern**: scenario 12 `merge-base origin/main` fails on shallow CI and after merge → **Addressed** (`c0c8af4a8`): working-tree assertions only
- **Concern**: `parseScope` split after decode → **Addressed**: split raw query, then decode
- Sampler loop / scope eviction → **N/A**: already follow-ups
- Delete stub review file → **Rebutted**: porch greps that filename for the required headings

## Lessons Learned

### What Went Well

Fork-owned `v2-*.ts` plus one mount kept C1 falsifiable. Fake clock + injected `V2Deps` let Phase 3/4 prove ordering without a live Tower.

### Challenges Encountered

Opencode cannot self-refresh. Phase 4 reviews kept finding vacuous tests (wrong git cwd, empty-equals-empty). Force-advance fired before the last test fix was re-reviewed.

### What Would Be Done Differently

Write scenario 12 against `git rev-parse --show-toplevel` from the first draft. Assert `nodes.size > 0` on any "converge" test.

### Methodology Improvements

Porch's 3-iteration ceiling is right, but the force-advance message cited iter-1 verdicts while later fixes were already on the branch. Name HEAD in that message.

## Architecture Updates

No architecture updates needed — the stream has not been run against a live Tower; the plan deferred `arch.md` until then. Hot tier is at cap and this is spec-narrow, not a displacement candidate.

## Lessons Learned Updates

- Routed: cold — Testing — Vitest cwd is `packages/codev`; git pathspecs in tests must pass `cwd: git rev-parse --show-toplevel` or they silently match nothing.
- No hot lesson. Cap is full; this is not cross-cutting enough to displace.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Live Tower run: idle CPU of the 100ms `discoverBuilders` loop (Phase 4 measured bytes, not syscalls).
- Scope-registry eviction for keys with zero subscribers and an aged-out buffer.
- Codex lane still quota-exhausted until 2026-08-27 16:01.
