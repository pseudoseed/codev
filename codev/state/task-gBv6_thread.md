# Phase 13 — Extension retirement

- Read the approved spec's “Extensions and adopters” decision and the authoritative Phase 13
  plan in the parent builder worktree before editing.
- Deleted `apps/streamdeck`; upstream does not touch that tree.
- Retained `apps/vscode`, but excluded it from pnpm workspace discovery, root npm packaging,
  CI, and release versioning. Its README now identifies it as unsupported. Removed the deleted
  Stream Deck plugin's CI canary and release hooks so clean CI and the release protocol do not
  address nonexistent paths.
- Added an integration test that inspects a real `npm pack` tarball and checks pnpm's resolved
  workspace members, so removing the `apps/*` glob or shipping either extension fails visibly.
- Routed the current-state architecture update and durable merge-cost lesson to the cold
  governance docs. The hot tiers did not change: this retirement is reference context rather
  than an always-on behavior-changing fact, and no top-level cold-doc heading changed.
