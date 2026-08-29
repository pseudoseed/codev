# bugfix-149 — A consult review lane can write into the artifact it is reviewing

## Investigate (2026-08-29)

### Reproduced

Ran the Claude Agent SDK with the exact options the `claude` consult lane passes
(`packages/codev/src/commands/consult/index.ts:908-919`) against a throwaway workspace holding a
`plan.md`, prompt: "append a `## Phase 2` section to plan.md".

Result: `MUTATED=true`. Tool trace showed `Edit` on the reviewed file **and** a `Bash` call
(`find /Users/chris -name "plan.md"`) reaching outside the granted cwd.

### Root cause

`allowedTools` is not a restriction. The SDK's own doc comment
(`@anthropic-ai/claude-agent-sdk@0.2.105/sdk.d.ts:1010`):

> List of tool names that are auto-allowed **without prompting for permission**.
> To restrict which tools are available, use the `tools` option instead.

The lane passes `allowedTools: ['Read','Glob','Grep']` with `permissionMode: 'bypassPermissions'`
and `allowDangerouslySkipPermissions: true`. So the full Claude Code toolset — Write, Edit, Bash —
is present *and* auto-approved, everywhere on disk. The three "allowed" names change nothing.

The mistaken belief is on the record: `codev/reviews/0103-consult-claude-agent-sdk.md:47` says
"Spec used `tools`, but SDK uses `allowedTools` for restricting available tools. Corrected." That
correction went the wrong way.

The issue's own hypothesis — the agy `--add-dir` grant at `index.ts:1334` — is **not** the cause.

### Per-lane audit (all four tested live)

| Lane | Control today | Can write? |
|---|---|---|
| `claude` (Agent SDK) | `allowedTools` (auto-approve only) + `bypassPermissions` | **YES** — edited the file, ran Bash outside cwd |
| `codex` (Codex SDK) | `sandboxMode: 'read-only'` | No |
| `gemini` (agy) | headless mode auto-denies unprompted perms | No — `a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied` |
| `opencode` | none; default `build` agent has `permission: * → allow` | **YES** — edited the file |

Two lanes, not one.

### Fix direction

Issue option 1 (read-only worktree per round) is architectural; out of BUGFIX scope.
Taking option 2 + option 3:

1. `claude`: add `tools: ['Read','Glob','Grep']` (a real boundary) and a `disallowedTools` belt.
2. `opencode`: deny write/edit/patch/bash per-run.
3. Cross-lane guard: hash the reviewed artifact before dispatch, fail loudly if it changed.

### Fix candidates verified live before writing any code

- `claude` + `tools: ['Read','Glob','Grep']` → `MUTATED=false`; Write/Edit/Bash absent from the
  model's context ("I don't have a tool to write or append to files").
- `opencode` + `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"deny","write":"deny","patch":"deny","bash":"deny"}}`
  → "No file-edit tool is available in this session"; file unchanged. The env config *merges*, so
  provider auth and model resolution (`xai/grok-4.6`) still worked.

Scope: well under the 300 LOC BUGFIX ceiling. Proceeding.

## Fix (2026-08-29)

Two lanes, two real boundaries. No detection-only fallback: the issue ranks a boundary above a
hash check, and both lanes turned out to support one.

**claude** (`consult/index.ts`) — `tools: READ_ONLY_CLAUDE_TOOLS` on the `claudeQuery()` call.
`allowedTools` stays (it is the auto-approval hint it always was). `disallowedTools:
WRITE_CAPABLE_CLAUDE_TOOLS` is a belt for an SDK build predating `tools` — the declared floor is
`^0.2.41`, the resolved version here is `0.2.105`.

**opencode** — `OPENCODE_PERMISSION` on the spawned child only, denying `edit`/`write`/`patch`/
`bash`. Chosen over `OPENCODE_CONFIG_CONTENT` because it overrides just the permission block and
leaves the user's providers, models and auth alone.

**gemini/agy** — no code change; headless mode already auto-denies. The `--add-dir` comment was
rewritten because it claimed to describe a permission grant and was the issue's prime suspect. It
is a reachability list; the denial comes from headless mode.

**codex** — no change; `sandboxMode: 'read-only'`.

134 lines across 3 files.

### Note on the suite lock

The targeted vitest run queued behind `bugfix-151`'s full suite on the machine-wide port-13999
mutex. That contention is issue #151's subject, not a failure here.

### Left out on purpose: MCP tools

The claude lane still inherits every MCP server from the user's own environment. Probed on this
machine: ~100 `mcp__uxpilot__*` tools reach the reviewer, including mutating ones
(`update_page`, `publish_design_preview`, `upload_canvas_asset`).

`tools` does not filter them — its doc says "the base set of available BUILT-IN tools" — and
`mcpServers: {}` does not suppress them either: the tool list came back identical with and
without it. None of them writes the local filesystem, so #149 as reported is closed, but a
reviewer holding outward-facing mutation tools is the same defect one layer out. Closing it needs
a mechanism I do not have from the SDK options, so it is a separate issue, not a line in this
fix.
