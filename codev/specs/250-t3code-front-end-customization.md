---
approved: 2026-08-30
validated: [claude, codex]
---

# Spec 250: t3code is the front end — private customization

## Problem Statement

Spec 146 built Codev's integration with t3code and then put the human-facing surface somewhere
else. `apps/client` is served by Tower on port 4100, the process spec 146 exists to delete, and
its data comes from PTY terminals because no workspace has t3code configured. Thirteen phases
landed and nothing in the product runs on t3code.

The correction is a ruling, not a discovery: **t3code is the front end.** Its **web app** is the
surface this spec builds on; its desktop and mobile apps exist and are explicitly out of scope
below. Codev's job is the protocol layer — porch's phases, human gates,
specs, plans, reviews, the architect/builder model — and the integration that puts Codev's work
inside t3code as threads.

Spec 146 avoided touching t3code, listing "Forking t3code" under Non-Goals and putting the tree
in a separate client instead. That trade is reversed here. Every change we make to t3code is a
**private customization**. It is not offered upstream to `pingdotgg/t3code` and does not wait on
anyone's review.

## Current State

### What t3code's model can express

Verified against the read-only clone at `/Users/chris/dev/t3code`, pinned at `082e6ea52186`.

`OrchestrationThreadShell` (`packages/contracts/src/orchestration.ts:469`) carries:

| Field | Purpose |
|---|---|
| `projectId` | One level of grouping. The only one. |
| `title` | Free text. The only free text on the record. |
| `worktreePath`, `branch` | Where the thread's work lives |
| `modelSelection`, `runtimeMode`, `interactionMode` | Which driver and model |
| `pinnedAt`, `pinOrderKey` | A flat pinned block with a fractional sort index |
| `settledAt`, `settledOverride`, `latestTurn`, `session` | Lifecycle |
| `hasPendingApprovals`, `hasActionableProposedPlan` | **Provider tool approvals, not porch gates** |

There is no parent-thread field and no metadata bag.

### What that means Codev cannot show

1. **Workspace > Architect > Builders does not exist.** The model is Project → Thread, flat.
2. **Several architects in one workspace, each owning its own builders, has nowhere to live.**
3. **There is no gate concept.** Status is `starting` / `running` / `ready` / `settled`, so a
   builder blocked on `plan-approval` is indistinguishable from one that finished. Spec 146 wrote
   the gate name into the thread *title*, a workaround visible to anyone who reads a title.
4. **No tiling.** Split view exists only for terminals inside one thread.

### The vendored contract, and why a fork is not free

This is the part the first draft of this spec got wrong, and it is the main constraint.

`packages/types/src/t3/pin.json` — **not** `tools/t3-server/pin.json` — pins the contract by
upstream commit and lists a nine-file `closure`. **`orchestration.ts` is on that list.** The
generator fails if the real import graph reaches a file the closure does not name, and
`shape-check.ts` checks payloads against the schema generated from it.

So the two record changes below are not edits to someone else's repo that Codev merely consumes.
They change the contract Codev vendors, and the vendored copy must be regenerated from **our**
tree rather than upstream's. Any spec that says "reuse the pin machinery verbatim, only the
commit changes" is wrong, and this one used to.

`tools/t3-server/t3-server.mjs` compounds it. `verify` refuses when
`head !== pin.commit` (`:114`) and refuses a dirty checkout (`:86`). A fork branch fails that
by construction. The mechanism needs two identities, not one relabelled.

### What already works and is not rebuilt here

`porch-driver` maps porch onto t3code commands. `codev-agent` reads `status.yaml`, streams
protocol state, issues approval capabilities and invokes `porch approve`. As of #241 a turn
dispatched through `porch-driver` settles against a live server; as of #227 `afx interrupt` and
`afx cleanup` work on the thread path.

Both are **changed by this spec, not preserved untouched** — the first draft claimed otherwise.
`porch-driver` must supply `role` and `parentThreadId` at `thread.create`, and `codev-agent`
must publish and clear gate state. Neither is a rewrite; both are new fields on existing calls.

`apps/client` is **kept and frozen**. It is the fallback: if this customization is abandoned, a
working client still exists. Frozen means it keeps passing its tests and receives fixes, not that
new front-end features land in both places. Spec 146's criteria 3, 4, 4b, 5, 7 and 8 stand as
already-met facts about it; they are not re-verified here.

**Keeping it does not keep Tower alive, and a review raised that it did.** Checked against spec
146 line 122: *"Tower is not deleted; it is hollowed out and renamed in role. `codev-agent` **is**
the surviving Tower process, minus everything that drove a terminal."* `apps/client` is served by
`client-static.ts` on that surviving HTTP server. What phase 14 deletes is the PTY manager,
render gate, terminal sessions and the mailbox — none of which `apps/client` touches. So the
fallback and the deletion do not trade against each other, and criteria 13 and 14 are unaffected.

## Desired State

### Where the fork lives

`github.com/pseudoseed/t3code`, branch `codev`, checked out at **`/Users/chris/dev/t3code-codev`**.

`/Users/chris/dev/t3code` stays the read-only upstream clone at the pin, because every piece of
spec 146 and 236 evidence was gathered against it and moving it invalidates all of it.

**`T3CODE_ROOT` alone is not enough, and saying "both coexist" was too easy.** One variable feeds
six consumers, and once `pin.commit` names the fork head, `verify` run against the preserved
upstream clone fails by construction — so the evidence that clone exists to keep re-runnable
stops being re-runnable. The rule is therefore explicit per identity, not per variable:

| Identity | Checkout | `verify` asserts |
|---|---|---|
| `upstreamBase` | `/Users/chris/dev/t3code` | HEAD equals `upstreamBase`, clean |
| fork | `/Users/chris/dev/t3code-codev` | HEAD equals `commit`, clean, and its merge-base with upstream equals `upstreamBase` |

`pin.json` carries both:

```json
{ "commit": "<our fork head>", "upstreamBase": "082e6ea521861fff37b90fcd789b5eaa5ef5d6a6" }
```

Exit `3` — "could not determine" — still exists and still must not be spelled like `1`.

**Drift detection splits into two questions that a single range cannot answer.** Pointed at our
own fork head, `classify-churn.mjs --since` compares our tree to itself and reports no churn
forever. But `upstreamBase..forkHEAD` is not the fix either: that range measures *our*
customization, and stays silent while upstream moves and we do not rebase. Two ranges, two
checkouts, two meanings:

| Question | Range | Read from |
|---|---|---|
| Has upstream moved since we based on it? | `upstreamBase..origin/main` | `/Users/chris/dev/t3code` |
| How far has our customization drifted? | `upstreamBase..forkHEAD` | `/Users/chris/dev/t3code-codev` |

The first is the one that goes silent if nobody asks it, so it is the one criterion 9 asserts is
non-zero against a known-moved upstream.

The same hazard applies to the generator's source-hash detector, which stamps `source-hash.json`
with `pin.commit` (`generate.mjs:122`): fork-sourced generation makes it a tautology unless it
hashes the upstream closure at `upstreamBase` alongside ours.

### The six changes to t3code

**1. `parentThreadId` and `role` on the thread record.** `role` is `architect` | `builder` |
`null`, where `null` is an ordinary t3code thread Codev did not create. `parentThreadId` is
nullable and names the architect thread owning a builder. Additive and nullable, so an existing
database opens unharmed and t3code's own threads are untouched. Only the architect→builder edge
is new.

**How a Codev workspace becomes a `projectId`.** "Workspace maps onto `projectId`" is a binding
that has to be written down, not assumed: `codev-agent` holds the map, keyed by canonical
workspace root, the same key `global.db` and the engine map already use. A workspace with no
project yet gets one created on first spawn; a `projectId` that no longer resolves is reported as
such rather than rendered as an empty workspace. Nothing derives the id from a path at read time,
because two checkouts of the same repo are two workspaces and one path is not stable across
machines.

**2. Sidebar grouping that reads them.** Project, then each architect, then that architect's
builders. Threads with `role: null` keep the existing flat presentation in their own section.

**3. Porch gates as first-class state, on the thread record.** Ruled on the record rather than a
side table: it streams with the thread, and a side table would need its own subscription and its
own ordering guarantee against the thread's.

The block carries gate name, requested-at, #128's structured question and choices, and a
**monotonic revision**.

**The revision is stored separately from the block, and this is the whole mechanism.** A nullable
block whose revision vanishes when the gate clears cannot reject a stale write — the late message
arrives, finds no revision to compare against, and recreates an approved gate. So the thread keeps
a non-nullable `gateRevision` high-water mark that only ever increases, including across a clear,
and a write is applied only when it exceeds it. Clearing is a write like any other and raises the
mark.

**The counter is allocated by the server, not by `codev-agent`, and that is the durability
story.** A counter held in `codev-agent`'s memory resets on restart, and a reset counter is worse
than no counter: every subsequent gate is silently rejected as stale and renders as *no gate
pending*, which is a false negative in the one place a human is waiting. So `codev-agent` sends a
gate write with no revision; the server assigns `gateRevision + 1` atomically and returns it.
Historical rows default to `0`. Two overlapping `codev-agent` connections therefore cannot race
to the same number, an equal revision is rejected rather than treated as idempotent, and a retry
of the same logical write is a new revision — which is safe, because the content is identical.

`codev-agent` is the only writer. `status.yaml` remains authoritative; the block is a projection
of it, and any disagreement is resolved by re-reading `status.yaml`, never the other way.

**t3code is event-sourced, so nullable columns are not sufficient.** `ThreadCreatedPayload`
events already in the log carry no `role` or `parentThreadId`. Decoding must default them rather
than fail, and a projection rebuild over a pre-fork event log is a test, not an assumption.

**4. Tiling for builder threads.** Four to six visible at once, porting the geometry already
solved in `apps/client/src/responsive/layout.ts`: panes at least 340x240 CSS px, body text 13px
or larger, and a **computed column count under the rule "as few rows as fit"** — explicitly not
"near-square", which `layout.ts:70-82` records as considered and rejected. The two rules both
give 3 columns for six panes at 1440, so the obvious criterion cannot tell them apart; they
diverge at seven panes at 1920, where near-square gives 3x3 and the correct rule gives 4x2.
Re-measured against t3code's own chrome, which is not `apps/client`'s.

**5. The approval capability reaches t3code's web app through the existing pairing ceremony.**
Ruled here rather than left open. `afx pair issue --purpose client-session` and the human-session
route already exist, are tested, and keep the authority in `codev-agent`. t3code's app gains a
pairing entry point; it does not gain approval authority, and its own session is never an
approval credential.

**6. A same-origin proxy from t3code's server to `codev-agent`.** Counted as its own change
because it is a server change, not a client one, and an earlier draft hid it inside the security
section. It mirrors what `apps/client` does at `/m/<id>/`: the page never makes a cross-origin
request, so `connect-src 'self'` stays closed.

**What a pane renders, which is most of the cost.** Geometry is the ported part; content is not
specified by `layout.ts` and has to be stated. A builder pane shows the same four things
`apps/client`'s does — role-prefixed id, status, porch phase, and the last three messages
addressed to that agent — and **not** a live transcript. Six live transcripts is six subscriptions
rendering continuously, which is a different feature with a different cost; opening one thread
full-size is how a transcript is read, and that already exists in t3code.

## Goals

1. Open t3code and see Codev's architects and builders in a tree, grouped by workspace.
2. A builder blocked on a gate says which gate, with its question and choices, in t3code.
3. Approve that gate from t3code, over the capability path spec 146 built, on an iPad on the
   tailnet, self-hosted, no cloud relay.
4. Watch four to six builders at once.
5. Track upstream without the customization becoming unmergeable.

## Non-Goals

- **Contributing any of this upstream.** Ruled by the owner.
- Rebuilding `porch-driver` or `codev-agent`. Both gain fields; neither is redesigned.
- Deleting `apps/client`. It is the fallback.
- Reimplementing t3code's process control, auth, remote access or mobile clients.
- **Multi-machine in one tree.** Spec 146 goal 4 and criterion 7 are met by `apps/client` and are
  not carried into t3code in this spec. Recorded here rather than dropped silently.
- t3code's **desktop and mobile apps**. The web app is the surface; the iPad reaches it in a
  browser over the tailnet, which is what criterion 6 tests.

## Constraints

- **Self-hosted only.** No cloud relay and no t3code account. Reachable over loopback and over a
  private mesh network; the tailnet is the tested path and criterion 6 requires it.
- **The vendored contract regenerates from the fork.** `tools/t3-codegen/REFRESH.md` is the only
  procedure that edits `pin.json`, and it must learn the two-identity form.
- **`shape-check.ts` keeps its stated semantics.** It is a lower bound in one direction and
  stricter in another, deliberately; the added fields must not turn it into a claim of validity.
- **Approval never traverses t3code's authorization.** `hasPendingApprovals` is provider tool
  approval and is not touched.
- Node: the server runs outside t3code's declared `engines.node`; the harness already records
  that as an advisory rather than a gate.

## Assumptions

- t3code's server owns its own migrations; the added columns follow that mechanism rather than
  Codev's `global.db` versioning.
- Upstream keeps `orchestration.ts` as the thread record's home. If it moves, the rebase is a
  port, not a merge.
- The owner runs one t3code instance for real work, distinct from the pinned test harness.

## Solution Approaches

**1. Patch set applied to the pinned checkout — rejected.** The changes span `packages/contracts`,
`apps/server` and `apps/web`. Patches across three trees conflict silently on every upstream bump
and then apply to the wrong place. Commits rebase and report conflicts.

**2. Fork with rebase onto upstream — chosen.** Ordinary git. Costs a rebase per upstream bump,
which criterion 9 makes a repeatable procedure rather than an event.

**3. Extend through t3code's plugin or extension surface — not available.** Its driver registry is
compile-time and there is no thread-record extension point; this is why spec 146 built a separate
client instead.

## Success Criteria

- [ ] 1. A workspace with one architect and three builders renders in t3code as a tree: project,
      architect, that architect's builders. Verified in t3code's own web app.
- [ ] 2. Two architects in one workspace, each with its own builders, render as two subtrees.
- [ ] 3. A builder stopped at `plan-approval` shows the gate name and #128's structured question
      with its choices, from the gate block rather than the title.
- [ ] 4. That gate is approved from t3code, and porch records the approving session id, machine
      and timestamp in `status.yaml`, over `codev-agent`'s capability path.
- [ ] 5. Six builder threads watchable at once at 1440x900, panes at least 340x240 CSS px, body
      text 13px or larger, measured against t3code's chrome.
- [ ] 5b. **Seven panes at 1920 tile 4x2, not 3x3.** The case that distinguishes "as few rows as
      fit" from the near-square rule `layout.ts` rejected. Criterion 5 alone cannot: both rules
      give 3 columns there.
- [ ] 6. The same view is reached from an iPad over the tailnet, no account, no relay, and drives
      a builder to completion.
- [ ] 7. A thread created by t3code's own UI, `role` null, appears where it always did and nothing
      in the new tree claims it.
- [ ] 8. An existing t3code database opens against the customized server, the added columns read
      as "not recorded" rather than a guess, and **a projection rebuilt over a pre-fork event log
      decodes every historical `ThreadCreatedPayload`** rather than failing on the absent fields.
- [ ] 8b. A migration interrupted partway leaves the database openable by the **pre-fork** server,
      because the columns are additive and nothing else is rewritten. Tested by killing the
      server mid-migration, not by argument.
- [ ] 9. The fork rebases onto a later upstream commit **named in `pin.json` at the time the
      criterion is run**, the contract regenerates from the fork and passes `shape-check`,
      `verify` asserts fork HEAD, upstream base, and that their merge-base equals `upstreamBase`,
      and **upstream churn measured as `oldUpstreamBase..newUpstreamTarget` in the upstream
      checkout is non-zero** — the range that goes silent if nobody asks it. Recorded as a
      procedure in `tools/t3-codegen/REFRESH.md`.

      The pin is 5 days old, so upstream may not yet have touched the closure. `classify-churn`
      counts only closure-touching commits, so a legitimate zero is possible. **A zero is
      therefore reported as `NO_UPSTREAM_MOVEMENT` and passes**, distinct from the tool failing
      or reading the wrong ref, which do not. Criterion 9 is satisfied by the procedure running
      and reporting one of those three, never by an unexplained zero.
- [ ] 10. An approved gate cannot be re-displayed by a later write, proved by clearing a gate and
      then delivering a write carrying a lower revision.
- [ ] 11. Hierarchy integrity. Each of these is **refused by the server at write time** — not
      rendered in a fallback, because a fallback is a second correct-looking answer:
      - a builder whose `parentThreadId` names an absent thread, a thread in another project,
        or itself
      - a builder parented to another **builder**, or to a `role: null` thread — the only legal
        edge is architect→builder
      - a builder with **no** `parentThreadId`
      - a thread with `role: architect` or `role: null` carrying a `parentThreadId`

      A parent **deleted or archived** after the fact orphans its children — `archivedAt` already
      exists on the record, so archiving is the likelier case — and the sidebar renders those in a
      stated unattributed group rather than dropping them.

## Test Scenarios

1. Tree with one architect, three builders; then two architects; then a `role: null` thread mixed
   in — all three in one project.
2. Gate appears, is approved from t3code, clears; a stale-revision write arrives afterward and is
   ignored.
3. Gate replaced by a later gate in the same thread without the first reappearing.
4. Disconnect mid-gate, reconnect, and confirm the rendered gate matches `status.yaml`.
5. Migration applied to a populated pre-fork database; then a deliberately failed migration.
6. Malformed and oversized gate payloads.
7. Orphan, cross-project, self-parent and role-conflicting records.
8. Six builders at 1440x900; the same at 390px with no horizontal scroll.
9. iPad over the tailnet driving a builder to completion.
10. Rebase onto the named upstream commit, regenerate, `shape-check` green.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Churn detection goes blind** — `classify-churn --since` pointed at the fork head compares our tree to itself and reports no churn forever | High | High | It consumes `upstreamBase`; a test asserts non-zero churn against a known-moved upstream |
| **Rebase-time migration collision** — upstream adds a migration at the same version | Medium | High | Number ours far above upstream's range and assert the gap at rebase |
| **Stale gate write recreates an approved gate** | Medium | High | The revision high-water mark survives the clear; criterion 10 delivers a stale revision after approval |
| Contract regeneration drifts from the fork | Medium | Medium | Criterion 9 makes regeneration part of the rebase, not a follow-up |
| The fork becomes unmergeable | Medium | High | Keep the diff narrow: two record fields, one gate block, sidebar and tiling. No refactors |
| A builder writes gate state through the RPC | Low | High | Gate writes require `codev-agent`'s credential; spec 146 criterion 9c already asserts the equivalent for approvals |
| `apps/client` and t3code diverge into two half-maintained clients | High | Low | `apps/client` is frozen, stated above, not maintained at parity |
| Upstream security fix reaches us late | Medium | High | Criterion 9's cadence gets an owner and a maximum interval after the first rebase |

## Security

- **Approval authority does not move.** t3code renders the gate; `codev-agent` remains the only
  thing that can approve one, over the capability path spec 146 built and tested. t3code's
  authenticated browser session is not an approval credential.
- **How the browser gets that capability is ruled, not open.** It travels the existing ceremony,
  and "the pairing token" is only half of it: `apps/client` holds a **machine credential** plus a
  **human session**, and t3code's web app needs both. Concretely it needs the `codev-agent`
  origin, the workspace path that identifies which workspace it is approving in, and a machine
  credential obtained by redeeming a `machine-credential` token — then a `client-session` token
  per session on top.
- **Where the credential is stored is a deliberate change from `apps/client`, not a description
  of it.** `apps/client` does not hold a credential in the browser: the operator writes
  `~/.agent-farm/client-machines.json` at mode 0600 and Tower serves it to the page as
  `/client/machines.json`. t3code's app has no such operator file, so it redeems and holds its own
  credential in per-origin browser storage. That is strictly more exposed — an XSS on the page
  reaches it, and the same-origin proxy can observe every forwarded credential — so it is scoped
  and revocable by design (`afx pair revoke <machine>`) and it is never Tower's shared key, which
  cannot be revoked for one machine without rotating it for all.
- **Cross-origin is decided: there is none.** t3code's app reaches `codev-agent` through a
  same-origin path proxied by t3code's own server, the way `apps/client` proxies `/m/<id>/`.

  **This is structural, not enforced, and an earlier revision of this spec said otherwise.**
  It claimed `connect-src 'self'` stays closed, which asserts a header t3code never sends:
  upstream sets no page-level CSP at all, only one on `.svg` responses (`http.ts:51,62`).
  `apps/client` does send one and the guarantee was copied across without checking. So the
  property holds because the page makes no cross-origin request, not because anything would
  stop it — which means it is a **test** obligation, watching the network for requests leaving
  the origin, and not a header to point at. Adding a page-level CSP is a reasonable later
  hardening and is not claimed here.
- **Gate writes are authenticated, and t3code's existing scopes cannot express it.** The pinned
  contract has only a coarse `orchestration:operate`, which every thread-driving client already
  holds — so "requires `codev-agent`'s credential" is not realizable by reusing it, and saying so
  was hand-waving. The customization adds a **distinct `codev:gate-write` scope**, granted to
  exactly one credential provisioned out of band at server start and never issued to a thread.
  A builder holding `orchestration:operate` is refused, and the refusal is a named signal rather
  than a generic 403.
- **We now maintain a fork of a server that executes shell commands.** Upstream security fixes
  reach us only through the rebase, which makes criterion 9's cadence a security property.

## Open Questions

**Nothing here blocks starting.** The two questions the first review round called blocking are
ruled above: the approval capability travels the existing pairing ceremony, and the gate block
lives on the thread record with a separately stored revision high-water mark. A spec that leaves
a blocking question open is not ready, so they were decided rather than deferred.

1. **Rebase cadence.** Criterion 9 makes a rebase repeatable. Because upstream security fixes
   reach us only through it, the interval gets an owner and a maximum after the first one is
   measured, not guessed at now.
2. **Whether `codev-skeleton/` ships the fork as an install requirement.** Only matters if Codev
   is adopted outside this machine, which it currently is not.

## References

- `codev/specs/146-codev-client-on-t3code.md` — the integration this corrects
- `packages/types/src/t3/pin.json`, `shape-check.ts`, `tools/t3-codegen/REFRESH.md`
- `tools/t3-server/t3-server.mjs` — `verify`, and its three exit codes
- `apps/client/src/responsive/layout.ts` — the tiling geometry being ported
- Issues #241, #227, #259, #260 — the thread path as it stands
