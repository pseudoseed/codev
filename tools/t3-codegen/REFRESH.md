# Refreshing the vendored t3code contract

Spec 146 requires a documented refresh procedure and a test that fails when the vendored copy
drifts from the pinned server. This is the procedure.

## Two identities (spec 250)

There are now **two** checkouts and refreshing means moving two pins, not one. See
`tools/t3-fork/FORK.md` for the full mapping.

| | Upstream | Fork |
|---|---|---|
| Checkout | `$T3CODE_ROOT`, default `/Users/chris/dev/t3code` | `$T3CODE_FORK_ROOT`, default `/Users/chris/dev/t3code-codev` |
| Pinned by | `pin.upstreamBase` | `pin.commit` |
| Role | the public tree we branched from, **read-only** | the private customization the artifacts are generated from |

`pin.commit` keeps its spec 146 meaning: the commit the generated artifacts came from. That
commit is the fork's from phase 5 onward, so **generation reads the fork** and
`source-hash.json` records the upstream closure alongside it. Comparing the fork's hashes to
the fork they came from proves only that the generator is deterministic; the `upstream`
section is the other end of the comparison, and `forkDrift.changedFiles` is the subtraction.

A refresh moves `upstreamBase` (upstream released something) and then moves `commit` (our
branch was rebased onto it). Moving one without the other leaves a fork whose merge-base is
no longer `upstreamBase`, and `t3-server.mjs verify` fails with `FORK_BASE_MISMATCH` rather
than letting a meaningless drift range be computed from it.

## What you are refreshing

Nine files, 3,663 lines — the transitive import closure of `orchestration.ts`, `git.ts` and
`auth.ts` in `packages/contracts/src`. They are listed in `packages/types/src/t3/pin.json` and
the generator **fails** if the real import graph reaches anything outside that list.

`rpc.ts` is deliberately not in the closure. Its own closure is 27 files and 11,120 lines,
because it names every unrelated subsystem's RPCs. The eight methods Codev calls are pinned in
`pin.json` instead; the orchestration ones are resolved from the contract's own
`OrchestrationRpcSchemas` map, so a method renamed upstream fails the generator rather than
silently drifting.

## Why this needs doing often

55 commits touched the closure between 2026-06-01 and the pin — roughly 20 a month. Of the 21
that changed a shape Codev consumes, **0 are confirmed breaking**, 3 are non-breaking and 18 are
undecidable because they alter unions. See `codev/research/146-contract-churn-classification.md`.

So the pin does not go stale as fast as raw commit counts suggest — but 18 undecidable plus 32
`source-only` commits means most churn has **unknown** effect rather than a known-safe one, which
is why this procedure exists at all rather than a "check the changelog" habit.

t3code also pins `effect: 4.0.0-beta.103` and imports its RPC from `effect/unstable/rpc/*`, a
pre-1.0 beta on a path the library marks unstable.

## The two drift layers, and which one matters

**`source-hash.json` is the detector. The schema diff is the explainer.**

`toJsonSchemaDocument` drops checks applied on the decoded side of a `decodeTo` transform.
`TrimmedNonEmptyString` is exactly that shape, and it is the base of every branded id in the
contract, so every schema listed in `generated/LOSSY.md` emits as unconstrained. If upstream relaxed
a branded id tomorrow, **not one byte of the generated output would change.** Only the source
hash catches it.

So: a source-hash failure with an empty schema diff is a **real change with unknown effect**.
It is not a false positive and it is not a formatting nit. Read the diff.

## Procedure

1. Fetch the t3code clone and pick the commit you intend to pin.

   ```bash
   git -C "$T3CODE_ROOT" fetch origin
   git -C "$T3CODE_ROOT" log --oneline -20
   ```

2. Check what actually changed in the closure. There are two questions and `classify-churn`
   refuses to guess which one you meant:

   ```bash
   cd tools/t3-codegen
   node classify-churn.mjs --upstream-movement   # upstreamBase..origin/main, from the upstream clone
   node classify-churn.mjs --fork-drift          # upstreamBase..<fork head>, from the fork checkout
   ```

   Each replays every commit touching the closure in its range and reports whether it changed a
   shape Codev consumes. Read both before moving either pin, not after.

   An empty `--upstream-movement` reports `NO_UPSTREAM_MOVEMENT` and exits `0`: upstream has not
   moved. That is a different answer from the tool failing (`1`, a bad invocation) and from it
   being unable to read a checkout or a ref (`3`). Invoked with no mode, or with both, it exits
   `1` and classifies nothing.

3. Move the pins. Edit `packages/types/src/t3/pin.json`: `upstreamBase` to the new upstream
   commit and `upstreamBaseDate` to its date, `commit` to the fork head that now sits on top of
   it and `commitDate` to *its* date, plus `effectVersion` if t3code's catalog moved. There is one
   date per identity because the two commits are no longer the same commit — a single date would
   be right for one and wrong for the other. If `effectVersion` changed, update the
   `devDependencies` in `tools/t3-codegen/package.json` to match and reinstall — generating with
   a different Effect than the server was built against produces artifacts that describe nothing
   real.

   `pin.methods` is the vendoring list, and it is not derived: `generate.mjs` iterates it, so a
   method the fork adds and this map does not name is silently never vendored. An entry whose
   `source` names a vendored file (`git.ts` for `vcs.*`, `orchestration.ts` for
   `codev.gateWrite`) is one whose method string lives in the unvendored `rpc.ts` — those are
   hand-recorded on purpose. `codev.gateWrite`'s schemas exist only in the fork; a refresh that
   moves the pin back to upstream must remove it or generation fails.

4. Put both checkouts on their pins and regenerate:

   ```bash
   git -C "$T3CODE_ROOT" checkout <upstreamBase>
   git -C "$T3CODE_FORK_ROOT" checkout <fork head>
   node ../t3-server/t3-server.mjs verify      # exits 0 only when both are clean on their pins
   #                                          (verify-upstream / verify-fork check one each)
   pnpm --filter @cluesmith/t3-codegen generate
   ```

   Generation reads the fork and hashes the upstream clone for comparison. If the upstream clone
   is absent or off its base, `source-hash.json` records `upstream.available: false` with a
   reason and the live upstream suite fails rather than accepting an unmeasured section as a
   match.

5. Read `generated/LOSSY.md` and `generated/UNREPRESENTED.md`. An entry appearing in
   UNREPRESENTED that Codev consumes is a **blocker**: there is no JSON Schema for it, so
   `shapeCheck` cannot check it in any form. Raise it rather than shipping.

6. Run the suite with **both** roots exported. `packages/codev/src/__tests__/spec-146-t3-contract.test.ts`
   verifies the upstream hashes against `$T3CODE_ROOT` and the generated hashes against
   `$T3CODE_FORK_ROOT`, in two separately-gated suites, so a stale regeneration fails here and a
   run missing one checkout reports that suite as skipped rather than passing it.

7. Re-export the review patches, because they are cut against `pin.commit`:

   ```bash
   rm -f ../t3-fork/patches/*.patch
   git -C "$T3CODE_FORK_ROOT" format-patch --no-signature \
     -o "$(cd ../t3-fork/patches && pwd)" <upstreamBase>..<fork head> \
     -- . ':(exclude)docs/codev'
   ```

   Two things that bite. `-o` resolves relative to `-C`, so a relative path writes the patches
   INTO the fork checkout, where they are untracked litter that makes `start-fork` refuse the next
   run. And `docs/codev` is excluded because it holds UI screenshots: a screenshot in a patch is a
   base64 blob, unreadable by the human the patches exist for and rewritten whole on every
   re-shoot. Commits that touch only that directory therefore produce no patch, so the numbering
   has gaps — `tools/t3-fork/FORK.md`'s phase log is the complete list of fork commits.

   They are a **review aid** — the customization readable by someone without the private
   repository — and not how the fork is built or rebased. `tools/t3-fork/FORK.md` says so
   there too.

8. **Re-run every evidence run that names a fork commit.** Moving `commit` invalidates all four at
   once, and `collect-spec-250-evidence.mjs` refuses with `STALE_RUN` rather than publishing a
   number about a fork nobody is looking at:

   ```bash
   node tools/t3-fork/criterion-8b.mjs --out codev/research/250-criterion-8b-evidence.json
   node packages/t3-client/live/spec-250-hierarchy.mjs --out codev/research/250-hierarchy-wire-evidence.json
   node tools/t3-codegen/classify-churn.mjs --upstream-movement --out codev/research/250-upstream-movement.json
   node tools/t3-fork/rebase-drill.mjs --out codev/research/250-rebase-drill.json
   node tools/t3-server/collect-spec-250-evidence.mjs      # then --check, which must exit 0
   ```

   **This step is the one that gets forgotten**, because a fork commit that touches no closure file
   changes nothing in the generated contract except a sha — so regeneration looks like the whole
   job, and the acceptance evidence quietly goes on describing the previous fork.

   Three of these start a server. **`T3_HARNESS_PORT` is not optional in practice**: other sessions
   leave servers on the default 3799 and on 3823, and the harness refuses to kill what it cannot
   prove it owns. Check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` — a `/dev/tcp` probe reports every
   port free under zsh, which does not implement that redirection, so it is a check that cannot fail.

   Also re-run the spec-250 Playwright suite, for the same reason: its results describe the fork head
   they ran against, and criterion 1, 2, 3, 5, 5b and 7 rest on them.

9. Commit the pin and the regenerated artifacts **together**. A pin without its artifacts, or
   artifacts without their pin, is worse than either alone — the drift test then compares against
   something nobody chose.

## The rebase drill (spec 250, phase 11)

**Before you carry the customization onto a later upstream, measure the job.** The drill is a
script rather than a hand procedure, because criterion 9 is about the procedure being repeatable
and a rebase performed once by hand proves an event:

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH
git -C "$T3CODE_ROOT" fetch origin                       # allowed: refs move, HEAD does not
node tools/t3-codegen/classify-churn.mjs --upstream-movement
node tools/t3-fork/rebase-drill.mjs --out codev/research/250-rebase-drill.json
```

**Nothing real moves, and the drill checks that rather than promising it.** It works in a scratch
clone and re-reads both checkouts afterwards; if `T3CODE_ROOT` left `upstreamBase`, if the fork
head moved, or if `pin.commit` changed, it **discards its own result** — a drill that disturbed
the thing it was meant to leave alone cannot be trusted about anything else.

**`pin.json` is NOT advanced by the drill.** The moment it names a new base, `verify-upstream`
expects the preserved clone to be there and every spec 146 and 236 result tied to the old base
stops being re-runnable. Advancing the base is a decision taken when there is a reason — a
security fix, a feature we need — never to satisfy a phase.

It reports these, and they answer different questions:

| Field | Question |
|---|---|
| `upstreamChurn` | how far upstream has moved, and how much of that touches the pinned closure |
| `stoppedAt` + `conflictedFiles` | where does a sequential `git rebase` stop |
| `wholeSurface.conflictedFiles` | how much conflicts IN TOTAL — a rebase stops at the first, so the first understates the job every time |
| `contractClosure.regenerationReachable` | can the vendored contract be regenerated afterwards, or is it stranded behind the conflicts |
| `contractClosure.sourceHash.moved` | would the regenerated contract be the one we vendored — which closure files the merged tree hands the generator with different bytes |
| `contractRegeneration` | did the contract REGENERATE from the rebased tree, and do the shapes Codev consumes still match the vendored ones. See below |
| `watermark` | does every migration upstream added land ABOVE the watermark our base leaves |

**The drill DOES regenerate the contract, in a second throwaway, and it does it without moving
anything.** `generate.mjs` refuses any checkout whose `HEAD` is not `pin.commit`, so pointed at this
repository "regenerate from the rebased tree" would mean moving the real pin — which is step 3 below,
taken when a rebase is adopted for a reason. The way around that is not to loosen the guard:

1. `git merge-tree --write-tree` plus `git commit-tree` give the merged tree an identity **inside the
   throwaway clone**. A sequential rebase stops at the first conflict, so there is usually no rebased
   HEAD; the generator reads only the closure, and the closure is usually clean.
2. A **scratch codegen root** is assembled beside it — `generate.mjs` resolves `pin.json`, its output
   directory and its staging area from its own file location, so a copy of the tool under a scratch
   directory reads a scratch pin naming the merged commit. The guard is satisfied honestly: the
   artifacts really are reproducible from the commit they name.
3. The output is compared byte for byte to the artifacts **vendored in this repository**, never to
   what the scratch run just wrote.

A regenerated contract that differs is a **result**, not a failure — it is what adopting the base
costs. `shapesDiffering` is the load-bearing list; `embedsCommitId` names the two artifacts that
carry the commit id and would differ after any rebase.

**The generator needs Node >= 22** (it imports the closure's TypeScript). The drill itself runs under
20. An interpreter that cannot run it reports `attempted: false` with `NO_INTERPRETER` — never "the
contract does not regenerate", which would be a claim about the fork made from a fact about this
machine. `T3_CODEGEN_NODE` overrides.

The generator's *inputs* are still measured alongside: `contractClosure.conflicted` says whether the
generator would find its source, and `contractClosure.sourceHash.moved` says whether that source
still hashes to what the vendored contract came from.

A `could-not-run` result carries none of these fields. That is deliberate: it means nothing was
learned, and a measurement-shaped field on such a document is the first thing a reader would mistake
for a finding. Its `reason` is the whole document.

The hash is taken off the merged worktree **before** the probe merge is aborted. After the abort the
worktree is the fork again and the comparison is the fork against itself, which reports zero moved
files on every run forever. If you move that call, the test that holds it is
`packages/codev/src/__tests__/spec-250-rebase-drill.test.ts`.

Outcomes: `ok` (including `NO_UPSTREAM_MOVEMENT`, which is a pass), `conflicts` — **a result, not a
failure; it is the number the drill exists to produce** — and `could-not-run`, which must never be
read as "no conflicts". Exit 0 for the first two, 3 for the last.

### Result, 2026-08-31

Against upstream `9b2d04317c68`, 104 commits past `082e6ea52186`, carrying 42 customization
commits:

- `classify-churn --upstream-movement`: the counts live in
  `codev/research/250-upstream-movement.json` and are printed into the acceptance evidence by the
  collector, so they cannot drift from the run. **Which** commits are undecidable is the part worth
  writing down: the `orchestration.subscribeThread` and `orchestration.dispatchCommand` union
  shapes, which are the two unions our customization adds members to.
- The sequential rebase stops at **commit 6 of 42** on `apps/server/src/server.test.ts`.
- The whole surface is **3 files of the 35 we modify**: that test, plus
  `apps/web/src/components/Sidebar.tsx` and `Sidebar.logic.ts`.
- **`packages/contracts/src/orchestration.ts` auto-merged clean** — the file `FORK.md` rated High,
  and the one upstream changed twice in the unions we extend.
- **The contract closure has zero conflicts**, so regeneration is reachable rather than stranded —
  but **4 of the 9 closure files come out of the merge with different bytes** (`auth.ts`,
  `baseSchemas.ts`, `environment.ts`, `orchestration.ts`), so the regenerated contract would not be
  the one vendored. Not blocked and not unchanged: two facts that had been reading as one.
- **The contract REGENERATES from the rebased tree** — the generator completes — and
  **`schema.json`, `schema.ts` and `types.d.ts` all move**. The shapes Codev consumes change when
  this base is adopted, and that is now a run rather than an open question.
- **Watermark holds against a real new migration**: upstream added `043`, above the `042` our base
  leaves. Phase 2 tested that invariant with a synthetic migration; this is the first time a real
  one has arrived to test it with.

## Verifying without regenerating

```bash
pnpm --filter @cluesmith/t3-codegen check
```

Regenerates in memory and fails if anything on disk differs. This is what CI should run.

## Requirements

- Node 22 (`PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH`). The generator imports TypeScript
  contract files directly and relies on Node's type stripping.
- An upstream t3code checkout at `$T3CODE_ROOT`, default `/Users/chris/dev/t3code`, and a fork
  checkout at `$T3CODE_FORK_ROOT`, default `/Users/chris/dev/t3code-codev`.
- **Both** checkouts are treated as read-only by these tools. The generator copies the closure
  into `.staging/` rather than importing in place, both so `effect` resolves from this tool's
  own `node_modules` and so nothing can ever write into a clone. The one verb in the harness
  that writes, `t3-server.mjs acquire`, targets the upstream clone and only ever checks out
  `upstreamBase`.
