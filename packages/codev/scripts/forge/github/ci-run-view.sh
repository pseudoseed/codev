#!/bin/sh
# Forge concept: ci-run-view (GitHub via gh CLI)
# forge-executable: gh
# Input:  CODEV_CI_RUN_ID (required — the `id` field from ci-runs, not `number`)
# Output: {ok, provider, run: {...}, jobs: [{id, name, status, conclusion,
#          startedAt, completedAt, failedSteps: [{name, number, conclusion}]}],
#          jobSource}
#
# Still no log bytes. This answers "is it still running, and which job is
# pending" and "which step failed" — the second of which is normally enough to
# know whether a failure is yours, and costs one ~1.3s call.
#
# `failedSteps` comes from gh's structured per-step conclusions, NOT from
# parsing a log. That matters: `gh run view --log-failed` labels its lines
# "UNKNOWN STEP" whenever its filename-to-step mapping misses, which on the run
# this was built against was every line of all 2528.
set -e
. "$(dirname "$0")/_lib.sh"

CONCEPT=ci-run-view

ci_require_tmpdir "$CONCEPT"

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi
ci_require_id "$CONCEPT" CODEV_CI_RUN_ID "$CODEV_CI_RUN_ID"
[ -z "$CODEV_CI_JOB_ID" ] || ci_require_id "$CONCEPT" CODEV_CI_JOB_ID "$CODEV_CI_JOB_ID"

rc=0
OUT=$(gh_run_json "$CODEV_CI_RUN_ID") || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "gh run view ${CODEV_CI_RUN_ID}" "$CI_TIMEOUT"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" not-found "run ${CODEV_CI_RUN_ID} could not be read (gh exit ${rc}); pass the \`id\` from ci-runs, not the run \`number\`" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" '{runId: $r}')"
  exit 1
fi

ci_require_json "$CONCEPT" "$OUT" "gh run view ${CODEV_CI_RUN_ID}"

printf '%s' "$OUT" | jq -c '{
  ok: true,
  provider: "github",
  jobSource: "run-view",
  run: {
    id: .databaseId,
    number: .number,
    title: .displayTitle,
    workflow: .workflowName,
    status: .status,
    conclusion: .conclusion,
    branch: .headBranch,
    sha: .headSha,
    event: .event,
    url: .url,
    createdAt: .createdAt
  },
  jobs: [ .jobs[] | {
    id: .databaseId,
    name: .name,
    status: .status,
    conclusion: .conclusion,
    startedAt: .startedAt,
    completedAt: .completedAt,
    failedSteps: [ .steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out")
                   | {name: .name, number: .number, conclusion: .conclusion} ]
  } ]
}'
