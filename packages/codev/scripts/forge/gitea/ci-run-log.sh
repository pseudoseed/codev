#!/bin/sh
# Forge concept: ci-run-log (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_CI_RUN_ID (required), CODEV_CI_JOB_ID (optional),
#         exactly ONE of CODEV_CI_LOG_TAIL / CODEV_CI_LOG_HEAD / CODEV_CI_LOG_GREP
#         (+ CODEV_CI_LOG_CONTEXT, default 3)
# Output: the shared ci-run-log envelope; see github/ci-run-log.sh
#
# REQUIRES FORGEJO 16.0 OR LATER, for the same reason as ci-failures: the job
# log API did not exist before it. On an older server this returns the
# unsupported-server envelope rather than an empty window.
#
# Forgejo 16 serves the log as text/plain with `accept-ranges: bytes`, so a tail
# could in principle be fetched as a byte range. It is not, because `tea api`
# sends no Range header and the log cache makes the second and third window over
# the same job free anyway — measured 142 KB / 1.0s for a 1599-line job log.
set -e
. "$(dirname "$0")/_ci.sh"

CONCEPT=ci-run-log

ci_require_tmpdir "$CONCEPT"

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi
ci_require_id "$CONCEPT" CODEV_CI_RUN_ID "$CODEV_CI_RUN_ID"
[ -z "$CODEV_CI_JOB_ID" ] || ci_require_id "$CONCEPT" CODEV_CI_JOB_ID "$CODEV_CI_JOB_ID"

# Window first: a malformed request should not cost an API call.
ci_window_parse "$CONCEPT"

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
  ci_fail "$CONCEPT" not-found "run ${CODEV_CI_RUN_ID} does not exist in ${REPO}; pass the \`id\` from ci-runs, not the run \`number\`" \
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

if [ "$(cat "$TMP/jobs.source")" = "tasks-scan" ]; then
  gitea_ci_unsupported "$CONCEPT" "job-log" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" '{runId: ($r | tonumber? // $r), hint: "ci-run-view still works on this server and lists per-job status"}')"
  exit 1
fi

if [ -n "$CODEV_CI_JOB_ID" ]; then
  TARGET=$(jq -c --argjson j "$CODEV_CI_JOB_ID" 'first(.[] | select(.id == $j)) // empty' "$TMP/jobs.json")
  if [ -z "$TARGET" ]; then
    ci_fail "$CONCEPT" not-found "job ${CODEV_CI_JOB_ID} is not part of run ${CODEV_CI_RUN_ID}" \
      "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --arg j "$CODEV_CI_JOB_ID" '{runId: $r, jobId: $j}')"
    exit 1
  fi
else
  TARGET=$(jq -c 'first(.[] | select(.status == "failure" or .status == "timed_out")) // empty' "$TMP/jobs.json")
  [ -n "$TARGET" ] || TARGET=$(jq -c 'if length == 1 then .[0] else empty end' "$TMP/jobs.json")
  if [ -z "$TARGET" ]; then
    ci_fail "$CONCEPT" bad-input "run ${CODEV_CI_RUN_ID} has no failing job and more than one job; set CODEV_CI_JOB_ID" \
      "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --slurpfile j "$TMP/jobs.json" '{runId: $r, jobs: [ $j[0][] | {id: .id, name: .name} ]}')"
    exit 2
  fi
fi

JOB_ID=$(printf '%s' "$TARGET" | jq -r '.id')
JOB_NAME=$(printf '%s' "$TARGET" | jq -r '.name')
JOB_STATE=$(printf '%s' "$TARGET" | jq -r '.status')

rc=0
gitea_ci_job_log "$REPO" "$JOB_ID" "$JOB_STATE" "$TMP/raw.log" || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "GET repos/${REPO}/actions/jobs/${JOB_ID}/logs" "$GITEA_TIMEOUT"
  exit 1
fi
if [ "$rc" -eq 44 ]; then
  gitea_ci_unsupported "$CONCEPT" "job-log" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson j "$JOB_ID" --arg n "$JOB_NAME" '{runId: ($r | tonumber? // $r), jobId: $j, jobName: $n}')"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "could not read the log for job ${JOB_ID} (${JOB_NAME})" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson j "$JOB_ID" --arg n "$JOB_NAME" '{runId: $r, jobId: $j, jobName: $n}')"
  exit 1
fi

ci_clean_log < "$TMP/raw.log" > "$TMP/clean.log"
ci_window_emit "$CONCEPT" "$TMP" gitea "$CODEV_CI_RUN_ID" "$JOB_ID" "$JOB_NAME" "$CI_LOG_FROM_CACHE"
