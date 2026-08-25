# SPIR 128 builder thread

## Specify — draft refinement

- Started from the architect-authored spec on `main`; did not replace its selected architecture.
- Read issue #128's architect ruling: porch-owned structured requests are required; parsing the
  durable `afx send` prose is explicitly rejected.
- The human vetoed the proposed record/wire vs visual split. Architect confirmed the full card is
  back in scope with record, wire, protocol parity, and tests.
- Resolved the two requested design questions: omit the catch-all `context` field and cap structured
  choices at five.
- Restored terminal evidence to the request contract because the approved gate design and issue both
  require the last relevant terminal output; it is optional for gates where no excerpt is relevant.
- Visual implementation is bound to `02-gate` plus Spec 83 D3/D8: Fraunces / Space Grotesk /
  IBM Plex Mono on `#EDE8DE`, zero chevrons, and no rust use beyond `.stamp-gate`.

## Specify — consultation iteration 1

- Porch required four lanes. Gemini quota-skipped; Codex and Claude requested changes; the
  configured opencode/Grok lane was spending-limit blocked, so the required opencode lane was
  completed with the available `opencode/big-pickle` model and approved.
- Reviewers correctly found that no gate-detail card currently exists; the spec now defines the
  accessible local-selection entry/exit lifecycle and scopes fidelity to the ticket heading plus
  question/output/choice panels. Queue rail, unavailable metadata, and approval bar remain out.
- Added the observable `porch gate --request-file` JSON contract, exact lifecycle/idempotency,
  camelCase nested schema, byte limits, terminal normalization, hostile-text rules, exact wire gate
  association, client contract-mismatch behavior, and runtime-resolver-aware parity.
- Reviewers found the older mockup/tokens use IBM Plex Sans and multiple rust references. The newer
  explicit architect direction remains controlling: Space Grotesk and exactly one direct
  `var(--rust)` reference in `.stamp-gate`; same-surface accents can derive via `currentColor`.

## Specify — spec-approval gate

- Consultation feedback is incorporated and rebutted. `porch done` checks passed and auto-requested
  `spec-approval`; stopped for explicit human review.

## Plan — initial draft

- Human approval was relayed by architect `uiv2`; `porch approve` passed the spec checks and entered
  plan. The boundary self-refresh was attempted exactly as requested but refused safely because the
  Codex harness has no in-session reset; `uiv2` was notified and work continued with context intact.
- The plan uses four sequential commits: porch record/CLI, resolver-delivered protocol guidance,
  exact-gate v2 wire, and the accessible content card.
- Retained the approved 16 KiB terminal cap deliberately: it preserves a complete diagnostic slice,
  while the 32 KiB request cap bounds state/SSE cost. Phase 1 records actual enriched state size.
- Visual acceptance names the central `02-gate` content slice exactly and makes a 1440×1080 browser
  screenshot side-by-side (ticket heading, question, terminal, choices; excluding queue/global
  chrome/metadata/decision bar) a required step before PR approval.

## Plan — consultation iteration 1

- Gemini quota-skipped; Codex and Claude requested changes. The configured opencode/Grok lane was
  spending-limit blocked, `big-pickle` timed out, and the required lane completed/approved with
  `opencode/nemotron-3.5-lightning-free`.
- Accepted the core parser finding: nested request YAML will use `js-yaml`, not extensions to the
  overview regex parser. Malformed values remain `unknown` through one documented serialization
  seam so the client can distinguish invalid from absent.
- Made v2's new `blockedGate` field explicit (required nullable on every node alongside the request),
  preserved the exported `detectBlocked*` wrappers, and added aggregate 500-frame replay measurement.
- Resolved the rust mechanics explicitly: a child `.stamp-gate` cannot color its parent. The older
  solid rust row border becomes neutral while 3px containment, pulse, and rust stamp preserve
  findability under the newer exactly-one-token constraint.
- Split the client work into semantic/live behavior and visual/browser-fidelity commits, yielding
  five machine-readable phases.

## Plan — plan-approval gate

- Iteration-1 rebuttals and all accepted review changes are committed in `2cef95880`.
- `porch done` checks passed and requested `plan-approval`; stopped for explicit human review.
- All gate/completion messages continue to target `architect:uiv2` explicitly because bare
  `architect` misroutes to `main` until issue #47 lands.
