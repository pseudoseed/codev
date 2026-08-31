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

### Phase 1, review round 1

claude APPROVE; opencode/grok REQUEST_CHANGES with two real findings, both accepted.

**`ready()` re-imposed the fork requirement one call after `start()` dropped it.** `start` was
upstream-only on purpose, then `smoke.mjs` runs `acquire, verify, start, ready` and `ready` called
the both-identity `verify`. On phase 2's first fork commit — `pin.commit` does not move until
phase 5 — a correct upstream server would have failed `ready` with `CHECKOUT_MOVED_DURING_RUN`,
a signal about a checkout the server never touches. Added `verify-upstream` / `verify-fork`;
`ready`, `smoke.mjs` and `live/integration.mjs` use the upstream one. Bare `verify` still asserts
both, which the acceptance criterion requires.

**`verifyCheckout` swallowed a failed `git status` and reported clean.** Inherited from spec 146,
including the comment that claimed it reported undetermined. Now exits 3 with `NO_<ID>_STATUS`.
Test triggers it for real: `chmod 000` on `.git/index` leaves `rev-parse HEAD` working and makes
`git status` exit 128, landing the failure exactly between the two checks.

**Open question for the architect, not resolved here:** phases 2-4 commit to the fork while
`pin.commit` stays at `upstreamBase`, so bare `verify` will report `FORK_CHECKOUT_MISMATCH` for
that whole window. That is the plan's sequencing. The per-identity verbs mean it no longer blocks
an upstream server start, but somebody has to decide whether `pin.commit` should advance with each
fork commit or stay put until phase 5.

**Consult lane note:** the opencode lane timed out at 360s on its first attempt and produced no
verdict (exit 1, loudly). `consult` has no timeout flag — `OPENCODE_TIMEOUT_MS` is hard-coded to
6 minutes at `packages/codev/src/commands/consult/index.ts:1561`. A plain retry completed.

### Architect ruling on `pin.commit`, implemented

**`pin.commit` stays at `upstreamBase` until phase 5.** It means "the vendored contract was
generated from this commit", and only regeneration moves it. Advancing it per fork commit would
make the file assert something false.

So `FORK_CHECKOUT_MISMATCH` through phases 2-4 is the truth. But a signal that fires for three
phases straight is one people learn to ignore, so the two cases are now spelled differently:

| `pin.contractSource` | Fork HEAD descends from `pin.commit` | Does not descend |
|---|---|---|
| `upstream` (phases 1-4) | `FORK_AHEAD_OF_CONTRACT`, exit 0 | `FORK_CHECKOUT_MISMATCH`, exit 1 |
| `fork` (phase 5 on) | `FORK_AHEAD_OF_CONTRACT`, exit 1 | `FORK_CHECKOUT_MISMATCH`, exit 1 |

Tolerated does not mean silent — it prints on every run.

A contract commit the fork repository does not contain is `NO_FORK_ANCESTRY`, exit 3. Whether
HEAD descends from a commit that is not there is not a question git can answer, and the old
blanket exit 1 was answering it anyway.

`pin.contractSource` is the switch. Phase 5 flips it to `"fork"`, and the plan now carries a
deliverable that the flip must be asserted by a test which fails if ahead still exits 0.

Plan edited at `codev/plans/250-*.md` phase 5 deliverables and acceptance criteria. 63 tests in
the spec 250 suite; `pnpm -w test` 7274 passed, 54 skipped, 0 failed.

---

## Phase 2 — Thread hierarchy in the fork's contract and projection

### What a human can see or do now that they could not before

**Nothing.** Schema and contract only, exactly as the phase table predicts. Two nullable columns
exist and nothing renders them. Phase 7 is still the first phase that puts anything on a screen.

### The plan's wiring premise was wrong

The plan said to sequence `CodevSchemaGuardLive` after `MigrationsLive` (`Migrations.ts:173`).
**`MigrationsLive` is exported and nothing builds it** — every reference in the tree is its own
definition or its own docstring. The real boot path is `persistence/Layers/Sqlite.ts`'s `setup`,
which calls `runMigrations()` directly and is what both `makeSqlitePersistenceLive` and
`SqlitePersistenceMemory` provide.

A guard hung off `MigrationsLive` would never have run in production, and a test that built
`MigrationsLive` itself would have passed anyway. The guard is called from `setup` instead, and
the ordering test reads that production file rather than a layer it assembles.

### Two spellings for the two fields, deliberately

`ThreadCreatedPayload` keeps `withDecodingDefault(null)`: the log is full of pre-fork payloads, a
rebuild replays every one, and the projector reads `payload.role` unconditionally, so that read
has to be total.

`OrchestrationThread` and `OrchestrationThreadShell` use `Schema.optional` instead, matching
`linkedPullRequest` — upstream's own newest field, optional so older cached snapshots decode. The
strict form cost **32 errors across 11 upstream test files**, which is the divergence this fork is
explicitly shaped to avoid. Every server read path normalizes `?? null`, so one spelling reaches
clients in practice. Final upstream test churn: 5 fixture edits in 3 files.

### Two bugs the architect's ruling exposed in phase 1 code

Both found by running the tools against a genuinely diverged fork for the first time.

1. **`classify-churn --fork-drift` measured `upstreamBase..pin.commit`.** Those were the same
   commit until the ruling froze `pin.commit`. After it, a fork with real customization commits
   reported **zero drift** — "I could not tell" spelled exactly like "nothing changed", on the one
   tool whose job is answering "what have we changed?". Now measures to `HEAD`, correct on both
   sides of phase 5.
2. **The first commit in any range was reported as `baseline`, never classified.** `git log
   from..to` excludes `from`, so with a single fork commit the mode returned a placeholder instead
   of a verdict. Now seeded from the range start. It immediately produced a real answer:
   `consumed-change-undecidable` — the phase-2 contract altered a union in
   `orchestration.subscribeThread`, which the classifier honestly refuses to decide. That is a
   genuine signal for phase 5.

### The fork live suite now skips, with a reason

`spec-146-t3-contract.test.ts`'s fork-hash suite compares generated artifacts against the fork
checkout, which is only valid while the checkout sits ON `pin.commit`. Through phases 2-4 it does
not. Gated on `FORK_AT_CONTRACT` and it names which of three cases it skipped for:

```
spec 250 [live: needs the fork checkout ON pin.commit — fork is at 1a414cee8409,
ahead of contract commit 082e6ea52186 (expected until phase 5 regenerates)]
```

It reopens by itself once phase 5 moves `pin.commit`, and a test asserts that.

### Flaky Tests

`apps/server/src/entrypoint.test.ts > matches through a symlinked entrypoint` fails in the fork.
**Pre-existing and unrelated**: `git diff 082e6ea5 -- entrypoint.ts entrypoint.test.ts` is empty,
the module imports only `node:fs` and `node:url`, and macOS resolves `/var` to `/private/var`.
Not skipped and not modified — touching upstream's test would be gratuitous divergence.

### Receipts

- Fork commit `1a414cee8409`, pushed to `origin/codev`.
- Fork typecheck green. contracts **291 passed**; server **2769 passed, 8 skipped**, 1 pre-existing
  failure above.
- Codev repo: build green, **7276 passed, 55 skipped, 0 failed**, plus 180 in the v2 suite.
- 66 tests in the spec 250 suite; 17 new fork tests across three new files.

### Phase 2, review round 1

claude REQUEST_CHANGES, opencode COMMENT. Both named the same two substitutions, independently.

**"Upstream migration still runs after the guard" was a raw `ALTER TABLE`.** That proves SQLite
accepts a column; it says nothing about whether the watermark let the *migrator* run one, which is
the whole question migration 900 got wrong. Now goes through `runMigrations({toMigrationInclusive:
41})` → guard → `runMigrations()`, upstream's own idiom.

**Criterion 8b was simulated.** "Killed partway through, still opens against the pre-fork server
binary" was tested in-process on an in-memory DB — no kill, no file, no pre-fork binary. Now real:
`tools/t3-fork/criterion-8b.mjs` starts the pinned t3@0.0.36, SIGKILLs a child after the first
ALTER, reopens the half-applied file with that same pre-fork binary, resumes with the fork's real
guard, and reopens again. Evidence at `codev/research/250-criterion-8b-evidence.json`, asserted by
7 tests including a not-older-than-source guard.

**This needed a new harness verb.** `restart` refuses when nothing is running; `start` wipes the
data dir. Neither could open a database the run did not just create, so criterion 8b was
*unprovable with the tools that existed* and nothing said so. Added `start --keep-data`.

Third finding, also fixed: `forkSkipReason` reported "ahead of contract commit" for any non-matching
fork head. Behind and unrelated now say so — otherwise a genuinely broken checkout hides inside the
tolerated case for three phases.

Fork commit `992b781f4314`. Codev repo: build green, 7283 passed, 55 skipped, 0 failed.

### Phase 2, review round 2 — both lanes APPROVE

opencode: no issues. claude: APPROVE with three non-blocking items, all real, all fixed.

1. **Nothing pinned the two `CODEV_SCHEMA_GUARD_*` signals.** They *are* the mitigation for staying
   out of the migration registry, and a rename or a merge into one line would have broken that deal
   while every other test stayed green. Now asserted: APPLIED fires naming the columns it added,
   NOOP fires on the next start, and neither ever fires alongside the other.
2. **`apply-codev-guard.ts` called `applyCodevSchemaGuard` while its docstring said
   `codevSchemaGuardStep`.** Fixed by making the code match the docstring, which is also the better
   half: the step is what production calls and it emits the signal, so the one test that runs the
   guard against a real file now exercises the logging path too.
3. **The 8b evidence recorded `forkRoot` but no fork commit.** A path is not a version. Added
   `forkCommit` — and the gap was live: the first regenerated evidence named `992b781f`, then a fork
   commit changed the guard and the evidence still described the older one. Added an assertion that
   the recorded commit equals the fork checkout's HEAD, skipping (not passing) when the fork is
   absent.

Fork `e1a858434a80`. Codev: build green, **7285 passed, 55 skipped, 0 failed**. 75 tests in the
spec 250 suite.

### Issue #199

Per the architect's displacement ruling the classify-churn lesson stays COLD. The three instances
from this project are filed on #199 as evidence instead — comment 5471612980 — with the argument
that criterion 8b is a rung below the current slot-4 wording: there was no check to answer wrongly,
because the harness had no verb that could host one, and an absence has no output to inspect.

---

## Phase 3 — Hierarchy integrity refused at write time

### What a human can see or do now that they could not before

**Nothing.** These are refusals on an API nobody calls yet, exactly as the phase table predicts.
Phase 7 is still the first phase that renders.

### The rule, and where it is enforced

One sentence: **the only legal edge is architect → builder.** Enforced in the decider, at write
time. Criterion 11 says "verified against the decider, not against the UI", and that is the point —
a rule enforced only where the tree is drawn is a rule the API does not have.

No fallback rendering. A reader that reparents an orphan, or draws a parentless builder at the
root, produces a second correct-looking answer, and then two places disagree about the tree with
nothing to say which is right.

### Six discriminants, not one error

`parent-not-found`, `parent-in-other-project`, `parent-is-self`, `parent-not-architect`,
`builder-without-parent`, `parent-on-non-builder`. A caller acts differently on each: "no such
parent" is a retry once the parent lands, "wrong parent role" is a caller bug, "builder without a
parent" is a missing field. One error for all of them says something is wrong and nothing about
what to do — and then gets matched on the message string, which is worse than no discriminant.

**Check order is load-bearing.** `parent-is-self` before `parent-not-found`, because a
self-reference is a caller bug whether or not the thread exists yet and "no such parent" would send
someone hunting a thread that is right in front of them. `parent-in-other-project` separate from
`parent-not-found` for the same reason: the parent *does* exist.

### The deliberate non-refusal

A parent archived or deleted afterwards is **not** retro-refused. Retro-refusal would make an
archive fail because of a thread it does not know about, and make archiving order-dependent. Those
children become orphans: still readable, still carrying the edge, pointing at an archived parent.
Two persistence tests assert an orphan stays distinguishable from a thread that never had a parent —
phase 7 needs that difference to put one in the unattributed group and leave the other alone.

Also accepted: creating a builder under an *already archived* architect. The rule is about the
edge's shape, not the parent's lifecycle; refusing would mean archiving silently changes which
commands are legal, which is a second rule nobody wrote down.

### A flaw in my own tooling, found the hard way

`criterion-8b.mjs` was documented as `> evidence.json`. A shell redirect **truncates the target the
instant the process starts**, so when the run crashed transiently it left an empty evidence file
where a passing one had been — and the suite then failed on a file that said nothing rather than on
the run that broke. I destroyed a good record that way.

Now `--out <path>`: the evidence is written once, at the end, and **only when the run passed**. A
failed run leaves the previous record untouched and reports the failure through its exit code and
stdout. Same shape as everything else this project keeps finding — a failure mode that reads
identically to a different, more alarming failure.

### Receipts

- Fork commit `e1b7f7b04af5`, pushed to `origin/codev`.
- Fork typecheck green; contracts **291 passed**; server **2788 passed, 8 skipped**, 1 pre-existing.
- Codev repo: build green, **7285 passed, 55 skipped, 0 failed**, plus 180 in the v2 suite.
- 15 decider tests, one per case, asserting the discriminant rather than the failure.

### Phase 3, review round 1 — the engine was deleting the deliverable

Both lanes REQUEST_CHANGES, both found the blocking bug independently.

`OrchestrationEngine` rewrote every `CodevHierarchyInvalidError` as a generic invariant error
reading **"Failed to generate an event identifier"** — false, not merely lossy — and persisted that
onto the rejected command receipt, which is replayed verbatim on redispatch. All six discriminants
existed only inside the decider. **The entire phase 3 deliverable was being deleted one layer above
where it was tested**, and all 15 decider tests stayed green because they call the decider directly.

Same shape as phase 2's `MigrationsLive`: testing the layer below the one production uses.

Added `OrchestrationEngine.codevHierarchy.test.ts`, which dispatches through the real engine.
**Verified to discriminate**: with the mapping reverted, 3 of its 4 tests fail. On this project that
check is no longer optional.

Two of my own tests asserted nothing, both caught by review:
- one built a `Set` of six string literals and asserted its size — proving six strings are six
  strings, while its name claimed to guard the discriminant collapse;
- one asserted on its own input fixture after an archive the decider never mutates.

Both replaced with assertions on real output. `commandInvariants.test.ts` gained the Codev cases the
plan listed, including both ordering decisions as tests.

Fork `40fb82ce92a8`. Fork typecheck green, server 2797 passed.

### Phase 3, review round 2 — both lanes APPROVE

opencode: none. claude: none blocking, two forward-looking notes.

**Acted on:** "discriminant survival across the ws/RPC boundary is untested — worth a phase-6
acceptance item given this spec has twice been caught testing below the layer production uses."
That is exactly right and it is now a phase 6 acceptance item with the reasoning attached, not a
note. `porch-driver` is the first real client; a discriminant that does not survive serialization
does not exist.

**Recorded, not changed:** `parent-not-architect` merges two of the plan's listed cases because
they share a reason — the parent is not an architect — with `detail` distinguishing them for a
human. Splitting now would invent a distinction no caller acts on; phase 7 can split it cheaply if
the UI needs different wording.

### Hot tier

`A test that cannot fail is not a test — revert the fix and confirm the test fails before trusting
it.` promoted, displacing the minimal-repro line, which was demoted to COLD rather than deleted.

The instruction's slot number and its quoted description pointed at different lines; I went by the
description, flagged the mismatch, and demoted rather than deleted so either reading was a one-line
fix. The architect confirmed the number came from a stale read of a pre-merge file.

Amendment applied: the *trigger* half ("when stuck after 2 failed hypotheses or ~30 min") is folded
into the consultation lesson, because a threshold only works if it is always-on — a stuck agent does
not go and read the cold file. Cap still 10, file still 30 lines. Skeleton got the addition only:
displacement is cap-driven and 3 against 10 is not at the cap.

---

## Phase 4 — Porch gate block with a server-allocated revision

### What a human can see or do now that they could not before

**Nothing.** State on a record nothing renders, written over an RPC nothing calls yet. Phase 7 is
still the first phase that puts anything on a screen.

### The one rule that made allocation and stale-rejection coexist

Review round 1 on the plan said these could not both be true as written, and it was right. Resolved
by making `revision` **optional on the command**:

| `revision` | Server |
|---|---|
| absent (normal) | allocate `gateRevision + 1`, apply, return it |
| present | apply only if it **exceeds** the mark; else `CODEV_GATE_REVISION_STALE` |

Equal is refused. Two writers that computed the same number are colliding, not agreeing.

The mark lives **on the thread, not inside the gate block**, and the *clear* raises it too. That is
the entire mechanism for criterion 10: the mark outlives the block it described, so a stale write
arriving after a human answered cannot resurrect the gate. Had it lived inside the block it would
have vanished with it.

### Why the gate needed its own RPC method

`RpcAuthorization` maps the **method**, not the command type: `dispatchCommand` as a whole is
`orchestration:operate`. A gate command routed through it would be reachable by every operator and
no row in the scope map could say otherwise. Four places, as the plan required. The commands are
deliberately **absent** from `ClientOrchestrationCommand` and
`DispatchableClientOrchestrationCommand`, which *are* the dispatchCommand payload.

`codev:gate-write` is in `AuthEnvironmentScope` and in **neither** `AuthStandardClientScopes` nor
`AuthAdministrativeScopes` nor the token allowlist. The scope tests are the exclusions, because
that is where the whole value is.

### The engine now returns its committed events

The gate's response must carry the revision allocated for **that** write. Re-reading the thread row
races a concurrent writer: both see the later value and one is told a number never allocated to it.
So `dispatch` returns `{ sequence, events }`. The idempotent replay path returns an **empty** array
honestly — it committed nothing this time, so there is nothing to read a revision from, and the
caller reports the write as unconfirmed rather than inventing one.

### Deviation: `gateRevision` is optional-in, required-out

The plan says non-nullable. Strict-required cost **159 errors across upstream test fixtures**,
which is the rebase debt phase 2 established we do not sign up for. So it is
`Schema.optional(NonNegativeInt).pipe(withDecodingDefault(0))`: optional on input, always a number
after decoding. The DB column is `INTEGER NOT NULL DEFAULT 0` and every read normalizes, so there
is still exactly one spelling of "no gate yet". **Flagged for the architect.**

### My own driver had the brittleness I keep finding in other people's code

`criterion-8b.mjs` hardcoded a two-element Codev column list. Phase 4 added two more columns and
the driver failed **while the criterion it tests still held** — the pre-fork server opened both the
half-applied and fully-applied databases exactly as before. Now derived from what the guard itself
reports: `present` is what the crash left, `added` is what the resume finished, and the assertions
are properties rather than counts.

The `--out` safeguard from phase 3 did its job: the failed run left the previous passing evidence
untouched.

### Interference worth knowing — and my first workaround for it was WRONG

Running `criterion-8b.mjs` before `npm test` produces spurious failures in unrelated suites.

I first recorded "run them sequentially" as the fix. **That is wrong and I have disproven it.**
Sequential runs fail too, and *which* tests fail changes every time:

| Run | Failures |
|---|---|
| 8b concurrent with the suite | 10 in consult/porch |
| 8b, then build, then suite — strictly sequential | 10 in the registry/reconciliation suite |
| 8b, then the suite — strictly sequential | 2 in `test-isolation.test.ts` |
| suite alone | **0** (7285 passed) |

Every one passes in isolation. **I do not know the mechanism and have not claimed one.** The leading
lead is a latent order/worker dependency in the suite itself — `MetricsDB.defaultPath` looks like it
is computed at module load — surfaced by the load 8b puts on the machine rather than by anything 8b
corrupts. Recorded on #263 as a correction, with both hypotheses marked as leads not findings.

**Operational rule:** a green suite run that immediately followed a harness run is not trustworthy.
Re-run the suite alone before believing either a pass or a failure.

### Receipts

- Fork `3a1780bbf66f` (wiring) and `57d24ddcb3be` (tests), pushed.
- Fork typecheck green; contracts **301 passed**; server **2815 passed, 8 skipped**, 1 pre-existing.
- Codev: build green, **7285 passed, 55 skipped, 0 failed**, plus 180 in the v2 suite.
- 29 new fork tests; 75 in the spec 250 suite here.

### Phase 4, review round 1 — the same function, the third time

Both lanes REQUEST_CHANGES; both independently found the blocking one.

**`isRefusal` was deleting gate refusals.** Phase 3 fixed that function for
`CodevHierarchyInvalidError`. Phase 4 added a third refusal type and I did not extend it, so every
gate refusal — including the stale write that IS criterion 10 — was rewritten as "Failed to generate
an event identifier". **Criterion 10 was false at the wire while all 11 decider tests stayed green.**
Third occurrence of the same mistake. A type-level exhaustiveness check would have caught all three.

**"Could not tell" shared a spelling with "no", on the routine path.** The unconfirmed branch was
labelled `CODEV_GATE_THREAD_NOT_FOUND`, and an idempotent replay of the same `commandId` lands there
*every time* — so a normal retry was reported as a nonexistent thread. Now
`CODEV_GATE_WRITE_UNCONFIRMED`, plus `CODEV_GATE_WRITE_FAILED` for database and decode errors that
were also being relabelled as a missing thread.

**Two declared reasons were never constructed.** `CODEV_GATE_SCOPE_REQUIRED` dropped — the transport's
`EnvironmentAuthorizationError` already names the scope. `CODEV_GATE_THREAD_NOT_FOUND` was raised as
the generic invariant error, making the RPC's declared error type a lie for its commonest failure;
found by *tightening a test*, not by reading.

**Best finding: no projector coverage.** Every decider test hand-builds its read model, so a
projector that dropped `gateRevision` would pass all 11 while every write after the first
re-allocated revision 1 — the exact failure the mechanism prevents, invisible to its own suite. Six
projector tests now; verified to fail when the mark is dropped.

**Third time this project caught me writing a test that cannot fail**: assertions inside
`if (events[0]?.type === ...)`, and a thread-not-found test asserting only that *something* failed.

Also done: OAuth allowlist exclusion asserted (the third place the scope must not appear),
and `codev/gateCredential.ts` names the issuance API and on-disk path of the single credential —
read + gate-write, deliberately not operate, scopes asserted as a set, token written 0600 by
temp-and-rename.

Fork `3d0e76776cd9`. Typecheck green, contracts 304, server 2832.

**New flaky observation:** `server.test.ts > routes websocket rpc server.upsertKeybinding` failed
once under the full parallel run, passes in isolation and on re-run. Same shared-resource class as
issue #263. Not fixed, recorded.

### The exhaustiveness check — ruled in, not deferred

The architect refused a follow-up issue: three occurrences of one mistake in one project is a
structural defect, and a follow-up is a promise to hit it a fourth time.

`isRefusal` was a hand-written disjunction over a structural union, so adding a member and
forgetting the predicate compiled cleanly. `dispatchErrorKind` now classifies **every** member of
`OrchestrationDispatchError` in a switch whose `default` assigns to `never`, and `isRefusal` reads
that classification rather than keeping a second list.

**Proven, not asserted**: a fourth member was added and the build refused it by name —
`error TS2322: Type 'ProbeUnclassifiedError' is not assignable to type 'never'` — then removed.

Runtime default is `internal`, the safe direction: a refusal misclassified as internal is a worse
message; an internal error misclassified as a refusal is a lie about whose fault it was.

Fork `570cc29dc63c`. Server 2835 passed.

### The four costumes, now one list in the review

Phases 2-4 produced the same defect four times, and the review carries them as a single table for
phase 6 to read first: a layer nothing builds, a layer something wraps, a decider tested without its
engine, a read model every test hand-builds. Each passed its own tests; each was found by review or
by a compiler.

One sentence: **a test that supplies the boundary itself cannot tell you the boundary exists.**
Phase 6 crosses the ws/RPC seam, which is costume five if a `porch-driver` test constructs its own
transport.

### Phase 4, review round 2 — costume five, one commit after writing the table

claude APPROVE, opencode REQUEST_CHANGES; same single substantive gap, treated as blocking because
the plan says the credential is provisioned *at server start*.

**The credential had no production caller.** `gateCredential.ts` named the scopes, named the path,
tested the write — and nothing in the server ran any of it. That is **costume one from this phase's
own review**, produced one commit after I wrote the four-costume table. Its own tests were green and
all of them were meaningless for the only question that mattered.

Knowing the pattern did not prevent it. Review caught it. What stops the recurrence is the test that
asserts the **call site** — `serverRuntimeStartup.ts` imports the provisioner and runs it as a named
phase — rather than asserting the module works. Verified to fail when the phase is removed.

Provisioning is non-fatal (a server that cannot write the token still serves every other client) and
idempotent by rotation rather than lookup (reusing a token would mean reading a bearer credential
back off disk; a server that reads tokens is a larger target than one that only writes them).

Second finding: the scope map **row** was asserted, the **enforcement** was not. A row nothing reads
documents an intention. Now asserts `ws.ts` routes through `requiredScopeForRpcMethod` on both the
effect and stream wrappers, and that an unmapped method throws rather than defaulting to permissive.

Fork `0254c84e1241`. Typecheck green, server 2839 passed.

Four regression tests in phase 4 verified by removing their mechanism: `isRefusal`, the projector's
mark, the wire decoding default, the startup provisioning.

### The antidote, promoted above the table

The architect's point: the review had the diagnosis five times and the remedy once, in passing. A
table of failure modes without its remedy becomes a talisman someone cites instead of checking.

**Assert the call site, not the module.** Every one of the five was caught by that move and would
have been prevented by it. The passing tests each asked whether the code *works*; none asked whether
production *reaches* it, and only the second was ever in doubt.

Also recorded: the architect explicitly agreed with three judgement calls rather than letting
silence stand for it — non-fatal provisioning, rotation over lookup, and declining the brittleness
finding. And that two lanes disagreeing on severity is not a tie to split: opencode's
REQUEST_CHANGES was right and treating it as blocking was right.

## Phase 4, iteration 3 — both lanes APPROVE, phase closed

opencode APPROVE with no key issues. claude APPROVE with three non-blocking findings. Fixed all
three in phase, per the standing ruling that structural fixes are never follow-ups.

The one that mattered: `OrchestrationRefusal` still hand-listed the same three tags that
`dispatchErrorKind` had just been made the owner of. That is the one-list-in-two-places shape the
exhaustive switch was installed to kill — **sitting one line below the switch**, in the same commit
that installed it. Classifying a fourth refusal without also editing the `Extract` would have left
the runtime correct and the type quietly wrong, which is worse than the original bug, because the
compile-time mechanism above it would have looked like it covered the case.

The general move, and it generalises past this file: **the fix for a list that must not drift is not
a better guard on the copy, it is to stop having a copy.** The switch is now a `DISPATCH_ERROR_KIND`
table under `as const satisfies { readonly [K in OrchestrationDispatchError["_tag"]]: ... }`.
Missing member → missing key; extra key → excess property; and the refusal *type* is derived from the
table's literal values, so there is no second place left to forget.

Verified both directions: deleting the `CodevGateWriteError` row gives TS2741 naming the tag;
flipping it to `"internal"` turns 2 engine tests red.

The other two: a doc comment on the wire type still documented `CODEV_GATE_SCOPE_REQUIRED`, dropped
back in iteration 1 — a contract disagreeing with itself, which a phase 6/8 consumer would have read
as current. And the exact-indentation source assertion is now a whitespace-tolerant regex, verified
to still fail on a bare registration and to survive a reformat.

Fork `51b55d4899e4`, pushed. Typecheck green; server 2839 passed / 8 skipped / 1 pre-existing
(entrypoint symlink, unmodified). 8b evidence regenerated at the new fork HEAD, `passed: true`,
upstream re-verified clean at `082e6ea52186`.

**What can a human see or do now that they could not before? Nothing yet.** Phases 1-6 are
infrastructure and phase 4 is no exception: the gate block, the revision high-water mark, the
isolated scope and the provisioned credential are all machinery with no rendered surface. Phase 7 is
the first that renders.

Porch has accepted phase 4 and moved to phase_5 iteration 1, opening with a context-refresh boundary.

---

## Phase 5 — the vendored contract, regenerated from the fork

The named input was one undecidable churn verdict. Running the classifier against the finished fork
found **three**, not one: `subscribeThread` at the phase 2 and phase 4 commits, and
`dispatchCommand` at the phase 3 commit. All the same class, so all three were decided.

Deciding them means the step the classifier declines to take: match union members by their
discriminant literal and compare the matched pairs. Over `upstreamBase..51b55d4899e4` that gives ten
findings, no removals, no narrowed types, no newly-required properties, no lost enum members, no
tightened `additionalProperties`. Nine are non-breaking under the classifier's own stated rules.

**The tenth is not.** Two alternatives were added to the `OrchestrationEvent` union —
`codev.gate-set` and `codev.gate-cleared` — and on an *output* a new alternative is a shape the
client must now handle. A client shape-checking the stream against the pre-regeneration contract
does not ignore a gate-set frame, it *rejects* it: the frame matches no member of the union that
client knows. Phase 4 shipped the server half of gate writes into a repository whose vendored
contract could not decode the events they produce. Regenerating is the fix, not a formality that
follows it.

So: non-breaking in every respect but one, and that one breaks against the old contract and not the
new one. The test holds both halves, and the half that matters is the second — it rebuilds the
pre-regeneration union by removing the two alternatives and asserts the frame fails against it.
Without that, "the new contract accepts the frame" is a claim about nothing.

### Three things the phase found that the plan did not name

**`codev.gateWrite` nearly vendored as nothing.** The plan flagged that `generate.mjs` iterates
`pin.methods` rather than the RPC map, so an unlisted method is silently skipped — correct, and it
stopped one step short. The non-`OrchestrationRpcSchemas` branch resolved schema names from `git.ts`
and only `git.ts`, and `CodevGateWriteInput` lives in `orchestration.ts`. Adding the pin entry alone
would have failed generation. The branch now takes its module from `spec.source`; reverting that
makes generation say `pin.json names CodevGateWriteInput for codev.gateWrite, but git.ts does not
export it.` `classify-churn.mjs` had the same hardcoding and would have reported the method as
`<absent>` at every commit — "not in the contract" spelled identically to "this tool looked in the
wrong file".

**The checker threw on the payload it was vendored to check.** The round-trip test did not fail an
assertion, it raised `UnsupportedKeywordError: ... "minItems"`. Phase 4's one-to-five bound on gate
`choices` is the first schema in the closure to emit `minItems`/`maxItems`, and `shapeCheck` throws
rather than passing on a keyword it has not implemented. `checked.ts` would have thrown at the call
site on every gate-write payload. Implementing the two keywords is a strengthening — nothing that
passed now fails, nothing that failed now passes — so it does not touch the "shape-check is not
relaxed" deliverable. Caught by running the payload a caller would send through the production
checker, not by reading the schema.

**Re-scoping the cold-start evidence test was half a fix.** `smoke.mjs` still wrote `pinnedCommit:
pin.commit`, so the next collection would have recorded a fork sha as the provenance of an upstream
run. The field is renamed to `upstreamCommit` and reads `pin.upstreamBase`; the test asserts the old
key is *absent*, which is what stops evidence written under the old meaning being read under the
new. `collect-phase10-evidence.mjs` had the same expression.

### Deliverables

Pin at `51b55d4899e4`, `contractSource: "fork"`. Closure still nine files — checked in advance, the
import graph of the fork's `orchestration.ts` is byte-identical to upstream's. `source-hash.json`
carries both sections and `forkDrift.changedFiles` is `auth.ts, orchestration.ts`. Twelve patches
exported to `tools/t3-fork/patches/` with `--no-signature`, review aid only, and FORK.md says so
plus the four-step abandonment procedure. The fork-hash live suite reopened by itself and a test
outside the gate asserts it — a gate cannot assert that it opened.

Every new mechanism verified by reverting it: the two shape-check keywords (twice — dropped from
`SUPPORTED`, then supported but unchecked), `contractSource`, `pin.commit`, the `pin.methods` entry,
the generator's module map, and the evidence field rename.

**What can a human see or do now that they could not before? Nothing yet.** Still infrastructure.
What changed is that a `codev.gate-set` frame arriving on the stream now shape-checks instead of
being rejected as unrecognized. Phase 7 is the first that renders.

### Iteration 1 review: one finding, both lanes

claude REQUEST_CHANGES, opencode COMMENT, same line. `generated/schema.ts:2` still attributed a
fork-only commit to `pingdotgg/t3code`. I had corrected `ATTRIBUTION.md` and `types.d.ts` and
missed the third header, which was a standalone string elsewhere in the generator — and it is the
module that actually ships.

Fixed one level up: one `PROVENANCE` constant, every emitter reads it. The more useful half of the
finding was the test, which named two files by hand, so the artifact not on the list was the one
that drifted. Extending the list to three would have caught this instance and not the next. It now
reads the directory: every generated artifact naming the upstream repo must also name the fork and
the base, with a guard that it found artifacts at all. Reverting the header fails that test and
nothing else.

---

## Phase 6 — hierarchy and gate state published, and the hop that had never been crossed

Three things landed and one thing was found.

**Landed.** `porch-driver` sends `role` and `parentThreadId`, omitted rather than nulled when the
caller names no role, so an upstream server sees the same payload it always did. Two of the fork's
six hierarchy reasons need no projection to decide, so they are refused before the worktree is laid
down. `launchSpawnedBuilder` resolves the spawning architect's thread id once — three answers, and
the middle one is a thread-backed workspace whose architect runs on a terminal, which gets neither
field and says so. And the gate publisher: `status.yaml` projected onto the thread, on its own
socket with the `codev:gate-write` credential, sending no revision.

**Found.** The plan's acceptance criterion is a live round trip, and the harness could not run one:
`start` runs the published `t3@0.0.36` CLI against upstream, which has no `codev.*` anything. So
`start-fork` now runs the fork's `apps/server/src/bin.ts` directly, on its own port and runtime dir.

The first run failed on all four cases. Every refusal arrived as
`OrchestrationDispatchCommandError` with the reason inside `message`, as English. Phase 3 fixed the
engine deleting discriminants; the ws layer was flattening them one hop further out, and every test
beneath that hop was green. Third time this spec has produced that shape.

Fork `804e56f8f864`: `OrchestrationDispatchCommandError` gains an optional `refusal`,
`CodevHierarchyInvalidReason` moves into the contract because it travels, four wrapping sites lift
or forward it. The test that asserts those sites found two the first fix missed — one of them
rebuilds an existing error to add a field, and would have deleted the discriminant while adding it.

The second run also failed, and it is worth naming why: the script read `domain.reason`, a true
reading of the old server and the wrong one for the new. A test that was right about the world when
it was written, whose failure after the fix looks exactly like the fix not working.

Third run: four illegal edges, four distinct readable reasons, all carrying
`CodevHierarchyInvalidError`. Recorded in `codev/research/250-hierarchy-wire-evidence.json` behind
an mtime guard.

**Costs paid.** The fork moving meant `verify` reported `FORK_AHEAD_OF_CONTRACT` at exit 1 — phase
5's flip firing for a real reason one phase after it was armed — so the contract regenerated at the
new head. `OrchestrationDispatchRefusal` is vendored now, so porch-driver's copied reason list is
checked against `generated/schema.json` unconditionally instead of skipping without a fork checkout.
Both evidence files re-collected, again, because `t3-server.mjs` changed.

**One design note for phase 7.** The gate block's optional content is narrowed to fit the fork's
caps — question dropped over 500 chars, choices capped at 5, excerpt truncated tail-first — and
every drop is reported. `gateName` and `requestedAt` always travel. A renderer should not assume the
question is present, and should not read a truncated excerpt as complete; the marker says so inline.

Codev suite green: 7367 + 180 passed, 54 skipped, 0 failed. Fork suite 2845 passed, 8 skipped, 1
pre-existing (entrypoint symlink).

## Phase 7 — the sidebar draws the tree

First phase that renders. Two fork commits: the grouping as a pure function, then the call site
that orders the sidebar's active list by it and draws the nesting. A third commits the screenshots.

**The finding came from the compiler, before a caller existed.** Two assignments from
`SidebarThreadSummary` and `Thread` at the top of `hierarchy.test.ts` caught the module keying on
`threadId` (the command spelling; both read models say `id`) and an interface that `exactOptionalPropertyTypes`
rejects for every real thread. Neither throws. Both would have shipped as "the sidebar sees no
hierarchy", which reads as an empty workspace rather than as a bug.

**The section boundary was the design problem.** t3code splits a project into Pinned / Active /
Snoozed / Settled before grouping runs, so the tree is built over one list. A builder whose
architect is PINNED was reported `parent-missing` — a lie told to someone who can see the architect
three rows up. `alsoVisible` fixes it with `parent-elsewhere`; role still outranks section.
Reading that map with `get() !== undefined` was a second bug (a roleless thread's role IS
`undefined`) and its test caught it; verified by reverting to `get`.

**`orderedThreads` is the keyboard's order too.** Shift-range-select and jump hints read it, so the
tree's order and that list are derived from one thing. A reorder that left it alone would put every
row in the right place and send the keyboard to the wrong ones.

**Playwright against the real stack.** `packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts`
plus `playwright.spec250.config.ts`. Fixture restarts the fork server on empty data, seeds over the
wire, mints a pairing credential per browser context (the bootstrap token is single-use and `ready`
redacts it from the log after one read). The fork's Vite dev server is NOT started by the fixture —
an absent one is a skip carrying the command, never a pass. 7 tests: 4 behavioural, 3 per-viewport.
Falsified by forcing the no-hierarchy branch: eight rows still render, every hierarchy selector goes
to zero.

**Screenshots** committed to the fork at `docs/codev/spec-250/phase-7/`, 390 / 1440x900 / 1920, two
per width. Writing them is opt-in (`SPEC_250_WRITE_SCREENSHOTS=1`) because `start-fork` refuses a
dirty fork — a suite that wrote them every run passes once then skips forever. Measured, not
eyeballed: no horizontal overflow, titles >= 13px, zero console errors after pairing.

**No design reference exists for this tree.** Drawn in t3code's own idiom (its row cards, its
divider token for the rail, the Snoozed/Settled shelf shape for the orphan heading); nothing ported
from `apps/client`. Flagged to the architect for a ruling rather than assumed.

Pin moved twice this phase and finally to `e19e2560dd7a`; contract regenerated, 16 patches re-cut,
both evidence files re-collected at the final pin.

**Architect review of the first screenshots, three changes, one a criterion gap.** Criterion 1 is
three levels and the render had two — the project was only a caption repeated on all eight cards.
Now a heading with the project's own favicon; rows under it drop the label, rows outside keep it.
Architect rows are captioned "Architect" in the slot that label vacated (indent alone only works
while the test data is called "Architect beta"; real threads are `builder/spir-250`). Orphan group
moved from amber to Settled's muted treatment — an archived parent orphaning its builders is legal,
and amber says broken.

Worth naming: the suite was green and every criterion had an assertion, and a level of criterion 1
was still missing. The tests and the render were built from the same reading of the plan. The
screenshot is what exposed it.

Answered the architect's scheduling question: live per-row working/turning status is t3code's own
`resolveSidebarThreadStatus` and spec 250 does not touch it — rows read "now" because the fixture's
threads have never taken a turn. The blocked-on-a-named-gate half is phase 8. No gap.

Trap for later: the codev suite must run under the DEFAULT node, not the Node 22 the fork needs.
A run with Node 22 on PATH fails 724 tests on a better-sqlite3 ABI mismatch, which looks like a
regression and is not.

Pin ended at `48a9aa399e5d` after four fork commits this phase; contract regenerated, 18 patches,
both evidence files re-collected.

**3-way review (2 lanes this protocol): both APPROVE, HIGH.** No blocking issues. Four non-blocking
notes from the Claude lane, all four acted on: `data-codev-builder-count` now comes from
`entry.builderCount` rather than the render-side run scan (it could only ever agree with the scan
the test counts — the same shape as the five costumes); the Active-only scoping of the tree is
recorded in the review so phase 8 inherits it rather than rediscovering it; `test:e2e:spec250`
added to `packages/codev/package.json`; the `??` expression parenthesised. Rebuttals at
`codev/projects/250-t3code-is-the-front-end-privat/250-phase_7-iter1-rebuttals.md`.

Pin finished at `7c7096d49de9`, 19 patches, both evidence files re-collected. Codev suite green
(7370 + 180, 54 skipped, 0 failed) under node v20; fork web suite 2887 passed; 9 Playwright tests
green against the live fork.

**Appearance APPROVED by the architect**, both 1440 and 390 opened. Project heading, the
`Architect` marker, and the neutral orphan shelf all accepted. Explicit ruling to carry forward:
**builders get no positive marker** — an architect is labelled and an indented row under a rail
beneath a labelled architect is unambiguous. Do not add a second pill.

One non-blocking note, checked and **left alone**: the `(1)` on the unattributed heading. t3code has
no shelf-header count treatment to adopt — Snoozed and Settled inline their counts in the label's own
colour (`Snoozed (3)` in blue, `Settled (12)` in `text-muted-foreground/50`), and `ui/badge.tsx` is
not used by any shelf header. The count already carries `text-secondary-label` against the label's
`text-muted-foreground/50`, which is the only emphasis t3code's own tokens offer at that level
without inventing a badge. The architect's rule was "use t3code's treatment if one exists, leave it
if not, do not invent" — so it stays.

## Phase 8 — the gate panel

`apps/web/src/codev/gateState.ts` (pure, three states) and `GatePanel.tsx` (t3code's `Alert` in the
`info` variant, above the composer, NOT in `ComposerBannerStack` — that stack shows one banner at a
time behind a cap and a gate is neither dismissible nor small). Sidebar marker is its own element in
rose, outside the status slot so it survives a hover.

**The finding: a gate must be written by the credential that writes gates.** A bootstrap exchange
asking for `codev:gate-write` is refused `invalid_scope` — phase 4 holding. The fixture reads
`<serverBaseDir>/codev/gate-writer.token` and opens its own connection, which is what
`thread-backend.ts` does in production.

**Second finding: the screenshot trap has a two-file version.** Phase 7's opt-in flag was not
enough — with two spec files the first writes PNGs into the fork and the second SKIPS in the same
run, correctly. Screenshots now write to `SPEC_250_SCREENSHOT_DIR` (outside the fork) and are
copied in. Phase 7's pictures were re-shot in the same commit because two builders now carry gates.

Falsified: collapsing `pending-unstructured` into `none`, and rendering the question with
`dangerouslySetInnerHTML`, each fail 8 tests.

17 Playwright tests green (8 gate + 9 hierarchy) at that point; 18 after the gated-architect test.
Pin at `39204a7ac368` then, `efadf838c414` finally.

**Architect review of the phase 8 screenshots.** Heading "Waiting on you: <gate>" approved and kept
— it leads with the required ACTION rather than describing a state, which is the difference between
a gate and a status. Sidebar and panel wording deliberately differ (scan vs summon); do not
reconcile them. Two changes: the terminal excerpt gained a caption, and the row marker became a
gavel plus the gate name after both `Gate: <name>` placements clipped something at ~230px (line
above the title clipped the role caption to "A…"; the title line clipped the title). One clip left
deliberately: a 15-char gate name on a gated architect shows "Archit…", with the gate name and the
title intact.

Pin at `efadf838c414`, 25 patches, both evidence files re-collected.


**3-way review (2 lanes): both APPROVE, HIGH.** opencode raised nothing. Claude raised one item and
it was the LOG rather than the code: the fork web suite number was stated against a source, not a
commit, and three commits landed after it. Re-run at `efadf838c414`: typecheck 0, **2916 passed**.
Codev suite at the same pin: 7370 + 180, 54 skipped, 0 failed.

**Two operational findings this phase, both worth carrying.**

1. **`git push` hangs in a non-interactive session on this machine.** `porch done` sat 28 minutes
   with build and tests already green; its child `git push` was blocked in
   `git credential-osxkeychain get`, which waits on a prompt nothing here can answer. Reads are
   fine (`git ls-remote` is instant), so it is the write path only. Workaround, no config on disk:
   `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='!gh auth git-credential'`
   in front of any command that pushes. Do NOT `git config --local` in a worktree — that writes the
   shared config and hits the main checkout and every other builder. A global fix is Chris's call.
2. **The exported patches were 14MB**, four of them base64 PNG screenshots rewritten on every
   re-shoot. Architect ruled: exclude `docs/codev` from the export. Now 504KB / 21 patches; the four
   screenshot-only commits produce none, and `FORK.md`'s phase log is the complete commit list.
   `format-patch -o` also takes an ABSOLUTE path — a relative one writes into the fork checkout.

## Phase 9 — builder tiling

Geometry ported from `apps/client/src/responsive/layout.ts` and **re-measured**. The one change that
matters: every function takes the AVAILABLE width, not the viewport, and the grid measures its own
container with a `ResizeObserver` (a window listener misses a collapsed sidebar, which changes the
space without changing the window). 1176px at 1440, not 1404. Three columns fit either way — so
**criterion 5 would have passed on the viewport version by luck**, and criterion 5b is the one that
catches it. `PAGE_PADDING` 18 → 12, `GRID_GAP` stays 12; both recorded with the measurement.

Route is `_chat/codev-builders`, a child of the chat shell on purpose — the criteria are about how
many panes fit BESIDE the sidebar.

**Architect ruling that changed the work:** my option set (add a contract field / subscribe per pane
/ ship without) was wrong on all three. `codev-agent` ALREADY publishes the porch phase and the last
three messages, workspace-scoped, one request for the whole grid —
`GET /api/agent/v1/workspaces/<b64>/state`. That is where apps/client reads them. Pane content lands
with **phase 10** over the same-origin proxy. **Do not extend the fork's contract for it.**

And the wording: "Phase not published" was FALSE. It is published; this page cannot reach it yet.
Now reads "Phase not read here yet — published by codev-agent".

**Two defects the screenshots caught and the tests did not:** pane text was 12px (`text-xs` is right
for a sidebar row, wrong for a scanned tile; raised rather than narrowing the assertion), and at 390
the shell's floating sidebar toggle sat on the first pane's title (route has a header now).

24 Playwright tests green across three specs. Rendered columns are counted from the browser's x/y
positions AND from `data-codev-grid-columns` — the attribute alone would be the component confirming
its own arithmetic, which is the phase 7 builder-count defect.

One combined run failed once at 12px immediately after the `text-[13px]` edit — Vite had not served
the new CSS yet. Green twice since on a settled server. Not a code defect and not skipped.

Pin at `2529a40421d1`, 24 patches (552K), both evidence files re-collected.

**Criterion 4b restored, at the architect's direction, after the first 1440 screenshot.** Spec 250
restated 5 and 5b and dropped 4b; the screenshot showed exactly what 4b prevents — six builders plus
an architect at three columns is 3+3+1. Architect now takes a persistent strip below the grid that
expands to a full pane; an equal tile only where FOUR COLUMNS FIT.

**Stated as columns, not as "1920 or wider", and the architect approved the departure before I
built it.** apps/client's viewport number is right there because that client owns the viewport;
here 1920 of viewport is 1688 of grid, and a viewport threshold would offer the tile with the
sidebar dragged wide enough that only three columns fit. Four columns IS the reason: 7 items at 4
columns is 4+3. Keyed on width alone, never the builder count — asserted as its own test, because a
count-based rule reflows the layout under a reader who did nothing. Spec 146's wording is unchanged;
apps/client is frozen and still owns its viewport. The plan now carries 4b as a criterion.

Header counts agents not tiles: "6 builders and an architect". With more than one architect there is
no "the" architect, so they all take tiles and no strip appears.

Architect will NOT rule on pane internals until phase 10 puts real content in them — every pane is
placeholder right now and that is not something to approve on.

Pin at `b97ef30dea2b`, 25 patches, both evidence files re-collected. 7 tiling tests green.

**Architect condition on multi-architect mode, and it found a real exposure.** With every architect
taking a tile there is no strip, no indent and no rail — the `architect/` prefix is the entire
distinction — and it lived inside the truncating span, so a long title would eat it. Prefix and
title are separate elements now; the prefix does not shrink and the title gives way.

The check measures `scrollWidth` vs `clientWidth`, NOT text: `text-overflow: ellipsis` is invisible
to a text assertion because the DOM keeps the whole string, so `toContainText("builder/")` passes on
`buil…`. And the test could not have failed as first written — six short fixture titles never fill a
pane. One fixture builder is long now; reverting the fix clips that pane's prefix by 22px.

26 e2e green. Pin at `aeebd7f2b9c2`, 26 patches, both evidence files re-collected.


**3-way review (2 lanes): Claude APPROVE/HIGH, opencode COMMENT/HIGH.** Stricter is binding; all
seven points acted on. The important one: **the grid had no in-app entry point** — the route existed,
nothing linked to it, and my own e2e `page.goto`'d the path, which proves a route renders and says
nothing about whether a user can reach it. Sidebar has a Builders link now (gated on
`hasCodevHierarchy`) and the e2e clicks it.

Second real defect: **the width was measured two ways** — `getBoundingClientRect` (border box) on
mount vs `contentRect` (padding removed) from the observer, then `contentWidth` subtracting padding
again. Named viewports still landed on 3 and 4 columns, which is what made it dangerous. Padding
moved to an inner wrapper.

Also: orphans now tile (phase 7's reasoning, missed a phase later); `data-codev-architect-placement`
no longer says "strip" on a page with no architect; the header counts architects in the
multi-architect case; `--codev-pane-body` is actually consumed; one grouping pass instead of two.

**The sidebar is 256px, not the 232 my comments claimed.** Conclusions unchanged (1184 → 3 columns,
1664 → 4), but the unit tests used invented numbers. Now measured — and 1440 with the sidebar
COLLAPSED fits four columns, so the architect gets a tile there. That is the rule working.

Rebuttals at `codev/projects/250-t3code-is-the-front-end-privat/250-phase_9-iter1-rebuttals.md`.
Pin at `8d4b878f3137`, 27 patches. 26 e2e green, fork web 2938.

## Phase 10 — approval from t3code over the same-origin proxy

The proxy is `apps/server/src/codev/agentProxy.ts`, at `/api/codev/agent/<target-id>/<agent-path>`.
**Its upstream is server-configured** (`T3CODE_CODEV_AGENT_ORIGINS`, `id=origin` entries) and the
browser selects by **id**, never by URL — the plan's own most consequential item, because a proxy
forwarding to a browser-named origin is an SSRF primitive and a route-path allowlist does not
constrain the host.

**The forward set is an allowlist, not a denylist**, and `Connection`'s own named tokens are
subtracted from it anyway. Both matter: an allowlist alone forwards a header a request declares
connection-scoped, and that header is the machine credential. `authorization` and `cookie` never
travel — t3code's session gates USE of the proxy and is not approval authority.

Deliberately not carried: the SSE stream (this proxy buffers), and both revocation routes (`afx
pair revoke` is the operator path; a browser that could revoke could deny a human their gate).
A 3xx from the configured origin is **refused**, not passed on — forwarded, the browser follows it
cross-origin.

**Pane content landed here too**, per the architect's ruling: `codev-agent` already published the
porch phase and the last three messages workspace-scoped in one request, and the panes now read it.
The fork's contract was not extended. Phase 9's "not read here yet" wording is gone; every branch
that still cannot show a phase names which — unpaired, unavailable, absent, or no porch project.

**Three defects the browser caught and no unit test could.**

1. **The page read the agent store once and froze.** Pairing succeeded, the credential reached
   browser storage, the poll ran — and the panel still said this browser holds no credential. The
   hand-rolled `useState` tick pushed from a listener set never followed the store.
   `useSyncExternalStore` with a replaced (never mutated) snapshot. This cost the most time in the
   phase and every unit test was green throughout.
2. **A gated pane dropped the phase it had just gained** — the gate replaced the phase line, which
   was right when there was no phase and wrong the moment one existed.
3. **`Send a message to start the conversation.` printed across `Waiting on you: <gate>`** on a
   thread with no turns. Present since **phase 8**; the phase 8 panel-only screenshot could not show
   it and the full-page one did, unnoticed. Hidden through upstream's own `hideEmptyPlaceholder`,
   which is also the honest fix: a thread at a gate is not waiting for a message.

**Tests.** Fork: 28 `agentProxy` unit tests (real sockets for both failure signals and for the
redirect refusal), 43 web unit tests across `pairing`/`approval`/`agentState`. Codev: a 7-test
vitest e2e driving the REAL fork server's proxy in front of a real `agent-routes` host, ending in a
real `status.yaml` — criterion 4 — plus the SSRF refusals and `afx pair revoke`. Playwright: 6 tests
against the live web app, recording **every request the page issues** and asserting each is
same-origin, which is what replaces the CSP assertion the plan's first draft proposed against a
header t3code does not send.

**Falsifiability.** Reverting the `Connection`-token subtraction, the header allowlist, the redirect
refusal, the credentials-in-URL rule and the anchored route pattern fails 5 unit tests. Pointing the
configured allowlist at a dead port fails 4 of the 7 e2e tests, which is what proves the ceremony
goes through the configured proxy and nothing else.

**Traps.** The Playwright run needs the DEFAULT node (v20): `better-sqlite3` is built for it, and
the agent host is in-process. That collides with `@cluesmith/t3-client`'s need for a global
`WebSocket`, so the fixture polyfills from `ws` when the global is absent. And `start-fork` refuses
a dirty fork, so the fork cannot be instrumented for a browser debugging session — the store bug had
to be found by elimination and fixed by using the right primitive.

Pin at `e0476d49aec1`, 31 patches. Both evidence files re-collected at the pin.

**Filed #264 while phase 10's suites ran — a SAFETY defect, not noise.** The builder received
"Gate pr approved — please run `porch next` to advance." for a gate nobody approved in this project.
`porch approve` sends the bare PROJECT ID as the `afx send` target (`porch/index.ts:1267`); the
workspace is taken from the SENDING process's cwd (`send.ts:96-113`); the agent is then TAIL-matched
against builder ids with leading zeros stripped (`tower-messages.ts:387-392`, `:510-511`). So `250`
from a Playwright fixture's temp workspace addressed `spir-250` in this one. Neither hop carries the
identity of the workspace whose `status.yaml` was written.

Porch state was unchanged — verified twice, and `porch next 250` still returned phase_10. The
correct response on receipt is to verify against porch and refuse to advance; #264 records that as
the mitigation as well as the defect. `notifyTerminal` no-ops under vitest (`notify.ts:62`), which
is why the sibling vitest e2e performs the same approval silently and only the Playwright run fires
it. **Not fixed here** — it is porch/tower, and folding it in would put an unrelated change in a
fork PR.

**Phase 10 review: Claude APPROVE/HIGH, opencode REQUEST_CHANGES/HIGH.** Stricter binding; every
finding accepted, nothing in a disagree column. Rebuttals at
`codev/projects/250-t3code-is-the-front-end-privat/250-phase_10-iter1-rebuttals.md`.

**The binding one is the most useful finding in the whole spec so far.** My vitest e2e's
availability guard logged a warning and RETURNED — which vitest records as a **pass**. On a run
where the fork server never started, criterion 4 and every SSRF refusal reported green with zero
assertions executed. This project keeps catching "I could not tell" spelled as "no"; that is the
same defect spelled as **"yes"**, on the phase's own acceptance criterion. The file's header stated
the rule ("Skips, never passes") and the code broke it — a header is not a mechanism. It was
invisible to me because every run I did had the fork up. `ctx.skip` now, and demonstrated rather
than asserted: `T3_NODE` unset gives **8 skipped** where it used to give **8 passed**.

Two more, both fixed. `UPSTREAM_TIMEOUT_MS` is an **idle-socket** timeout and the comment claimed
it bounded the whole exchange — the same class of error as the `connect-src` claim this phase
existed to correct; the comment now states the residual (a trickling upstream is not bounded, and
that upstream is one the operator named). And `data-codev-approval-state` collapsed `sessionEnded`
into `refused`, which **both lanes found independently**; four outcomes, four words, in an exported
pure function so the attribute and the rendering cannot drift.

One I found myself between the lanes: the proxy buffered request bodies with **no bound** — Effect's
`MaxBodySize` defaults to unbounded. Capped at 64 KiB, declared oversize refused before the read.
Verified by running the same test against the fork commit before the fix: fails there, passes now,
with no fork history touched.

Pin at `3786b840e1a4`, 33 patches. Fork web 2984, fork server 198, 32/32 Playwright across all four
spec-250 specs, e2e 8 passed. Both branches pushed.

**Phase 10 CLOSED after iteration 2: Claude COMMENT/HIGH, opencode APPROVE/HIGH with no issues.**
opencode verified the iteration-1 fixes in the code rather than in my rebuttals — `ctx.skip` typed
`never`, the idle-timeout wording, four-to-four attribute mapping, and the proxy registered in
`server.ts` beside the targets route (the wiring, not just the module).

Iteration 2's one finding, and it is the same family as iteration 1's one layer in. Iteration 1 was
a test that **could not run** and reported a pass. Iteration 2 was a test that **could run and
could not fail**: `url.startsWith(origin)` is a prefix match, `webAppUrl()` defaults to a fixed
`http://localhost:5733`, and the agent host binds an ephemeral port — so ports 57330-57339 (ten,
inside macOS's ephemeral range, ~0.06% of runs) would have had a genuinely direct browser-to-agent
request counted as same-origin, and the phase's central security assertion would have passed anyway.

A rare false pass is worse than a common one: it makes the test look reliable while it is not, and
0.06% is the rate at which nobody ever sees it fail.

The durable half of the fix is not the comparison — it is that the predicate **moved out of the
Playwright spec into its own module so it could be tested at all.** The function deciding whether a
security claim passed was the one piece of the suite with no test of its own, which is how it stayed
wrong. Five unit tests now, in the default suite; restoring the prefix match fails three of them.
Non-http schemes are exempt as a CLASS (`data:`, `blob:`, `about:`), because naming `blob:` beside
`data:` would have left `about:` to break a later run.

**Phase 11 groundwork, done during phase 10's review waits.** Architect ruled the rebase drill runs
on a THROWAWAY clone with the real pin unchanged, and the plan now records why: advancing
`upstreamBase` to satisfy a phase would strand every spec 146 and 236 result tied to `082e6ea52186`.
Criterion 6 closes run-and-met or UNMET-with-a-runbook, never open and never on a simulation. The
runbook is `codev/resources/250-ipad-acceptance-runbook.md`, and verifying it against the fork
rather than writing it from memory caught three wrong instructions — the worst being that it sent
the human to `t3-server.mjs start-fork`, a throwaway data dir with empty data, for a criterion that
says a builder is driven to completion.

Pin `3786b840e1a4`, 33 patches. Both branches pushed. **No PR yet — phase 11 opens it.**
