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

## Implement — Phase 1: validated porch gate-request record

- Added the neutral `GateRequest` contract and optional porch `GateStatus.request`, retaining the
  camelCase nested request under existing snake_case gate timestamps.
- `porch gate [id] --request-file PATH` now parses strict UTF-8 JSON, normalizes and validates the
  entire request before state mutation, attaches or replaces content without resetting held time,
  and skips identical writes. Flag-free gate requests and human approval retain attached history.
- Validation enforces one-to-five choices, recommendation cardinality, unknown-key rejection,
  field and whole-request UTF-8 byte limits, decision trimming, CRLF/ANSI terminal cleanup, and
  control/bidi rejection (including prohibited content hidden inside ANSI sequences).
- Automatic fresh gate cycles and rollback clear stale request content; both explicit and
  pre-approved artifact approval paths preserve the current cycle's request.
- Targeted porch coverage passes (157 tests), as do the types and full Codev builds. A full suite
  run before the final lifecycle assertions passed 6,088 Codev tests and 167 v2 tests; all tests
  touched after that run were rerun targeted.
- Commit-weight measurement using porch's exact `js-yaml` dump options: a maximally valid 32,768-byte
  normalized JSON request adds 29,379 bytes to the representative status YAML (312-byte baseline,
  29,691 bytes enriched). This supports retaining the 16 KiB excerpt while keeping the explicit
  whole-request cap; Phase 3 still measures aggregate replay/SSE cost.
- Phase 1 review noted that the four live/skeleton porch skill copies also need the new CLI flag.
  Carry those resolver-facing command docs into Phase 2 with the protocol guidance so agents that
  obey the mandatory skill lookup can discover `--request-file`.

### Phase 1 consultation iteration 1

- Gemini quota-skipped; Claude and the fallback opencode `mimo-v2.5-free` lane approved. Codex
  found that the first OSC regex could greedily span two ST-terminated sequences and delete an
  OSC-8 hyperlink's visible label.
- Accepted and fixed the finding: OSC stripping now stops at the first BEL/ST terminator, with a
  regression covering an OSC-8 opener/label/closer followed by a consecutive title sequence.
- The iteration-1 rebuttal records the fix and the focused gate-request suite now passes 33 tests;
  the post-fix porch checks passed the full build and test suite.

### Phase 1 consultation iteration 2

- Gemini quota-skipped; Claude and fallback opencode approved. Codex correctly identified that
  OSC/CSI plus a two-byte ESC pattern did not fully sanitize charset and string-control families.
- Accepted and fixed: DCS/SOS/PM/APC now remove their complete ST-terminated payload in 7-bit and
  C1 forms, OSC handles 7-bit/C1 terminators, general ESC grammar handles charset selection such
  as `ESC ( B`, and unterminated strings retain a control byte so validation rejects them rather
  than fabricating visible payload.
- Added regressions for charset reset, DCS, C1 SOS/ST, and unterminated OSC. The focused validator
  suite passes 35 tests and the package typecheck passes; details are in the iteration-2 rebuttal.

## Implement — Phase 2: resolver-delivered gate authoring guidance

- Added one byte-identical live/skeleton `protocols/shared/gate-request.md` fragment with the JSON
  shape, request-file command, optionality, single-line decision rules, terminal cleanup guidance,
  workspace-relative path behavior, no-approval boundary, and mandatory separate `afx send` notice.
- Wired it through resolver includes for every bundled human gate: SPIR spec/plan/PR, PIR
  plan/dev/PR, ASPIR PR, AIR PR, BUGFIX PR. SPIR/ASPIR builder prompts deliver the same fragment for
  promptless verify-approval, and builder-prompt loading now resolves includes at spawn.
- Extended the mandatory porch skill discovery surface in both Claude/Codex live and skeleton
  twins, preserving each existing twin's byte parity. Already-pending gate tasks now explain
  optional same-cycle augmentation before the hard STOP.
- New Spec 128 tests cover vocabulary delivery, all live/skeleton protocol twins, skill twins,
  skeleton-only fresh-install resolution, builder-prompt spawn resolution, and pending-task order.
  The Codev build passes and 377 targeted resolver/protocol regression tests pass.
- The first post-fix porch check reported the tests command failed but surfaced no assertion (only
  npm config warnings). The identical full command immediately passed 6,127 Codev tests and 167 v2
  tests; no test name was available to annotate or skip. Treat as an unnamed transient unless it
  reproduces with an identifiable producer.
- The subsequent porch check passed build and the complete test suite. Phase consultation approved
  in Codex, Claude, and fallback opencode (`opencode/hy3-free`); Gemini quota-skipped. Non-blocking
  feedback noted that the shared fragment could advertise byte limits and scratch-file cleanup,
  but found the delivered contract accurate and the full phase implementation complete.

## Implement — Phase 3: exact-gate v2 wire projection

- Overview now decodes only nested gate request values with `js-yaml` while retaining its legacy
  scalar parser. One canonical-order selection returns gate, display label, requested time, and the
  raw request together; the exported `detectBlocked*` functions remain wrappers over that seam.
- The overview carrier keeps request content `unknown | null`. Projection deliberately casts only
  at the Tower serialization seam so structurally malformed YAML values remain visible and the v2
  client rejects the enclosing frame instead of converting it into the legacy-null state.
- Every v2 node now carries required nullable `blockedGate` and `blockedGateRequest` fields. Builder
  request-only changes participate in sampler comparison/deltas and buffered resume; workspace and
  architect nodes always project both as null.
- The client validator imports `GateRequest` and `GATE_REQUEST_LIMITS` from `codev-types`, rejects
  missing/extra/hostile nested values and invalid gate/request associations, and returns the
  canonical request. Reducer cloning preserves request content through snapshot/delta reduction.
- Aggregate JSON measurement uses a request exactly at the 32,768-byte whole-request cap (3,623
  backslashes make JSON escaping, rather than independent field caps, load-bearing): one node frame
  is 32,986 bytes; a realistic heavily loaded 20-builder snapshot is 659,804 bytes; its
  `lastByScope` map is 660,231 bytes; 500 maximal replay frames total 16,493,892 bytes. This remains
  below the locked 16 MiB replay bound, so no tighter buffer mitigation is necessary.
- Verification receipts: 256 targeted Tower/server tests and all 180 v2 tests pass; types tests,
  v2 production build, and full Codev build pass. The complete package suite passes 6,138 Codev
  tests (48 skipped) plus all 180 v2 tests.
- The unnamed porch-check transient from Phase 2 recurred on the first Phase 3 `porch done`: the
  219-second test command returned nonzero while porch again surfaced only npm config warnings and
  no failing test. The exact check command was immediately rerun with a complete captured log and
  passed 6,139 Codev tests (48 skipped) plus 180 v2 tests. There is still no named producer that can
  responsibly be annotated or skipped.
- Phase 3 consultation approved in Codex, Claude, and fallback opencode (`opencode/hy3-free`);
  Gemini quota-skipped. Claude measured the unconditional YAML decode as a non-blocking ~67 µs per
  current 3.4 KiB status file versus ~6 µs for the scalar scan. The implementation keeps it simple
  for now: the sampler needs exact nested YAML semantics, atomic porch writes make parse failure
  exceptional, and the existing comment explicitly documents fallback to unavailable enrichment.

## Scope change after Phase 3

- Architect `uiv2` stopped client implementation after Spec 146 landed on `main`: Codev is replacing
  v2 with a new client on a self-hosted t3code server. Phase 4 had not started, so no partial semantic
  gate card was present to finish.
- The PR therefore contains the completed and consulted Phases 1–3 only. Phase 5 is **cancelled by
  Spec 146**, not deferred; Phase 4 is also intentionally unimplemented because its only consumer was
  the retiring v2 client.
- The structured porch record and resolver-delivered authoring guidance remain prerequisites for the
  replacement client. The already-committed v2 wire projection is retained as harmless transition
  work per the architect's explicit instruction.
