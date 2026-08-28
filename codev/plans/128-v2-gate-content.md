# Plan: v2 gate content — record, wire, and card

**Specification**: [codev/specs/128-v2-gate-content.md](../specs/128-v2-gate-content.md)

## Executive Summary

Implement the approved porch-owned structured-request approach from the inside out: define one
neutral `GateRequest` contract; make porch validate, normalize, persist, and lifecycle-manage that
contract; teach every shipped gate-bearing protocol how to author it; project the request from the
same status entry as `blockedGate`; then add an accessible local-selection gate-detail card to the
v2 client. This ordering keeps porch as the sole state writer, gives the wire one canonical shape,
and makes each later phase consume a tested contract rather than inventing a parallel one.

The approved 16 KiB `terminalExcerpt` cap is retained deliberately rather than silently: a final
compiler/test failure can need several kilobytes of stack trace and preceding warnings to remain
decidable, while the 32 KiB whole-request ceiling bounds each state addition and per-node wire
payload. Even a worst-case excerpt is only 16 KiB of repeated text per later state blob (and Git
compresses/packs repeated blob content), which is a bounded commit-weight trade-off for preserving
one complete diagnostic slice; Phase 3 measures the separate aggregate snapshot/replay-buffer cost
rather than treating a per-request limit as an aggregate bound.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Validated porch gate-request record"},
    {"id": "phase_2", "title": "Resolver-delivered gate authoring guidance"},
    {"id": "phase_3", "title": "Exact-gate v2 wire projection"},
    {"id": "phase_4", "title": "Accessible live gate-detail behavior"},
    {"id": "phase_5", "title": "Design-faithful gate-detail presentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Validated porch gate-request record

**Dependencies**: None

#### Objective

Create the canonical request shape and the backward-compatible porch authoring/lifecycle path, so
a builder can attach deterministic decision content to the current gate without changing existing
content-free gate behavior or allowing invalid input to mutate state.

#### Files to Create / Modify

- `packages/types/src/gate-request.ts` (new) — canonical `GateRequest` / choice types and exported
  limits; camelCase is the single portable nested shape.
- `packages/types/src/index.ts` — export the neutral contract for porch, Tower, and v2 consumers.
- `packages/codev/src/commands/porch/types.ts` — add optional `GateStatus.request` without changing
  the containing snake_case timestamp fields.
- `packages/codev/src/commands/porch/gate-request.ts` (new) — strict JSON-object validation,
  normalization, UTF-8 byte accounting, ANSI/control/bidi rejection, and field-specific errors.
- `packages/codev/src/commands/porch/index.ts` — parse `porch gate <id> --request-file <path>`,
  validate before mutation, attach/replace only on the current pending gate cycle, preserve
  `requested_at`, skip the write for identical normalized content, and reject approved/non-current
  targets. The flag-free path continues to preserve an existing request.
- `packages/codev/src/commands/porch/next.ts` — keep request creation/approval history semantics
  intact at automatic gate transitions and ensure a newly-created cycle does not inherit old
  request content.
- `packages/codev/src/commands/porch/__tests__/gate-request.test.ts` (new) — authoring,
  normalization, bounds, no-mutation errors, replacement/idempotency, and content-free
  compatibility.
- `packages/codev/src/commands/porch/__tests__/state.test.ts` — pre-feature YAML compatibility and
  normalized request round-trip coverage.
- `packages/codev/src/commands/porch/__tests__/rollback.test.ts` and
  `packages/codev/src/commands/porch/__tests__/next.test.ts` — approval preserves history,
  rollback/new-cycle clearing, and automatic gate-transition regression cases.

#### Deliverables

- [ ] One canonical request contract with question, one-to-five choices, at most one recommendation,
      optional terminal evidence, no `context`, and the approved field/request limits.
- [ ] Decision text is trimmed; terminal text converts CRLF to LF, strips ANSI, preserves allowed
      tabs/newlines, and rejects other controls, NUL, and bidi override/isolate characters.
- [ ] Unknown JSON keys, non-boolean `recommended`, invalid UTF-8 JSON, and every over-limit value
      fail with a field-specific non-zero CLI error before state mutation.
- [ ] Valid content attaches/replaces on the current pending gate without resetting held time;
      identical content is a true no-op; approval preserves it; rollback/new cycle clears it.
- [ ] Existing `porch gate <id>`, automatic gate requests, notifications, and explicit human
      approval authorization remain unchanged.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A legacy `status.yaml` with no request loads byte-for-byte without migration, warning, eager
      rewrite, or error.
- [ ] Persisted YAML nests camelCase request keys under the existing gate entry while
      `requested_at` / `approved_at` remain snake_case.
- [ ] The full invalid-input matrix from Spec scenarios 5–8 leaves the status file unchanged.
- [ ] `pnpm --filter @cluesmith/codev-types build` passes.
- [ ] Targeted porch tests and `pnpm --filter @cluesmith/codev build` pass.

#### Test Plan

- Unit-test every normalization and validation boundary with ASCII and multibyte UTF-8 values at
  limit-1, limit, and limit+1; include ANSI, CRLF, NUL, C0/C1 controls, and bidi controls.
- Exercise `gate()` against temporary real status/request files: unreadable file, malformed JSON,
  minimal/full/five-choice requests, two recommendations, unknown keys, replacement, identical
  replay, flag-free preservation, and an approved gate.
- Round-trip legacy and enriched YAML through `readState` / `writeState`; assert legacy reads do not
  cause a write and invalid requests never reach `writeStateAndCommit`.
- Run rollback/approval scenarios and verify timestamps plus historical request presence exactly.

### Phase 2: Resolver-delivered gate authoring guidance

**Dependencies**: Phase 1

#### Objective

Deliver concise, identical instructions at every bundled human-gate handoff so builders know how
to record the question, choices, consequences, recommendation, and relevant terminal excerpt while
continuing to send the existing architect notification.

#### Files to Create / Modify

- `codev/protocols/shared/gate-request.md` and
  `codev-skeleton/protocols/shared/gate-request.md` (new, byte-identical) — reusable
  resolver-delivered authoring vocabulary and JSON/request-file example; explicitly say structured
  content is optional and `afx send` is still required.
- Gate-bearing live/skeleton phase-prompt twins:
  - `protocols/spir/prompts/{specify,plan,review}.md`
  - `protocols/pir/prompts/{plan,implement,review}.md`
  - `protocols/aspir/prompts/review.md`
  - `protocols/air/prompts/pr.md`
  - `protocols/bugfix/prompts/pr.md`
  Each includes the shared guidance through the runtime resolver rather than instructing a builder
  to fetch a framework file by path.
- `codev/protocols/{spir,aspir}/builder-prompt.md` and matching
  `codev-skeleton/` twins — carry the same guidance for their promptless post-merge
  `verify-approval` handoff.
- `packages/codev/src/commands/porch/next.ts` — when an already-pending gate is returned, mention
  the optional `porch gate <id> --request-file <path>` augmentation before the STOP instruction;
  this covers upgraded/custom protocols without fabricating request content.
- `packages/codev/src/__tests__/spec-128-gate-prompt-parity.test.ts` (new) — assert the shared
  vocabulary resolves for every bundled human-gate phase and that every live/skeleton file that
  exists in both trees is byte-identical.
- `packages/codev/src/__tests__/template-delivery.test.ts` — resolver include coverage for a fresh
  install with no local protocol copy.

#### Deliverables

- [ ] Every bundled human-gate path tells the builder what structured content to author, how to
      attach it, that it may be omitted, and that notification remains separate and mandatory.
- [ ] One shared fragment owns the wording; phase prompts deliver it through `{{> ...}}` resolver
      includes rather than duplicating or path-fetching it.
- [ ] Runtime-only skeleton resolution works when `codev/protocols/<name>` is absent locally.
- [ ] Live and shipped protocol copies remain byte-identical wherever both exist.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A resolver-backed prompt for SPIR spec/plan/PR/verify, PIR plan/dev/PR, ASPIR PR/verify, AIR
      PR, and BUGFIX PR contains question/choice/consequence/recommendation/terminal vocabulary and
      the request-file command.
- [ ] No prompt implies that structured content replaces `afx send`, is mandatory, or can approve
      a gate.
- [ ] The parity and template-delivery tests pass from a fixture with no live protocol shadow.
- [ ] `pnpm --filter @cluesmith/codev build` and targeted protocol tests pass.

#### Test Plan

- Resolve each gate-bearing prompt through the real four-tier resolver and inspect the delivered
  text, not just source-file presence.
- Compare corresponding `codev/` and `codev-skeleton/` files byte-for-byte; treat an absent live
  protocol as runtime-resolved rather than drift.
- Regression-test the `gate_pending` task ordering: optional augmentation appears before the hard
  STOP and content-free waiting remains valid.

### Phase 3: Exact-gate v2 wire projection

**Dependencies**: Phase 1

#### Objective

Publish `blockedGateRequest` on builder nodes from the exact canonical gate selected for
`blockedGate`, with `null` as the only compatibility/absence value and malformed payloads left
visible to the client's contract validator.

#### Files to Create / Modify

- `packages/types/src/v2-events.ts` — add `blockedGate: string | null` and
  `blockedGateRequest: GateRequest | null` to the shared v2 builder-node contract (non-builder
  nodes receive canonical null values where required by the current node shape).
- `packages/types/src/api.ts` — add documented `blockedGateRequest: unknown | null` to the internal
  overview/discovery carrier. `unknown` is intentional at the YAML trust boundary, not a competing
  request shape; the public valid v2 wire remains the canonical `GateRequest | null`.
- `packages/codev/src/agent-farm/servers/overview.ts` — keep the existing lightweight scalar parser
  for legacy overview fields, but decode the `gates` subtree for requests with the already-direct
  `js-yaml` dependency so block scalars, escapes, Unicode, and YAML-looking literal text follow the
  same semantics as porch's writer. Store request values as `unknown` at this untrusted ingestion
  boundary and derive gate name/request in one selection path over canonical supported-gate order.
  Keep exported `detectBlocked`, `detectBlockedGate`, and `detectBlockedSince` as wrappers over that
  selection so the existing dashboard/VSCode callers remain source-compatible.
- `packages/codev/src/agent-farm/servers/v2-projection.ts` and
  `packages/codev/src/agent-farm/servers/v2-routes.ts` — thread the discovered gate name/request
  into snapshot and delta builder nodes while preserving status and bucket behavior.
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — legacy, full, malformed/raw,
  historical, unrequested, and multiple-pending association cases.
- `packages/codev/src/agent-farm/__tests__/v2-projection.test.ts`,
  `packages/codev/src/agent-farm/__tests__/v2-routes.test.ts`, and
  `packages/codev/src/agent-farm/__tests__/v2-sampler.test.ts` — full/null projection and delta
  comparison coverage.
- `apps/v2/src/lib/validate.ts` — add required nullable `blockedGate` and
  `blockedGateRequest` fields to `ClientNode`; structurally validate the canonical nested shape on
  every frame and import the shared runtime limits (plus the `GateRequest` return type) from
  `codev-types` so the hand-written wire validator cannot drift. Invalid present content fails the
  enclosing frame rather than becoming `null`.
- `apps/v2/__tests__/validate.test.ts` and `apps/v2/__tests__/reducer.test.ts` — full/null/malformed
  snapshot and node-delta contract cases.

#### Deliverables

- [ ] Overview's existing `blockedGate` keeps its current name/semantics; v2 adds both required
      nullable fields. Builder nodes carry the selected canonical gate/request, while every
      workspace and architect node carries `blockedGate: null` and `blockedGateRequest: null`.
- [ ] Legacy content-free gates publish `null`; absent, historical, unrequested, or non-selected
      request content never leaks onto the active gate.
- [ ] Parsed YAML request values remain `unknown` until the deliberate Tower serialization seam.
      A malformed present value is projected unchanged (not coerced to `null`) through that
      explicitly tested unchecked seam, and the client turns the enclosing frame into the existing
      visible contract-mismatch state. The public valid-wire type remains `GateRequest | null`.
- [ ] Snapshot, delta, resume, sampler comparison, and reducer paths retain request changes.
- [ ] Server/client boundaries remain intact: the server imports the contract from `codev-types`;
      the client keeps its required structural runtime validation while importing the canonical
      type and numeric limits from `codev-types`, never from server code.
- [ ] Aggregate cost is measured rather than inferred: record actual JSON bytes for a maximal
      request in one node, a maximal realistic snapshot, `lastByScope`, and the 500-frame replay
      worst case (about 16 MiB per scope if all 500 frames repeat a 32 KiB node) and add a regression
      assertion or tighter mitigation if measurement exceeds the server's acceptable bound.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The exact multiple-entry scenarios in Spec scenarios 1, 7, 9, and 12 produce the expected
      gate/request pair without changing `blockedGate`, `blockedSince`, counts, or status.
- [ ] `blockedGate` itself is required and validated on every v2 node (`null` for non-builders), and
      the compatibility card can render the canonical name when its request is `null`.
- [ ] A request-only node change emits a v2 node delta and survives client reduction.
- [ ] The client distinguishes an absent request from an invalid request.
- [ ] Existing `detectBlocked*` exports and their dashboard/VSCode consumers remain unchanged.
- [ ] The measured maximum snapshot/replay memory result is recorded in the builder thread/review;
      the test suite locks any buffer-size or projection mitigation chosen from that measurement.
- [ ] Type-package, Codev/Tower, and v2 client builds pass; targeted server and client tests pass.

#### Test Plan

- Produce representative YAML fixtures through porch's real `yaml.dump` writer, including block
  terminal scalars, quoted escapes, Unicode, and YAML-looking literal lines; decode request content
  through `js-yaml` and assert one selection helper returns the gate plus only its raw request.
- Exercise `projectHierarchy` and sampler snapshots/deltas with full, null, changed, and malformed
  requests; verify the documented `unknown` serialization seam, `detectBlocked*` wrappers, and no
  server/client cross-import.
- Feed client validation hostile nested values (wrong arrays/types, extra keys, six choices, two
  recommendations) and assert mismatch identifies `blockedGateRequest`, while required null fields
  validate on non-builders. Compute serialized byte/memory bounds for maximal nodes, snapshots,
  `lastByScope`, and 500-frame replay retention.

### Phase 4: Accessible live gate-detail behavior

**Dependencies**: Phase 3

#### Objective

Deliver the complete semantic and live-state behavior of the content card independently of its
final visual treatment: accessible activation, literal full/fallback rendering, and automatic
return to the site when the selected builder changes or disappears.

#### Files to Create / Modify

- `apps/v2/src/App.tsx` — own selected-builder id in local state above the site/detail switch,
  resolve it against the live reducer map, and clear it when absent or no longer gate-waiting.
- `apps/v2/src/components/SiteView.tsx`, `WorkspacePlot.tsx`, `ArchitectHeader.tsx`, and
  `BuilderRow.tsx` — thread the activation callback through every tree nesting path; expose pointer,
  Enter, and Space activation only for gate-waiting builders with correct button semantics/focus.
- `apps/v2/src/components/GateDetail.tsx` (new) — Back to site, ticket heading, canonical gate,
  literal question, optional terminal output/timestamp, choices/consequences, recommendation, and
  explicit no-structured-request compatibility state. Split terminal content into React text-line
  nodes only to classify warning lines; create no approval control, HTML/Markdown, or active links.
- `apps/v2/src/site.css` — add only the minimum layout/focus/overflow rules needed for a usable
  semantic card; final typography, surfaces, spacing, and mockup fidelity belong to Phase 5.
- `apps/v2/__tests__/GateDetail.test.tsx` (new) — full/minimal/null/safe-text/warning rendering,
  omission rules, keyboard activation, Back, recommendation, and timestamp cases.
- `apps/v2/__tests__/SiteView.test.tsx` and `apps/v2/__tests__/reducer.test.ts` — selection from all
  nesting paths plus live node update/removal lifecycle.

#### Deliverables

- [ ] Pointer, Enter, and Space on a gate-waiting builder open the selected detail; Back restores the
      live site without a router or reload.
- [ ] Selection stores only the node id and resolves the current node every render; a `gone` frame or
      transition away from `gate-waiting` closes the detail instead of showing stale content.
- [ ] Full/minimal requests render only recorded content; `null` renders builder, canonical gate, and
      explicit compatibility copy; missing optional regions are omitted.
- [ ] Terminal and choice content stays literal inactive React text. Only warning lines whose first
      non-whitespace character is `⚠` receive a semantic warning class.
- [ ] No queue, unavailable metadata, decorative inferred icons, decision bar, or approval path is
      introduced.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Full, minimal, compatibility, hostile-text, warning, recommendation, timestamp, and omission
      scenarios pass in component tests.
- [ ] Gate rows are keyboard-operable with visible focus and correct button semantics; non-gate rows
      do not acquire a false action.
- [ ] Pushing request updates refreshes the open card; pushing non-gate/`gone` frames returns to the
      current site tree without losing unrelated live state.
- [ ] `pnpm --filter @cluesmith/codev-v2 build` and targeted client tests pass.

#### Test Plan

- Render full/minimal/null cards with React Testing Library and assert markup-like and URL-like text
  creates no elements/anchors; assert warning classification does not reinterpret content.
- Activate gate rows at workspace, architect, and unattached nesting levels by click/Enter/Space;
  verify Back and focus behavior.
- Reduce node-update and gone frames while detail is selected and assert current content updates or
  the site returns with the tree intact.

### Phase 5: Design-faithful gate-detail presentation

**Dependencies**: Phase 4

#### Objective

Apply the approved visual system to the working semantic card and verify the running browser
side-by-side against the exact named mockup slice, keeping the newer single-rust-token constraint
explicit even where it supersedes the existing rust row border.

#### Files to Create / Modify

- `apps/v2/src/site.css`, `apps/v2/src/tokens.css`, and `apps/v2/src/tokens-dark.css` — implement
  hatch/ticket/output/choice surfaces, responsive layout, wrapping/overflow, focus, warnings, and
  recommendation treatment using directed Fraunces / Space Grotesk / IBM Plex Mono on `#EDE8DE`.
  Explicitly replace `.stake.needs-attn`'s direct rust border with a neutral `currentColor`/ink
  border: because `.stamp-gate` is its descendant, the parent border cannot inherit the child's rust.
  The row remains findable through its 3px containment, attention pulse, and rust gate stamp, but no
  longer has a solid rust outline. Keep the sole direct `var(--rust)` in `.stamp-gate`; only
  descendants of that stamp may derive rust through `currentColor`. Add no chevrons.
- `apps/v2/__tests__/fidelity.test.tsx` and `apps/v2/__tests__/SiteView.test.tsx` — exact source-level
  typography, scope-exclusion, rust, chevron, and containment invariants.
- `apps/v2/e2e/fixture-server.mjs` and `apps/v2/e2e/site.spec.ts` — full request fixture plus real
  browser activation, live departure/removal, mismatch, responsive, computed-style, and screenshot
  verification.

#### Deliverables

- [ ] The exact approved visual slice is verified in a real browser at 1440×1080: the **central
      content card only** from `codev/research/v2-mockups/02-gate.png` / `02-gate.html` — ticket
      heading (`GATE — WORK HAS STOPPED` plus builder identity), `THE QUESTION`, `LAST TERMINAL
      OUTPUT`, and `WHAT HAPPENS NEXT` choice cards. The left queue rail, global header/footer,
      metadata rows unavailable on the wire, and bottom decision bar are excluded from comparison.
- [ ] The page uses Fraunces / Space Grotesk / IBM Plex Mono on `#EDE8DE`, containment rather than
      disclosure chrome, responsive choice layout, legible local terminal overflow, and zero
      chevrons.
- [ ] The client contains exactly one direct `var(--rust)`, in `.stamp-gate`. The existing parent
      gate-row rust outline is intentionally neutralized (not falsely described as inherited from a
      descendant); findability remains through containment, pulse, and the stamp.
- [ ] Full/fallback/malformed browser paths preserve the semantic behavior from Phase 4; no later
      design units or approval controls are stubbed.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Playwright covers pointer/keyboard activation, Back, live request update, node departure,
      `gone`, compatibility, malformed mismatch, hostile text, and narrow-viewport overflow.
- [ ] Source checks find zero chevrons and exactly one direct `var(--rust)` occurrence, whose rule is
      `.stamp-gate`; computed styles preserve rust for the gate stamp, ochre for warnings, and neutral
      ink containment for the parent gate row.
- [ ] A captured browser screenshot of the named central slice is opened beside `02-gate.png` at the
      same 1440×1080 viewport and manually compared for typography, `#EDE8DE` ground, containment,
      spacing, hierarchy, terminal contrast, and choice layout. Record the comparison result and
      screenshot path in the builder thread/review before requesting PR approval so architect
      `uiv2` can repeat the same comparison.
- [ ] `pnpm --filter @cluesmith/codev-v2 build`, unit tests, and Playwright e2e pass; the root Codev
      build/test regression suite passes.

#### Test Plan

- Use Playwright against the fixture SSE server for the complete live lifecycle and safe-text paths;
  assert no reload and inspect computed font, color, layout, overflow, and focus styles.
- At a 1440×1080 viewport, capture the central content card and perform an explicit side-by-side
  browser comparison with `codev/research/v2-mockups/02-gate.png` / `02-gate.html`; repeat at a
  narrow viewport for wrapping/overflow and keyboard focus.
- Run a repository-wide CSS/source scan for `var(--rust)`, chevrons, unsafe rendering APIs,
  Markdown/link activation, and approval commands.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A 16 KiB terminal excerpt adds weight to every later porch state commit | Medium | Medium | Retain it consciously for complete diagnostic context, cap the whole request at 32 KiB, reject rather than truncate, test boundary sizes, and record actual enriched `status.yaml` size during Phase 1. |
| Overview corrupts a block/escaped terminal scalar or silently turns malformed stored content into absence | Medium | High | Decode the gates subtree with `js-yaml`, retain the selected request as `unknown` through one documented serialization seam, and test writer-produced block/quoted fixtures end-to-end into client mismatch. |
| Invalid input partially mutates or resets held time | Medium | High | Read/parse/normalize the whole file before touching state, deep-compare normalized content, and assert status bytes/timestamp remain unchanged on every failure/no-op. |
| Protocol guidance misses a gate or bypasses runtime resolution | Medium | High | One shared resolver include, enumerate every bundled human-gate phase in a test, and enforce live/skeleton parity only where both copies exist. |
| The card passes DOM tests but misses the approved design | Medium | High | Bind acceptance to the exact `02-gate` central content slice and require a 1440×1080 browser screenshot opened side-by-side before PR review. |
| Literal terminal/choice content creates markup, links, spoofing, or overflow | Medium | High | Reject prohibited controls at ingress, validate again at the wire, use React text nodes/`pre`, forbid Markdown/HTML/linkification, and test hostile and long strings. |
| Local selection displays stale content after SSE changes | Medium | High | Store only selected node id, resolve it from the live reducer every render, and clear on `gone` or departure from gate-waiting. |
| The newer single-rust invariant silently destroys the older row-outline treatment | Medium | High | Explicitly neutralize the parent outline because a child cannot style its ancestor; preserve 3px containment, pulse, and rust stamp, use `currentColor` only below `.stamp-gate`, and verify the trade-off side-by-side. |
| New wire fields break package isolation or delta comparison | Low | High | Put the shape in `codev-types`, update sampler equality tests, and run existing core/sdk import-boundary suites. |

## Documentation Updates

- Update `codev/resources/arch.md` with the porch-owned `GateRequest` lifecycle and exact-gate v2
  projection if the implementation establishes a durable cross-subsystem contract; do not add this
  feature changelog to the HOT tier.
- Route any genuinely reusable state/parser/UI lesson to
  `codev/resources/lessons-learned.md` during review; otherwise state why no lesson qualifies.
- Protocol-facing user guidance is delivered in the mirrored resolver fragment and gate prompts in
  Phase 2. No README or public approval documentation change is required because approval semantics
  do not change.
