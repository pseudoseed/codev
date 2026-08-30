# spir-250 — t3code is the front end

## 2026-08-30 — plan phase

Spec 250 arrived approved (frontmatter `approved: 2026-08-30`, validated by claude + codex), so
porch handed me the plan phase directly.

### What I verified before planning, rather than taking the spec's word for it

- `/Users/chris/dev/t3code` is at `082e6ea52`, clean, remote `pingdotgg/t3code`. Matches
  `pin.json`'s `commit`.
- `/Users/chris/dev/t3code-codev` **does not exist yet**. The fork is phase 1's work, not a
  precondition someone already met.
- `OrchestrationThreadShell` (`packages/contracts/src/orchestration.ts:469` in the clone) has no
  parent field and no metadata bag, as the spec says. `ThreadCreatedPayload` at `:1148` carries
  only threadId/projectId/title/model/runtime/interaction/branch/worktreePath/timestamps.
- Upstream's live migration range ends at **42** (`042_ProjectionThreadLinkedPullRequest`). That
  is why the plan numbers ours at 900/901 — the spec said "far above" without naming a number.
- Upstream scopes are `orchestration:read`, `orchestration:operate`, `terminal:operate`,
  `review:write`, `access:read/write`, `relay:*`. Nothing expresses gate-writing, confirming the
  spec's `codev:gate-write` addition is necessary rather than convenient.
- `codev-agent`'s route prefix is `/api/agent/v1`, and the route table already carries
  `gate-approve`, `approval-submit`, `session-probe`, `pairing-redeem`, `human-session-issue`.
  Phase 10 proxies to these; it does not invent a new approval surface.
- t3code is `pnpm@11.10.0`, `engines.node: ^24.13.1`.

### Decisions I made that the spec left to the plan

1. **Migration numbers 900 and 901.** Spec said "number ours far above upstream's range"; 900
   with upstream at 42 gives an 858-migration gap, and a test asserts upstream has not reached it.
2. **`T3CODE_FORK_ROOT` as a second variable.** The spec ruled the identities explicit but named
   no variable. Stretching `T3CODE_ROOT` over both is exactly the failure it warns about.
3. **`tools/t3-fork/patches/` as a review aid.** The fork's commits cannot appear in this repo's
   PR, so a reviewer would otherwise have no diff for the six changes. Stated in the plan as a
   review aid only — approach 1 (patch set applied to a checkout) stays rejected.
4. **Eleven phases.** The vendoring harness is built first, while fork HEAD still equals
   `upstreamBase`, so its assertions have known answers before any customization exists to hide a
   harness bug inside.

### Flagged for the architect

Phase 1 runs `gh repo fork pingdotgg/t3code` — creating a **public** fork under `pseudoseed`.
Outward-facing and not quietly undoable. The spec bakes the destination, so it is decided, but
the act itself is worth a look before it happens.

### Claims verified while the plan consultations ran

- `afx pair` exists with `--purpose machine-credential | client-session`
  (`packages/codev/src/agent-farm/commands/pair.ts:55`), and `--purpose` has no default. Phase
  10's ceremony is real, not assumed.
- `afx pair revoke <machine>` exists and revokes the credential plus its live approval
  capabilities (`pair.ts:319-324`). The plan's revocation acceptance criterion is checkable.
- The spec's "one variable feeds six consumers" is exactly right: `T3CODE_ROOT` is read by
  `t3-server.mjs`, `smoke.mjs`, `classify-churn.mjs`, `transform-blindness-probe.mjs`,
  `generate.mjs`, and `spec-146-t3-contract.test.ts`. Six.
- `verify()` in `t3-server.mjs:100-140` compares HEAD to `pin.commit` and refuses a dirty tree,
  with `UNDETERMINED` as its own exit. Phase 1's two-identity change extends this rather than
  replacing it, and exit 3 stays distinct.

### opencode lane failed silently on the first attempt

Run 1 of `consult -m opencode` **exited 0 and wrote no review file**. Its stdout shows
`permission requested: external_directory (/Users/chris/dev/t3code/*); auto-rejecting`, then a
failed glob, then two successful reads, then exit. An exit 0 with no verdict is the exact shape
lessons-critical.md warns about — "I could not tell" spelled the same way as "no". Not counted as
a review. Re-run in progress; if it fails the same way the lane gets reported rather than
silently dropped from the round.

Both producers confirmed alive before waiting: `consult -m claude` (pid 34003) and
`consult -m opencode` → `opencode run -m xai/grok-4.6` (pids 38846/38936).

### Fix for the opencode lane

Root cause found rather than worked around: opencode auto-rejects `external_directory`
permission requests, and the plan cites `/Users/chris/dev/t3code` throughout, so the reviewer
died mid-run on the first read outside the worktree — twice, both times exiting 0 with no file.

`opencode run --auto` exists but the consult lane does not pass it. `OPENCODE_CONFIG_CONTENT`
does the same job scoped to a single invocation, verified directly:

    OPENCODE_CONFIG_CONTENT='{"permission":{"external_directory":"allow"}}' \
      opencode run -m xai/grok-4.6 -- 'Read /Users/chris/dev/t3code/package.json ...'
    → pnpm@11.10.0

Stated plainly: `external_directory: allow` grants *any* external directory for that process, not
just the t3code clone. Acceptable for a read-only review lane on this machine; it is not a narrow
grant and is not described as one. No global config was edited.

Worth raising with the architect separately: the consult opencode lane exiting 0 with no verdict
after a permission rejection is a lane bug, not a spec-250 problem. Two runs, same shape.

## Plan review round 1 — claude lane, REQUEST_CHANGES

The central finding was one I had got wrong, and I verified it before acting rather than taking
the review at its word.

**Migration 900 would have silently disabled every future upstream migration.** Effect's migrator
is a watermark, not a set difference — `unstable/sql/Migrator.js:78` selects
`ORDER BY migration_id DESC` and `:121` does `if (currentId <= latestMigrationId) continue`. Read
in `node_modules/.pnpm/effect@4.0.0-beta.103/`, the exact version `pin.json` names. Registering
900/901 makes the watermark 901, so upstream's 043+ arrive below it and are skipped while the
migrator logs that the schema is current. My "number far above upstream's range" mitigation
converted a loud collision into silent schema divergence, and my proposed guard test ("fail if
upstream reaches 900") asserted the inverse of the right invariant.

Fix: Codev's columns never enter `migrationEntries`. A guarded idempotent
`PRAGMA table_info` + `ALTER TABLE ADD COLUMN` runs at server start and never touches
`effect_sql_migrations`.

**This contradicts a spec assumption** — "the added columns follow [t3code's migration]
mechanism". It is an Assumption, not a Constraint and not a Baked Decision, and it is the
assumption that produces the bug. Flagged at the plan gate rather than changed quietly.

A side effect worth recording: criterion 8b would have passed **by construction** under the
migrator route, because `Migrator.js:142` wraps the run in `sql.withTransaction` and SQLite DDL is
transactional. Outside the migrator there is no wrapper, so the kill test now discriminates.

### Other verified findings

- `spec-146-t3-contract.test.ts:254` fails if the cold-start evidence is older than
  `t3-server.mjs` — which phase 1 edits. Re-collection is now a phase-1 deliverable, and the
  assertion is not loosened.
- `:231` asserts `evidence.pinnedCommit === pin.commit`, which phase 5 breaks. Re-scoped to
  `upstreamBase`: the evidence describes the upstream harness, so re-collecting it against the
  fork would change what it is evidence of.
- Seven files read `T3CODE_ROOT`, not the three I listed. I missed
  `packages/t3-client/live/integration.mjs:77` because my first grep was truncated at 20 lines.
  All seven are now assigned to an identity in a table.
- `generate.mjs:78` refuses when checkout HEAD ≠ `pin.commit`; switching its root to the fork is
  the load-bearing edit, which I had left implicit.
- Phase 10 understated both modules it ports: `client-static.ts:329-337` expands hop-by-hop
  tokens from the request's own `Connection` header (a fixed list is insufficient), and
  `approval.ts` has four outcomes — `sessionEnded` is distinct from `unconfirmed` and is ordinary,
  since sessions idle out at 30 minutes. `approval.ts:300-316` also forbids manufacturing the
  machine/session/timestamp client-side, which criterion 4 depends on.
- Phases 2, 3, 4, 7, 8, 9 touch only the fork, so each now logs its fork commit in `FORK.md` —
  their only artifact in this repository.
