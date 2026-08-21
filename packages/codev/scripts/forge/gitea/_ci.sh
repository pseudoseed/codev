# Shared helpers for the Gitea/Forgejo CI concept scripts (#13). SOURCED.
#
# Sources gitea/_lib.sh for gitea_repo / gitea_api / gitea_api_error (#12) and
# the shared _ci-lib.sh / _ci-extract.sh. POSIX sh, leading underscore, never a
# concept.
#
# WHAT FORGEJO ACTUALLY OFFERS, MEASURED 2026-08-21
#
# The issue proposed driving this from `tea actions runs list|view|logs`. Those
# subcommands exist on tea 0.14.2, and two of the three do not work against
# Forgejo 15.0.2 (git.pseudoseed.com):
#
#   tea actions runs view 11130  → 404 on /api/v1/repos/…/actions/runs/11130/jobs
#   tea actions runs logs 6881 --job 40084
#                                → 404 on /api/v1/repos/…/actions/jobs/40084/logs
#
# Both routes were added in **Forgejo 16.0** (released 2026-07-16). And
# `tea actions runs list --output json` is lossy even where it works: workflow,
# branch, started and duration all come back as empty strings. So these scripts
# go through `tea api`, as #12 established for the PR concepts.
#
# What 15.0.2 does have:
#
#   GET actions/runs?page=1&limit=N[&status=…]   runs; 0.3s; ~17.8 KB PER RUN
#                                                (each embeds a full repo object)
#   GET actions/runs/{id}                        one run
#   GET actions/tasks?page=1&limit=N[&status=…]  JOBS, GitHub-shaped, 482 B each
#
# Three query-parameter facts, all measured, all footguns:
#
#   * `limit` is IGNORED unless `page` is also present. `actions/runs?limit=3`
#     returned all 6922 runs. Every call here passes page=1.
#   * `status=` filters server-side and works.
#   * `branch=` and `event=` are silently IGNORED. Branch filtering is
#     client-side, and it is not a string compare — see below.
#
# THE BRANCH IS NOT THE BRANCH
#
# For `pull_request` runs Forgejo reports head_branch / prettyref as `#3847` —
# the PR number. Only push and schedule runs carry a real branch name. On the
# reference repo the first 100 tasks were: #3869 ×32, #3865 ×10, main ×7,
# v1.0.230 ×1. So filtering by `builder/pir-13` matches NOTHING on a repo that
# runs CI on pull requests, unless the branch is first resolved to its PR
# number — which is one base/head lookup, the same primitive #12 built.
#
# TWO ID SPACES
#
# Run `id` 11130 has `index_in_repo` 6881, and `actions/runs/6881` resolves to a
# DIFFERENT, real run. The web URL shows the index. So CODEV_CI_RUN_ID is always
# the `id` field from ci-runs, never the number, and these scripts never guess
# which one they were handed.

. "$(dirname "$0")/_lib.sh"
. "$(dirname "$0")/../_ci-lib.sh"
. "$(dirname "$0")/../_ci-extract.sh"

# The Forgejo release that first exposed Actions jobs and logs over the API.
GITEA_CI_LOG_MIN_VERSION="16.0"

# The server version string, for error messages. Best effort: a server that will
# not answer `version` still gets a usable message, just a vaguer one.
gitea_server_version() {
  _v=$(gitea_api "version" 2>/dev/null) || _v=
  printf '%s' "$_v" | jq -r '.version // "unknown"' 2>/dev/null || printf 'unknown'
}

# The unsupported-server envelope.
#
# This exists so that an old Forgejo can never be mistaken for a run with no
# failures. Those two are the same observation to a caller that only sees an
# empty array, and they are opposite facts: one means "your CI is fine", the
# other means "I cannot see your CI at all".
gitea_ci_unsupported() {
  _concept="$1"; _route="$2"; _extra="$3"
  [ -n "$_extra" ] || _extra='{}'
  _ver=$(gitea_server_version)
  ci_fail "$_concept" unsupported-server \
    "this Forgejo has no Actions ${_route} API (added in Forgejo ${GITEA_CI_LOG_MIN_VERSION}); server reports ${_ver}. ci-runs and ci-run-view still work here." \
    "$(printf '%s' "$_extra" | jq -c --arg v "$_ver" --arg n "$GITEA_CI_LOG_MIN_VERSION" '. + {serverVersion: $v, needs: (">=" + $n)}')"
  return 0
}

# Fetch a JSON response INTO A FILE and classify it.
#
#   gitea_ci_fetch <url> <destfile>
#     0  = a JSON object or array is in <destfile>
#     44 = the endpoint said 404 (on Forgejo 15 that is how a missing Actions
#          API announces itself)
#     45 = some other error body, left in <destfile> for the caller to quote
#     124 = timed out (gitea_api already said so on stderr)
#
# A file rather than a shell variable because a single page of `actions/runs` is
# ~892 KB — Forgejo embeds the entire repository object in every run — and the
# jq reduction should read it from disk rather than after it has been copied
# through two shell strings.
gitea_ci_fetch() {
  _url="$1"; _dest="$2"
  _rc=0
  gitea_api "$_url" > "$_dest" || _rc=$?
  [ "$_rc" -eq 0 ] || return "$_rc"
  # Classify from the FILE, not from a prefix of it. Reading `head -c 400` and
  # handing that to gitea_api_error looked equivalent and is not: a truncated
  # JSON prefix does not parse, so every large healthy response classified as an
  # error. Found on the first live call against Forgejo.
  if jq -e 'type == "array"' "$_dest" >/dev/null 2>&1; then
    return 0
  fi
  if jq -e 'type == "object"' "$_dest" >/dev/null 2>&1; then
    _msg=$(jq -r '.message // empty' "$_dest" 2>/dev/null) || _msg=
    case "$_msg" in
      '') return 0 ;;
      *"couldn't be found"*|*'could not be found'*|*'Not found'*|*'not found'*|*'does not exist'*) return 44 ;;
      *) return 45 ;;
    esac
  fi
  # Not JSON at all: Forgejo answers an unknown ROUTE with the bare text
  # "404 page not found", which is how a missing Actions API announces itself.
  case "$(head -c 40 "$_dest")" in
    404*) return 44 ;;
  esac
  return 45
}

# Resolve a branch name to the PR ref Forgejo will have recorded on its runs.
# Echoes `#<n>` when the branch has a PR, nothing when it does not. Returns 1
# only when the REPO could not be read — a branch with no PR is an answer.
gitea_ci_pr_ref() {
  _repo="$1"; _branch="$2"
  _base=${CODEV_PR_BASE:-$(gitea_default_branch "$_repo")} || return 1
  _resp=$(gitea_api "repos/${_repo}/pulls/${_base}/${_branch}") || return 1
  case "$(gitea_api_error "$_resp")" in
    ok) ;;
    *) return 0 ;;
  esac
  _n=$(printf '%s' "$_resp" | jq -r 'if type == "object" and (.number | type) == "number" then "#\(.number)" else empty end' 2>/dev/null) || _n=
  printf '%s' "$_n"
}

# The jobs of a run, normalised, plus GITEA_JOB_SOURCE describing where they
# came from. Echoes a JSON array; returns 1 on a hard failure.
#
# Forgejo 16 has `actions/runs/{id}/jobs`, which carries the job `id` the log
# API takes. Forgejo 15 has neither, but `actions/tasks` lists the same jobs
# with a `run_number`, so the run object gives us `index_in_repo` and the tasks
# can be filtered to it. That fallback is why `ci-run-view` still answers on
# 15.0.2 instead of going dark with the log concepts.
#
# On the fallback path the identifier is a TASK id, not a job id, and there is
# no way to obtain a job id on a server that does not expose jobs. So `id` is
# null and `taskId` carries what we have. Emitting the task id as `id` would
# hand callers a number that looks usable with ci-run-log and is not.
gitea_ci_jobs() {
  _concept="$1"; _repo="$2"; _runid="$3"; _runindex="$4"; _out="$5"
  printf 'false' > "${_out}/jobs.truncated"

  _rc=0
  gitea_ci_fetch "repos/${_repo}/actions/runs/${_runid}/jobs" "${_out}/jobs.raw" || _rc=$?
  if [ "$_rc" -eq 0 ]; then
    printf 'runs-jobs' > "${_out}/jobs.source"
    jq -c '[ .[]? | {
      id: .id, taskId: .task_id, name: .name,
      status: .status,
      conclusion: (if (.status == "success" or .status == "failure" or .status == "skipped" or .status == "canceled" or .status == "cancelled") then .status else null end),
      startedAt: null, completedAt: null, failedSteps: []
    } ]' "${_out}/jobs.raw" > "${_out}/jobs.json"
    return 0
  fi
  [ "$_rc" -eq 44 ] || return 1

  # Forgejo 15: no jobs route. Recover the jobs from `actions/tasks`, which
  # carries run_number. Tasks come back newest-first, so a run occupies one
  # contiguous block and the walk can stop the moment it has gone PAST that
  # block — otherwise every lookup of an older run would cost the full page
  # ceiling and report truncation it did not need to.
  printf 'tasks-scan' > "${_out}/jobs.source"
  _acc='[]'
  _page=1
  _found=0
  _passed=0
  while [ "$_page" -le "$CI_TASKS_MAX_PAGES" ]; do
    _rc=0
    gitea_ci_fetch "repos/${_repo}/actions/tasks?page=${_page}&limit=${GITEA_PAGE_LIMIT}" "${_out}/tasks.json" || _rc=$?
    [ "$_rc" -eq 0 ] || return 1
    _raw=$(jq '.workflow_runs | length' "${_out}/tasks.json")
    [ "$_raw" -eq 0 ] && break
    _hits=$(jq -c --argjson r "$_runindex" '[ .workflow_runs[]? | select(.run_number == $r) | {
        id: null, taskId: .id, name: .name, status: .status,
        conclusion: (if (.status == "success" or .status == "failure" or .status == "skipped" or .status == "canceled" or .status == "cancelled") then .status else null end),
        startedAt: .run_started_at, completedAt: .updated_at, failedSteps: []
      } ]' "${_out}/tasks.json")
    if [ "$(printf '%s' "$_hits" | jq 'length')" -gt 0 ]; then
      _acc=$(printf '%s\n%s' "$_acc" "$_hits" | jq -s -c 'add')
      _found=1
    fi
    _min=$(jq --argjson r "$_runindex" '[.workflow_runs[]?.run_number] | min // ($r + 1)' "${_out}/tasks.json")
    if [ "$_min" -lt "$_runindex" ]; then _passed=1; break; fi
    [ "$_raw" -lt "$GITEA_PAGE_LIMIT" ] && break
    _page=$((_page + 1))
  done
  printf '%s' "$_acc" > "${_out}/jobs.json"
  # Truncated only when the walk ran out of allowance BEFORE reaching the run.
  # Having walked past it and found nothing is a complete answer.
  if [ "$_found" -eq 0 ] && [ "$_passed" -eq 0 ] && [ "$_page" -gt "$CI_TASKS_MAX_PAGES" ]; then
    printf 'true' > "${_out}/jobs.truncated"
    echo "${_concept}: this Forgejo has no jobs API, and run ${_runid} was not reached within ${CI_TASKS_MAX_PAGES} pages of the task list; raise CODEV_CI_TASKS_MAX_PAGES" >&2
  fi
  return 0
}

# Fetch one job log (Forgejo 16 only), via the cache when the job is terminal.
gitea_ci_job_log() {
  _repo="$1"; _job="$2"; _status="$3"; _dest="$4"
  _cache=$(ci_cache_path gitea "$_repo" "$_job")
  if ci_cache_read "$_cache" > "$_dest" 2>/dev/null && [ -s "$_dest" ]; then
    CI_LOG_FROM_CACHE=true
    return 0
  fi
  CI_LOG_FROM_CACHE=false
  _rc=0
  gitea_api "repos/${_repo}/actions/jobs/${_job}/logs" > "$_dest" || _rc=$?
  [ "$_rc" -eq 0 ] || return "$_rc"
  # `tea api` exits 0 on HTTP errors and prints the body, so a 404 arrives here
  # looking like a log. Classify it before anyone treats an error page as one.
  if [ ! -s "$_dest" ] || gitea_api_error "$(head -c 200 "$_dest")" | grep -q 'notfound'; then
    return 44
  fi
  ci_cache_write "$_cache" "$_dest" "$_status"
  return 0
}
