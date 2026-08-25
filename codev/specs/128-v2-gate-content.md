# Specification: v2 gate content — record, wire, and card

- **Issue:** #128
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft

## Problem Statement

The approved v2 gate design is meant to let an architect understand a blocked builder's
decision without opening its worktree. The card asks a concrete question, shows each available
choice and what that choice will cause, and preserves the terminal output that led to the
decision. Today the system records only the gate's name, state, and timestamps.

This affects architects deciding gates, builders waiting for a ruling, and adopters receiving
Codev's shipped protocols. A card built against today's contract can only repeat a gate name and
a timestamp. That is not a reduced version of the design; it omits the information that makes
the gate decidable.

## Current State

Porch stores each gate as `pending` or `approved`, with request and approval timestamps. Tower
projects the active gate onto a builder as `blockedGate`, a canonical string such as
`plan-approval` or `pr`. No structured field carries the question, choices, consequences, or
terminal evidence.

Builders separately send an `afx send architect` notification in prose. Mailbox-first delivery
makes that message durable, but its wording is agent-authored and its purpose is notification.
Recovering fields from it would require free-text parsing that can fail silently whenever a
builder phrases the message differently. Issue #128 records the architect's ruling against
that approach.

Only porch writes `status.yaml`; the hand-edit prohibition is unchanged. Porch currently permits
a gate to reach `pending` without any richer content, and existing status files contain no such
content.

The v2 client already renders the gate-waiting status according to Spec 83, but its gate surface
cannot render a decision it never receives.

## Desired State

Porch accepts an optional structured request when a builder requests a gate and persists it on
that gate through porch's existing state-write path. The structured request has:

- one non-empty `question`;
- between one and five `choices`, each with a non-empty `label` and non-empty `consequence`;
- an optional `recommended` marker on at most one choice; and
- an optional `terminalExcerpt` containing the last relevant terminal output, including warnings.

The choice count is capped at five. A gate is a focused decision, and an unbounded list would
turn both the persisted record and the approved card into an arbitrary report. Five supports
multi-way rulings without making the card's rendering contract unbounded. Text values must be
non-empty after trimming; presentation is responsible for safe wrapping rather than truncating
or changing their meaning.

There is deliberately no general-purpose `context` field. Framing that changes the decision
belongs in the question, a consequence, or the terminal evidence. An optional free-text catch-all
would recreate the prose contract this feature is replacing.

The request block on a gate remains optional. Omitting it preserves current behavior and requires
no migration. Supplying an invalid block fails loudly and does not persist a partial request; the
builder can correct it or request the gate without content. When content is attached to a gate
already made pending by the normal completion flow, it augments that same pending gate rather
than creating a second request or changing its original held-since timestamp.

The v2 builder-node payload keeps `blockedGate` unchanged and adds a nullable
`blockedGateRequest`. It contains the request belonging to the currently pending gate, or `null`
when there is no active gate or the active gate has no recorded request. The contract has one
canonical gate-request shape shared by porch and wire consumers rather than duplicated shapes
that can drift.

The v2 gate card renders the active gate's question, choices, per-choice consequences,
recommendation, and terminal excerpt when present. Missing optional content is omitted explicitly;
the client never invents it. When `blockedGateRequest` is `null`, the card retains its current
name-only fallback so legacy and content-free gates stay visible.

The card follows the approved `02-gate` design and Spec 83's D3/D8 visual discipline: Fraunces,
Space Grotesk, and IBM Plex Mono on `#EDE8DE`; containment rather than disclosure chrome; zero
chevrons; and rust reserved exclusively for the existing `.stamp-gate` treatment. This feature
must not introduce a second rust use anywhere in the client.

The existing architect notification remains unchanged, and approval remains a terminal-only
human action requiring `--a-human-explicitly-approved-this`. The card explains a decision; it
does not approve one.

## Success Criteria

- [ ] A gate-request contract represents a question, one to five labelled choices with per-choice
      consequences, at most one recommendation, and an optional terminal excerpt; it has no
      catch-all context field.
- [ ] `GateStatus.request` is optional, and every pre-feature `status.yaml` loads without migration,
      rewrite, error, or warning.
- [ ] Porch persists a supplied valid request through its normal write-and-commit path; no other
      producer writes the field, and invalid structured input is rejected without partial state.
- [ ] A gate requested without structured content still reaches `pending` and keeps its existing
      architect-notification behavior.
- [ ] The v2 builder-node contract exposes `blockedGateRequest`, populated only from the currently
      pending gate and `null` when absent, while `blockedGate` remains backward-compatible.
- [ ] The v2 gate card renders the question, all choices and consequences, the recommendation, and
      terminal evidence from `blockedGateRequest`; `null` renders the existing name-only fallback.
- [ ] The rendered card matches the approved `02-gate` design side by side, contains no chevrons,
      and adds no use of rust beyond `.stamp-gate`.
- [ ] Card approval remains out of scope and no client path bypasses the explicit human terminal
      approval flag.
- [ ] Gate-request vocabulary in the shipped protocol tree and the repository's live protocol tree
      remains byte-identical wherever the framework requires mirroring.
- [ ] Automated tests cover state compatibility, valid and invalid persistence, wire projection,
      client full/fallback rendering, visual invariants, and protocol-tree parity.

## Constraints

- `status.yaml` remains porch-owned and is never hand-edited or written by Tower or the client.
- `GateStatus.request` is optional; no migration or eager rewrite of existing state is allowed.
- `blockedGate` keeps its name and semantics for existing consumers.
- Framework protocol changes land in both `codev/` and `codev-skeleton/`.
- The two human approval gates, the PR gate, and any protocol-specific gates retain their existing
  transition and authorization semantics.
- `afx send architect` remains a notification rather than the structured record.
- Approval from the card is out of scope; human approval still requires
  `--a-human-explicitly-approved-this` at a terminal.
- Spec 83 D3 and D8 and the approved `02-gate` mockup govern the visual result. The client uses
  Fraunces / Space Grotesk / IBM Plex Mono on `#EDE8DE`, uses no chevrons, and reserves rust solely
  for `.stamp-gate`.
- Server/client package boundaries remain intact: the shared request contract belongs in the
  neutral types layer and neither server nor client imports through the other.

## Assumptions

- Gate content is authored by the builder that has the relevant worktree and terminal context.
- A useful structured gate normally has a small choice set; five is sufficient for the supported
  decision surface.
- Some gates legitimately have no relevant terminal excerpt, so terminal evidence is optional.
- Existing content-free gates will remain common until updated protocol prompts are in use; the
  name-only fallback is a permanent compatibility state, not an error.
- Queue ordering, held duration, machine/workspace attribution, worktree, branch, and run-commit
  metadata are separate projections; this feature does not encode them inside `GateRequest`.
- The approved mockup and shipped client tokens are available as the visual source of truth for
  browser comparison.

## Solution Approaches

### Approach 1: Porch-owned structured gate requests (recommended)

Porch records a typed request alongside the gate it already owns, and the wire projects that
record directly. This gives the card deterministic fields, keeps one source of truth, preserves
legacy state through optionality, and lets malformed input fail loudly. It requires a persisted
format extension, CLI validation, protocol-prompt changes, wire work, and client work, but those
are the layers that own the behavior.

### Approach 2: Reuse and parse the architect mailbox message

The existing notification is durable and often contains the same facts, making this cheaper in
the short term. Its format is uncontrolled prose, however. Parsing it back into choices and
consequences is brittle and a miss looks like valid thin content. That recreates the design
infidelity this project exists to prevent and was rejected in the issue's architect ruling.

### Approach 3: Scrape the builder terminal

Terminal output can supply evidence but cannot reliably identify the decision, enumerate choices,
or associate consequences with them. Terminal presentation is also transient and formatting-heavy.
This approach is rejected as both incomplete and fragile.

## Open Questions

- **Critical:** None.
- **Important:** None. The two design-shaping questions are resolved here: omit general `context`,
  and cap choices at five.
- **Nice-to-know:** Observed production content may later justify field-level character limits.
  That optimization does not block the initial contract, which requires trimmed non-empty strings
  and bounded choice cardinality.

## Test Scenarios

1. **Legacy state:** Load a pending gate containing only existing fields. Porch accepts it, the
   node publishes `blockedGateRequest: null`, and the card renders its name-only fallback.
2. **Full request:** Record a question with five choices, exactly one recommendation, and terminal
   output containing a warning. The state round-trips all values, the current builder node publishes
   them unchanged, and the card renders each piece in the approved layout.
3. **Minimal valid request:** Record one choice with no recommendation and no terminal excerpt.
   The omitted regions are absent rather than blank, fabricated, or replaced with prose.
4. **No content:** Request a gate without structured content. It still becomes pending and notifies
   the architect as before.
5. **Invalid content:** Reject an empty question, zero or six choices, empty labels or consequences,
   and two recommended choices. No partial request is written.
6. **Already-pending gate:** Attach valid content after the completion flow has made the gate
   pending. The original request timestamp remains stable and the wire updates to expose content.
7. **No active gate:** An approved gate may retain its historical request in state, but the builder
   node publishes `blockedGate: null` and `blockedGateRequest: null`.
8. **Approval unchanged:** Approving a gate that carries a request still fails without the explicit
   human flag and follows the existing approval path with it.
9. **Protocol parity:** Every mirrored prompt that asks a builder to request a gate carries the same
   structured vocabulary in the live and skeleton trees.
10. **Visual verification:** Compare the running card and `02-gate.png` side by side at the target
    viewport. Typography, containment, background, content hierarchy, and status treatment match;
    source and computed-style checks confirm zero chevrons and no second rust use.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Existing state fails after the schema extension | Low | High | Keep the request optional and test pre-feature YAML unchanged. |
| Structured input is malformed or partially written | Medium | High | Validate the complete request before the porch-owned atomic state write; reject partial content loudly. |
| A pending gate briefly exists before content is attached | Medium | Low | Treat `null` as an explicit compatibility state and let the same pending gate be augmented without resetting held time. |
| Protocol copies drift | Medium | High | Mirror live and skeleton vocabulary and enforce parity in tests. |
| The client fabricates or shows stale gate content | Low | High | Derive request from the same pending gate as `blockedGate`; otherwise publish `null`. |
| The card passes tests but misses the approved design | Medium | High | Require browser verification and side-by-side comparison with `02-gate.png`, in addition to behavioral tests. |
| New styling dilutes gate-only rust semantics | Medium | High | Reuse `.stamp-gate`, forbid any second rust use, and assert the invariant. |
| Unbounded prose returns through a new catch-all field | Medium | Medium | Omit `context`; keep the schema limited to decision fields and terminal evidence. |

## References

- Issue #128, including the architect ruling selecting porch-owned structured content
- `codev/research/v2-mockups/02-gate.png` and `02-gate.html` — approved gate design
- Spec 83 D3 and D8 — status-to-design mapping and v2 surface boundaries
- Spec 1313 — mailbox-first `afx send` delivery
- Current porch gate-state and v2 builder-node contracts
