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

## Architect ruling — stay out of the numbered registry

2026-08-30. Ruled with my finding rather than around it: because `schemaGuard` is upstream's own
PRAGMA-then-conditional-ALTER pattern verbatim, the only open question was registry membership,
and the answer is stay out. The reasoning worth keeping: a number we occupy is a number upstream
will eventually want, and that collision is silent — two entries claiming `043` means one is
skipped and its column never appears, which reads at runtime as "not recorded" rather than as a
failed migration. A separate layer cannot collide at all.

Accepted cost, recorded rather than argued away: our columns never appear in upstream's migration
history. Mitigated with a named start-up signal, `CODEV_SCHEMA_GUARD_APPLIED` /
`CODEV_SCHEMA_GUARD_NOOP` — two signals, because "added two columns" and "had nothing to do" are
different facts.

Spec risk row amended at `codev/specs/250-...md:341` under the architect's authority as approver.

## Plan review round 1 — codex lane, REQUEST_CHANGES

Substituted for opencode after three silent failures. Additive to claude's round rather than
overlapping it. All five verified before acting:

1. **Gate revision was not implementable as written.** I had asserted both "codev-agent sends no
   revision, the server allocates" and "a write carrying a lower revision is rejected". If no
   write ever carries one, there is nothing to reject and criterion 10 has nothing to deliver.
   Resolved by making `revision` optional: absent means allocate, present means must exceed the
   mark or be refused `CODEV_GATE_REVISION_STALE`.
2. **`codev:gate-write` was unenforceable where I put it.** `RpcAuthorization.ts:24` maps the
   whole `dispatchCommand` method to `orchestration:operate` — it scopes methods, not command
   types, so a gate command routed through it would be reachable by every operator. Gate writes
   now travel their own RPC method with its own row in that same map.
3. **My `t3-project-map.ts` would have been dead code.** `thread-backend.ts:442-450` already
   resolves projects by `canonicalWorkspaceKey` and `:785-818` creates them, inside
   `ensureThreadBackendReady`. Phase 6 extends that path instead. Also noted: `project.create` is
   not idempotent (`:382`), so the existing single-flight guard is load-bearing.
4. **Persistence work named too few modules.** All four codex named exist and are now in phases 2
   and 4, with the start-up layer order asserted by a test rather than left to construction order.
5. **SSRF.** A server proxy forwarding to a browser-named origin is an SSRF primitive, and a
   route-path allowlist does not constrain the host. Target is now chosen from a server-held
   allowlist by id; absolute URLs refused, redirects not followed.

## My own finding: the CSP claim was false

Chasing codex's proxy finding I checked the CSP the plan and the spec both lean on. t3code sets
`Content-Security-Policy` on `.svg` asset responses only (`apps/server/src/http.ts:51,62`,
`default-src 'none'; style-src 'unsafe-inline'; sandbox`), and `apps/web/index.html` carries no
CSP meta tag. There is no page-level CSP and therefore no `connect-src` to "keep closed" — both
the spec's Security section and my plan asserted a header that is never sent.

The same-origin design is unchanged and still right; the guarantee is structural, not enforced.
The test now records every request the page makes under Playwright instead of parsing a header.
Adding a page-level CSP is recorded as a follow-up, explicitly not done: it changes how every
t3code page loads, far wider than the spec's "keep the diff narrow" constraint.

## My own finding: three phases planned tests with a tool the fork does not have

Phases 7, 8 and 9 all said "verified under Playwright". t3code has no `playwright` in any
`package.json`, and `apps/web`'s entire test script is
`vp test run --passWithNoTests --project unit` with `@effect/vitest` as its only test dependency.
Criteria 5 and 5b are browser measurements — pane bounding boxes in CSS px, computed font size —
so a vitest unit test cannot close them; it proves the arithmetic in `columnsFor`, not that the
rendered pane is 340px wide inside t3code's chrome.

Resolved by putting the harness in **this** repository, which already has
`@playwright/test ^1.58.0` in `packages/codev`, `apps/client`, `apps/v2` and
`packages/artifact-canvas`, driving the fork's dev server over HTTP. Two reasons in order: it
keeps the fork diff narrow, which the spec names as its unmergeability mitigation, and the
criteria are Codev's so the tests that close them belong in Codev's CI.

Cost recorded: those tests need a running fork, so they are gated, and a skip is reported as a
skip rather than counted as a pass.

## The opencode lane: my diagnosis was wrong, and so was my evidence

Correcting the record rather than leaving it. I reported five runs "exiting 0 with no verdict" and
the architect filed #261 on that framing.

**Every one of those runs was `consult ... 2>&1 | tail -15`.** In a pipeline the reported exit
code is the *last* command's, so "exit code 0" was always `tail`'s. Run clean, with stdout and
stderr redirected to files instead of piped, the same command returns **exit code 1**.

So the lane was hard-failing loudly the whole time, exactly as designed — its own docs say missing
CLI, unknown model, non-zero exit and empty output all throw (`commands/consult/index.ts:1693`,
and #20 records why: porch counts a lane that produced nothing as an approval). The silent-lane
story was an artifact of how I invoked it.

The real cause is in the stderr I had been discarding:
`permission requested: external_directory (/Users/chris/dev/t3code/*); auto-rejecting`.

Also corrected: **porch does not invoke consult.** `porch next 250` emits a task whose text is
"Run: consult -m opencode ..." and I execute it — porch is a pure planner. So the "porch spawns
the child without your env var" theory describes a mechanism that does not exist here, and
exporting the variable before `porch next` changed nothing (verified: porch re-issued the
identical task).

What remains real: `runOpencodeConsultation` sets `OPENCODE_PERMISSION` unconditionally at
`index.ts:1806` — `{...process.env, OPENCODE_PERMISSION: JSON.stringify(OPENCODE_READ_ONLY_PERMISSION)}`
— and `OPENCODE_READ_ONLY_PERMISSION` (`:1647`) covers only `edit`, `write`, `patch` and `bash`.
`external_directory` is not in it, so it falls back to opencode's default of ask, which
auto-rejects when non-interactive. Any review whose subject lives outside the workspace loses this
lane. That is the genuine #261, and it is narrower than what I first reported.

`process.env` is spread first, so `OPENCODE_CONFIG_CONTENT` does reach the child — which is why my
run 3 read external files successfully. Why run 3 still produced no file is the open question the
clean re-run is answering now.

## Plan review round 1 — opencode lane, REQUEST_CHANGES

The lane finally ran once I stopped piping it through `tail` and kept the permission grant: 298s,
full review, exit 0. Keeping codex as well gave three reviews instead of two, and that paid for
itself immediately — opencode found a hole in the fix I had just made for codex's finding.

Codex said `codev:gate-write` could not be enforced on `dispatchCommand`, so I moved gate writes to
their own RPC method. Opencode pointed out that a scope-map row alone does not compile:
`RpcAuthorization.ts:130` is `satisfies Record<WsRpcMethod, AuthEnvironmentScope>`, and
`WsRpcMethod` derives from `WsRpcGroup` in `packages/contracts/src/rpc.ts` — which pin.json
**deliberately excludes** from the vendored closure. So the method needs registering in four
places, and phase 4 now names all of them.

**The most damaging finding in either round:** `acquire()` does
`gitIn(t3Root, 'checkout', '--detach', pin.commit)` at `t3-server.mjs:94`, against `T3CODE_ROOT` —
the read-only upstream clone. Once phase 5 moves `pin.commit` to the fork head, that checks a fork
SHA out into the clone the spec keeps pinned at `upstreamBase`, and `start` (`:389`) and `status`
(`:663`) compare the same way. `smoke.mjs:156` and `live/integration.mjs:196` both call `acquire`,
so it fires from an ordinary test run rather than a deliberate invocation. I had rewired only
`verify`. Phase 1 now rewires `acquire`, `start` and `status` too.

Also: gate commands must stay out of `ClientOrchestrationCommand` /
`DispatchableClientOrchestrationCommand` (`orchestration.ts:935-987`) — those unions *are* the
`dispatchCommand` payload, so including them would hand gate-writing to every
`orchestration:operate` holder and bypass the new scope entirely. `ThreadSessionSetCommand` is the
internal-only precedent. And `generate.mjs:335` walks `pin.methods`, not `OrchestrationRpcSchemas`,
so the new method must be listed in `pin.json` or it is never vendored — the `vcs.*` entries are
there for exactly this reason.

## plan-approval gate reached

`porch done 250` passed all three checks and stopped at `plan-approval`. Structured gate request
recorded via `porch gate 250 --request-file`, architect notified.

Round 1 ran three lanes — claude, codex, opencode — all `REQUEST_CHANGES`, all findings accepted.
Nothing in the disagree column, which is unusual and worth noting: two of the findings were errors
of mine that would have caused real damage, and opencode found a hole in the fix I had just made
for codex's finding. That is the case for three lanes rather than porch's two.

Waiting on the human decision. The one item I flagged for a look before phase 1 starts is
`gh repo fork pingdotgg/t3code` — a public fork under `pseudoseed`, outward-facing and not quietly
undoable. The gate request offers the architect the option of creating it themselves instead.

Commits this phase:
- `2882b2eb2` initial plan, 11 phases
- `6c1d5d870` claude round
- `8d25ac891` schema guard grounded in upstream's idiom
- `245296d5e` codex round + architect ruling, spec risk row amended
- `abf5f3d6a` browser harness moved out of the fork
- `987c5a416` porch-level lane note
- `46285ad8c` opencode round
- rebuttals committed separately

## Architect ruling — private repo, not a GitHub fork

2026-08-30, at the plan-approval gate. My phase 1 said `gh repo fork pingdotgg/t3code`, which was
wrong in a way I had flagged as merely "outward-facing" rather than as contradicting the spec.

**A GitHub fork inherits the source repository's visibility.** There is no private fork of a
public repo, so forking would have published every customization to anyone looking, t3code's
authors included — the exact opposite of this spec's "private customization" ruling.

Amended: `gh repo create pseudoseed/t3code --private`, with `origin` as the private repo and
`upstream` as `pingdotgg/t3code`. Rebasing works identically, which is the only capability the
plan actually needs. `gh repo fork` is recorded as a prohibition rather than a preference: it is
one command, and deleting the repo afterwards does not un-publish something that was indexable.

Verified rather than assumed: t3code is MIT, `Copyright (c) 2026 T3 Tools Inc.`, so the private
copy keeps the licence and attribution intact. Phase 1 has a deliverable checking it, plus one
asserting the created repo's visibility instead of trusting the create command's exit code.

Also added a phase-1 deliverable asserting `/Users/chris/dev/t3code` is byte-identical at the end
of the phase — same HEAD, clean tree. Two of this round's worst findings were about something
writing into that clone by accident, so it is worth checking rather than intending.

The word "fork" is kept elsewhere in the plan and in `pin.json`'s field names, describing the git
relationship rather than GitHub's feature. Noted in the plan so it does not read as a
contradiction.

## plan-approval APPROVED — entering implement, phase 1

Architect approved and recorded the gate on 2026-08-30.

### Standing instruction for every phase, from the architect

**After each phase, answer: "what can a human see or do now that they could not before?"**

This is how spec 146 failed — thirteen phases of correct plumbing landed and nobody could see
anything, which is the reason this spec exists at all. When the honest answer is "nothing yet,
this is infrastructure", **say that in the phase report** rather than letting the phase count
stand in for progress.

**Phase 7 is the first phase that puts anything on a screen.** Phases 1-6 are all infrastructure:

| Phase | Visible to a human? |
|---|---|
| 1 vendoring harness | No — tooling only |
| 2 hierarchy columns | No — schema only |
| 3 write-time integrity | No — refusals on an API nobody calls yet |
| 4 gate block + scope | No — state nothing renders yet |
| 5 regenerated contract | No — vendored types |
| 6 porch-driver + codev-agent publish | Barely — data now exists in t3code's DB, still unrendered |
| **7 sidebar** | **Yes — the tree appears in t3code's web app** |

**If phases 1-6 start sprawling, tell the architect and reorder rather than discovering it at
phase 7.** That is an explicit instruction, not a suggestion.

### Where things stand entering phase 1

Nothing has been built yet. No repo created, no code written. Phase 1's first act is
`gh repo create pseudoseed/t3code --private` — never `gh repo fork`, see the plan's executive
summary for why the two are not interchangeable.

---

## Phase 1 — Two-identity vendoring harness

### What a human can see or do now that they could not before

**Nothing.** This is infrastructure, exactly as the table above predicts for phase 1. There is a
private repository that did not exist, and the tooling can now hold two checkouts without
confusing them. Nothing renders. Phase 7 is still the first phase that puts anything on a screen.

### What landed

`pseudoseed/t3code` created with `gh repo create --private` — **not** `gh repo fork`, because a
fork inherits the source repository's visibility and cannot be private off a public parent.
Asserted rather than inferred: `gh repo view` reports `visibility: PRIVATE`, `isFork: false`.
Branch `codev` at `082e6ea5`, checked out at `/Users/chris/dev/t3code-codev`, `origin` = the
private repo, `upstream` = `pingdotgg/t3code`. MIT `LICENSE` byte-identical to upstream's.

`/Users/chris/dev/t3code` is untouched: still on branch `main` at `082e6ea5`, clean tree. The
fork was cloned with `--no-hardlinks` so the two repositories share no object files at all.

New `tools/t3-fork/identities.mjs` holds the mapping once. Every tool asks it rather than
re-deriving `process.env.T3CODE_ROOT ?? '<literal path>'`, and a test asserts that — the "seven
readers" table is now executable rather than a paragraph.

### The destructive one, and how it is now tested

`acquire()` does `checkout --detach` against the upstream clone, and `smoke.mjs` and
`live/integration.mjs` both call it. On `pin.commit` it would have written a fork sha into the
read-only clone from an ordinary test run. `acquire`, `start` and `status` are now pinned to
`upstreamBase`; `verify` is the only verb that knows about both.

The test for it does not read the source. It builds a throwaway repo with two commits, points
`upstreamBase` at the earlier one and `commit` at the later one, runs `acquire`, and asserts
which sha the tree landed on.

### T3_PIN_FILE

New env override on `t3-server.mjs`. "Fork is dirty at its pin" and "the fork's merge-base is not
`upstreamBase`" are only reachable with checkouts sitting on the pinned shas, and no test can make
a throwaway repository produce t3code's shas. The alternative was asserting those paths by reading
the source, which proves nothing about what the process does.

### Two things the fixtures taught

Two git repos built from identical bytes, message and a fixed author identity in the same second
produce the **same commit sha**. The "unrelated histories" fixture shared a commit with the tree
it was supposed to be unrelated to, so it exited 0 where 3 was expected. `makeRepo` now writes
unique content per repository.

A fork that *lacks* the base commit and a fork that has it but no longer descends from it are two
different answers: `3` (NO_FORK_MERGE_BASE) and `1` (FORK_BASE_MISMATCH). Both are tested.

### Port 3799 was held by someone else

A `t3 serve` from the main checkout (`--base-dir /Users/chris/dev/codev-1455`, started 13:58) held
3799, so the first evidence run failed with `EADDRINUSE` reported as "no pairing token". Not killed
— it is not this session's. The cold-start evidence was re-collected on `T3_HARNESS_PORT=3811`.

### Deferred / notes for later phases

- `source-hash.json` now has an `upstream` section and a `forkDrift` block. Both read as
  "not yet diverged" because the fork head equals `upstreamBase`. Phase 5 is where they start
  carrying information.
- `classify-churn --upstream-movement` reports 3 closure commits between `upstreamBase` and
  `origin/main`. Upstream has moved; that is a phase-5 decision, not a phase-1 one.
