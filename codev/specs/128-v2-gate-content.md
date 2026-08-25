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

The v2 client renders the gate-waiting status stamp and row treatment according to Spec 83. It
does **not** yet have a gate-detail surface, route, queue rail, or name-only gate card. Those
facts bound the client work below; this spec does not assume a hidden surface already exists.

## Desired State

### Structured record

Porch accepts an optional structured request when a builder requests a gate and persists it on
that gate through porch's existing state-write path. The structured request has:

- one non-empty `question`;
- between one and five `choices`, each with a non-empty `label` and non-empty `consequence`;
- an optional `recommended` marker on at most one choice; and
- an optional `terminalExcerpt` containing the last relevant terminal output, including warnings.

There is deliberately no general-purpose `context` field. Framing that changes the decision
belongs in the question, a consequence, or the terminal evidence. An optional free-text catch-all
would recreate the prose contract this feature replaces.

The choice count is capped at five. A gate is a focused decision, and an unbounded list would
turn both the record and card into an arbitrary report. Five supports multi-way rulings without
making the rendering contract unbounded.

After normalization, UTF-8 limits are: question 1 KiB, label 256 bytes, consequence 2 KiB,
terminal excerpt 16 KiB, and the complete request 32 KiB. Exceeding any limit rejects the whole
request. Presentation wraps accepted text without truncating or changing its meaning.

The portable request object uses camelCase in TypeScript, JSON input, persisted YAML, and the v2
wire. The containing legacy gate-status fields keep their existing snake_case names
(`requested_at`, `approved_at`). This is an intentional nested boundary, not two GateRequest
shapes.

### Builder authoring and lifecycle

The authoring interface is `porch gate <id> --request-file <path>`, where the file is UTF-8 JSON
containing exactly the GateRequest fields. The existing `porch gate <id>` form remains valid and
can request a content-free gate. An unreadable or invalid file prints a field-specific CLI error,
exits non-zero, and makes no state mutation.

When `--request-file` targets the current pending gate, valid content attaches to or replaces the
request for that same gate cycle without changing `requested_at`; repeating identical content is
idempotent. Calling `porch gate` without the flag preserves any request already attached to that
cycle. A rollback starts a new gate cycle and clears the prior request with the timestamps.
Approval preserves the request as history while changing status, but the wire no longer projects
it. A request cannot be attached to an approved or non-current gate.

Decision strings are trimmed. Terminal content normalizes CRLF to LF, strips ANSI escape
sequences, and permits newlines and tabs while rejecting other control characters. All fields
reject bidirectional override/isolate controls and NUL. Unknown JSON keys and non-boolean
`recommended` values are rejected. The stored normalized request is what the wire publishes.

Phase prompts that bring builders to a gate ask them to provide the question, choices and
consequences, recommendation when applicable, and last relevant terminal output through this
interface. They also state that content is optional and the existing architect notification must
still be sent. The vocabulary ships through the framework resolver and is mirrored wherever both
live and skeleton protocol copies exist.

### Wire projection

The v2 builder-node payload keeps `blockedGate` unchanged and adds a nullable
`blockedGateRequest`. It contains the request belonging to the currently pending gate, or `null`
when there is no active gate or the active gate has no recorded request. The contract has one
canonical GateRequest shape in the neutral types layer, shared by porch and wire consumers rather
than duplicated shapes that can drift.

“Currently pending” means the exact gate selected by the existing `blockedGate` algorithm: the
first canonical supported gate whose status is `pending` **and** whose `requested_at` is present.
`blockedGateRequest` is read from that same gate entry only. A request on any historical,
unrequested, or later pending entry is never paired with a different `blockedGate`.

### Gate-detail card

The v2 client adds a gate-detail mode. Activating a gate-waiting builder row by pointer, Enter, or
Space selects that builder in local page state and replaces the site view with the content card;
“Back to site” returns to the tree. No router or stable URL is required. If the selected node is
removed or stops being gate-waiting, the client returns to the site rather than showing stale
content.

The detail renders the builder, canonical gate name, question, choices, per-choice consequences,
recommendation, and terminal excerpt when present. The terminal header uses the builder node's
existing `lastDataAt` as its timestamp when available. Missing optional content is omitted; the
client never invents it. When `blockedGateRequest` is `null`, the new detail shows the builder and
gate name with an explicit “no structured request recorded” compatibility state.

Request content is untrusted display text. React text nodes and a preformatted text surface render
it literally: no HTML interpretation, `dangerouslySetInnerHTML`, Markdown, link activation, or
icon inference from labels. Terminal lines whose first non-whitespace character is `⚠` may receive
the design's ochre warning treatment, but their content remains literal text. A malformed
`blockedGateRequest` invalidates the enclosing node frame under Spec 83's existing client
validation and enters visible contract-mismatch handling; it must not degrade to `null`.

The card follows the **content slice** of the approved `02-gate` design: ticket heading, question,
last-output panel, and “What happens next” choices. The queue rail, global header/footer controls,
worktree/branch/commit metadata absent from the v2 wire, choice-specific decorative icons, and
decision bar are not part of this card and are not stubbed. The queue is separate navigation work;
the decision bar would violate the no-client-approval constraint.

The content card follows Spec 83's D3/D8 discipline and the architect's explicit visual direction:
Fraunces, Space Grotesk, and IBM Plex Mono on `#EDE8DE`; containment rather than disclosure chrome;
and zero chevrons. The client contains exactly one direct `var(--rust)` use, in `.stamp-gate`.
Other gate-semantic accents needed by the content slice may derive from that declaration through
`currentColor`, but no second selector references the rust token. This newer project constraint is
intentional even though the older HTML source names IBM Plex Sans and contains repeated direct
rust utility classes.

The existing architect notification remains unchanged, and approval remains a terminal-only
human action requiring `--a-human-explicitly-approved-this`. The card explains a decision; it
does not approve one.

## Success Criteria

- [ ] A canonical GateRequest represents a question, one to five labelled choices with per-choice
      consequences, at most one recommendation, and an optional terminal excerpt; it has no
      catch-all context field and obeys the stated normalization and UTF-8 limits.
- [ ] `GateStatus.request` is optional, and every pre-feature `status.yaml` loads without migration,
      rewrite, error, or warning.
- [ ] Porch persists a supplied valid request through its normal write-and-commit path; no other
      producer writes the field, and invalid structured input is rejected without partial state.
- [ ] `porch gate <id> --request-file <path>` implements replacement, idempotency, error, and
      lifecycle behavior as specified, while the flag-free command remains backward-compatible.
- [ ] A gate requested without structured content still reaches `pending` and keeps its existing
      architect-notification behavior.
- [ ] The v2 builder-node contract exposes `blockedGateRequest`, populated only from the same gate
      selected for `blockedGate` and `null` when absent; `blockedGate` remains backward-compatible.
- [ ] Activating a gate-waiting builder opens the gate-detail mode accessibly; Back, node removal,
      or departure from gate-waiting returns to the live site without stale content.
- [ ] The card renders question, choices and consequences, recommendation, and literal terminal
      evidence from `blockedGateRequest`; `null` renders the explicit compatibility state, and
      malformed content triggers contract mismatch.
- [ ] The rendered ticket heading and question/output/choice panels match the corresponding slice
      of `02-gate` side by side, contain no chevrons, use the directed font family, and leave
      exactly one direct `var(--rust)` reference in `.stamp-gate` across the client.
- [ ] Card approval remains out of scope and no client path bypasses the explicit human terminal
      approval flag.
- [ ] Gate-request vocabulary in the shipped protocol tree and the repository's live protocol tree
      remains byte-identical wherever both framework copies exist.
- [ ] Automated tests cover state compatibility, validation and persistence, lifecycle, wire
      projection, client full/fallback/malformed rendering, safe text, visual invariants, and
      protocol-tree parity.

## Constraints

- `status.yaml` remains porch-owned and is never hand-edited or written by Tower or the client.
- `GateStatus.request` is optional; no migration or eager rewrite of existing state is allowed.
- `blockedGate` keeps its name and semantics for existing consumers.
- Framework protocol changes land in both `codev/` and `codev-skeleton/` wherever both copies exist;
  runtime-resolved protocols are not copied into the live tree solely to manufacture parity.
- Existing gate transition, notification, and authorization semantics remain unchanged.
- `afx send architect` remains a notification rather than the structured record.
- Approval from the card is out of scope; human approval still requires
  `--a-human-explicitly-approved-this` at a terminal.
- The card's visual result is governed by the named `02-gate` content slice plus the architect's
  explicit direction: Fraunces / Space Grotesk / IBM Plex Mono on `#EDE8DE`, zero chevrons, and
  exactly one direct rust-token reference in `.stamp-gate`. This direction supersedes the older
  mockup's IBM Plex Sans declaration and repeated rust utility classes.
- Server/client package boundaries remain intact: the shared request contract belongs in the
  neutral types layer and neither server nor client imports through the other.

## Assumptions

- Gate content is authored by the builder that has the relevant worktree and terminal context.
- A focused decision needs no more than five choices.
- Some gates legitimately have no relevant terminal excerpt, so terminal evidence is optional.
- Existing content-free gates will remain common until updated protocol prompts are in use; the
  compatibility state is permanent and is not an error.
- Queue ordering, machine/workspace attribution, worktree, branch, and run-commit metadata are
  separate projections; this feature does not encode them inside GateRequest.
- The queue rail, decision bar, and unavailable ticket metadata in `02-gate` are separate units;
  visual acceptance for this feature compares only the ticket heading and three content panels.
- The approved mockup and shipped client tokens are available for browser comparison.

## Solution Approaches

### Approach 1: Porch-owned structured gate requests (recommended)

Porch records a typed request alongside the gate it already owns, and the wire projects that
record directly. This gives the card deterministic fields, keeps one source of truth, preserves
legacy state through optionality, and lets malformed input fail loudly. It requires a persisted
format extension, CLI validation, protocol-prompt changes, wire work, and client work, but those
are the layers that own the behavior.

### Approach 2: Reuse and parse the architect mailbox message

The existing notification is durable and often contains the same facts, making this cheaper in
the short term. Its format is uncontrolled prose. Parsing it back into choices and consequences
is brittle and a miss looks like valid thin content. That recreates the design infidelity this
project exists to prevent and was rejected in the issue's architect ruling.

### Approach 3: Scrape the builder terminal

Terminal output can supply evidence but cannot reliably identify the decision, enumerate choices,
or associate consequences with them. Terminal presentation is also transient and formatting-heavy.
This approach is rejected as incomplete and fragile.

## Open Questions

- **Critical:** None.
- **Important:** None. The design-shaping questions are resolved: omit general `context`, cap
  choices at five, use the request-file CLI contract, and scope visual fidelity to the named content
  slice.
- **Nice-to-know:** Whether a later queue unit should add a stable gate-detail URL. Local selection
  is sufficient for this card and does not block the record, wire, or approved content surface.

## Test Scenarios

1. **Legacy state:** Load a pending gate containing only existing fields. Porch accepts it, the node
   publishes `blockedGateRequest: null`, and the new detail renders the named compatibility state.
2. **Full request:** Record a question with five choices, exactly one recommendation, and terminal
   output containing a warning. State round-trips normalized values, the current node publishes
   them, and the card renders each piece in the approved layout.
3. **Minimal valid request:** Record one choice with no recommendation and no terminal excerpt.
   Optional regions are absent rather than blank, fabricated, or replaced with prose.
4. **No content:** Request a gate without structured content. It still becomes pending and notifies
   the architect as before.
5. **Invalid content:** Reject an empty question, zero or six choices, empty labels or consequences,
   two recommendations, unknown fields, over-limit UTF-8 content, prohibited controls, and an
   over-limit complete request. No partial request is written and the error identifies the field.
6. **Already-pending gate:** Attach valid content after completion made the gate pending, replace it,
   and repeat the same input. The original request timestamp stays stable, the wire exposes the
   latest normalized content, and the identical repeat is idempotent.
7. **Rollback and approval:** Approval preserves historical content but publishes no active request.
   Rollback creates a clean pending cycle with no stale content.
8. **Approval unchanged:** Approving a gate with a request still fails without the explicit human
   flag and follows the existing approval path with it.
9. **Multiple entries:** Historical and other pending gate entries cannot supply content for the
   canonical gate selected by `blockedGate`.
10. **Protocol parity:** Each mirrored gate prompt carries identical structured vocabulary; a
    runtime-resolved protocol absent from the live tree is not treated as drift.
11. **Literal safe rendering:** Markup-like and URL-like text cannot create HTML or active links.
    ANSI is stripped, prohibited control/bidi input is rejected, accepted newlines remain legible,
    and warning-line ochre does not require HTML input.
12. **Client contract drift:** A node with an invalid request enters the established visible
    contract-mismatch state; an absent request alone renders the compatibility card.
13. **Gate-detail lifecycle:** Pointer and keyboard activation open the chosen gate. Back returns to
    the site, and a `gone` or non-gate node update closes the detail automatically.
14. **Visual verification:** Compare the running ticket heading and question/output/choice panels
    with the same slice in `02-gate.png` at the target viewport. Typography, containment,
    background, hierarchy, and status treatment match; source and computed-style checks confirm
    zero chevrons and exactly one direct rust-token use in `.stamp-gate`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Existing state fails after the schema extension | Low | High | Keep request optional and test pre-feature YAML unchanged. |
| Structured input is malformed or partially written | Medium | High | Validate the complete request before the porch-owned atomic write; reject partial content loudly. |
| Terminal content bloats Git state or SSE frames | Medium | High | Enforce per-field UTF-8 limits and a 32 KiB whole-request cap. |
| Display content injects markup, links, controls, or bidi spoofing | Medium | High | Normalize/reject controls at ingress and render literal React text only; test hostile strings. |
| A pending gate briefly exists before content is attached | Medium | Low | Treat `null` as explicit compatibility and augment the same cycle without resetting held time. |
| Protocol copies drift | Medium | High | Mirror vocabulary where both copies exist and enforce parity in tests. |
| Client fabricates or shows stale gate content | Low | High | Derive request from the same pending entry as `blockedGate`; otherwise publish `null`. |
| Card passes tests but misses the approved design | Medium | High | Name the exact mockup slice and require browser side-by-side comparison. |
| Styling dilutes the rust invariant | Medium | High | Use one `.stamp-gate` token reference and derive any same-surface accent through `currentColor`. |
| Prose returns through a catch-all field | Medium | Medium | Omit `context`; keep the schema limited to decision fields and terminal evidence. |

## References

- Issue #128, including the architect ruling selecting porch-owned structured content
- `codev/research/v2-mockups/02-gate.png` and `02-gate.html` — approved gate design
- Spec 83 D3 and D8 — status-to-design mapping and v2 surface boundaries
- Spec 1313 — mailbox-first `afx send` delivery
- Current porch gate-state and v2 builder-node contracts
