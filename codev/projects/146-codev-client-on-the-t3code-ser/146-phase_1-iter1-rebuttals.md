# Phase 1, iteration 1 — rebuttals

Three lanes, three REQUEST_CHANGES, and they converged on one defect that was real and serious.
Every finding below was checked against the source before I acted on it. One is rejected with
reasons; everything else is fixed.

## The defect all three found, and it was mine

**Finding (gemini, codex, claude):** `generate.mjs` discarded `doc.$defs`, leaving 105 dangling
`$ref`s in `schema.json`. `shape-check.ts` listed `$ref` in `SUPPORTED` but never resolved it, so
it walked into an empty schema, found nothing to check, and returned `matches: true` at every one
of those positions. `types.d.ts` degraded to `unknown` at 111 positions. Claude confirmed it
empirically: `defaultModelSelection: 12345` returned `matches: true` with zero mismatches.

**Verified.** 105 `$ref`s, 0 definitions, 111 `unknown`s. Exactly as reported.

**Fixed** (commit `8f2a2c1`):

- `emitWithDefs()` carries definitions, namespaced per top-level schema. Claude verified before
  recommending that `#/$defs/Objects_` names *four different shapes* across four documents, so a
  naive merge would alias unrelated schemas onto one key. That check changed the fix, and it was
  right to make it.
- The generator now **fails** if any emitted `$ref` has no definition. This shipped once; it does
  not ship twice.
- `shapeCheck` resolves `$ref` against a defs pool and throws `UnresolvedRefError` rather than
  passing, with a cycle guard for self-referential schemas.
- The type generator resolves `$ref` too. 111 `unknown`s → 100, and the remaining 100 are
  **correct**: `ModelSelectionSource` genuinely is `Schema.Unknown` upstream.

Result: 19 refs, 19 defs, zero dangling.

**No comment on this is adequate without the following.** The module whose entire stated purpose
is "'I could not tell' must never be spelled the same way as 'yes'" was doing precisely that, and
it had **no tests at all**, which is why nothing caught it.

## `shapeCheck` had no tests

**Finding (gemini, claude, codex):** no unit tests for matching, mismatch, `UnsupportedKeywordError`,
or `describeMismatches`. The plan named `t3-shape-check.test.ts` and it was never written.

**Correct, and it is the root cause of the finding above.** Added 18 tests
(`spec-146-shape-check.test.ts`), deliberately weighted towards *the ways a checker can lie*
rather than the happy path — a suite that only proved it accepts good input would have passed
against the broken version too. Notably:

- an unresolvable `$ref` throws rather than matching;
- an unimplemented keyword throws, with the keyword and path named;
- every generated schema is walked asserting no `UnresolvedRefError`, which is the regression
  guard for this exact defect;
- one test asserts `shapeCheck` **accepts** `cwd: ''` *because the server rejects it*. That
  encodes the boundary between "shape matches" and "server will take it", which is the distinction
  the next reader would otherwise collapse.

## Licence notice was paraphrased, not reproduced

**Finding (codex):** `ATTRIBUTION.md` said `Copyright (c) t3code contributors`; upstream `LICENSE`
says `Copyright (c) 2026 T3 Tools Inc.` MIT requires the notice reproduced accurately.

**Verified against `/Users/chris/dev/t3code/LICENSE`. Correct — I wrote a legal notice from
memory.** Now read **verbatim** from the pinned checkout at generation time, and the generator
fails hard if `LICENSE` is absent, so it can never be invented again.

## A silently passing skip — in this phase's own tests

**Finding (codex):** the missing-checkout branch `return`s from a normal vitest test, so it is
reported as passed rather than skipped.

**Correct and embarrassing in context**, since it is the exact failure this phase exists to
prevent. Changed to `ctx.skip()`. **Verified rather than assumed:** with `T3CODE_ROOT` pointing at
nothing, the suite reports `23 passed | 1 skipped`, not `24 passed`.

## `LOSSY.md` omitted `TrimmedString`; `UNREPRESENTED.md` overclaimed

**Finding (codex):** `LOSSY.md` still omits the required `TrimmedString` case, and
`UNREPRESENTED.md` claims every schema in the closure was representable while only reflecting
schemas passed through `record()`.

**Both correct.**

- `TrimmedString` was skipped because the detector required a `.check(`, and `TrimmedString` is a
  bare `decodeTo`. But a transform with no check still loses information: it trims, and
  `{"type":"string"}` does not say so, so a consumer cannot tell that `" x "` and `"x"` are the
  same value to the server. Now reported with that reason.
- `ForwardCompatibleArray` was also missing, for a different reason — it is a *function* returning
  a schema, so it had no `.ast`. Combinators are now probed by application.
- 22 lossy now, up from 20. All three cases the plan names are covered.
- `UNREPRESENTED.md` now states its actual scope instead of a claim the tool never tested.

## The harness was incomplete and not actually pinned

**Finding (codex, claude):** `acquire` never checks out the pinned commit; no readiness wait, no
pairing, no dispatched no-op, no teardown verification, no cold-start-twice evidence.

**Correct on every point.** Fixed and, more importantly, **proved**:

- `acquire` fetched and then reported success without checking anything out. It now checks out the
  pinned commit, refuses over a dirty tree, and verifies.
- Added `ready`, because `start` returning is not evidence the server is up — `npx` may still be
  downloading, and a phase dispatching immediately would fail for a reason unrelated to what it
  was testing.
- `tools/t3-server/smoke.mjs` runs the full criterion twice: stop → acquire → verify → start →
  ready → authenticate → dispatch a real `orchestration.dispatchCommand` → `Exit: Success` → port
  free after teardown. **Both runs pass.** Evidence at
  `codev/research/146-harness-coldstart-evidence.json`, asserted in the suite rather than merely
  recorded.

Two bugs only running it could find:

1. **I invented the auth endpoints** and got a 404. t3 uses `POST /oauth/token`, form-encoded,
   with its own `urn:t3:params:oauth:token-type:environment-bootstrap`, then
   `/api/auth/websocket-ticket`. The proven spike had all of this and I should have read it.
2. **`stop` did not free the port.** It killed the recorded pid — the `npx` wrapper — while the
   server, its grandchild, kept listening. A later "cold" start would silently have been warm,
   making a start-twice proof a proof of nothing.

The harness also has a limit I am **not** claiming to have closed, recorded in its README and in
the plan's risk table: it pins the *checkout*, not the `t3` CLI binary that serves it, so a
divergence between them is invisible to `verify`. Two closures exist (build the server from the
pinned tree, or pin the CLI version in `pin.json`). Neither is done, and no later phase may assume
it away.

## Rejected, with reasons

**Finding (codex):** "Loss detection does not implement the planned transform-stripping
comparison. It uses source-regex and bare-schema heuristics."

**Not adopted, deliberately.** The heuristic finds all three cases the plan names
(`TrimmedNonEmptyString`, `ForwardCompatibleArray`, `TrimmedString`) plus 19 more, and the
underlying claim — that the emitter drops checks behind a transform — is proved directly by
`tools/t3-codegen/transform-blindness-probe.mjs`, whose committed output shows a **zero-byte**
schema diff against a changed source hash. A second mechanism would add surface without adding
evidence.

Recorded here as *checked and declined* rather than silently skipped, so the next reviewer does
not re-open it.

**Finding (claude, in its second pass):** `afx shell` is PTY-coupled and unruled.

**Does not hold.** `commands/shell.ts` has no import from `terminal/`. Only `attach.ts` does, and
`afx attach` is ruled in the plan (retires with the PTY layer, announced in release notes). Also
recorded as checked.

## Items deferred to their owning phase

**Finding (claude):** "`generate --check` unwired to CI."

The command works and is documented (`pnpm --filter @cluesmith/t3-codegen check`, verified: exit 0
clean, exit 1 on drift). Wiring it into a CI workflow file is real work, but Phase 1 owns the
tool, not the pipeline; CI behaviour is documented in `tools/t3-server/README.md` with the rule
that a missing checkout must skip visibly and never pass silently.

## Status

Build green. Full suite: 6201 passed / 48 skipped, plus 180 in the v2 suite. 42 spec-146 tests.
All 18 Phase 1 acceptance criteria met, each verified rather than asserted.
