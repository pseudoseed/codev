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
