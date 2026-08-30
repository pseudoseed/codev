---
name: afx
description: Agent Farm CLI — the tool for spawning builders, managing Tower, workspaces, and cron tasks. ALWAYS consult this skill BEFORE running any `afx` command to get the exact syntax. This prevents wasting time guessing flags that don't exist. Use this whenever you need to spawn a builder, check status, send messages, clean up worktrees, manage Tower, or run cron tasks. If you're about to type `afx` followed by anything, check here first.
---

# Agent Farm CLI

## afx spawn

Spawns a new builder in an isolated git worktree.

```
afx spawn [number] [options]
```

**The ONLY flags that exist:**

| Flag | Description |
|------|-------------|
| `--protocol <name>` | Protocol: spir, aspir, air, bugfix, maintain, experiment. **Required for numbered spawns.** |
| `--task <text>` | Ad-hoc task (no issue number needed) |
| `--shell` | Bare Claude session |
| `--worktree` | Bare worktree session |
| `--files <files>` | Context files, comma-separated. **Requires `--task`.** |
| `--no-comment` | Skip commenting on the GitHub issue |
| `--force` | Skip dirty-worktree and collision checks |
| `--soft` | Soft mode (AI follows protocol, you verify) |
| `--strict` | Strict mode (porch orchestrates) — this is the default |
| `--resume` | Resume builder in existing worktree |
| `--harness <name>` | Agent harness for THIS spawn: `claude`, `codex`, `opencode`, or a custom harness. Overrides `.codev/config.json`; the config value stays the fallback. Refused at spawn if the harness has no render-gate profile. |
| `--model <id>` | Pin the model for THIS spawn, e.g. `sonnet`, `claude-fable-5`, `x-ai/grok-4.6` (opencode wants `provider/model`). Resolved into the harness's own flag — never baked into a command path. Using it with a harness that has no model selector is an error, not a silent no-op. |
| `--no-role` | Skip loading role prompt |

**There is NO `-t`, `--title`, or `--name` flag.** Without `--branch`, the branch name is auto-generated from the issue title.

**Examples:**
```bash
afx spawn 42 --protocol spir           # SPIR builder for issue #42
afx spawn 42 --protocol aspir          # ASPIR (autonomous, no human gates)
afx spawn 42 --protocol air            # AIR (small features)
afx spawn 42 --protocol bugfix         # Bugfix
afx spawn 42 --protocol spir --soft    # Soft mode
afx spawn 42 --resume                  # Resume existing builder
afx spawn 42 --protocol air --harness opencode --model x-ai/grok-4.6
afx spawn 42 --protocol air --model sonnet   # pin a model, same harness
afx spawn --task "fix the flaky test"  # Ad-hoc task (no issue)
afx spawn 42 --protocol spir --force   # Skip dirty-worktree check
```

**Pre-spawn checklist:**
1. `git status` — worktree must be clean (or use `--force`)
2. Commit specs/plans first — builders branch from HEAD and can't see uncommitted files
3. `--protocol` is required for numbered spawns

## afx send

Sends a message to a running builder.

```
afx send [builder] [message]
```

| Flag | Description |
|------|-------------|
| `--all` | Send to all builders |
| `--file <path>` | Include file content |
| `--interrupt` | Ready the prompt first — end the turn and clear the composer — with the keystrokes recorded as safe for the target (Ctrl+C on claude/codex and shells; ESC then Ctrl+U on opencode) |
| `--raw` | Skip structured formatting |
| `--no-enter` | Don't press Enter after message |

```bash
afx send 0042 "PR approved, please merge"
afx send 0585 "check the test output" --file /tmp/test-results.txt
```

## afx interrupt

Sends an ESC keystroke to a builder's PTY — the only thing that reaches it **mid-turn**.

```
afx interrupt <builder>
```

| Flag | Description |
|------|-------------|
| `--enter` | Send Enter after ESC so queued messages process; unsafe at unknown dialogs |
| `--no-enter` | Send ESC alone (the default; retained for compatibility) |

A builder chaining foreground waits inside one turn queues every `afx send` unread — including your order
to stop. ESC alone is the safe default because Enter can activate a highlighted dialog action. Use
`--enter` only when the terminal is in a known running turn and the queued messages need to process.
Distinct from `afx send --interrupt`, which readies the prompt — ends the turn AND clears the composer — with the keystrokes recorded as safe for the target (Ctrl+C on claude/codex and shells; ESC then Ctrl+U on opencode), then delivers a message.

```bash
afx interrupt 0042 --enter
afx send 0042 "That producer died — stop waiting and report."
```

## afx refresh

Refreshes a builder's context: save working state → `/clear` → re-orient. Use when a builder's context window
is exhausted; `afx spawn --resume` reattaches the *same* conversation and does **not** give it a fresh one.

```
afx refresh <builder>
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Print what would be sent; write nothing to the builder |
| `--note <text>` | Extra context appended to the re-orientation |
| `--file <path>` | Append file content (48KB max, read from *your* filesystem) |
| `--interrupt-first` | ESC before the save request, for a builder already wedged |
| `--mode <strict\|soft>` | Override mode if it cannot be detected |
| `--timeout <seconds>` | Wait for the save-state receipt (default 300) |
| `--min-bytes <n>` | Minimum state-file size to accept (default 1000) |
| `--quiet-window <ms>` | Terminal silence counting as turn-ended (default 1500) |

Every gate fails safe: if the state file never arrives, carries a stale nonce, is a stub, is still being
written, or the builder will not go quiet, the command **aborts without clearing** and exits non-zero,
naming the gate. Requires a harness with in-session context clearing (Claude Code); others abort loudly.

`afx reset` is a deprecated alias: it still works, prints a one-line notice to stderr, and will be removed
in a future release.

```bash
afx refresh 0042 --dry-run                # inspect first — touches nothing
afx refresh 0042
afx refresh 0042 --note "PR #90 merged while you were mid-phase. Rebase first."
afx refresh 0042 --interrupt-first        # builder is wedged mid-turn
```

## afx cleanup

Removes a builder's worktree and branch after work is done.

```
afx cleanup [options]
```

| Flag | Description |
|------|-------------|
| `-p, --project <id>` | Builder project ID (no leading zeros: `585` not `0585`) |
| `-i, --issue <number>` | Cleanup bugfix builder by issue number |
| `-t, --task <id>` | Cleanup task builder (e.g., `task-bEPd`) |
| `-f, --force` | Force cleanup even if branch not merged |

```bash
afx cleanup -p 585              # Clean up project 585
afx cleanup -p 585 -f           # Force (unmerged branch)
```

**Note:** `afx cleanup` uses plain numbers (`585`), not zero-padded (`0585`). But `afx send` uses zero-padded IDs (`0585`).

## afx status

```bash
afx status                      # Show all builders and workspace status
```

No flags needed. Shows Tower status, workspace, and all active builders.

## afx whoami

```bash
afx whoami                      # Report this terminal's identity (workspace, type, name)
afx whoami --json               # Same, as a single JSON object
```

Resolves identity from Tower/global.db's perspective: builder-worktree cwd
match first, then the Tower-injected `CODEV_ARCHITECT_NAME` env var. Exits 1
with an explanation when identity cannot be determined — it never guesses and
never defaults to `main` (issue #1094). Builders also get an `architect:`
field naming their spawning architect when recorded. Works without Tower.

## afx pair

Pairing tokens and machine credentials for the codev client — the operator entry
point to the human approval path (spec 236).

```bash
afx pair issue --purpose client-session --authority "chris at laptop"
afx pair issue --purpose machine-credential --authority "ipad setup"
afx pair issue --purpose client-session --ttl-minutes 30 --authority "…"
afx pair list                   # Outstanding tokens and paired machines, revoked ones marked
afx pair revoke <machine>       # Withdraw a machine's credential AND its approval capabilities
```

| Flag | Meaning |
|------|---------|
| `--purpose <p>` | `client-session` or `machine-credential`. **Required, no default** — a token is bound to one ceremony, so a wrong guess fails at redemption, in another process, against another route. |
| `--authority <text>` | Recorded verbatim into the session and, through it, into `status.yaml`. **Optional** — defaults to naming this command and the invoking account. Never interpreted, and it does not assert a human was present, because nothing here can verify that. |
| `--ttl-minutes <n>` | How long the token stays redeemable. **Default 10, max 60.** |

**`--purpose` picks the ceremony, and they are not interchangeable.**
`machine-credential` is redeemed at `POST /pairing/redeem` to enrol a device;
`client-session` is spent at `POST /human-sessions` to open the session an
approval costs.

**`afx pair revoke` works holding nothing, with Tower stopped.** That is the
point of the command. Over HTTP, revocation is `human-session` — which includes
`machine-credential` — so the operator who wants to withdraw a device is the one
who cannot. The CLI writes both stores directly: the machine credential and that
device's approval capabilities, because revoking only the first leaves a
withdrawn device still able to present a live capability to `porch approve`.

**This skill is canonical for the commands and flags.**
`codev/resources/146-remote-access-runbook.md` covers the same ground for a
human, with the surrounding procedure (TLS posture, what to do when a device is
lost) — read it for the *procedure*, read this for the *command*. If the two
disagree about a flag, this file is the one checked against the CLI.

## afx tower

```bash
afx tower start                 # Start Tower on port 4100
afx tower stop                  # Stop Tower
afx tower log                   # Tail Tower logs
afx tower status                # Check daemon and cloud connection status
afx tower connect               # Connect to Codev Cloud
afx tower disconnect            # Disconnect from Codev Cloud
```

There is NO `afx tower restart` — use `afx tower stop && afx tower start`.

## afx workspace

```bash
afx workspace start             # Start workspace for current project
afx workspace stop              # Stop workspace processes
```

`afx dash` is a deprecated alias — use `afx workspace` instead.

## afx cron

```bash
afx cron list                   # List all cron tasks
afx cron status <name>          # Check task status
afx cron run <name>             # Run immediately
afx cron enable <name>          # Enable
afx cron disable <name>         # Disable
```

There is NO `afx cron add` — create YAML files in `.af-cron/` directly:

```yaml
name: Service Health Check      # required, unique per workspace
schedule: "*/15 * * * *"        # required, cron expression (or @hourly/@daily/@startup)
command: ./health-check.sh      # required, run via shell
message: "Health alert: ${output}"  # required, ${output} = trimmed command output
condition: "exitCode != 0"      # optional JS expression, see below
target: architect               # optional, default architect
timeout: 30                     # optional, seconds, default 30
enabled: true                   # optional, default true
```

`condition` is a JavaScript expression with two variables in scope: `output` (string — the command's trimmed output) and `exitCode` (number — 0 on success, the command's exit code on non-zero exit, 124 on timeout, -1 on spawn failure). With a `condition`, the message is delivered exactly when it evaluates truthy — including on failed runs (e.g. `exitCode != 0` alerts when the command fails). Without a `condition`, the message is delivered only when the command exits 0.

## Other commands

```bash
afx open <file>                 # Open file in annotation viewer (NOT system open)
afx shell                       # Spawn utility shell
afx attach                      # Attach to running builder terminal
afx rename <name>               # Rename current shell session
afx architect                   # Start architect session in current terminal
```
