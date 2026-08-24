# spir-83 thread

Spec 83 already on disk and approved (rev. 11, 2026-08-24). Issue #83 has no Baked Decisions section. Porch is in plan.

Plan drafted at `codev/plans/83-v2-client-shell.md`. Five phases: static serving / packaging, reducer, stream client, site view, Playwright fixture. No live-Tower e2e; `gone` is a fixture frame. FR-3 and FR-15 stay unmet per D13/D5 (#97, #98).

Iter 1 reviews: gemini skipped, claude COMMENT, opencode COMMENT, codex REQUEST_CHANGES. All REQUEST_CHANGES accepted. Plan updated. Rebuttal at `codev/projects/83-v2-client-shell-apps-v2-render/83-plan-iter1-rebuttals.md`.

Plan-approval: architect:uiv2 under standing delegation. Refresh at enter:implement refused (opencode has no in-session clear). Continuing.

Phase 1 implementing: apps/v2 scaffold, v2-static, isPublicRoute, copy-v2. Frozen C1/C2 files unchanged (git diff --stat empty). New v2 unit tests + existing v2 suite 86/86. Full codev suite needs `pnpm --filter @cluesmith/codev build` first (skeleton/dist); that is porch's build check.
