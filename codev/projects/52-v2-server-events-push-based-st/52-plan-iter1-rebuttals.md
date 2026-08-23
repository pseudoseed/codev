# Plan rebuttal — iteration 1

Gemini and Codex did not review (agy skip; Codex usage limit until 2026-08-27). Claude and opencode both REQUEST_CHANGES HIGH. Every named defect is accepted and is now in the plan.

## Claude

- **`spawnedByArchitect` always null from `discoverBuilders`.** Accepted. Phase 1 `V2Deps` now includes `getBuilders` (`state.ts:279`). Join is `row.worktree === discovered.worktreePath` (full path). New AC: a non-null `spawnedByArchitect` that matches an in-projection architect must parent there, so 9f cannot hide a skipped join.
- **Snapshot/subscribe ordering across `getRehydratedTerminalsEntry`.** Accepted. Shared rule: subscribe first with a queue, snapshot, flush `seq > snapshot.seq`.
- **`listWorkspaces` vs `getKnownWorkspacePaths`.** Accepted. `listWorkspaces()` is the injected dep; default binding is `getKnownWorkspacePaths()` minus `/.builders/` paths.
- **`makeReq` / `makeRes` / `makeCtx` not exported.** Accepted. Phase 2 now says copy, not reuse or extract.
- **`lastDataAt` line.** Accepted. `:823`.
- **Architect `heldMail` case.** Accepted. `to_agent` compared case-insensitively.

## Opencode

- **Default `V2Deps` never enrich `spawnedByArchitect`.** Same fix as Claude.
- **Pause + keep-buffer lies on last-client resume.** Accepted. Compare loop starts on first `/v2/events` and does not pause. Tick still fans only to connected scopes. New Phase 3 test: disconnect the only client, mutate, resume in-window, expect the missed deltas.
- **`dark` is a handshake.** Accepted. Same cursor rules as `snapshot` / `resumed`: no increment, not buffered, emitted per connect.

Also accepted from both: do not rehydrate unknown/dark paths (`getRehydratedTerminalsEntry` would mint a workspace via `getWorkspaceTerminalsEntry`). Criterion 5 now has an explicit AC (`buckets` length 20 on snapshot builders).
