# Plan consultation iteration 1 rebuttals

## Lane disposition

- **Gemini:** `COMMENT`, lane did not review because Antigravity was quota-limited. No findings to
  disposition.
- **Codex:** `REQUEST_CHANGES`; both findings accepted and incorporated.
- **Claude:** `REQUEST_CHANGES`; all six findings accepted, and the phase-size suggestion was also
  incorporated.
- **opencode:** `APPROVE` using the available `opencode/nemotron-3.5-lightning-free` model after the
  configured Grok model was spending-limit blocked and `big-pickle` timed out. Its suggestion that
  the parent row could use `currentColor` to retain rust was **not** accepted as stated; Claude was
  correct that a descendant `.stamp-gate` cannot supply color to its ancestor.

## Codex findings

### 1. Do not hand-parse nested/multiline request YAML

**Accepted.** Phase 3 no longer extends the regex parser to decode `GateRequest`. It keeps the
existing lightweight scalar parser for existing overview fields but uses the already-direct
`js-yaml` dependency for the gates subtree. Test fixtures must be produced by porch's actual
`yaml.dump` writer and cover block scalars, quotes/escapes, Unicode, and YAML-looking literal
terminal text.

### 2. Reconcile malformed propagation with `GateRequest | null`

**Accepted.** The revised plan names the trust boundary instead of hiding it:

- YAML request values enter `ParsedStatus` / `OverviewBuilder` as `unknown | null`.
- `unknown` is an unvalidated carrier, not a second GateRequest schema.
- One documented and tested unchecked Tower serialization seam passes a present raw value through
  rather than coercing it to `null`.
- The public valid wire remains canonical `GateRequest | null`.
- The client's structural validator rejects a malformed present value into the visible mismatch
  state.

The tests now trace malformed state end-to-end through discovery, projection/SSE, and client
validation.

## Claude findings

### 1. Parent rust border cannot inherit from `.stamp-gate`

**Accepted and made explicit.** The newer approved constraint (exactly one direct `var(--rust)`, in
`.stamp-gate`) cannot preserve the existing solid rust ancestor border through `currentColor`.
Phase 5 now deliberately neutralizes `.stake.needs-attn` to an ink/currentColor 3px containment
border. The visual consequence is stated: the row loses the solid rust outline but remains
findable through containment, the existing attention pulse, and the rust GATE stamp. Only
descendants of `.stamp-gate` may derive its rust via `currentColor`. Side-by-side browser
verification must judge that explicit trade-off.

### 2. Use `js-yaml`, not a 16 KiB scalar regex decoder

**Accepted.** Same change as Codex finding 1. The risk register now names scalar corruption and
malformed-to-absence collapse, not the less-likely indentation misassociation theory.

### 3. Client validation cannot be supplied by a TypeScript type

**Accepted.** Phase 3 now preserves `apps/v2/src/lib/validate.ts` as the hand-written runtime wire
validator. It imports the canonical `GateRequest` return type and runtime limits from
`codev-types`, so choice/byte limits do not drift, but it still structurally checks unknown JSON.
The plan no longer claims both sides merely import a type and thereby validate.

### 4. `blockedGate` is new on v2, and non-builder semantics were ambiguous

**Accepted.** The revised plan states that Overview's `blockedGate` stays backward-compatible but
v2 adds **both** fields. Because `V2Node` is one shape, both are required nullable fields on every
node: builders receive the selected canonical gate/request; workspaces and architects receive two
explicit nulls. Client validation and acceptance criteria now cover `blockedGate` itself, including
the request-null compatibility card.

### 5. Preserve `detectBlockedGate` / `detectBlockedSince`

**Accepted.** Phase 3 now introduces one internal gate-selection result while retaining exported
`detectBlocked`, `detectBlockedGate`, and `detectBlockedSince` wrappers. Existing dashboard and
VSCode callers and tests remain source-compatible.

### 6. Measure aggregate SSE/replay cost

**Accepted.** The executive summary no longer treats 32 KiB per request as an aggregate bound.
Phase 3 measures serialized bytes for a maximal node, realistic snapshot, `lastByScope`, and the
500-frame replay worst case (approximately 16 MiB per scope if every frame repeated a 32 KiB
node). The result must be recorded, and a regression assertion or tighter buffer/projection
mitigation is required if the measured bound is unacceptable.

### Minor: Phase 4 was too large

**Accepted.** The client work is now two atomic phases:

1. **Phase 4 — Accessible live gate-detail behavior:** semantic rendering, safe text, keyboard and
   pointer activation, Back, and live stale-selection lifecycle with component tests.
2. **Phase 5 — Design-faithful gate-detail presentation:** tokens/CSS, rust trade-off, browser e2e,
   screenshot, and the exact `02-gate` central-slice side-by-side.

This leaves each commit independently testable and valuable while keeping the browser comparison
an explicit final implementation phase rather than a review afterthought.
