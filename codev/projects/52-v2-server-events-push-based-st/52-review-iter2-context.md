### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy typically exits 1 in this workspace
- codex: COMMENT — Codex lane skipped — usage limit until 2026-08-27 16:01
- claude: REQUEST_CHANGES — Design and C1 compliance are solid and the build passes, but scenario 12 fails CI now and can never pass on main.
- opencode: COMMENT — Opencode lane timed out after 360s without a verdict

### Builder Response to Iteration 1
# Review rebuttal — iteration 1

Claude REQUEST_CHANGES HIGH. CI red on scenario 12. Accepted.

## Must-fix

- Scenario 12 no longer uses `git merge-base`. It asserts the working-tree source: one `/v2/` prefix, no `handleV2Route` in `tower-server.ts` / `pty-session.ts`.
- `parseScope` now splits the raw query on unencoded commas, then `decodeURIComponent` each segment. A path containing `%2C` stays one path.

## Not doing

- Delete the stub review file: porch greps `v2-server-events-push-based-st.md` for the Architecture/Lessons headings.
- Sampler lifecycle / scope eviction: already named as follow-ups.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
