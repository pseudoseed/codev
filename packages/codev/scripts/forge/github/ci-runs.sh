#!/bin/sh
# Forge concept: ci-runs (GitHub via gh CLI)
# forge-executable: gh
# Input:  CODEV_BRANCH_NAME  (optional) — filter to one branch
#         CODEV_CI_STATUS    (optional) — success|failure|pending|queued|in_progress|skipped|canceled
#         CODEV_CI_WORKFLOW  (optional) — workflow file name or display name
#         CODEV_CI_LIMIT     (optional, default 20)
# Output: {ok, provider, runs: [{id, number, name, workflow, status, conclusion,
#                                branch, sha, event, url, createdAt}], truncated}
#
# The cheap question, and the whole point of tiering these concepts: "did my
# push pass" must never drag a log through a context window. One `gh run list`
# call, ~0.7s measured, no log bytes at any point.
#
# It also answers "is this mine or is it flaky", which is why CODEV_CI_WORKFLOW
# exists: the same workflow across other commits is a run-history question, and
# on 2026-08-21 two wrong conclusions were drawn about CI state that were both
# answerable from run history and neither checked, because asking was awkward.
#
# `id` is what ci-run-view / ci-failures / ci-run-log take. `number` is the
# human run number. On GitHub they differ; on Forgejo they differ AND both are
# valid inputs to the same route, so the concepts never guess which one they
# were handed. Pass `id`.
set -e
. "$(dirname "$0")/_lib.sh"

CONCEPT=ci-runs

ci_check_status "$CONCEPT" "$CODEV_CI_STATUS"

LIMIT=${CODEV_CI_LIMIT:-$CI_LIMIT_DEFAULT}
case "$LIMIT" in ''|*[!0-9]*|0) LIMIT=$CI_LIMIT_DEFAULT ;; esac

# One more than asked for, so that "there are more runs than this" can be
# reported instead of guessed. gh has no hasMore of its own, and a list that was
# cut by a limit is indistinguishable from a complete one once printed.
set -- run list --limit "$((LIMIT + 1))" --json databaseId,number,name,workflowName,status,conclusion,headBranch,headSha,event,url,createdAt
[ -n "$CODEV_BRANCH_NAME" ] && set -- "$@" --branch "$CODEV_BRANCH_NAME"
[ -n "$CODEV_CI_WORKFLOW" ] && set -- "$@" --workflow "$CODEV_CI_WORKFLOW"
if [ -n "$CODEV_CI_STATUS" ]; then
  set -- "$@" --status "$(ci_status_for github "$CODEV_CI_STATUS")"
fi

rc=0
OUT=$(ci_tool gh "$@") || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "gh run list" "$CI_TIMEOUT"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "gh run list failed (exit ${rc}); see stderr above"
  exit 1
fi

printf '%s' "$OUT" | jq -c --argjson limit "$LIMIT" '{
  ok: true,
  provider: "github",
  runs: [ .[] | {
    id: .databaseId,
    number: .number,
    name: .name,
    workflow: .workflowName,
    status: .status,
    conclusion: .conclusion,
    branch: .headBranch,
    sha: .headSha,
    event: .event,
    url: .url,
    createdAt: .createdAt
  } ] | .[0:$limit],
  truncated: (length > $limit),
  note: null
}'
