#!/bin/sh
# Forge concept: ci-failures (GitHub via gh CLI)
# forge-executable: gh
# Input:  CODEV_CI_RUN_ID (required — the `id` from ci-runs)
#         CODEV_CI_JOB_ID (optional — pin one job instead of the first failing)
# Output: {ok, provider, runId, runStatus, runConclusion, jobsFailed, extracted,
#          failures: [{jobId, jobName, stepName, stepNumber, matchedBy, text,
#                      from, to, logLines, returnedLines, truncated}],
#          otherFailingJobs, cached}
#
# The concept that matters. Two calls: the run (structured, gives the failing
# job and the failing STEP name), then that ONE job's log, which is extracted
# down to the assertion and capped. The other failing jobs are listed by name
# and id and deliberately not fetched — later failures are usually downstream of
# the first, and fetching them is how a bounded answer becomes a log dump again.
#
# WHEN EXTRACTION FAILS IT SAYS SO AND HANDS OVER
#
#   {"extracted": false, "reason": "no recognized failure pattern",
#    "failures": [{"jobId": …, "jobName": …, "logLines": 1247}],
#    "next": "ci-run-log CODEV_CI_RUN_ID=… CODEV_CI_JOB_ID=… CODEV_CI_LOG_TAIL=80"}
#
# It never falls back to "here are the last 50 lines". A builder handed 50
# arbitrary lines treats them as the diagnosis and reasons from noise; a builder
# told extraction failed reads the log with a targeted ci-run-log call, which is
# both correct and cheaper. The response carries the job id it would need, so
# the refusal is a handoff rather than a dead end.
set -e
. "$(dirname "$0")/_lib.sh"

CONCEPT=ci-failures

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi
ci_require_id "$CONCEPT" CODEV_CI_RUN_ID "$CODEV_CI_RUN_ID"
[ -z "$CODEV_CI_JOB_ID" ] || ci_require_id "$CONCEPT" CODEV_CI_JOB_ID "$CODEV_CI_JOB_ID"

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

FAILED=$(printf '%s' "$RUN" | jq -c "$GH_FAILED_JOBS_JQ")
RUN_STATUS=$(printf '%s' "$RUN" | jq -r '.status // "unknown"')
RUN_CONCLUSION=$(printf '%s' "$RUN" | jq -r '.conclusion // "null"')

# Pin a job if asked. A job id that is not in this run is an error, not an empty
# answer — silently returning "nothing failed" for a mistyped id is the exact
# shape of wrong answer this concept exists to remove.
if [ -n "$CODEV_CI_JOB_ID" ]; then
  TARGET=$(printf '%s' "$RUN" | jq -c --argjson j "$CODEV_CI_JOB_ID" 'first(.jobs[] | select(.databaseId == $j)) // empty')
  if [ -z "$TARGET" ]; then
    ci_fail "$CONCEPT" not-found "job ${CODEV_CI_JOB_ID} is not part of run ${CODEV_CI_RUN_ID}" \
      "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --arg j "$CODEV_CI_JOB_ID" '{runId: $r, jobId: $j}')"
    exit 1
  fi
else
  TARGET=$(printf '%s' "$FAILED" | jq -c '.[0] // empty')
fi

JOBS_FAILED=$(printf '%s' "$FAILED" | jq 'length')

# No failing job. Say which of the two reasons it is — a green run and a run
# still going are not the same answer, and neither is "the server could not tell
# me", which is an error envelope rather than this branch.
if [ -z "$TARGET" ]; then
  printf '%s' "$RUN" | jq -c --arg concept "$CONCEPT" '{
    ok: true, provider: "github", runId: .databaseId,
    runStatus: .status, runConclusion: .conclusion,
    jobsFailed: 0, extracted: false,
    reason: (if .status != "completed" then "run has not finished" else "no job in this run failed" end),
    failures: []
  }'
  exit 0
fi

JOB_ID=$(printf '%s' "$TARGET" | jq -r '.databaseId')
JOB_NAME=$(printf '%s' "$TARGET" | jq -r '.name')
JOB_STATE=$(printf '%s' "$TARGET" | jq -r '.conclusion // .status')
STEP=$(printf '%s' "$TARGET" | jq -c 'first(.steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out")) // null')

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
# awk NR, not `wc -l`: a log with no trailing newline makes wc undercount by
# one, and logLines would then disagree with the from/to the extractor reports.
LOG_LINES=$(awk 'END {print NR}' "$TMP/clean.log")

OTHERS=$(printf '%s' "$FAILED" | jq -c --argjson j "$JOB_ID" '[.[] | select(.databaseId != $j) | {id: .databaseId, name: .name}]')

if ci_extract "$TMP/clean.log" > "$TMP/extract.txt" 2>/dev/null && [ -s "$TMP/extract.txt" ]; then
  MATCHED=$(head -1 "$TMP/extract.txt" | cut -f1)
  FROM=$(head -1 "$TMP/extract.txt" | cut -f2)
  TO=$(head -1 "$TMP/extract.txt" | cut -f3)
  tail -n +2 "$TMP/extract.txt" > "$TMP/text.txt"
  CAP=$CI_MAX_STEP_BYTES
  [ "$CAP" -gt "$CI_MAX_RESPONSE_BYTES" ] && CAP=$CI_MAX_RESPONSE_BYTES
  META=$(ci_cap_file "$TMP/text.txt" "$CAP" "$TMP/capped.txt")
  RETURNED_LINES=${META% *}
  TRUNCATED=${META#* }
  TEXT=$(jq -R -s -c . < "$TMP/capped.txt")
  jq -cn \
    --arg run "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" --arg rc "$RUN_CONCLUSION" \
    --argjson job "$JOB_ID" --arg jobName "$JOB_NAME" --argjson step "$STEP" \
    --arg matched "$MATCHED" --argjson text "$TEXT" \
    --argjson from "$FROM" --argjson to "$TO" \
    --argjson logLines "$LOG_LINES" --argjson returned "$RETURNED_LINES" \
    --argjson truncated "$TRUNCATED" --argjson jobsFailed "$JOBS_FAILED" \
    --argjson others "$OTHERS" --argjson cached "$CI_LOG_FROM_CACHE" \
    '{ok: true, provider: "github", runId: ($run | tonumber? // $run),
      runStatus: $rs, runConclusion: (if $rc == "null" then null else $rc end),
      jobsFailed: $jobsFailed, extracted: true,
      failures: [{
        jobId: $job, jobName: $jobName,
        stepName: ($step.name // null), stepNumber: ($step.number // null),
        matchedBy: $matched, text: $text,
        from: $from, to: $to,
        logLines: $logLines, returnedLines: $returned, truncated: $truncated
      }],
      otherFailingJobs: $others, cached: $cached}'
  exit 0
fi

# Rung 6: nothing recognisable. Hand over the parameters for the follow-up
# rather than inventing a diagnosis.
jq -cn \
  --arg run "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" --arg rc "$RUN_CONCLUSION" \
  --argjson job "$JOB_ID" --arg jobName "$JOB_NAME" \
  --argjson logLines "$LOG_LINES" --argjson jobsFailed "$JOBS_FAILED" \
  --argjson others "$OTHERS" --argjson cached "$CI_LOG_FROM_CACHE" \
  '{ok: true, provider: "github", runId: ($run | tonumber? // $run),
    runStatus: $rs, runConclusion: (if $rc == "null" then null else $rc end),
    jobsFailed: $jobsFailed, extracted: false,
    reason: "no recognized failure pattern",
    failures: [{jobId: $job, jobName: $jobName, logLines: $logLines}],
    otherFailingJobs: $others, cached: $cached,
    next: ("ci-run-log CODEV_CI_RUN_ID=" + $run + " CODEV_CI_JOB_ID=" + ($job|tostring) + " CODEV_CI_LOG_TAIL=80")}'
