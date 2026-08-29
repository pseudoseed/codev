---
VERDICT: APPROVE
SUMMARY: Focused, correct fix establishes read-only boundaries for Claude and OpenCode lanes with appropriate regression coverage.
CONFIDENCE: HIGH
---
KEY_ISSUES:
- None

PR_SUMMARY: |
  ## Summary
  Fixes #149. Prevents Claude and OpenCode consultation lanes from modifying the workspace they review.

  ## Root Cause
  Claude’s `allowedTools` only bypassed permission prompts rather than restricting available tools. OpenCode’s default agent configuration allowed mutation tools.

  ## Fix
  Restrict Claude’s built-in tools to `Read`, `Glob`, and `Grep`, with explicit write-capable tool denials as defense in depth. Pass child-scoped OpenCode permissions denying edit, write, patch, and shell execution.

  ## Test Plan
  - Verify Claude query options enforce the restricted toolset.
  - Verify the OpenCode child receives denying permissions, overrides caller grants, and does not mutate the parent environment.
  - Live-probe both lanes against throwaway workspaces and confirm file hashes remain unchanged.