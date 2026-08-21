#!/bin/sh
# Forge concept: ci-run-view (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_CI_RUN_ID (required — the `id` from ci-runs, NOT the `number`)
# Output: {ok, provider, run: {...}, jobs: [...], jobSource, truncated}
#
# Still no log bytes.
#
# `jobSource` says which route answered, because the two are not equivalent:
#
#   runs-jobs   Forgejo 16 `actions/runs/{id}/jobs`. Carries the job `id` that
#               ci-failures and ci-run-log need.
#   tasks-scan  Forgejo 15 has no jobs route, so the jobs are recovered by
#               filtering `actions/tasks` on run_number. That yields TASK ids,
#               not job ids, so `id` is null and `taskId` carries what exists.
#               A task id looks like a job id and is not accepted by the log
#               API, so handing it back as `id` would be a trap.
#
# Forgejo exposes no per-step data on either version, so `failedSteps` is always
# [] here. It is present rather than omitted so the field means the same thing
# on both providers.
set -e
. "$(dirname "$0")/_ci.sh"

CONCEPT=ci-run-view

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi

REPO="$(gitea_repo)" || exit 1
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rc=0
gitea_ci_fetch "repos/${REPO}/actions/runs/${CODEV_CI_RUN_ID}" "$TMP/run.json" || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "GET repos/${REPO}/actions/runs/${CODEV_CI_RUN_ID}" "$GITEA_TIMEOUT"
  exit 1
fi
if [ "$rc" -eq 44 ]; then
  ci_fail "$CONCEPT" not-found "run ${CODEV_CI_RUN_ID} does not exist in ${REPO}; pass the \`id\` from ci-runs, not the run \`number\` — on Forgejo both are valid ids for different runs" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" '{runId: $r}')"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "Forgejo could not read run ${CODEV_CI_RUN_ID}: $(head -c 200 "$TMP/run.json")"
  exit 1
fi

RUN_INDEX=$(jq -r '.index_in_repo' "$TMP/run.json")

rc=0
gitea_ci_jobs "$CONCEPT" "$REPO" "$CODEV_CI_RUN_ID" "$RUN_INDEX" "$TMP" || rc=$?
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "could not list the jobs of run ${CODEV_CI_RUN_ID}"
  exit 1
fi

# Read back from files rather than from a command substitution: gitea_ci_jobs
# has to report three things (the jobs, which route answered, whether the walk
# was cut short) and a subshell would discard two of them.
jq -c --slurpfile jobs "$TMP/jobs.json" --arg source "$(cat "$TMP/jobs.source")" \
      --argjson truncated "$(cat "$TMP/jobs.truncated")" '{
  ok: true, provider: "gitea", jobSource: $source,
  run: {
    id: .id, number: .index_in_repo, title: .title,
    workflow: .workflow_id, status: .status, conclusion: null,
    branch: .prettyref, sha: .commit_sha, event: .event,
    url: .html_url, createdAt: .created
  },
  jobs: $jobs[0],
  truncated: $truncated
}' "$TMP/run.json"
