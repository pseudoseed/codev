# spir-83 thread

Spec 83 already on disk and approved (rev. 11, 2026-08-24). Issue #83 has no Baked Decisions section. Porch is in plan.

Plan drafted at `codev/plans/83-v2-client-shell.md`. Five phases: static serving / packaging, reducer, stream client, site view, Playwright fixture. No live-Tower e2e; `gone` is a fixture frame. FR-3 and FR-15 stay unmet per D13/D5 (#97, #98).

Iter 1 reviews: gemini skipped, claude COMMENT, opencode COMMENT, codex REQUEST_CHANGES. All REQUEST_CHANGES accepted. Plan updated. Rebuttal at `codev/projects/83-v2-client-shell-apps-v2-render/83-plan-iter1-rebuttals.md`.

Plan-approval: architect:uiv2 under standing delegation. Refresh at enter:implement refused (opencode has no in-session clear). Continuing.

Phase 1 done: `2c9777a0b` plus NODE_ENV fix `8489c45ca`. Reviews: gemini skip, codex APPROVE, claude COMMENT (fixed), opencode APPROVE.

Phase 2: validate.ts + reducer.ts. 47 client tests green. `passWithNoTests` removed.

Phase 3: bootstrap + SSE reader + stream client. 100 v2 tests green.

Iter 1: gemini skip, codex/claude/opencode REQUEST_CHANGES. All accepted (unreachable vs mismatch, forceFresh, cancel SSE, emit copy, wait TDZ, applied-eof).

Iter 2: gemini skip, claude APPROVE, codex REQUEST_CHANGES (`res.text()` on 200 → mismatch; fixed). Opencode consult CLI cannot read its temp prompt (external_directory). Review written against disk files: APPROVE.

Phase 4 on 3ff35f22a. Phase 5: fixture server + 14 Playwright tests green. cold-load-ms=137.

Phase 5 iter 2: Claude/opencode APPROVE. Codex REQUEST_CHANGES accepted except idle CDP (spec says measure/print, not assert). Resume now records since/stream/mode + sentinel; GATE/STALLED computed colours; two-page tree dump. 14 e2e still green.

Phase 5 iter 3: Codex/Claude/opencode APPROVE. Refresh at enter:review refused (opencode has no in-session clear). Architect verified phase 5; screenshot defect: workspace header `ALPHARUN`. Fixed `.ws-plot-name` flex+gap; name wrapped; 124 unit tests. Review at `codev/reviews/83-v2-client-shell.md`. idle-Bps=0 recorded as no-polling evidence.

Review iter 1: gemini skip, opencode APPROVE, Codex/Claude REQUEST_CHANGES. Merged origin/main (spec rev. 12). Accepted CI step, drop frozen-files test, rename packaging to e2e, orphan render, architect-parented coverage, sourcemap off. Cache-Control left. PR #104.
