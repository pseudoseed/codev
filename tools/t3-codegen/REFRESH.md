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
   commit, `commit` to the fork head that now sits on top of it, plus `commitDate` and
   `effectVersion` if t3code's catalog moved. If `effectVersion` changed, update the
   `devDependencies` in `tools/t3-codegen/package.json` to match and reinstall — generating with
   a different Effect than the server was built against produces artifacts that describe nothing
   real.

4. Put both checkouts on their pins and regenerate:

   ```bash
   git -C "$T3CODE_ROOT" checkout <upstreamBase>
   git -C "$T3CODE_FORK_ROOT" checkout <fork head>
   node ../t3-server/t3-server.mjs verify      # exits 0 only when both are clean on their pins
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

7. Commit the pin and the regenerated artifacts **together**. A pin without its artifacts, or
   artifacts without their pin, is worse than either alone — the drift test then compares against
   something nobody chose.

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
