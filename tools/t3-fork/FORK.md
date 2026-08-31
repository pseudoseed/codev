# The private t3code fork

Spec 250. `t3code` is the front end; Codev integrates with it. Every change we make to
t3code is a **private customization** — it does not go upstream to `pingdotgg/t3code`, and
we do not ask for their buy-in.

## The two checkouts

| | Upstream | Fork |
|---|---|---|
| Repository | `https://github.com/pingdotgg/t3code` (public) | `https://github.com/pseudoseed/t3code` (**private**) |
| Branch | `main`, read-only | `codev` |
| Checkout | `/Users/chris/dev/t3code` | `/Users/chris/dev/t3code-codev` |
| Env override | `T3CODE_ROOT` | `T3CODE_FORK_ROOT` |
| Pinned to | `pin.upstreamBase` | `pin.commit` |
| Written to by us | **never** | yes, one commit per plan phase |

The fork's remotes: `origin` is the private repository, `upstream` is `pingdotgg/t3code`.

## Why it is a created repository and not a GitHub fork

`gh repo fork` was not used and must not be. **A GitHub fork inherits the visibility of the
repository it forks**, so forking a public repository cannot produce a private one. The
repository was created with:

```bash
gh repo create pseudoseed/t3code --private
```

and the history was pushed into it. `gh repo view pseudoseed/t3code --json visibility` reports
`PRIVATE` and `isFork: false`; that is asserted rather than inferred from the create command
having exited zero.

The MIT `LICENSE` and its attribution travel with the copy, unmodified.

## Why the upstream clone must never move

Every piece of spec 146 and spec 236 evidence — the cold-start runs, the recorded source
hashes, the live contract suite — reproduces against `/Users/chris/dev/t3code` at
`upstreamBase`. Moving it off that commit does not break a test; it makes recorded results
unreproducible while every test still passes.

That is why `t3-server.mjs`'s `acquire`, `start` and `status` are pinned to `upstreamBase`
rather than to `pin.commit`. `acquire()` runs `git checkout --detach` against the upstream
clone, and both `smoke.mjs` and `packages/t3-client/live/integration.mjs` call it, so an
ordinary test run would have written a fork sha into the read-only clone the moment
`pin.commit` diverged.

## Which tool reads which checkout

| Reader | Identity | Why |
|---|---|---|
| `tools/t3-server/t3-server.mjs` | both | it is the verifier; `verify` asserts each, other verbs are upstream-only |
| `tools/t3-codegen/generate.mjs` | fork | generation is fork-sourced from phase 5; also hashes upstream for comparison |
| `tools/t3-codegen/classify-churn.mjs` | both | one identity per mode, and the mode is mandatory |
| `tools/t3-codegen/transform-blindness-probe.mjs` | fork | it probes what we emit |
| `tools/t3-server/smoke.mjs` | upstream | keeps the spec 146 cold-start evidence reproducible |
| `packages/t3-client/live/integration.mjs` | upstream | spec 146 / #241 live tests, meaning unchanged |
| `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` | both | upstream suite asserts upstream, fork suite asserts fork |

The mapping is resolved in one place, `tools/t3-fork/identities.mjs`. The one deliberate
exception is `packages/t3-client/live/integration.mjs`, which reads `T3CODE_ROOT` directly and
**requires** it (#214): a missing input there must read as a sentence rather than as a failure
inside the server, and keeping it required also means the fork's path cannot arrive by accident.
It never reads `T3CODE_FORK_ROOT`, and a test asserts that.

## Verifying

```bash
node tools/t3-server/t3-server.mjs verify            # both identities
node tools/t3-server/t3-server.mjs verify-upstream   # upstream only
node tools/t3-server/t3-server.mjs verify-fork       # fork only
```

The per-identity verbs exist so an upstream-only caller does not acquire a dependency on the
fork. `smoke.mjs` and `packages/t3-client/live/integration.mjs` use `verify-upstream`, and so
does `ready` — a fork that has moved ahead of `pin.commit` says nothing about the upstream
process answering on the port, and gating an upstream server start on it would break every
spec 146 run the moment we commit a customization.

Exit `0` with both checkouts clean on their pins. Exit `1` names which identity failed. Exit
`3` is "could not determine" — a missing checkout, an unreadable HEAD, an unresolvable
merge-base — and it is never spelled the same way as `1`.

### Ahead of the contract is not the same as on the wrong commit

`pin.commit` means **the vendored contract was generated from this commit**, and only
regeneration moves it. Phase 5 is where regeneration happens, so from the fork's first
customization commit until then the checkout is legitimately ahead of the pin. `pin.contractSource`
records which state we are in:

| `contractSource` | Fork HEAD descends from `pin.commit` | Fork HEAD does not descend |
|---|---|---|
| `upstream` (phases 1-4) | `FORK_AHEAD_OF_CONTRACT`, exit `0` | `FORK_CHECKOUT_MISMATCH`, exit `1` |
| `fork` (phase 5 onward) | `FORK_AHEAD_OF_CONTRACT`, exit `1` | `FORK_CHECKOUT_MISMATCH`, exit `1` |

**`contractSource` is now `fork`.** Phase 5 regenerated, so the tolerated row is history: a
checkout ahead of `pin.commit` means the vendored contract is stale and `verify` exits `1`. The
next customization commit therefore turns the suite red until the contract is regenerated from it,
which is the intended cost of vendoring a moving source.

The tolerated case was reported, not silenced — it printed on every run. It was spelled
differently from a real error on purpose: a signal that fires for three phases straight is one
people learn to ignore, and then it fires for a real reason and nobody looks.

A contract commit the fork repository does not contain at all is `NO_FORK_ANCESTRY`, exit `3`.
Whether HEAD descends from a commit that is not there is not a question git can answer.

`verify` also asserts `git merge-base <commit> <upstreamBase> == <upstreamBase>`. A rebase or
a squash that drops the base leaves a fork that is clean at a commit nothing can be measured
against, and without that check it verifies green.

## The rebase surface: which UPSTREAM files this fork edits

Phase 11 is the rebase drill, so this is the list it drills against. As of `e0476d49aec1`:
**35 upstream files MODIFIED, 35 files ADDED.** Only the modified ones can conflict, and the split
is measured rather than remembered — a count that drifts is worse than no count:

```bash
git diff --name-status "$upstreamBase"..HEAD -- . ':(exclude)docs/codev' \
  | awk '$1=="M"{print $2}'      # the conflict surface
git diff --name-status "$upstreamBase"..HEAD -- . ':(exclude)docs/codev' \
  | awk '$1=="A"{print $2}'      # carried without conflict
```

The added half is `apps/server/src/codev/`, `apps/web/src/codev/`,
`packages/shared/src/codevAgentProxy.ts`, `apps/web/src/routes/_chat.codev-builders.tsx` and
`apps/server/scripts/apply-codev-guard.ts`. **Roughly half the modified files are upstream TESTS**
(`decider.delete.test.ts`, `projector.test.ts`, `ProjectionSnapshotQuery.test.ts`,
`commandInvariants.test.ts`, `server.test.ts`, `orchestration.test.ts`, `Sidebar.logic.test.ts`,
`AgentAwarenessRelay.test.ts`, two `serverRuntimeStartup` tests), which conflict as readily as
source and are the half easiest to forget when estimating the drill.

**Measured on 2026-08-31 by `tools/t3-fork/rebase-drill.mjs`** against upstream `9b2d04317c68`,
104 commits past our base: **3 of the 35 modified files conflict.** The risk column below is the
prediction; the drill is the measurement, and where they disagree the drill wins:

| File | Predicted | Measured |
|---|---|---|
| `packages/contracts/src/orchestration.ts` | **High** | **auto-merged clean** — and upstream touched it twice in exactly the two unions we extend (`subscribeThread`, `dispatchCommand`) |
| `apps/server/src/server.test.ts` | Low ("mostly one-hunk additions") | **conflicts**, and it is where the sequential rebase stops, at commit 6 |
| `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts` | Medium | **conflicts** |
| the pinned contract closure | — | **zero conflicts**, so regeneration is not blocked, and **4 of the 9 closure files come out of the merge with different bytes** (`auth.ts`, `baseSchemas.ts`, `environment.ts`, `orchestration.ts`) |
| the regenerated contract | — | **the generator runs to completion** against the merged tree, and `schema.json`, `schema.ts` and `types.d.ts` all move. That is the cost of adopting this base, run rather than predicted, in a throwaway that leaves `pin.json` alone |

The prediction was wrong in the direction that matters least (a High that came out clean) and right
about the sidebar. What it under-rated was the upstream TEST — which is the half this table already
warned is easiest to forget, now demonstrated rather than asserted.

| Where | Files | What we change | Conflict risk |
|---|---|---|---|
| `packages/contracts/` | `orchestration.ts`, `orchestration.test.ts`, `auth.ts`, `rpc.ts` | `role`, `parentThreadId`, `codevGate`, `gateRevision`, the `codev.gateWrite` method and its scope | **High.** `orchestration.ts` is the file upstream changes most, and every one of our fields sits in structs it edits. |
| `apps/server/src/orchestration/` | `decider.ts`, `projector.ts`, `commandInvariants.ts`, `Errors.ts`, `Layers/OrchestrationEngine.ts`, `Layers/ProjectionPipeline.ts`, `Layers/ProjectionSnapshotQuery.ts`, `Services/OrchestrationEngine.ts` + 4 test files | hierarchy refusal at write time, the gate write, the refusal reason surviving the ws boundary, committed events returned | **Medium-high.** Eight source files across the command path. |
| `apps/server/src/persistence/` | `Layers/ProjectionThreads.ts`, `Services/ProjectionThreads.ts`, `Layers/Sqlite.ts` | the two columns on both persistence paths; one `codevSchemaGuardStep` call in `setup`, after `runMigrations()` | **Low-medium.** The Sqlite hunk is one line. |
| `apps/web/src/components/` | `Sidebar.tsx`, `Sidebar.logic.ts`, `Sidebar.logic.test.ts`, `ChatView.tsx` | the Workspace → Architect → Builders tree; `<GatePanel>` above the composer; one extra condition on `hideEmptyPlaceholder` | **Medium** for the sidebar, **low** for `ChatView` (two small hunks). |
| server plumbing | `http.ts`, `server.ts`, `ws.ts`, `auth/RpcAuthorization.ts`, `serverRuntimeStartup.ts` (+ 2 tests), `server.test.ts`, `relay/AgentAwarenessRelay.test.ts`, `auth/CodevGateScope.test.ts` | `export` on `authenticateRawRouteWithScope`; three codev route layers merged into `makeRoutesLayer`; gate-writer provisioning; the `codev:gate-write` scope | **Low.** Mostly one-hunk additions. |
| generated / manifest | `routeTree.gen.ts`, `packages/shared/package.json` | the `_chat/codev-builders` route (regenerated, not hand-edited); one `exports` entry for `./codevAgentProxy` | **Low.** `routeTree.gen.ts` regenerates. |

**`apps/client` is untouched, and stays untouched.** It is the frozen fallback:
`git diff <phase-boundary>..HEAD -- apps/client` is empty at every phase boundary from 7 onward,
and that is checked rather than assumed.

## Do not "tidy" these on rebase

Two things in this fork look like inconsistencies and are not. Both are cheap to "fix" and both
fixes are wrong.

**1. `role` / `parentThreadId` are spelled two different ways.**

| Schema | Spelling | Why |
|---|---|---|
| `ThreadCreatedPayload` | `Schema.NullOr(...).pipe(Schema.withDecodingDefault(...))` | The event log holds `thread.created` payloads written before the fields existed. A rebuild replays every one and the projector reads `payload.role` unconditionally, so that read must be total. |
| `OrchestrationThread`, `OrchestrationThreadShell` | `Schema.optional(Schema.NullOr(...))` | Matches `linkedPullRequest` one line above — upstream's own newest field, optional so older cached snapshots decode. |

Unifying on the strict form produces **32 errors across 11 upstream test files**, paid again at
every rebase, to remove `undefined` from a read model the server never emits as `undefined` (every
read path normalizes `?? null`). The strict form looks more correct in isolation, and the reason it
is worse here is not visible from the diff. Endorsed by the architect on 2026-08-30.

**2. The schema guard is not wired to `MigrationsLive`.**

`MigrationsLive` is exported from `persistence/Migrations.ts` and **nothing builds it**. Wiring the
guard there would look tidier and would mean it never runs in production — while a test that
constructs `MigrationsLive` itself passes. It is called from `persistence/Layers/Sqlite.ts`'s
`setup`, which is the path that actually boots the database, and a test asserts the ordering
against that file rather than against a layer it assembles.

## The exported patches are a review aid

`tools/t3-fork/patches/` holds `git format-patch upstreamBase..pin.commit`, one file per fork
commit. **It exists to be read.** A reviewer who does not have the private repository can see
every byte of the customization in the Codev pull request.

**It is not how the fork is built, and not how it is rebased.** The fork is a git repository with
real history and a real `upstream` remote; it moves forward with `git rebase upstream/main` or a
merge, against the actual commits. Nothing in this project applies these patches to produce the
fork, and a patch that fails to apply says nothing about whether the fork is healthy.

They are regenerated whenever `pin.commit` moves:

```bash
rm -f tools/t3-fork/patches/*.patch
git -C "$T3CODE_FORK_ROOT" format-patch --no-signature \
  -o "$(pwd)/tools/t3-fork/patches" <upstreamBase>..<pin.commit> \
  -- . ':(exclude)docs/codev'
```

`--no-signature` matters: without it every patch footer carries the local git version, so the
files churn whenever someone regenerates them on a different machine.

**`-o` takes an ABSOLUTE path.** It resolves relative to `-C`, not to your shell, so a relative
one writes the patches into the fork checkout — where they are untracked litter that makes
`start-fork` refuse the next run.

**`docs/codev` is excluded, and that is what the artefact is FOR.** That directory holds the UI
screenshots, and a screenshot in a patch is a base64 blob: unreadable by the human this file
exists to serve, and rewritten in full every time a phase re-shoots. Four screenshot commits had
taken the export from 504KB to 14MB, which made the diff noisier the more carefully the UI was
photographed. The pictures live in the fork and are read there.

**So the patch numbering has gaps, and the phase log above is the complete list.** A commit that
touches only `docs/codev` produces no patch at all. Every fork commit is listed in the phase log
with its sha whether or not it exported a patch, and that table — not the file count — is the
answer to "what is in this fork".

## Abandoning the fork

The spec keeps `apps/client` as the fallback, so falling back has to be a procedure rather than a
reconstruction. Four steps:

1. Set `pin.commit` back to `pin.upstreamBase` in `packages/types/src/t3/pin.json`.
2. Set `pin.contractSource` back to `"upstream"`.
3. Regenerate: `node tools/t3-codegen/generate.mjs` (Node 22, with the upstream clone present).
4. Re-run `node tools/t3-server/t3-server.mjs verify`.

Remove `codev.gateWrite` from `pin.methods` in the same edit — its schemas live only in the fork,
so the generator fails on step 3 if it is left behind. That failure is the procedure working, not
a problem with it. The fork repository and `tools/t3-fork/patches/` can stay where they are; the
vendored contract is what decides whether Codev depends on the customization.

## Phase log

| Phase | Fork commit | What landed |
|---|---|---|
| 1 | `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6` | Branch `codev` created at `upstreamBase`. No customization yet — the two identities exist and are equal on purpose, so every new assertion has a known answer. |
| 2 | `1a414cee8409a407977ff6c6505fad1ab82f2ec8` | `role` and `parentThreadId` on the thread record, through the contract, the projector and both persistence paths. Columns applied by `apps/server/src/codev/schemaGuard.ts`, outside upstream's migration registry. |
| 2 | `992b781f4314ec1df1abb752c7c9c5378ec13c26` | Review fixes: the "upstream migration still runs" test goes through the migrator instead of a raw `ALTER TABLE`, and `apps/server/scripts/apply-codev-guard.ts` runs the real guard against a file-backed database for criterion 8b. |
| 2 | `e1a858434a8096d7a82e05347f8159d94f42c0b1` | The two `CODEV_SCHEMA_GUARD_*` log signals are pinned by a test — they are the whole mitigation for staying out of the migration registry and nothing enforced they stay two. |
| 3 | `e1b7f7b04af5aa869a552baa622fc9e526a00bb3` | Illegal hierarchy edges refused at write time in the decider, with six reason discriminants. `role`/`parentThreadId` added to `thread.create`, optional so upstream clients dispatch it unchanged. |
| 3 | `40fb82ce92a8ed42e6868bd946bfee00b79b3022` | `OrchestrationEngine` was rewriting every refusal as "Failed to generate an event identifier" and persisting it onto the rejected receipt. The discriminants now survive the wrapper, asserted by an engine-level test. |
| 4 | `3a1780bbf66f` | Gate block, `gateRevision` high-water mark, `codev.gateWrite` on its own RPC method with its own scope, and the engine returning its committed events. |
| 4 | `57d24ddcb3be` | 29 tests: revision monotonicity and criterion 10, the scope exclusions, the payload bounds. |
| 4 | `6e8bdec207d6` | The two tests the optional-on-the-wire deviation rests on: the column rejects NULL, and an absent `gateRevision` decodes to a number. |
| 4 | `3d0e76776cd9` | `isRefusal` was deleting gate refusals — the phase 3 bug in the same function. Reason taxonomy split, projector gate coverage added, and the single gate-write credential named. |
| 4 | `570cc29dc63c` | `dispatchErrorKind` makes an unclassified dispatch error a **compile error**, replacing the hand-written disjunction that shipped the same bug three times. |
| 4 | `0254c84e1241` | The gate-writer credential is actually provisioned at server start. It had no production caller — costume one, in the phase that named it. |
| 4 | `51b55d4899e4` | `OrchestrationRefusal` derived from the `DISPATCH_ERROR_KIND` table instead of hand-listing the same three tags a second time. The classification is one place; a missing member is a missing key. |
| 6 | `804e56f8f864` | A refusal's `reason` did not survive the ws boundary — measured against a live fork server, not inferred. `OrchestrationDispatchCommandError` gains an optional `refusal` field; `CodevHierarchyInvalidReason` moves into the contract because it travels; four wrapping sites lift or forward it. |
| 7 | `4633e0a7f498` | `apps/web/src/codev/hierarchy.ts` — the grouping, as a pure function over the two fields phase 2 added. Three buckets: architect subtrees, roleless threads kept flat, and orphans named with the reason they could not be placed. |
| 7 | `90a5a2d3a312` | The call site: the sidebar's active list is ordered by the grouping and the tree is drawn from that order. `alsoVisible` added so a builder whose architect is pinned reads as `parent-elsewhere`, not `parent-missing`. |
| 7 | `e19e2560dd7a` | The tree screenshotted at 390, 1440x900 and 1920, committed under `docs/codev/`. |
| 7 | `a183f56ecec2` | The project level, the architect's role marker, and Settled's treatment for the orphan group in place of amber — the architect's review of the first screenshots. |
| 7 | `48a9aa399e5d` | The three widths re-shot against those changes. |
| 7 | `7c7096d49de9` | Review fix: the builder count came from the render scan the test counts, so it could only agree with itself. Sourced from the grouping. |
| 8 | `5e8ace3b186f` | `apps/web/src/codev/gateState.ts` and `GatePanel.tsx` — the porch gate read from `codevGate`, in three states, with a sidebar marker in a hue no existing status pill owns. |
| 8 | `39204a7ac368` | The gate panel screenshotted at the three widths; phase 7's re-shot in the same commit, because two builders now carry gates. |
| 8 | `90d2b118b786` | The terminal excerpt gains a caption — unlabelled it is just trailing monospace. |
| 8 | `81c2463d7…` → `98e950e42` | The row marker: two placements tried, both clipped something at ~230px. It is a gavel plus the gate name now, on the line above the title. |
| 8 | `efadf838c414` | Both phases re-shot against those changes. |
| 9 | `36038cdcb…` → `d2e675a7aa08` | `apps/web/src/codev/layout.ts`, `BuilderGrid.tsx`, `BuilderPane.tsx` and a `_chat/codev-builders` route — four to six builders watchable at once, geometry ported from `apps/client` and re-measured against t3code's chrome. |
| 9 | `36717ab7ecfc` | The route gains a header: at 390 the shell's floating sidebar toggle was sitting on the first pane's title. |
| 9 | `2529a40421d1` | The grid screenshotted at the three widths. |
| 9 | `6fecade36146` | Criterion 4b: the architect takes a strip below the grid rather than a ragged seventh tile, and an equal tile only where four columns fit. |
| 9 | `b97ef30dea2b` | Re-shot with the strip. |
| 9 | `0065abc29ed7` | The pane's role prefix cannot be clipped: it is the only thing distinguishing an architect tile from a builder tile when every architect takes one. |
| 9 | `aeebd7f2b9c2` | Re-shot with a long title in the grid, which is what makes the prefix test able to fail. |
| 9 | `8d4b878f3137` | Re-shot after the 3-way review fixes: a sidebar entry point to the grid, and one width measurement instead of two. |
| 10 | `0b90c36682a4` | `apps/server/src/codev/agentProxy.ts` — the same-origin proxy to `codev-agent`, with a server-configured origin allowlist. Web side: `pairing.ts`, `approval.ts`, `agentState.ts`, `useCodevAgent.ts`, `PairingPanel.tsx`, `GateApproval.tsx`, and the panes reading the porch phase and messages `codev-agent` had been publishing since phase 6. `packages/shared/src/codevAgentProxy.ts` holds the two paths both sides must agree on. |
| 10 | `79db4c7b8f07` | The page read the agent store once and froze. The hand-rolled `useState` tick never followed the store; `useSyncExternalStore` does. Found by the browser, invisible to every unit test. |
| 10 | `75150bfcf382` | A gated pane dropped the phase it had just gained: the gate replaced the phase line rather than leading it. |
| 10 | `fe10e0c0b07f` | `Send a message to start the conversation.` printed across `Waiting on you: <gate>` on a thread with no turns. Present since phase 8; the panel-only screenshots did not show it. Hidden through upstream's own `hideEmptyPlaceholder`, because it is also wrong advice at a gate. |
| 10 | `e0476d49aec1` | The pairing form, the approve control and the grid screenshotted at the three widths. |
| 10 | `24aeeebb3` | The proxy buffered request bodies with no bound. `MAX_PROXIED_BODY_BYTES` at 64 KiB, with "too large" and "malformed" given different signals — a chunked body declares no length, so the cap on the read is what answers for it. |
| 10 | `3786b840e` | 3-way review fixes: `UPSTREAM_TIMEOUT_MS` claimed more than an idle timeout gives, and `data-codev-approval-state` was coarser than its own words. |
| review | `2f64a1b0e` | The codex lane's two blocking findings. `send` in `approval.ts` returns transport failure as a **value**, so all five call sites must answer for a dead network — three pre-submit steps report a definite `AGENT_UNREACHABLE_*` because nothing was submitted, and both submit routes report `unconfirmed` because the request may have arrived. `GateApproval` gains the `catch` its `finally` never had. And `MAX_PROXIED_RESPONSE_BYTES` bounds the **return** path, which `24aeeebb3` had left unbounded on the same file. |
| #272 | `26b4c2dc0` | The tree's project level was derived entirely from architects, so a project with none drew no heading and was absent from the sidebar. Codev now registers a project per workspace whether or not anything has been spawned there, which makes "nobody has spawned here yet" the ordinary case — and it was rendering identically to "this workspace does not exist". A project group with no architect draws its heading with nothing under it. `CodevSidebarEntry` gains an `empty-project` case, so every consumer had to say what it does with an entry that carries no thread; `codevOrderedThreads` is that answer for the six that wanted "the rows, in render order". |

### Both bounds, and why the return path was the worse one

`24aeeebb3` bounded the request body during phase 10. The **response** stayed unbounded until the
codex lane's review of the PR, and it is the more exposed half of the same defect.

A request body arrives from an authenticated, paired caller, so the cap bounds what a browser
somebody let in can make this server hold. A response body arrives from whatever
`CODEV_AGENT_ORIGINS` names — so an operator misconfiguration, or a `codev-agent` that streams
without end, made the server buffer without end, and no credential was needed to arrange it.

Two numbers rather than one, deliberately: 64 KiB for requests, which are a few hundred bytes of
JSON, and 1 MiB for responses, which carry an operation record with its check names and pane
content. Tying them together would make one of the two wrong the first time either kind of traffic
changed.

**`oversized` is its own outcome**, alongside `unreachable` and `silent`. Passing on the first
megabyte as though it were the whole reply is a partial answer reading as a complete one, on the
route that decides whether a gate was approved; and reporting it as `unreachable` sends an operator
to check whether a host that is plainly running and answering is running.

The first version settled *after* `destroy()`, and `destroy()` makes the stream emit `error`
synchronously — so the `error` handler's `unreachable` won the race and the proxy reported a
reachable host as unreachable. `settle` is once-only, which is exactly why the truthful outcome has
to be claimed first and the teardown done second.

### A careful outcome vocabulary is not the same as answering

`approval.ts` documents four outcomes in its header, spells `unconfirmed` apart from refusal in
five places, and refuses to invent `approvedAt` from the browser clock. Eleven rounds of review
read all of that approvingly.

None of it ran when `fetch` itself rejected. `send` did a bare `await fetchImpl(...)`, four of its
five call sites had no `catch`, and `GateApproval` had a `finally` and no `catch` — so a proxy
disconnect while opening the session, issuing the capability, minting the nonce, or taking the
synchronous fallback stopped the spinner and produced **nothing**. No error, no unconfirmed state,
no outcome. On the approval surface that is the worst answer available, because it is
indistinguishable from having pressed nothing.

The fix is a type rather than a `try`, so the next call site cannot inherit it: `send` returns
`({reached: true} & Json) | {reached: false, error}`, and `reached: false` is not assignable to
anything that reads `.status`.

**The three pre-submit steps are NOT `unconfirmed`, and that distinction is the point.** Nothing
was submitted, so the gate provably did not move; saying "check the gate" there would teach a human
that `unconfirmed` is the ordinary noise of a flaky network, which is precisely how the rare real
one gets ignored. The two submit routes — the async one, and the synchronous fallback that approves
before it answers — are `unconfirmed`, because the request may have arrived and only the reply been
lost.

### The proxy's upstream is the OPERATOR's, and the browser cannot name one

Phase 10 gives the fork's server a reverse proxy to `codev-agent` at
`/api/codev/agent/<target-id>/<agent-path>`, so t3code's page reaches the approval
ceremony without ever making a cross-origin request. There is no page-level CSP in t3code to
lean on — `Content-Security-Policy` appears on `.svg` asset responses only — so the guarantee
is structural: the page holds no absolute URL, and the e2e watches the network rather than
parsing a header that is not sent.

**Configure it with `T3CODE_CODEV_AGENT_ORIGINS`,** a comma-separated list of `id=origin`
entries, e.g. `local=http://127.0.0.1:4100`. Unset means the proxy carries nothing and SAYS SO;
an entry that cannot be used is reported rather than dropped. The browser selects a target by
**id**, never by URL — a proxy that forwards to an origin the browser names is an SSRF
primitive, and a route-path allowlist does not constrain the host.

Three things it deliberately does not do: it does not carry the SSE stream (it buffers, and a
buffered stream is live on the wire and empty in the page); it does not carry either revocation
route (`afx pair revoke` is the operator path, and a browser that could revoke could deny a
human their own gate); and it does not forward `authorization` or `cookie`, because t3code's own
session is not approval authority and no other server should be handed t3code's identity.

**Phase 11 added no row either, and for a different reason.** It is the acceptance phase: the
rebase drill, the churn report, the watermark re-check and the evidence all live in the Codev
repository and read the fork without writing to it. The one change it made outside this repo was to
`apps/client`'s test suite — which is Codev's, not the fork's. **The drill deliberately leaves no
trace in the fork**: it works in a throwaway clone and asserts afterwards that the fork head did not
move.

**Phase 5 added no row, and that is not an omission.** It regenerated the vendored contract in the
Codev repository from `51b55d4899e4`; it changed nothing in the fork.

**Phase 6 added one, and it was found by running the thing.** The plan's acceptance criterion for
phase 6 is a live round trip: dispatch an illegal hierarchy edge over a socket and assert the client
can still tell "no such parent" from "wrong parent role". Doing that needs a server built from THIS
source, which `t3-server.mjs start` does not provide — it runs the published `t3@<pin.cliVersion>`
CLI against the upstream checkout, and that server has no `codev.*` anything. So the harness gained
`start-fork`, which runs `apps/server/src/bin.ts` directly, on its own port and its own runtime
directory, sharing no state with the upstream server.

The first run of that test failed, and the failure was the point: every refusal arrived as
`OrchestrationDispatchCommandError` with the reason inside `message`, as English. Phase 3 fixed the
ENGINE deleting discriminants; the ws layer was flattening them one hop further out, and every test
beneath that hop was green.

**Phase 7 is the first phase that renders, and its finding came from the compiler.**

`hierarchy.ts` is pure, its tests build their own row type, and both of those are right for testing
a grouping — and together they cannot tell you the module fits anything the sidebar holds. Two
assignments from `SidebarThreadSummary` and `Thread` at the top of the test file are the check, and
they failed before any call site existed:

- the module keyed on `threadId`, the **command** spelling, while both read models call it `id`;
- `role?: X` does not accept `undefined` under `exactOptionalPropertyTypes`, so the interface
  described a shape no caller has until `| undefined` was written out.

Neither is a runtime error. Both would have surfaced as `buildCodevHierarchy(threads)` quietly
returning no hierarchy — which on screen reads as an empty workspace, not as a bug.

**The section boundary is the fork's, and the renderer had to learn it.** t3code splits a project
into Pinned / Active / Snoozed / Settled before any grouping runs, so the tree is built over ONE of
those lists. A builder whose architect the user pinned is then looking at a list its parent is not
in, and the first draft answered `parent-missing` — three rows below the architect the user can see.
`buildCodevHierarchy` now takes `alsoVisible`, the rest of the sidebar, and answers
`parent-elsewhere` instead. Role still outranks section: a non-architect parent stays
`parent-not-architect` wherever it sits, because a section boundary must not change what a thread is.

**Nothing changes for a project with no Codev roles.** `hasCodevHierarchy` is false there and the
renderer takes the loop it has always had — same rows, same order, no wrappers, no headings. An
empty tree's chrome would be new furniture in every upstream user's sidebar for a feature they do
not have.

**The order returned is also the ordered list.** `orderedThreads` is not only a render order:
shift-range-select and jump-hint labels are assigned from it. A component that reordered rows while
leaving that list alone would draw a correct tree whose keyboard reached the wrong rows — every row
in the right place and nothing on screen to show it.

**Three changes came from the architect's review of the first screenshots, and one of them was a
criterion gap rather than taste.** Criterion 1 is three levels — project, architect, that
architect's builders — and the render had two: the project was present only as a caption repeated
on all eight cards, one string in the most prominent line of every row, with the thread's own name
below it in lighter weight. It is a heading now, once, carrying the project's own favicon; rows
under it drop the per-row label and rows outside it keep it, where it is the only thing saying
which project they belong to. Architect subtrees are gathered by project so a project's run is
contiguous, because a heading over a run another project interrupts is a heading that lies.

The other two: nothing said which row was an architect — it was carried by one level of subtle
indent plus test data that happened to be called "Architect beta", and real threads are called
`builder/spir-250` — so the architect row is captioned in the slot the project label vacated, and
builders are not, because a caption on every child of a labelled parent is a caption nobody reads.
And the orphan group was amber, which says something is broken; an archived architect orphaning its
builders is a state this project ruled LEGAL, so it wears Settled's treatment with the emphasis on
the count.

Verified in a browser against the fork's own web app, not only in unit tests:
`packages/codev/src/__tests__/e2e/spec-250-hierarchy.spec.ts` in the Codev repository, run with
`npx playwright test --config playwright.spec250.config.ts`. The fork's Vite dev server must be
running; an absent one is reported as a skip carrying the command to start it, never as a pass.

### Phase 8: the gate has to be written by the credential that writes gates

The e2e fixture could not seed a gate the way it seeds everything else. A bootstrap exchange
requesting `codev:gate-write` is refused with `invalid_scope`, which is phase 4's design holding:
gate writes come from ONE credential — `codev-agent`, scoped to `orchestration:read` and
`codev:gate-write` and nothing else — provisioned by the server rather than derived from whatever
token a client happens to hold.

So the fixture reads that credential from `<serverBaseDir>/codev/gate-writer.token`, where the
fork's server writes it at start, and opens its own connection with it — which is exactly what
`thread-backend.ts` does in production. A fixture that obtained the ability any other way would
have been testing a path no writer uses.

### Phase 9: the tiling had to be re-measured, and the width is not the viewport's

`apps/client/src/responsive/layout.ts` computed every column count from
`viewportWidth`, because its grid WAS the page. This one is a route inside the chat shell, behind a
sidebar that is 232px at rest, narrower when dragged and gone at 390. Carrying the constants across
unchanged would have produced numbers that are right about a page nobody is looking at.

So every function takes the AVAILABLE width and the grid measures its own container with a
`ResizeObserver` — a window listener would miss a collapsed sidebar entirely, which changes the
space without changing the window. Six panes at 1440 have 1176px, not 1404. Three columns fit
either way, so criterion 5 would have passed on the viewport version by luck; seven panes at 1920
is the case that keeps it honest, and it is criterion 5b.

`PAGE_PADDING` dropped from 18 to 12 — t3code's shell already pays for horizontal inset and the
grid should not double it. `GRID_GAP` stayed at 12 because that was already t3code's rhythm. Both
are in the file with the measurement rather than carried silently.

### Criterion 4b came back, and the screenshot is why

Spec 250 restated spec 146's criteria 5 and 5b and never restated 4b. Nothing in the plan was
broken by leaving it out — and the first 1440 screenshot was the argument for it: six builders and
an architect at three columns is 3 + 3 + 1, one lonely card beside two empty slots. The architect
directed it in, and the plan carries it as a criterion now rather than as a memory.

**It is stated as "four columns fit", not as "1920 or wider", and the number must not be corrected
back.** Spec 146 states a viewport width, which is right for `apps/client`: that client owns the
whole viewport, so available and viewport are the same number, and it stays right there. This grid
sits behind a sidebar, where 1920 of viewport is 1688 of grid — and a viewport threshold would offer
the tile at 1920 with the sidebar dragged wide enough that only three columns fit, which is the
ragged row 4b exists to prevent. Four columns is not a proxy for the reason; it is the reason
written down: seven items at four columns is 4 + 3, the ordinary shape of any grid.

Keyed on width alone and never on the builder count, asserted as its own test. A count-based rule
would move the architect between strip and tile as builders come and go, which is a layout that
reflows under a reader who did nothing.

### Two phase 9 defects the screenshots caught and the tests did not

The pane's status, phase and footer lines were `text-xs`, which is 12px. That is right for a sidebar
row — read from a foot away with one thread in focus — and wrong for a tile in a grid of seven,
which is scanned. Criterion 5 puts the floor at 13 for exactly that reason. The type went up; the
alternative was narrowing the assertion to "body text only" and declaring the labels out of scope,
which is how a grid passes its tests and is unusable.

And at 390 the shell's floating sidebar toggle sat on top of the first pane's own `architect/`
label. The route has a header now, which clears it at every width and names a screen that was
otherwise seven unlabelled cards.

### The gate marker had to fit a 230px row, and neither first answer did

The label read `Gate: plan-approval`, on the line above the title, which is correct in isolation and
does not survive a gated ARCHITECT: that row carries the role caption too, and the caption plus the
label plus the timestamp overflow — the caption truncated to `A…`, which answers "is it blocking on
me" by destroying "what agent is this". Moving the label to the title line fixed the caption and
truncated the TITLE instead, on every gated row, which is worse: the title is the row's primary
identifier.

The label is the gate NAME alone now, and the word "Gate" is carried by the panel's own gavel.
Six characters bought back the room; the row and the panel say "gate" the same way. One clip is
left deliberately: a 15-character gate name on a gated architect still shows `Archit…`. The gate
name and the title are both intact, which is the right order — an architect at a gate is the row a
human most needs to find.

### Screenshots never write into the fork, and that is not tidiness

`start-fork` refuses a dirty fork checkout. A suite whose screenshots landed in the fork therefore
poisons itself the moment there is more than one spec file: the first writes new PNG bytes and
every file after it SKIPS, because the tree it needs is now dirty. It passes, it skips the rest,
and the skip is correct behaviour — which is what makes it easy to miss. Phase 7 met the one-file
version of this and answered it with an opt-in flag; phase 8 met the two-file version, which the
flag did not cover.

A run now always writes outside the fork, and refreshing the committed pictures is a copy:

```bash
SPEC_250_SCREENSHOT_DIR=/tmp/spec-250-shots \
  npx playwright test --config playwright.spec250.config.ts
cp -R /tmp/spec-250-shots/. "$T3CODE_FORK_ROOT/docs/codev/spec-250/"
```

### What the churn classifier could not decide, decided

`classify-churn.mjs --fork-drift` reports three commits as `consumed-change-undecidable`. That is
the classifier refusing to guess inside a union, not a pass, so phase 5 decided them by hand and
recorded the answer here. Reproduce the diff by emitting the JSON Schema for each method at
`upstreamBase` and at `pin.commit` and comparing union members by discriminant:

| Method | Direction | Change | Verdict |
|---|---|---|---|
| `orchestration.subscribeThread` | output | `role`, `parentThreadId`, `codevGate`, `gateRevision` added to the snapshot thread; `role`/`parentThreadId` added to the `thread.created` payload | non-breaking |
| `orchestration.subscribeThread` | output | two alternatives added to the `OrchestrationEvent` union: `codev.gate-set`, `codev.gate-cleared` | **breaking for a client on the pre-regeneration contract**, non-breaking after |
| `orchestration.dispatchCommand` | input | `role`, `parentThreadId` added to `thread.create`, both optional | non-breaking |

Nothing was removed, nothing became required, no type narrowed, no enum lost a member, and
`additionalProperties` did not tighten anywhere. The one change that is genuinely breaking is the
pair of new event alternatives, and it breaks in exactly one direction: a client shape-checking the
stream against the **upstream-generated** contract rejects a `codev.gate-set` frame, because the
frame matches no member of the union it knows. That is the defect this phase closes — regenerating
is the fix, and `spec-250-generated-contract.test.ts` holds the before-and-after so the claim is
measured rather than asserted.

### Migration 900 is abandoned, and must stay abandoned

The first draft of phase 2 planned a numbered migration at id 900, reasoning that a large gap
below upstream's next id was safe. **Under a watermark migrator it is the opposite of safe.**

`effect_sql_migrations` records the highest id that has run and the runner skips everything at or
below it. Once 900 runs, the watermark is 900 and upstream's `043` is below it — so every future
upstream migration is silently skipped, forever, on every Codev database. Nothing errors. The
schema simply stops keeping up, and the first symptom arrives months later as a query failing
against a column upstream added and we never got.

A low id is no better: upstream takes the number we took, and a database that ran ours is then
told it already ran a migration it has never seen.

So Codev's columns are applied outside the registry, in upstream's own idiom — `PRAGMA
table_info` then `ALTER TABLE … ADD COLUMN` for what is absent, the same shape as
`042_ProjectionThreadLinkedPullRequest.ts`. Nothing Codev writes ever touches
`effect_sql_migrations`. `apps/server/src/codev/schemaGuard.test.ts` asserts that, and asserts
that schema work landing after the guard still takes effect.

The one real cost is that the columns are absent from the migration history. The mitigation is
that the guard logs `CODEV_SCHEMA_GUARD_APPLIED` (with the columns it added) or
`CODEV_SCHEMA_GUARD_NOOP` on every start. Two signals, because "added two columns" and "had
nothing to do" are different facts.

**Where it is wired:** `apps/server/src/persistence/Layers/Sqlite.ts`, in `setup`, immediately
after `runMigrations()`. Not after `MigrationsLive` — that export exists and nothing builds it,
so a guard hung there would never run in production while a test that constructed the layer
itself passed.
