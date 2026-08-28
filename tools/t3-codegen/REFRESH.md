# Refreshing the vendored t3code contract

Spec 146 requires a documented refresh procedure and a test that fails when the vendored copy
drifts from the pinned server. This is the procedure.

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

184 commits landed on the closure between 2026-02-07 and 2026-08-25 — roughly 27 a month.
t3code also pins `effect: 4.0.0-beta.103` and imports its RPC from `effect/unstable/rpc/*`, a
pre-1.0 beta on a path the library marks unstable. A pin here goes stale in weeks.

## The two drift layers, and which one matters

**`source-hash.json` is the detector. The schema diff is the explainer.**

`toJsonSchemaDocument` drops checks applied on the decoded side of a `decodeTo` transform.
`TrimmedNonEmptyString` is exactly that shape, and it is the base of every branded id in the
contract, so all 20 schemas in `generated/LOSSY.md` emit as unconstrained. If upstream relaxed
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

2. Check what actually changed in the closure since the current pin:

   ```bash
   cd tools/t3-codegen
   node classify-churn.mjs --since "$(node -p "require('../../packages/types/src/t3/pin.json').commit")"
   ```

   This replays each commit touching the closure and reports whether it changed a shape Codev
   consumes. Read the output before moving the pin, not after.

3. Move the pin. Edit `packages/types/src/t3/pin.json`: `commit`, `commitDate`, and
   `effectVersion` if t3code's catalog moved. If `effectVersion` changed, update the
   `devDependencies` in `tools/t3-codegen/package.json` to match and reinstall — generating with
   a different Effect than the server was built against produces artifacts that describe nothing
   real.

4. Check out the pinned commit and regenerate:

   ```bash
   git -C "$T3CODE_ROOT" checkout <commit>
   pnpm --filter @cluesmith/t3-codegen generate
   ```

5. Read `generated/LOSSY.md` and `generated/UNREPRESENTED.md`. An entry appearing in
   UNREPRESENTED that Codev consumes is a **blocker**: there is no JSON Schema for it, so
   `shapeCheck` cannot check it in any form. Raise it rather than shipping.

6. Run the suite. `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` verifies the
   hashes against the checkout, so a stale regeneration fails here.

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
- A t3code checkout at `$T3CODE_ROOT`, default `/Users/chris/dev/t3code`.
- The checkout is treated as **read-only**. The generator copies the closure into `.staging/`
  rather than importing in place, both so `effect` resolves from this tool's own
  `node_modules` and so nothing can ever write into the clone.
