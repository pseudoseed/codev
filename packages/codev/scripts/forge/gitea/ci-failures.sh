#!/bin/sh
# Forge concept: ci-failures (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_CI_RUN_ID (required), CODEV_CI_JOB_ID (optional)
# Output: the shared ci-failures envelope; see github/ci-failures.sh
#
# REQUIRES FORGEJO 16.0 OR LATER. The Actions job-log API
# (`actions/jobs/{id}/logs`) landed in Forgejo 16.0, released 2026-07-16; on
# 15.0.2 there is no token-reachable log anywhere — not via `tea actions runs
# logs` (which calls that same route), not via any other API route, and not via
# the web UI route, which is session-only and rejects both an API token and
# basic auth. Verified against a live 15.0.2 instance.
#
# On such a server this returns the `unsupported-server` envelope, naming the
# version it found and the version it needs, and CARRYING THE FAILING JOB NAMES
# it was still able to determine. What it must never do is return an empty
# `failures` array: "your CI is fine" and "I cannot see your CI at all" are
# opposite facts, and they are the same observation to a caller that only sees
# an empty list.
set -e
. "$(dirname "$0")/_ci.sh"

CONCEPT=ci-failures

if [ -z "$CODEV_CI_RUN_ID" ]; then
  jq -cn '{ok: false, error: "bad-input", detail: "CODEV_CI_RUN_ID is required"}'
  echo "${CONCEPT}: CODEV_CI_RUN_ID is required" >&2
  exit 2
fi
ci_require_id "$CONCEPT" CODEV_CI_RUN_ID "$CODEV_CI_RUN_ID"
[ -z "$CODEV_CI_JOB_ID" ] || ci_require_id "$CONCEPT" CODEV_CI_JOB_ID "$CODEV_CI_JOB_ID"

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
RUN_STATUS=$(jq -r '.status // "unknown"' "$TMP/run.json")

rc=0
gitea_ci_jobs "$CONCEPT" "$REPO" "$CODEV_CI_RUN_ID" "$RUN_INDEX" "$TMP" || rc=$?
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "could not list the jobs of run ${CODEV_CI_RUN_ID}"
  exit 1
fi
JOB_SOURCE=$(cat "$TMP/jobs.source")
FAILED=$(jq -c '[ .[] | select(.status == "failure" or .status == "timed_out" or .conclusion == "failure") ]' "$TMP/jobs.json")
JOBS_FAILED=$(printf '%s' "$FAILED" | jq 'length')

# Forgejo 15: the jobs came from the task scan, so there is no job id and no log
# API. Say which server this is, and hand back what IS known.
if [ "$JOB_SOURCE" = "tasks-scan" ]; then
  gitea_ci_unsupported "$CONCEPT" "job-log" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" --argjson f "$FAILED" --argjson n "$JOBS_FAILED" \
       '{runId: ($r | tonumber? // $r), runStatus: $rs, jobsFailed: $n,
         failingJobs: [ $f[] | {taskId: .taskId, jobName: .name} ],
         hint: "ci-run-view still works on this server and lists per-job status"}')"
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
  TARGET=$(printf '%s' "$FAILED" | jq -c '.[0] // empty')
fi

if [ -z "$TARGET" ]; then
  jq -cn --arg r "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" '{
    ok: true, provider: "gitea", runId: ($r | tonumber? // $r),
    runStatus: $rs, runConclusion: null, jobsFailed: 0, extracted: false,
    reason: (if $rs == "success" then "no job in this run failed" else "no failing job found for this run" end),
    failures: []}'
  exit 0
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
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson j "$JOB_ID" --arg n "$JOB_NAME" --argjson c "$JOBS_FAILED" \
       '{runId: ($r | tonumber? // $r), jobsFailed: $c, failingJobs: [{jobId: $j, jobName: $n}]}')"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  ci_fail "$CONCEPT" forge-error "could not read the log for job ${JOB_ID} (${JOB_NAME})" \
    "$(jq -cn --arg r "$CODEV_CI_RUN_ID" --argjson j "$JOB_ID" --arg n "$JOB_NAME" '{runId: $r, jobId: $j, jobName: $n}')"
  exit 1
fi

ci_clean_log < "$TMP/raw.log" > "$TMP/clean.log"
# awk NR, not `wc -l`: a log with no trailing newline makes wc undercount by
# one, and logLines would then disagree with the from/to the extractor reports.
LOG_LINES=$(awk 'END {print NR}' "$TMP/clean.log")
OTHERS=$(printf '%s' "$FAILED" | jq -c --argjson j "$JOB_ID" '[.[] | select(.id != $j) | {id: .id, name: .name}]')

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
    --arg run "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" \
    --argjson job "$JOB_ID" --arg jobName "$JOB_NAME" \
    --arg matched "$MATCHED" --argjson text "$TEXT" \
    --argjson from "$FROM" --argjson to "$TO" \
    --argjson logLines "$LOG_LINES" --argjson returned "$RETURNED_LINES" \
    --argjson truncated "$TRUNCATED" --argjson jobsFailed "$JOBS_FAILED" \
    --argjson others "$OTHERS" --argjson cached "$CI_LOG_FROM_CACHE" \
    '{ok: true, provider: "gitea", runId: ($run | tonumber? // $run),
      runStatus: $rs, runConclusion: null,
      jobsFailed: $jobsFailed, extracted: true,
      failures: [{
        jobId: $job, jobName: $jobName,
        stepName: null, stepNumber: null,
        matchedBy: $matched, text: $text,
        from: $from, to: $to,
        logLines: $logLines, returnedLines: $returned, truncated: $truncated
      }],
      otherFailingJobs: $others, cached: $cached}'
  exit 0
fi

jq -cn \
  --arg run "$CODEV_CI_RUN_ID" --arg rs "$RUN_STATUS" \
  --argjson job "$JOB_ID" --arg jobName "$JOB_NAME" \
  --argjson logLines "$LOG_LINES" --argjson jobsFailed "$JOBS_FAILED" \
  --argjson others "$OTHERS" --argjson cached "$CI_LOG_FROM_CACHE" \
  '{ok: true, provider: "gitea", runId: ($run | tonumber? // $run),
    runStatus: $rs, runConclusion: null,
    jobsFailed: $jobsFailed, extracted: false,
    reason: "no recognized failure pattern",
    failures: [{jobId: $job, jobName: $jobName, logLines: $logLines}],
    otherFailingJobs: $others, cached: $cached,
    next: ("ci-run-log CODEV_CI_RUN_ID=" + $run + " CODEV_CI_JOB_ID=" + ($job|tostring) + " CODEV_CI_LOG_TAIL=80")}'
