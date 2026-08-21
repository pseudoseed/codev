#!/bin/sh
# Forge concept: ci-run-log (GitHub via gh CLI)
# forge-executable: gh
# Input:  CODEV_CI_RUN_ID (required)
#         CODEV_CI_JOB_ID (optional — defaults to the first failing job, or the
#                          only job if the run has exactly one)
#         exactly ONE window:
#           CODEV_CI_LOG_TAIL=N     last N lines
#           CODEV_CI_LOG_HEAD=N     first N lines (setup, install, config)
#           CODEV_CI_LOG_GREP=<ere> matching lines, with CODEV_CI_LOG_CONTEXT
#                                   (default 3) lines either side
# Output: {ok, provider, runId, jobId, jobName, window, logLines, returnedLines,
#          from, to, truncated, lines: [...], matchLines?: [...]}
#
# The escape hatch, and deliberately a SEPARATE concept rather than a flag on
# ci-failures: a window parameter on the main call gets passed by habit, and
# then every status question drags a log again — which is the thing this issue
# exists to prevent. Reaching for this should be a deliberate act.
#
# There is no default window. Zero windows and two windows are both exit 2 with
# a named message, because a default is how "deliberate" decays into "always".
#
# This is remote head/tail/grep -C over a log, and nothing more. The value codev
# adds is doing it against two forges with one contract and a bounded response,
# not inventing log analysis.
set -e
. "$(dirname "$0")/_lib.sh"

CONCEPT=ci-run-log

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi

# Window first: a malformed request should not cost an API call.
ci_window_parse "$CONCEPT"

rc=0
RUN=$(gh_run_json "$CODEV_CI_RUN_ID") || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "gh run view ${CODEV_CI_RUN_ID}" "$CI_TIMEOUT"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" not-found "run ${CODEV_CI_RUN_ID} could not be read (gh exit ${rc}); pass the \`id\` from ci-runs, not the run \`number\`" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" '{runId: $r}')"
  exit 1
fi

ci_require_json "$CONCEPT" "$RUN" "gh run view ${CODEV_CI_RUN_ID}"

if [ -n "$CODEV_CI_JOB_ID" ]; then
  TARGET=$(printf '%s' "$RUN" | jq -c --argjson j "$CODEV_CI_JOB_ID" 'first(.jobs[] | select(.databaseId == $j)) // empty')
  if [ -z "$TARGET" ]; then
    ci_fail "$CONCEPT" not-found "job ${CODEV_CI_JOB_ID} is not part of run ${CODEV_CI_RUN_ID}" \
      "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --arg j "$CODEV_CI_JOB_ID" '{runId: $r, jobId: $j}')"
    exit 1
  fi
else
  TARGET=$(printf '%s' "$RUN" | jq -c "${GH_FAILED_JOBS_JQ} | .[0] // empty")
  # No failing job: fall back to the only job, if there is exactly one. With
  # several passing jobs there is no defensible default, and picking one would
  # hand back a log the caller did not ask for.
  if [ -z "$TARGET" ]; then
    TARGET=$(printf '%s' "$RUN" | jq -c 'if (.jobs | length) == 1 then .jobs[0] else empty end')
  fi
  if [ -z "$TARGET" ]; then
    NAMES=$(printf '%s' "$RUN" | jq -c '[.jobs[] | {id: .databaseId, name: .name}]')
    ci_fail "$CONCEPT" bad-input "run ${CODEV_CI_RUN_ID} has no failing job and more than one job; set CODEV_CI_JOB_ID" \
      "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson jobs "$NAMES" '{runId: $r, jobs: $jobs}')"
    exit 2
  fi
fi

JOB_ID=$(printf '%s' "$TARGET" | jq -r '.databaseId')
JOB_NAME=$(printf '%s' "$TARGET" | jq -r '.name')
JOB_STATE=$(printf '%s' "$TARGET" | jq -r '.conclusion // .status')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rc=0
gh_job_log "$JOB_ID" "$JOB_STATE" "$TMP/raw.log" || rc=$?
if [ "$rc" -eq 124 ]; then
  ci_fail_timeout "$CONCEPT" "gh api repos/{owner}/{repo}/actions/jobs/${JOB_ID}/logs" "$CI_TIMEOUT"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "could not read the log for job ${JOB_ID} (${JOB_NAME}); gh exit ${rc}" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson j "$JOB_ID" --arg n "$JOB_NAME" '{runId: $r, jobId: $j, jobName: $n}')"
  exit 1
fi

ci_clean_log < "$TMP/raw.log" > "$TMP/clean.log"
ci_window_emit "$CONCEPT" "$TMP" github "$CODEV_CI_RUN_ID" "$JOB_ID" "$JOB_NAME" "$CI_LOG_FROM_CACHE"
