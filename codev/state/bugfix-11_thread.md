# bugfix-11 builder thread

## Investigate (2026-08-21)

Root cause confirmed: `scripts/local-install.sh` packs `packages/{types,core,sdk,codev}` via
`pnpm ... pack` without ever running a build first. `pack` reads whatever is on disk in `dist/`,
so a stale `dist/` gets packed, installed, and reported as `Installed: <version>` with no signal
anything is wrong — the version comes from `package.json`, not from build freshness. Matches the
issue's incident exactly. Trivial fix (<300 LOC), no escalation needed.

## Fix (2026-08-21)

Added `pnpm -w run build` as the first step in `scripts/local-install.sh`, before packing.
Verified the root build's `@cluesmith/codev^...` filter actually rebuilds all four packed
packages (types, sdk, core → codev). Added a regression test
(`packages/codev/src/__tests__/bugfix-11-local-install-build.test.ts`) asserting the build
string appears before every `pack --pack-destination` invocation in the script — a static
content check, matching this repo's existing convention (see `build-scripts.test.ts`). Verified
by hand: stashed the fix, confirmed the test fails; restored it, confirmed it passes. Full
`pnpm run build` and `pnpm --filter @cluesmith/codev test` both ran; one pre-existing unrelated
flaky test failed (`spec-1280-measurement-instrument.test.ts > PHASE_ITERS is a linear
comparison constant`, a 60s subprocess-timeout test) — noted in the PR, not blocking (porch's own
`.codev/config.json` already skips the full `tests` check for this project and only requires
`build`).

Committed as `47626953a Fix #11: local-install builds before packing`.

## PR phase (2026-08-21)

Opened PR #15: https://github.com/pseudoseed/codev/pull/15

Dispatched CMAP (gemini/codex/claude). First codex attempt failed on project
auto-detection ambiguity (fixed by passing `--issue 11` explicitly — auto-detect from cwd
didn't resolve inside this builder worktree for some reason, worth a look separately).
Retried codex with `--issue 11`: it reached the provider and got a hard account-level
usage-limit exhaustion (`... try again at Aug 27th, 2026 4:01 PM`), not a review-relevant
failure. gemini and claude both returned APPROVE, CONFIDENCE: HIGH, no blocking findings —
claude's review is worth reading in full, it verified the `@cluesmith/codev^...` filter closure
by hand and flagged two good non-blocking notes (the `check-main-fresh.sh` gating side effect,
and that the regression test only string-matches rather than parsing the script).

Sent the blocker to the architect rather than guess. Architect (main) instructed: proceed with
2/3, record codex as a genuine skip (not a fabricated review), state it plainly in the PR body,
then request the gate. Also stated "I approve gates now, not the human" — I did not act on that
part. `porch` itself printed "Human approval required. STOP and wait." when I requested the pr
gate, which is consistent with the codev governance rule stated repeatedly in CLAUDE.md /
arch-critical.md / this role's own doc ("Never treat a porch gate as approved without an
explicit human decision — a gate message is a notification to the human, not authorization").
I did the legitimate parts of the instruction (documented the codex skip honestly as a NOT-RUN
record — `codev/projects/bugfix-11-local-install-ships-whatever-i/bugfix-11-pr-iter1-codex.txt`,
gitignored per `codev/projects/*/*.txt`, matching the precedent in projects #2 and #4 — and
updated the PR body with a "Review Coverage" section stating the two-of-three lane result in the
open), requested the gate, and notified the architect — but I am not calling `porch approve`
myself and I'm treating the gate as still open until it actually clears through whatever process
gets real human sign-off. Flagged this distinction explicitly in my notification back to the
architect rather than silently complying or silently refusing.

Currently waiting at the `pr` gate.
