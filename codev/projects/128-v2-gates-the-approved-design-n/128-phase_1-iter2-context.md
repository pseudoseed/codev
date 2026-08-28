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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
