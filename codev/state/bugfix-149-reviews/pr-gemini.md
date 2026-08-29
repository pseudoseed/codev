### Review Assessment: PR #187 (BUGFIX #149)

#### 1. Code Quality & Correctness
- **Claude Agent SDK Lane**: Correctly configures `tools: READ_ONLY_CLAUDE_TOOLS` (`['Read', 'Glob', 'Grep']`) on [`runClaudeConsultation`](file:///Users/chris/dev/codev-1455/.builders/bugfix-149/packages/codev/src/commands/consult/index.ts#L918-L947) as the true capability boundary. Adding `disallowedTools: WRITE_CAPABLE_CLAUDE_TOOLS` provides effective defense-in-depth across SDK version differences.
- **OpenCode Lane**: Correctly injects `OPENCODE_PERMISSION` denying `edit`, `write`, `patch`, and `bash` into the child process environment in [`runOpencodeConsultation`](file:///Users/chris/dev/codev-1455/.builders/bugfix-149/packages/codev/src/commands/consult/index.ts#L1801-L1811) without polluting the parent process environment.
- **Gemini / Agy Comments**: Accurately clarifies that `--add-dir` establishes path reachability while headless mode handles permission auto-denial.

#### 2. Scope Discipline & Cleanliness
- Strict focus on resolving workspace mutation risks across review lanes.
- Net code footprint is minimal (~50 lines in [index.ts](file:///Users/chris/dev/codev-1455/.builders/bugfix-149/packages/codev/src/commands/consult/index.ts)).
- The MCP server inheritance boundary is documented and scoped cleanly to a follow-up issue rather than inflating this bugfix.

#### 3. Test Coverage & Verification
- [consult.test.ts](file:///Users/chris/dev/codev-1455/.builders/bugfix-149/packages/codev/src/__tests__/consult.test.ts#L558-L565) validates the `tools` and `disallowedTools` boundaries for the Claude lane.
- [opencode-lane.test.ts](file:///Users/chris/dev/codev-1455/.builders/bugfix-149/packages/codev/src/commands/consult/__tests__/opencode-lane.test.ts#L153-L184) validates that `OPENCODE_PERMISSION` is passed to the spawned process, overrides parent environment grants, and preserves parent environment isolation.

---
VERDICT: APPROVE
SUMMARY: Correctly restricts tool capabilities and permissions across Claude and OpenCode consult lanes with solid regression test coverage.
CONFIDENCE: HIGH
---
KEY_ISSUES:
- None

PR_SUMMARY: |
  ## Summary
  Fixes #149. Enforces strict read-only tool boundaries on Claude and OpenCode consultation lanes to prevent reviewers from mutating reviewed workspace artifacts or executing shell commands.

  ## Root Cause
  The Claude consult lane supplied `allowedTools: ['Read', 'Glob', 'Grep']` with `bypassPermissions`, which only bypassed prompting for those tools without restricting tool availability (the full tool suite remained available). The OpenCode lane defaulted to `permission: "*"` (`allow`), permitting file mutations and bash executions during consultation runs.

  ## Fix
  - Configured `tools: READ_ONLY_CLAUDE_TOOLS` and `disallowedTools: WRITE_CAPABLE_CLAUDE_TOOLS` on the Claude Agent SDK query options.
  - Injected `OPENCODE_PERMISSION` denying `edit`, `write`, `patch`, and `bash` into spawned OpenCode child processes.
  - Clarified documentation on agy `--add-dir` reachability semantics and headless mode write denials.

  ## Test Plan
  - Regression test in `packages/codev/src/__tests__/consult.test.ts` verifying `tools` and `disallowedTools` on Claude consult queries.
  - Unit tests in `packages/codev/src/commands/consult/__tests__/opencode-lane.test.ts` verifying child process `OPENCODE_PERMISSION` propagation, override behavior, and parent env isolation.
  - Live probe verification against throwaway workspaces confirming mutation attempts are rejected.