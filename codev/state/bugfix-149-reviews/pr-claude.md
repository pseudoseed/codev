I'll read the diff and the surrounding code.Now let me verify the claims against the installed SDK and source.Verified the whole chain rather than taking the PR body at its word.

**What checks out:**
- SDK 0.2.105 typedefs confirm the root cause exactly: `allowedTools` is documented as "auto-allowed without prompting… To restrict which tools are available, use the `tools` option instead" (`sdk.d.ts:1010-1015`), and `tools?: string[] | {preset}` is "the base set of available built-in tools" (`sdk.d.ts:1036-1044`). The fix uses the right knob.
- `disallowedTools` is documented as "removed from the model's context… even if they would otherwise be allowed" — a legitimate belt.
- `OPENCODE_PERMISSION` is a real env var in the installed opencode 1.18.18 binary, and `opencode models` with `{"edit":"deny","write":"deny","patch":"deny","bash":"deny"}` loads config and resolves models cleanly (exit 0), so the extra keys don't trip config validation.
- Env override is child-scoped (`spawn(..., {env: {...process.env, ...}})`), and one of the three tests pins exactly that.
- Tests: 95 passed across both files, 6.39s. The opencode tests are strong — they assert what the *spawned process* saw, including override of a caller-granted `allow`.
- Scope: 134 LOC of source/test, one root cause, no drive-bys.

**Three things worth acting on, none blocking:**

1. **The claude and opencode lanes just lost shell entirely, and the prompts still assume they have it.** `buildImplementationQuery` tells reviewers "If you compute a diff yourself, use `git diff <base>...HEAD`" (`index.ts:2523,2527`) and the PR prompt says "use the Read tool or `cat`". Neither lane can now run git, tests, or `gh`. This review itself used Bash for `gh issue view 149`, `npx vitest run`, and probing the opencode binary — under the fix the claude lane can do none of that. The boundary is still right (an insecure reviewer is worse than a less capable one), but the capability loss is real and undocumented in the PR. opencode supports per-pattern bash permissions (`bash: {"git diff *": "allow", "*": "deny"}`), and the Agent SDK has `canUseTool` for a read-only Bash gate. Worth a follow-up.

2. **"Filed separately" is not yet true.** `gh issue list --search mcp` returns only #149. The MCP-inheritance gap has no issue.

3. **Same misconception survives at `packages/codev/src/commands/doctor.ts:367-374`** — `allowedTools: []` + `bypassPermissions` + `allowDangerouslySkipPermissions`. Blast radius is tiny (`maxTurns: 1`, prompt "Reply OK"), so out of BUGFIX scope, but it is the identical pattern and will read as read-only to the next auditor.

Minor: `consult.test.ts:582-583` asserts `!(permissionMode === 'bypassPermissions' && tools === undefined)`, which is already implied by the `toEqual(['Read','Glob','Grep'])` two lines up. Harmless. Also `codev/state/bugfix-149_thread.md` has uncommitted modifications in the worktree.

---
VERDICT: APPROVE
SUMMARY: Root cause confirmed against the SDK typedefs and the opencode binary; both boundaries are real, tests pass 95/95, scope is tight.
CONFIDENCE: HIGH
---
KEY_ISSUES:
- None blocking. Follow-ups: (a) claude and opencode lanes lose Bash entirely while the shared prompts still instruct `git diff`/`cat` — consider `canUseTool` and opencode bash patterns to restore read-only verification; (b) the MCP-inheritance issue the PR says is "filed separately" does not exist yet; (c) `doctor.ts:367` repeats the `allowedTools`-as-restriction misconception (low risk, out of scope).

PR_SUMMARY: |
  ## Summary
  Fixes #149. Two of the four consult review lanes could write into the workspace they were reviewing; both are now closed with a real tool boundary rather than a permission hint.

  ## Root Cause
  `allowedTools` in the Claude Agent SDK is auto-approval, not a restriction — its own doc says "use the `tools` option instead". Passing `['Read','Glob','Grep']` there alongside `permissionMode: 'bypassPermissions'` left the full Claude Code toolset in context and auto-approved. Separately, opencode's default `build` agent ships `permission: "*" → allow`, which `--auto` does not override. Both were reproduced live: each lane edited the `plan.md` it was asked to review, and the claude lane ran Bash outside its cwd.

  ## Fix
  - claude: `tools: ['Read','Glob','Grep']` on the `query()` call — the actual boundary — plus `disallowedTools` as a belt for SDK builds predating `tools`.
  - opencode: `OPENCODE_PERMISSION` denying `edit`/`write`/`patch`/`bash`, set on the spawned child only, so the user's own sessions and auth are untouched.
  - agy and codex: no code change; headless auto-deny and `sandboxMode: 'read-only'` already closed them. The agy `--add-dir` comment (the issue's prime suspect) was corrected to say it describes reachability, not permission.

  ## Test Plan
  - `consult.test.ts`: the claude lane's `query()` options must carry a restricted `tools` set and a `disallowedTools` belt.
  - `opencode-lane.test.ts`: three tests assert the spawned child sees the denying `OPENCODE_PERMISSION`, that it overrides a caller who granted itself write access, and that the parent env is left alone.
  - 95/95 tests pass across both files.
  - Live verification per lane against a throwaway workspace: claude (through the built CLI) reports no file-editing tool, opencode reports no edit tool, agy auto-denies, codex read-only. File hashes unchanged.

**Action items:**
- File the MCP-inheritance follow-up issue before merge, since the PR body claims it exists
  - `gh issue create --label area/consult --title "Consult review lanes inherit the user's MCP servers, including mutating tools"`
- Decide whether to open a second follow-up for restoring read-only shell to the claude and opencode lanes (`canUseTool` gate; opencode `bash` pattern permissions), since the review prompts at `packages/codev/src/commands/consult/index.ts:2523,2527` still instruct `git diff`
- Commit the pending edit to `codev/state/bugfix-149_thread.md`
  - `git add codev/state/bugfix-149_thread.md && git commit -m "[Bugfix #149] docs: thread log"`Legitimate stop: the `pr` gate is awaiting a human decision, and this session is a **consult review lane**, not the builder.

Acting on the action items would mean writing into the worktree I was asked to review — committing `codev/state/bugfix-149_thread.md`, filing an issue on the builder's behalf. That is precisely the defect PR #187 exists to close (#149). A reviewer that mutates the artifact under review breaks the review.

My output is the verdict, already delivered: **APPROVE**, high confidence, with three non-blocking follow-ups for the builder or architect to act on.

Stopping again.