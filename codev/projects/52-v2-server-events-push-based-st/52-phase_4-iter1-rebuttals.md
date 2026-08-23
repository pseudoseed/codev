# Phase 4 rebuttal — iteration 1

Claude REQUEST_CHANGES HIGH. Gemini skipped, Codex quota-exhausted, opencode timed out. Blocking defect accepted.

## Must-fix

- **Scenario 12 cwd.** Git now runs with `cwd: git rev-parse --show-toplevel`. Routes diff must be non-empty. `origin/main` missing throws with a named error.

## Also accepted

- Scenario 8 connects client B after mutation 50 so it must reconcile a mid-stream snapshot against A's full delta list.
- Sampler stores a bus key plus a filter path list. `watchScope`/`seedScope` take the client's `scopePaths` as the key and `inScope` as the filter, so dark paths do not mint a second key and do not receive `node` deltas.

## Not disputed

None.
