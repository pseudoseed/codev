### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy typically exits 1 in this workspace
- codex: COMMENT — Codex lane skipped — usage limit until 2026-08-27 16:01
- claude: REQUEST_CHANGES — Phase 4's scenarios 3, 8b, 6 and buckets are sound, but scenario 12 — the only proof of C1 — always passes because its git pathspecs are wrong relative to vitest's cwd.
- opencode: COMMENT — Opencode lane timed out after 360s without a verdict

### Builder Response to Iteration 1
# Phase 4 rebuttal — iteration 1

Claude REQUEST_CHANGES HIGH. Gemini skipped, Codex quota-exhausted, opencode timed out. Blocking defect accepted.

## Must-fix

- **Scenario 12 cwd.** Git now runs with `cwd: git rev-parse --show-toplevel`. Routes diff must be non-empty. `origin/main` missing throws with a named error.

## Also accepted

- Scenario 8 connects client B after mutation 50 so it must reconcile a mid-stream snapshot against A's full delta list.
- Sampler stores a bus key plus a filter path list. `watchScope`/`seedScope` take the client's `scopePaths` as the key and `inScope` as the filter, so dark paths do not mint a second key and do not receive `node` deltas.

## Not disputed

None.


### Iteration 2 Reviews
- gemini: COMMENT — Gemini lane skipped — agy typically exits 1 in this workspace
- codex: COMMENT — Codex lane skipped — usage limit until 2026-08-27 16:01
- claude: REQUEST_CHANGES — Iteration-1 scenario-12 defect is genuinely fixed and verified, but `seedScope` lets a dark connect narrow a shared scope filter and emit spurious `gone` frames to already-connected clients.
- opencode: APPROVE — Phase 4 proofs hold; the scenario 12 cwd false-pass is fixed and the idle/convergence/restart/C1 checks pass.

### Builder Response to Iteration 2
# Phase 4 rebuttal — iteration 2

Claude REQUEST_CHANGES HIGH. opencode APPROVE. Blocking defect accepted.

## Must-fix

- **`seedScope` no longer overwrites `filterByScope`.** It unions the new filter with the existing one so a dark second connect cannot shrink a live scope and fire `gone`. Test: live client A receives no `gone` when B connects with `isReadable: false`.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
