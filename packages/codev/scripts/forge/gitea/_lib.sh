# Shared helpers for the Gitea forge preset scripts.
#
# This file is SOURCED, not executed (`. "$(dirname "$0")/_lib.sh"`), so it has
# no shebang and defines only functions/vars. POSIX sh only — no bashisms — the
# scripts are #!/bin/sh and forge runs them via `sh -c`. It is not a forge
# concept: forge.ts builds presets from an explicit KNOWN_CONCEPTS allowlist, so
# a leading-underscore file in this directory is never registered as a concept.

# Resolve owner/repo for the `tea api` path.
#
# `tea api` needs an explicit owner/repo in the path (unlike `tea pulls`/`tea
# issues`, which auto-detect it from the local git remote). Honor CODEV_REPO
# when set, else derive owner/repo from origin's URL (handles https, ssh, and
# scp-style remotes, with or without a .git suffix).
#
# Fails fast: if the result isn't a clean `owner/repo` (no origin remote, an
# unusual URL, etc.), print a stderr message naming CODEV_REPO as the remedy and
# return non-zero so the caller can `exit 1` — otherwise `tea api "repos//…"`
# fails later with a confusing 404. Callers must use:  REPO="$(gitea_repo)" || exit 1
gitea_repo() {
  _repo="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
  _owner=${_repo%%/*}
  _rest=${_repo#*/}
  # Valid iff exactly one slash, both sides non-empty:
  #   - "$_owner" = "$_repo"       → no slash at all
  #   - -z "$_owner" / -z "$_rest" → empty owner or repo (e.g. "/x", "x/")
  #   - "$_rest" != "${_rest%/*}"  → a second slash (e.g. "a/b/c")
  if [ -z "$_repo" ] || [ "$_owner" = "$_repo" ] || [ -z "$_owner" ] || [ -z "$_rest" ] || [ "$_rest" != "${_rest%/*}" ]; then
    echo "gitea forge: could not determine owner/repo from the 'origin' remote; set CODEV_REPO=owner/repo" >&2
    return 1
  fi
  printf '%s' "$_repo"
}

# Page size to request per page. Gitea caps list responses at the server's
# `max_response_items` (default 50), so `&limit=200` silently truncates to ~50
# with no client-side pagination. Requesting 50 matches that default cap; a
# server tuned higher just returns more per page (fewer round-trips).
GITEA_PAGE_LIMIT=50

# Hard ceiling on pages fetched, so a misbehaving server that never returns a
# short page can't spin forever. 100 pages × 50 = 5000 items — far beyond any
# real open-PR / recently-merged / all-pulls window we page over.
GITEA_MAX_PAGES=100

# Fetch a paginated Gitea list endpoint and emit ONE concatenated JSON array on
# stdout, so the caller's existing jq normalizer sees the same shape as before.
#
# Usage: tea_api_paged "repos/<owner>/<repo>/pulls" "state=all"
#   $1 = API path (no page params)
#   $2 = extra query string (may be empty), e.g. "state=open"
#
# Loops page=1,2,3… appending "&limit=<N>&page=<page>", concatenates each page's
# array, and stops when a page returns fewer than the requested limit (the last
# page) or an empty/blank response, bounded by GITEA_MAX_PAGES.
#
# EXIT STATUS: 0 = the whole list was fetched, 3 = it STOPPED EARLY and what is
# on stdout is a PREFIX, 4 = the response WAS NOT A LIST (an error body — stdout
# carries it verbatim for the caller to classify with gitea_api_error), 1 = the
# request failed. Callers must distinguish 3 from 0: a short list and a truncated
# list look identical once printed, and reading a truncated one as complete is
# how "recently merged" quietly renders an empty panel. Truncation also always
# says so on stderr.
#
# Status 4 exists because callers cannot classify an error body they never see.
# Gitea answers a 404 with a JSON OBJECT, and this function used to feed that
# straight into `jq -s 'add'`, which cannot add an object to an array — so the
# walk died on a raw `jq: error (at <stdin>:1): array ([]) and object ({...})
# cannot be added` and the caller's own gitea_api_error check, sitting after the
# call, was unreachable. The exit status was still non-zero, so no wrong answer
# was ever returned; what was lost was the message saying which PR was missing.
# Found by the claude review lane on PIR #12 and reproduced before fixing.
tea_api_paged() {
  _path="$1"
  _query="$2"
  _page=1
  _acc='[]'
  _items=0
  _deadline=$(( $(date +%s) + GITEA_PAGED_DEADLINE ))
  while [ "$_page" -le "$GITEA_MAX_PAGES" ]; do
    if [ "$(date +%s)" -ge "$_deadline" ]; then
      echo "gitea forge: '${_path}' still had pages after ${GITEA_PAGED_DEADLINE}s (${_items} items over $((_page - 1)) pages); stopping. Raise CODEV_FORGE_PAGED_DEADLINE, or narrow the query." >&2
      printf '%s' "$_acc"
      return 3
    fi
    if [ -n "$_query" ]; then
      _url="${_path}?${_query}&limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    else
      _url="${_path}?limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    fi
    _resp="$(gitea_api "$_url")" || return 1
    # Blank body or an empty array → no more pages.
    [ -n "$_resp" ] || break
    # Classify BEFORE accumulating. Anything that is not a JSON array cannot be
    # a page of results, and must reach the caller intact rather than as a jq
    # diagnostic about adding an object to an array.
    if ! printf '%s' "$_resp" | jq -e 'type == "array"' >/dev/null 2>&1; then
      printf '%s' "$_resp"
      return 4
    fi
    _count="$(printf '%s' "$_resp" | jq 'length')" || return 1
    _acc="$(printf '%s\n%s' "$_acc" "$_resp" | jq -s 'add')" || return 1
    _items=$((_items + _count))
    [ "$_count" -lt "$GITEA_PAGE_LIMIT" ] && break
    _page=$((_page + 1))
  done
  if [ "$_page" -gt "$GITEA_MAX_PAGES" ]; then
    echo "gitea forge: '${_path}' hit the ${GITEA_MAX_PAGES}-page ceiling (${_items} items); stopping." >&2
    printf '%s' "$_acc"
    return 3
  fi
  printf '%s' "$_acc"
}

# ---------------------------------------------------------------------------
# Timeouts
# ---------------------------------------------------------------------------

# Wall-clock ceiling for a single `tea api` call, in seconds. Override with
# CODEV_FORGE_TIMEOUT. 60s is generous for any single-object Gitea endpoint
# (a repo probe is ~0.2s, a PR object ~0.3s, a base/head lookup ~1.2s against a
# real Forgejo) while still being far below the 300s porch check timeout, so a
# stuck call surfaces as a named error inside a phase rather than as a stalled
# phase.
GITEA_TIMEOUT=${CODEV_FORGE_TIMEOUT:-60}
case "$GITEA_TIMEOUT" in
  ''|*[!0-9]*) GITEA_TIMEOUT=60 ;;
esac

# Wall-clock ceiling for a whole paged walk (see tea_api_paged), in seconds.
# Override with CODEV_FORGE_PAGED_DEADLINE. Deliberately larger than
# GITEA_TIMEOUT: a legitimate multi-page walk is several sequential requests.
GITEA_PAGED_DEADLINE=${CODEV_FORGE_PAGED_DEADLINE:-120}
case "$GITEA_PAGED_DEADLINE" in
  ''|*[!0-9]*) GITEA_PAGED_DEADLINE=120 ;;
esac

# Run a command under a wall-clock limit. Returns the command's own exit status,
# or 124 (the exit status `timeout(1)` uses) if the limit was reached.
#
# Deliberately does NOT use timeout(1)/gtimeout even when present. macOS ships
# neither by default, so the fallback would be the path that actually runs for
# most adopters while the tested-in-CI path would be the one that doesn't —
# exactly the arrangement where the untested path rots. One implementation,
# same behaviour everywhere.
#
# TWO THINGS HERE ARE LOAD-BEARING, and both exist because killing the command
# is not the same as unblocking the caller:
#
#  1. The command's stdout goes to a TEMP FILE, not to the caller's pipe. Every
#     caller runs this inside `$(...)`. A killed command can leave a grandchild
#     holding the write end of that pipe, and the command substitution then
#     blocks forever on a process nobody is waiting for — the timeout fires, the
#     message prints, and the script still hangs. Measured, not theorised: with
#     the command writing straight to the pipe, a 3s timeout against a wrapper
#     that spawns `sleep 300` printed its timeout message at 3s and was still
#     blocked two minutes later.
#  2. The watchdog subshell's own stdout goes to /dev/null, for the same reason.
#
# Grandchildren are swept with `pkill -P` where it exists. That is best-effort
# and not the guarantee — (1) is the guarantee, and it holds even where `pkill`
# does not exist.
gitea_timeout() {
  _limit="$1"
  shift
  # Both files live in a private mktemp DIRECTORY. The marker's path used to be
  # derived from the output file's ("$_tf.fired"), which mktemp does not reserve
  # — a predictable name in a world-writable tmpdir that anyone could pre-create
  # to make every call report a timeout.
  _dir=$(mktemp -d) || return 1
  _tf="${_dir}/out"
  _fired="${_dir}/fired"
  "$@" >"$_tf" &
  _cmd_pid=$!
  ( sleep "$_limit"
    # Claim the timeout only if there is still something to kill. Writing the
    # marker unconditionally misreports a command that finished in the same
    # instant the deadline passed — it succeeded, and saying otherwise discards
    # a good answer. `kill -0` narrows that window to the gap between this test
    # and the signal; it cannot be closed entirely without a lock, and a
    # false timeout is a retryable error rather than a wrong answer.
    if kill -0 "$_cmd_pid" 2>/dev/null; then
      : > "$_fired"
      pkill -TERM -P "$_cmd_pid" 2>/dev/null
      kill -TERM "$_cmd_pid" 2>/dev/null
      sleep 2
      pkill -KILL -P "$_cmd_pid" 2>/dev/null
      kill -KILL "$_cmd_pid" 2>/dev/null
    fi
  ) >/dev/null 2>&1 &
  _wd_pid=$!
  # `|| _rc=$?` rather than `wait; _rc=$?`: the concept scripts run under
  # `set -e`, which would abort here the moment the wrapped command exited
  # non-zero — before the timeout could be classified and named.
  _rc=0
  wait "$_cmd_pid" || _rc=$?
  kill "$_wd_pid" 2>/dev/null

  # Whether the watchdog fired is recorded by the watchdog, not INFERRED from
  # the exit status. Inferring it (status 143/137 = "we killed it") looked
  # equivalent and is not: a killed process can still exit 0. A wrapper whose
  # own `wait` takes no operand does exactly that — POSIX defines operand-less
  # `wait` as always returning zero — so its death by SIGTERM was reported as a
  # successful call returning an empty body, and the caller then diagnosed an
  # unreadable repository instead of a timeout. Found by the test that pins this
  # function; the marker file cannot be wrong the same way.
  if [ -f "$_fired" ]; then
    rm -rf "$_dir"
    return 124
  fi
  # A half-written response is worse than no response, so output is emitted only
  # on the non-timeout path.
  cat "$_tf"
  rm -rf "$_dir"
  return "$_rc"
}

# `tea api` under GITEA_TIMEOUT, with a named error on the timeout path.
#
# Every gitea concept script goes through this rather than calling `tea api`
# directly, so that a Gitea endpoint which stops returning surfaces as an error
# naming the endpoint instead of a phase that never finishes (issue #12: a
# `state=all` walk of a 1599-PR repo cost ~17 minutes and read as a hang).
#
# NOTE: `tea api` exits 0 on HTTP errors and prints the error body, so a zero
# status from this function means "the request completed", NOT "it succeeded".
# Callers must inspect the response — see gitea_api_error.
gitea_api() {
  _rc=0
  gitea_timeout "$GITEA_TIMEOUT" tea api "$@" || _rc=$?
  if [ "$_rc" -eq 124 ]; then
    echo "gitea forge: 'tea api $*' did not return within ${GITEA_TIMEOUT}s; set CODEV_FORGE_TIMEOUT to raise the limit" >&2
    return 124
  fi
  return "$_rc"
}

# Classify a `tea api` response body. Echoes one of:
#   ok        — a JSON object or array (the request succeeded)
#   notfound  — Gitea's 404, in either of the two shapes it uses
#   error     — anything else (auth failure, 5xx, unparseable body)
#
# Gitea answers 404 two ways: a JSON body `{"message":"The target couldn't be
# found.", ...}` for a known route with an unknown target, and the bare text
# `404 page not found` for an unknown route. Both are verified against Forgejo
# 15.x + tea 0.14.2.
#
# `notfound` is NOT on its own an answer of "no". A mistyped or unreachable
# owner/repo returns a byte-identical 404 to a repo that simply has no such PR,
# so a caller may only read `notfound` as "no" once it has independently
# established that the repo resolves — see gitea_default_branch, which does
# exactly that as a side effect.
gitea_api_error() {
  _body="$1"
  case "$_body" in
    404*) printf 'notfound'; return 0 ;;
  esac
  _type=$(printf '%s' "$_body" | jq -r 'type' 2>/dev/null) || _type=
  case "$_type" in
    object)
      _message=$(printf '%s' "$_body" | jq -r '.message // empty' 2>/dev/null) || _message=
      case "$_message" in
        '') printf 'ok' ;;
        *"couldn't be found"*|*"could not be found"*|*'Not found'*|*'not found'*|*'does not exist'*)
          printf 'notfound' ;;
        *) printf 'error' ;;
      esac
      ;;
    array) printf 'ok' ;;
    *) printf 'error' ;;
  esac
}

# Resolve the repository's default branch, and — as the load-bearing side
# effect — prove that the repo resolves at all under the current credentials.
#
# Both matter. Gitea returns the SAME 404 body for "this repo does not exist /
# you cannot see it" as for "this branch has no PR", so a base/head lookup's 404
# is only readable as "no PR" after this call has succeeded. Callers that skip
# it because they were handed an explicit base would answer `false` for a
# typo'd CODEV_REPO.
gitea_default_branch() {
  _repo="$1"
  _resp=$(gitea_api "repos/${_repo}") || return 1
  _status=$(gitea_api_error "$_resp")
  if [ "$_status" != "ok" ]; then
    echo "gitea forge: could not read repository '${_repo}' — Gitea said: ${_resp}" >&2
    echo "gitea forge: set CODEV_REPO=owner/repo, or run from a checkout whose remote is a configured Gitea host" >&2
    return 1
  fi
  _branch=$(printf '%s' "$_resp" | jq -r '.default_branch // empty' 2>/dev/null) || _branch=
  if [ -z "$_branch" ]; then
    echo "gitea forge: repository '${_repo}' reported no default branch; set CODEV_PR_BASE" >&2
    return 1
  fi
  printf '%s' "$_branch"
}

# How many PR objects to fetch at once in gitea_fetch_pulls. Override with
# CODEV_FORGE_CONCURRENCY.
#
# Forgejo answers a single PR object in ~1s, and the alternative — asking the
# list endpoint for the same PRs — costs the same ~1s each AND cannot be bounded
# by which PRs you actually want. Sequential resolution of a week of merges (107
# PRs on the reference repo) is ~107s, past the 30s ceiling
# `executeForgeCommand` imposes on every concept; at 8 at a time it is ~14s and
# fits. 8 is deliberately polite — this is somebody's self-hosted forge.
GITEA_CONCURRENCY=${CODEV_FORGE_CONCURRENCY:-8}
case "$GITEA_CONCURRENCY" in
  ''|*[!0-9]*|0) GITEA_CONCURRENCY=8 ;;
esac

# Fetch several PR objects by number and emit them as ONE JSON array.
#
# Usage: gitea_fetch_pulls <repo> <number>...
#
# Fetches up to GITEA_CONCURRENCY at a time into a temp dir, then concatenates.
# A number whose fetch fails or returns a non-PR body is DROPPED from the result
# rather than aborting the batch: these are all "resolve some detail about PRs I
# already know exist" calls, and one unreadable PR should not take out the whole
# answer. Ordering of the output array is not meaningful — callers sort.
gitea_fetch_pulls() {
  _repo="$1"
  shift
  [ $# -gt 0 ] || { printf '[]'; return 0; }

  _dir=$(mktemp -d) || return 1
  _n=0
  for _num in "$@"; do
    gitea_api "repos/${_repo}/pulls/${_num}" >"${_dir}/${_num}.json" 2>/dev/null &
    _n=$((_n + 1))
    if [ $((_n % GITEA_CONCURRENCY)) -eq 0 ]; then
      wait
    fi
  done
  wait

  # `jq -s` over the files, keeping only bodies that really are PR objects.
  # A plain glob, not `find | xargs`: xargs is free to split a long list across
  # SEVERAL jq invocations, which would emit several arrays and silently drop
  # all but the first once the caller parsed it. Callers cap their batches (see
  # GITEA_MERGED_MAX_PRS), so the glob cannot approach ARG_MAX.
  _out=$(jq -s '[ .[] | select(type == "object" and (.number | type) == "number") ]' "$_dir"/*.json 2>/dev/null) || _out=
  rm -rf "$_dir"
  if [ -z "$_out" ]; then
    printf '[]'
    return 0
  fi
  printf '%s' "$_out"
}
