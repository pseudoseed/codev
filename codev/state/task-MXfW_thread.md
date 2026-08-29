# Phase 13 — Extension retirement

## 2026-08-28 — Recovery and verification

- Fetched `origin/builder/task-gBv6` as directed. The named tip `3ebc6cc30` was a porch-only
  status commit; the preserved Phase 13 implementation was its ancestor `dd6af847c`. Read that
  commit before cherry-picking it. Resolved its lock/workspace conflict against current `main`
  by retaining current workspace members, adding the required `!apps/vscode` negation, and
  regenerating `pnpm-lock.yaml` from current `main`.
- Opened and checked the approved spec's `Extensions and adopters` section and the authoritative
  Phase 13 plan in the parent `spir-146` worktree. The plan was read only.
- Audited the recovered changes rather than accepting them on provenance. `apps/streamdeck` is
  absent; `apps/vscode` remains, has the unsupported warning, and is excluded from pnpm workspace
  discovery, CI, release versioning, and root packaging. Active Stream Deck-only CI and release
  paths were removed. Governance changes are in the cold `arch.md` and `lessons-learned.md`; the
  capped hot files are unchanged.
- Verified `pnpm list --recursive --depth -1 --json`: `apps/web` and `apps/v2` resolve as workspace
  members while VS Code and Stream Deck do not.
- Ran a fresh real `npm pack`, listed the resulting tarball, and found zero
  `package/apps/{vscode,streamdeck}/` entries. The tarball retained
  `package/apps/web/package.json` and `package/apps/v2/package.json` (3,160 total entries).
- The phase regression test passed: 1 file, 3 tests. `pnpm build` passed and built the supported
  web/v2 apps without VS Code.

## Flaky Tests

- The full `pnpm test` run reached 6,161 passing tests but failed one unrelated pre-existing
  teardown race: `spawn-gate-profile.test.ts` raised `ENOTEMPTY` while deleting a real spawned
  builder worktree. The test passed immediately in isolation (6/6). The integration branch already
  contains the bounded `rmSync(..., maxRetries: 20, retryDelay: 100)` fix from Phase 3, so this
  Phase 13 branch does not duplicate or conflict with that owned fix.

## 2026-08-28 — Review correction

- Ran the configured three-lane implementation review after code and tests. Gemini skipped without
  reviewing because its headless command permission was unavailable. Claude approved with
  non-blocking cleanup findings. Codex requested changes for three active release leftovers and
  one inaccurate architecture sentence inherited from the parent branch context.
- Opened every cited file. Removed the stale deleted-canary instruction, the standalone VS Code
  Marketplace bump script, and VS Code release workflow text from both the working release notes
  and its template. Corrected `arch.md` to describe the packages that exist on this branch, and
  updated the hot-tier map entry (without adding a hot fact) so it routes readers to the retained
  unsupported source accurately.
- Strengthened the regression suite: it now requires the Stream Deck directory and VS Code bump
  script to be absent and checks the active release surfaces for extension hooks. The revised
  phase test passes 5/5.
- Review round 2: Gemini again skipped without reviewing; Claude approved. Codex found one remaining
  blocking cold-doc problem: a historical Stream Deck lesson still gave present-tense build/link
  commands and claimed CI built both extensions. Rewrote it as explicitly historical while
  preserving the durable multi-artifact verification lesson. Added a direct regression assertion
  that the deleted SDK canary workflow stays absent, and documented the resulting published-SDK
  coverage gap in cold `arch.md`. The phase suite remains 5/5.
- Review round 3 (the final review round): Gemini skipped, Codex approved without findings, and
  Claude found one active-context defect after confirming all prior blockers were resolved. The
  issue taxonomy still invited agents to file new `area/streamdeck` work against a deleted path and
  presented VS Code as a supported area. Removed the retired Stream Deck area and narrowed VS Code
  to retained-source/upstream-merge maintenance in both `CLAUDE.md` and `AGENTS.md`; verified the
  twins remain byte-identical.
