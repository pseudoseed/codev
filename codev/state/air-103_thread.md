# air-103 — consult: the opencode lane cannot read its own prompt file

## Implement

#44 attached large prompts via `-f` but still wrote them under `consultSandboxDir()` (`/var/folders/...`). opencode auto-rejects `external_directory`, so a spec/plan review large enough to leave argv still got a pointer it could not open, then exited 0.

Writing the prompt (and any sandbox-only attachment) under `<workspace>/.consult/`, which is already gitignored. A protocol-mode run with no `VERDICT` records metrics exit 1, not 0.

## PR

https://github.com/pseudoseed/codev/pull/121
