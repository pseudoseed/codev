### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy exited with code 1
- codex: REQUEST_CHANGES — Phase 1 is largely complete, but ANSI normalization can delete meaningful terminal evidence.
- claude: APPROVE — Phase 1 meets every acceptance criterion — contract, validation, lifecycle, and legacy compatibility are correct and verified beyond the suite.
- opencode: APPROVE — Phase 1 implementation is complete and correct — the canonical GateRequest contract, validation, normalization, lifecycle, and backward-compatible state all match the spec and plan deliverables.

### Builder Response to Iteration 1
# Phase 1 iteration 1 rebuttals

## Codex — REQUEST_CHANGES

### OSC stripping could delete visible hyperlink text

**Accepted and fixed.** The original OSC expression allowed its body to consume an ST (`ESC \\`)
and backtrack to a later terminator, so two ST-terminated OSC sequences could be treated as one
large escape. In an OSC-8 hyperlink that could remove the visible label between the opening and
closing sequences.

`ANSI_OSC` now stops at the first BEL or ST terminator. Its body accepts neither BEL nor an ESC
that begins ST, while still accepting other characters and non-ST ESC bytes. A regression test
passes an ST-terminated OSC-8 opener, visible link label, ST-terminated closer, and a consecutive
title OSC; normalization now removes each escape independently and preserves
`visible label after text` exactly.

The focused gate-request suite passes with 33 tests and the Codev package typecheck passes after
the change.

## Non-blocking review observations

- Claude's requested maximum-state measurement is now recorded in the builder thread: a maximally
  valid 32,768-byte normalized JSON request adds 29,379 bytes under porch's exact YAML dump options.
- Claude noted that agents consult the porch skill before using the CLI. The four live/skeleton
  porch skill copies will be updated alongside Phase 2's resolver-delivered gate authoring
  guidance, so the new flag is discoverable at the required skill lookup boundary.
- Empty terminal excerpts remain accepted because the approved schema makes the field optional but
  does not specify a non-empty invariant for it. The client can omit the optional panel for an empty
  value without rejecting otherwise schema-valid historical content.


### Iteration 2 Reviews
- gemini: COMMENT — Gemini lane skipped — agy exited with code 1
- codex: REQUEST_CHANGES — Phase 1 is otherwise sound, but terminal normalization still mishandles common ANSI escape families.
- claude: APPROVE — Phase 1 meets every deliverable and acceptance criterion; validation, lifecycle, and legacy compatibility verified in code and by passing tests/builds.
- opencode: APPROVE — Phase 1 is complete and correct — canonical GateRequest contract, validation/normalization, atomic porch gate persistence, lifecycle, and legacy compatibility are all implemented and verified.

### Builder Response to Iteration 2
# Phase 1 iteration 2 rebuttals

## Codex — REQUEST_CHANGES

### Charset and ANSI string-control families were incomplete

**Accepted and fixed.** The earlier sanitizer handled OSC and CSI but its final two-byte expression
was not a complete ECMA-48 escape grammar. It rejected charset selection such as `ESC ( B`, and a
DCS/SOS/PM/APC string could lose only its introducer/terminator while leaving control payload as
fabricated visible evidence.

The sanitizer now processes ANSI in semantic order:

1. OSC strings introduced by 7-bit `ESC ]` or C1 OSC, through their first BEL/ST terminator;
2. DCS, SOS, PM, and APC strings introduced by either 7-bit ESC or C1 forms, through ST, removing
   the complete control payload;
3. CSI sequences in their 7-bit or C1 forms; and
4. general ECMA-48 ESC sequences with zero or more intermediate bytes and a final byte, which
   covers charset designation/reset such as `ESC ( B`.

String/CSI introducers are excluded from the general fallback. An unterminated string therefore
retains its ESC/C1 control and is rejected instead of losing its introducer and exposing its
payload as ordinary text.

New regressions cover `ESC ( B`, an ST-terminated DCS payload, a C1 SOS payload terminated by C1
ST, and an unterminated OSC. The focused gate-request suite passes all 35 tests and the Codev
package typecheck passes.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
