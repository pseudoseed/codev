#!/bin/sh
# Forge concept: ci-runs (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_BRANCH_NAME (optional), CODEV_CI_STATUS (optional),
#         CODEV_CI_WORKFLOW (optional — workflow file, e.g. ci.yml),
#         CODEV_CI_LIMIT (optional, default 20), CODEV_PR_BASE (optional)
# Output: {ok, provider, runs: [...], truncated, note?}
#
# The cheap question. No log bytes on any path.
#
# `conclusion` is always null here and that is not an oversight: Forgejo has no
# separate conclusion field, `status` carries success/failure/skipped/canceled
# directly. Emitting a fabricated conclusion would make the two providers look
# identical where they are not.
#
# Branch filtering is client-side and PR-aware — see the header of _ci.sh for
# why `branch=` cannot be sent to the server and why `builder/x` has to become
# `#123` before it will match anything.
set -e
. "$(dirname "$0")/_ci.sh"

CONCEPT=ci-runs

ci_check_status "$CONCEPT" "$CODEV_CI_STATUS"

LIMIT=${CODEV_CI_LIMIT:-$CI_LIMIT_DEFAULT}
case "$LIMIT" in ''|*[!0-9]*|0) LIMIT=$CI_LIMIT_DEFAULT ;; esac

REPO="$(gitea_repo)" || exit 1

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

QUERY=""
[ -n "$CODEV_CI_STATUS" ] && QUERY="status=$(ci_status_for gitea "$CODEV_CI_STATUS")"

NOTE=null
PR_REF=""
if [ -n "$CODEV_BRANCH_NAME" ]; then
  PR_REF=$(gitea_ci_pr_ref "$REPO" "$CODEV_BRANCH_NAME") || {
    ci_fail "$CONCEPT" forge-error "could not read repository '${REPO}' while resolving branch '${CODEV_BRANCH_NAME}'"
    exit 1
  }
  if [ -z "$PR_REF" ]; then
    NOTE='"branch has no pull request, so only push/schedule runs on that branch can match; Forgejo labels pull_request runs with the PR number, not the branch"'
  fi
fi

ACC='[]'
PAGE=1
TRUNCATED=false
while [ "$PAGE" -le "$CI_MAX_PAGES" ]; do
  rc=0
  gitea_ci_fetch "repos/${REPO}/actions/runs?page=${PAGE}&limit=${GITEA_PAGE_LIMIT}${QUERY:+&$QUERY}" "$TMP/page.json" || rc=$?
  if [ "$rc" -eq 124 ]; then
    ci_fail_timeout "$CONCEPT" "GET repos/${REPO}/actions/runs" "$GITEA_TIMEOUT"
    exit 1
  fi
  if [ "$rc" -eq 44 ]; then
    gitea_ci_unsupported "$CONCEPT" "workflow-runs" "$(jq -cn --arg r "$REPO" '{repo: $r}')"
    exit 1
  fi
  if [ "$rc" -ne 0 ]; then
    ci_fail "$CONCEPT" forge-error "Forgejo could not list workflow runs for ${REPO}: $(head -c 200 "$TMP/page.json")"
    exit 1
  fi

  RAW=$(jq '.workflow_runs | length' "$TMP/page.json")
  HITS=$(jq -c --arg branch "$CODEV_BRANCH_NAME" --arg prref "$PR_REF" --arg wf "$CODEV_CI_WORKFLOW" '
    [ .workflow_runs[]?
      | select($wf == "" or .workflow_id == $wf)
      | select($branch == "" or .prettyref == $branch or ($prref != "" and .prettyref == $prref))
      | {
          id: .id,
          number: .index_in_repo,
          name: .title,
          workflow: .workflow_id,
          status: .status,
          conclusion: null,
          branch: .prettyref,
          sha: .commit_sha,
          event: .event,
          url: .html_url,
          createdAt: .created
        } ]' "$TMP/page.json")
  ACC=$(printf '%s\n%s' "$ACC" "$HITS" | jq -s -c 'add')

  # -gt, not -ge: stopping at exactly LIMIT would leave `truncated` (computed
  # below as length > limit) reading false when there is more to see. One extra
  # item is what makes "there are more runs than this" a fact rather than a
  # guess — the same reason the github script asks gh for LIMIT + 1.
  [ "$(printf '%s' "$ACC" | jq 'length')" -gt "$LIMIT" ] && break
  if [ "$RAW" -lt "$GITEA_PAGE_LIMIT" ]; then break; fi
  PAGE=$((PAGE + 1))
done

# The loop condition — not a break — is what ends a walk that ran out of
# allowance, so PAGE past the ceiling means there was more to see. Checking it
# here rather than inside the loop also covers the UNFILTERED case: asking for
# 200 runs from a 6922-run repo collects exactly 200 and used to report
# truncated=false, because the old check only fired when a client-side filter
# was active. A capped answer that says it is complete is the failure this
# whole issue is about.
if [ "$PAGE" -gt "$CI_MAX_PAGES" ]; then
  TRUNCATED=true
  echo "${CONCEPT}: stopped after ${CI_MAX_PAGES} pages of runs; raise CODEV_CI_MAX_PAGES for a deeper search" >&2
fi

printf '%s' "$ACC" | jq -c --argjson limit "$LIMIT" --argjson truncated "$TRUNCATED" --argjson note "$NOTE" '{
  ok: true, provider: "gitea",
  runs: .[0:$limit],
  truncated: ($truncated or (length > $limit)),
  note: $note
}'
