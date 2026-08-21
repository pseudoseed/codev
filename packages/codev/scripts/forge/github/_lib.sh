# Shared helpers for the GitHub CI concept scripts (#13). SOURCED, not executed.
#
# POSIX sh, no shebang, leading underscore so forge never registers it as a
# concept. The older github concepts are one-line `exec gh …` scripts and do not
# use this; the CI ones need a run lookup, a job-log fetch and a cache, and none
# of that should be written three times.

. "$(dirname "$0")/../_ci-lib.sh"
. "$(dirname "$0")/../_ci-extract.sh"

# The gh `run view` projection every CI concept needs. One call, ~1.3s measured,
# and it already carries per-step conclusions — so the failing STEP name comes
# from structured JSON rather than from parsing a log.
GH_RUN_FIELDS='databaseId,number,displayTitle,workflowName,name,status,conclusion,headBranch,headSha,event,url,createdAt,jobs'

# Fetch a run as JSON. Echoes the JSON; returns 124 on timeout, 1 otherwise.
gh_run_json() {
  ci_tool gh run view "$1" --json "$GH_RUN_FIELDS"
}

# The jobs of a run that actually failed, as a JSON array, in run order.
#
# `cancelled` is NOT in this list. A cancelled job has no failure to diagnose,
# and treating it as one produces an extract of whatever the runner happened to
# be printing when the cancel landed — an arbitrary slice of log presented as a
# cause, which is the thing this concept exists to avoid.
GH_FAILED_JOBS_JQ='[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")]'

# Fetch one job log, via the cache when the job is terminal.
#
#   gh_job_log <jobId> <jobStatusOrConclusion> <destFile>
#
# Uses `gh api repos/{owner}/{repo}/actions/jobs/{id}/logs` — NOT
# `gh run view --log-failed`. The reason is measured, and it contradicts the
# issue that asked for this work: --log-failed returned 2528 lines / 293 KB for
# one failing job on run 32515040122, every line tagged "UNKNOWN STEP", because
# it selects the failing JOB and cannot always attribute lines to steps. The
# per-job endpoint returns the same bytes without the invented step column, for
# exactly the job asked for, and mirrors the shape Forgejo 16 serves at
# `actions/jobs/{id}/logs` — so both providers share one cache and one
# extractor.
gh_job_log() {
  _job="$1"; _status="$2"; _dest="$3"
  _cache=$(ci_cache_path github "$(ci_repo_slug)" "$_job")
  if ci_cache_read "$_cache" > "$_dest" 2>/dev/null && [ -s "$_dest" ]; then
    CI_LOG_FROM_CACHE=true
    return 0
  fi
  CI_LOG_FROM_CACHE=false
  _rc=0
  ci_tool gh api "repos/{owner}/{repo}/actions/jobs/${_job}/logs" > "$_dest" || _rc=$?
  [ "$_rc" -eq 0 ] || return "$_rc"
  ci_cache_write "$_cache" "$_dest" "$_status"
  return 0
}
