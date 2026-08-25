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
