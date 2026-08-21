# Forge Concept Commands

Forge concept commands decouple codev from direct `gh` CLI calls. Each GitHub operation is routed through a configurable external command.

## Concepts

| Concept | Env Vars | Description |
|---------|----------|-------------|
| `issue-view` | `CODEV_ISSUE_ID` | Fetch issue details (JSON) |
| `pr-list` | — | List open PRs (JSON array) |
| `issue-list` | — | List issues (JSON array) |
| `issue-comment` | `CODEV_ISSUE_ID`, `CODEV_COMMENT_BODY` | Post a comment on an issue |
| `pr-exists` | `CODEV_BRANCH_NAME` | Check if a PR exists for a branch |
| `recently-closed` | `CODEV_SINCE_DATE` (optional) | List recently closed issues |
| `recently-merged` | `CODEV_SINCE_DATE` (optional) | List recently merged PRs |
| `user-identity` | — | Get current user's handle (plain text) |
| `team-activity` | `CODEV_GRAPHQL_QUERY` | Run a batched GraphQL query |
| `on-it-timestamps` | `CODEV_ISSUE_NUMBERS`, `CODEV_GRAPHQL_QUERY`, `CODEV_REPO_OWNER`, `CODEV_REPO_NAME` | Get "on it" comment timestamps |
| `pr-create` | `CODEV_PR_TITLE`, `CODEV_PR_BODY`, `CODEV_PR_BASE` (optional), `CODEV_PR_HEAD` (optional), `CODEV_PR_REPO` (optional), `CODEV_PR_DRAFT` (optional) | Open a PR; prints `{"number", "url"}` |
| `pr-merge` | `CODEV_PR_NUMBER` | Merge a PR |
| `pr-search` | `CODEV_SEARCH_QUERY` | Search PRs (JSON array) |
| `pr-view` | `CODEV_PR_NUMBER`, `CODEV_INCLUDE_COMMENTS` (optional) | View PR details (JSON or text) |
| `pr-diff` | `CODEV_PR_NUMBER`, `CODEV_DIFF_NAME_ONLY` (optional) | Get PR diff |
| `auth-status` | — | Check forge authentication status |

## Configuration

In `.codev/config.json`:

```json
{
  "forge": {
    "provider": "gitlab",
    "issue-comment": "my-custom-script $CODEV_ISSUE_ID"
  }
}
```

### Resolution order
1. Manual concept override in `forge` section
2. Provider preset (if `provider` is set)
3. Default (GitHub via `gh` CLI)

### Providers

Built-in presets: `github` (default), `gitlab` (via `glab`), `gitea` (via `tea`).

**Note:** Non-GitHub presets are best-effort. Output schemas may differ from GitHub's JSON contracts. Non-conforming JSON returns `null` — consumers handle this gracefully. Override individual concepts if a preset doesn't match your CLI version.

### Gitea / Forgejo specifics

Forgejo has no GitHub-style PR search and charges its `/pulls` list endpoint per
returned PR object (~0.65s each, measured against Forgejo 15.x), so the gitea
scripts avoid list endpoints wherever a targeted one exists.

| Concept | How gitea answers it |
|---|---|
| `pr-exists` | `GET pulls/{base}/{head}` — one request. Base is `CODEV_PR_BASE`, else the repo's default branch. |
| `pr-search` | `head:` queries use the same base/head lookup; issue-number queries search `issues?type=pulls&q=` and then resolve each match. |
| `pr-diff` | `pulls/{n}.diff`, or `pulls/{n}/files` for `CODEV_DIFF_NAME_ONLY=1`. |
| `recently-merged` | `issues?type=pulls&state=closed&since=` (a server-side window), then one `pulls/{n}` per match for the head branch. |
| `team-activity`, `on-it-timestamps` | Disabled, permanently. Both are `gh api graphql` pass-throughs and Forgejo has no GraphQL. Callers say so on stderr rather than returning empty. |

**pr-search query grammar.** The query is parsed, not forwarded. Understood
terms: `head:<branch>`, `is:open`, `is:merged`, `is:closed`, `in:body`, and a
bare issue number (`123` or `#123`). With no `is:` qualifier the search spans
every state, so a merged PR is findable after the fact. Anything outside the
grammar returns `[]` and says so on stderr rather than guessing.

**A merged PR's branch name.** Gitea rewrites `head.ref` to `refs/pull/N/head`
once a merged PR's source branch is deleted, but `head.label` keeps the branch
name. The gitea scripts read `head.label` first, which is what lets `pr-exists`
and `pr-search head:` still find a merged PR.

**Base branches other than the default.** `pr-exists` and `pr-search head:` need
a base branch. They use the repository's default unless `CODEV_PR_BASE` is set,
so a PR targeting an integration branch needs that variable.

### Environment overrides

| Variable | Default | Effect |
|---|---|---|
| `CODEV_REPO` | derived from `origin` | `owner/repo` for the gitea scripts |
| `CODEV_PR_BASE` | the repo's default branch | base branch for `pr-exists` / `pr-search head:` |
| `CODEV_FORGE_TIMEOUT` | 60 | seconds before a single `tea api` call is killed and reported |
| `CODEV_FORGE_PAGED_DEADLINE` | 120 | seconds before a paged walk stops early (exit 3) |
| `CODEV_FORGE_CONCURRENCY` | 8 | parallel PR fetches |
| `CODEV_FORGE_MERGED_DAYS` | 7 | `recently-merged` window when `CODEV_SINCE_DATE` is unset |
| `CODEV_FORGE_MERGED_MAX` | 300 | merged PRs `recently-merged` will resolve before refusing |
| `CODEV_FORGE_SEARCH_MAX` | 10 | PRs `pr-search` resolves for one issue number |

### Exit statuses

`0` is an answer and `1` is a failure, as usual. **`3` means the result was
truncated**, and the concept prints nothing on stdout when it returns it: a
partial list is indistinguishable from a complete one once printed, so "nothing
matched" (`[]`, status 0) and "I stopped looking" (status 3) are deliberately
different. `2` is a missing or unusable input.

### Disabling concepts

Set a concept to `null` to disable it:
```json
{
  "forge": {
    "team-activity": null
  }
}
```

## Validation

Run `codev doctor` to see forge concept status, provider, and validation results.

## Code

- **Dispatcher**: `packages/codev/src/lib/forge.ts`
- **Contracts**: `packages/codev/src/lib/forge-contracts.ts`
- **Spec**: `codev/specs/589-non-github-repository-support.md`
