# bugfix-264 — gate-approval notification crosses workspaces

## Investigate (2026-08-31)

### Reproduced, twice, deliberately

Built a throwaway porch project in a temp workspace:
`<scratch>/repro-ws/.builders/fake-264/codev/projects/264-repro/status.yaml`,
protocol `air`, one pending gate `pr`. Ran `porch approve 264 pr
--a-human-explicitly-approved-this` from `<scratch>/repro-ws`.

**Run 1** (my normal builder env): the message
`Gate pr approved — please run porch next to advance.` landed in
`builder-bugfix-264`'s pane in `/Users/chris/dev/codev-1455`. My real
`bugfix-264` project's `pr` gate stayed `pending`; `porch next` returned the
same phase. The notification was false.

**Run 2** (identical, but `env -u CODEV_BUILDER_ID -u CODEV_WORKTREE_ROOT -u
CODEV_THREAD_ID`): no delivery. `afx send` failed with
`Workspace '<scratch>/repro-ws' has no registered terminals. (NOT_FOUND)`.

The delta between the two runs is the whole mechanism.

### Root cause — two hops, neither carrying the project's identity

**Hop 1 — the recipient is a bare project id.**
`packages/codev/src/commands/porch/index.ts:1267` sends `target: state.id`.
`notify.ts:66-71` turns that into `afx send <projectId> "<msg>" --raw` with
`cwd = workspaceRoot`. Nothing names the builder that owns the project, and
nothing names the workspace the approved `status.yaml` lives in.

**Hop 2 — the workspace comes from the SENDER's session, and the agent is
tail-matched.** `agent-farm/commands/send.ts:60-110` resolves the workspace
from `CODEV_THREAD_ID`, else `CODEV_BUILDER_ID`+`CODEV_WORKTREE_ROOT`, else a
cwd walk-up. The issue attributes this to cwd; run 2 shows the launch-identity
env wins over cwd, which is why a Playwright suite running in `spir-250`'s pane
made a temp-workspace approval resolve to `/Users/chris/dev/codev-1455`. Then
`servers/tower-messages.ts:387-392` (live) and `:504-515` (registry) match
`builderId.endsWith('-' + stripLeadingZeros(agent))`, so `250` reaches
`builder-spir-250` and `bugfix-264` reaches `builder-bugfix-264`.

The existing #1094 guard checks that the sender's identity is *verifiable*, not
that the recipient is *correct*. Both runs had a perfectly verifiable identity.

### Scope

Fits BUGFIX. Planned change, well under 300 LOC:

1. `porch` addresses the builder that owns the project — canonical id resolved
   from the project's own worktree path — and pins the workspace, instead of
   sending a bare project id from wherever the process happens to be.
2. `afx send --exact` disables tail matching; a miss is an error naming the
   target and the workspace, never a plausible neighbour.
3. The message text carries project id + workspace and says it is a hint to
   verify against porch, not an approval.

No architectural change; no new abstraction.

## Fix (2026-08-31)

### The change

Both hops now carry the project's identity, and the last one refuses to guess.

**Porch addresses the project's worktree, not its id.** `notifyGateApproved`
(new, `commands/porch/notify.ts`) sends
`afx send --worktree <artifactRoot> --exact "<msg>" --raw`. `artifactRoot` is
the directory whose `status.yaml` was just written, so it names one builder in
one workspace or it names nothing. `notifyProtocolComplete` is pinned the same
way — it prompts `afx cleanup`, which is destructive.

**`afx send --worktree <path>`** resolves the recipient AND the resolution
workspace from that path, scoped to the workspace that owns it
(`resolveRecipientWorktree`, `agent-farm/commands/send.ts`). `fromWorkspace`
still comes from the sender's session; those were one value and are now two.
A worktree no builder owns throws, naming the worktree and listing who is
registered.

**`afx send --exact`** turns off the builder tail match in both Tower resolvers
(live and the offline-hold registry). The miss names the address, the workspace,
and the builders actually there.

**The message text is checkable.** It names the project and the workspace, says
outright that it is not an approval and carries no authority, and tells the
recipient to confirm with `porch next <id>` and what a mismatch means.

### Verified

- Original reproducer, re-run against this build: nothing delivered. porch logs
  `No builder in workspace '<tmp>' owns worktree '<tmp>/.builders/fake-264'`.
- Live positive: `afx send --worktree /Users/chris/dev/codev-1455/.builders/bugfix-264
  --exact` delivered to `builder-bugfix-264`.
- Both regression files confirmed to fail with the fix backed out (3 failures
  each), then restored.

### Not fixed here

Issue #185's "On it" false positive in the spawn render gate, per the
architect — separate issue.

## PR + CMAP (2026-08-31)

PR #270. Three verdicts, all APPROVE:

- **claude** — HIGH. Verified the `exact` short-circuit sits after the exact
  builder loop and the architect block, so `--exact builder-spir-250` and
  `--exact architect` still resolve. Two non-blocking items, both applied:
  `exact` also skipped the SHELL lookup (wider than the flag's name), and a
  JSDoc block was orphaned above `workspaceForWorktree`.
- **codex** — HIGH, no issues.
- **opencode** — HIGH, no issues. Run in place of gemini.

The **gemini lane did not review**: `agy` exited 1 on quota. Recorded as a
non-blocking skip, which is not an approval — so opencode was run as the third
lane rather than counting the skip as a verdict.

Post-review changes: `exact` now removes the tail match and nothing else (shells
and architects still resolve), pinned by a new test; JSDoc reattached.
