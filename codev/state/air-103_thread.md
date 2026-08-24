# air-103 — consult: the opencode lane cannot read its own prompt file

## Implement

#44 attached large prompts via `-f` but still wrote them under `consultSandboxDir()` (`/var/folders/...`). opencode auto-rejects `external_directory`, so a spec/plan review large enough to leave argv still got a pointer it could not open, then exited 0.

Writing the prompt (and any sandbox-only attachment) under `<workspace>/.consult/`, which is already gitignored. A protocol-mode run with no `VERDICT` records metrics exit 1, not 0.

## PR

https://github.com/pseudoseed/codev/pull/121 — merged 2026-08-24 by pseudoseed. Issue #103 closed.

Owner approved the pr gate on the PR (comment 5399588454). Correction on the record: `-f` of a `/var/folders` path was never broken (CLI reads it); the agent's Read tool is what refuses `external_directory`. Staging still the right fix.

## Closeout

`porch approve 103 pr` then `porch done 103 --merged 121` then `porch done 103`. Protocol complete (verified).

3 porch state commits are unlanded on this branch, not in the merged PR:

- `7a6a0e872` chore(porch): 103 PR #121 merged
- `4819c9f83` chore(porch): 103 pr gate-approved
- `aa7d8f553` chore(porch): 103 protocol complete

Did not open a follow-up PR. Waiting on architect.
