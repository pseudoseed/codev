# Shared plumbing for the CI concepts (#13). SOURCED, not executed.
#
# Holds the response envelope, the caps, the log cache, and the window parsing —
# everything the four concepts share that is not the extraction ladder itself
# (that is _ci-extract.sh). POSIX sh; jq is required, as it already is for
# pr-list and every gitea concept.
#
# THE ENVELOPE, AND WHY ERRORS ARE PRINTED ON STDOUT
#
# Every ci-* concept prints ONE JSON object on stdout, on success and on
# failure. A caller therefore always has something structured to read, and never
# has to interpret an empty string.
#
# That includes the failure paths, which is a deliberate departure from the
# other concepts. `executeForgeCommand` collapses every failure mode to `null`
# (forge.ts), so "the API timed out at 60s", "the run does not exist" and "the
# server has no log API" arrive identically — and #12 spent a phase on exactly
# that ambiguity with pr-exists returning null-that-read-as-false. Printing the
# envelope regardless of exit status means the class of failure survives the
# trip. Exit statuses still follow the #12 contract: 0 answered, 1 could not
# answer, 2 missing or unusable input.
#
# The one rule that outranks the rest: a response that carries log text ALWAYS
# carries logLines, returnedLines and truncated, so a trimmed answer can never
# read as a whole one.

CI_LIMIT_DEFAULT=20

# Per-extract and per-response byte caps (issue #13: "a few KB per failing
# step"). A cap that bites is always reported as truncated:true — never
# silently.
CI_MAX_STEP_BYTES=${CODEV_CI_MAX_STEP_BYTES:-2048}
CI_MAX_RESPONSE_BYTES=${CODEV_CI_MAX_BYTES:-8192}
case "$CI_MAX_STEP_BYTES" in ''|*[!0-9]*) CI_MAX_STEP_BYTES=2048 ;; esac
case "$CI_MAX_RESPONSE_BYTES" in ''|*[!0-9]*) CI_MAX_RESPONSE_BYTES=8192 ;; esac

# How many list pages a client-side filter may walk before it stops and says so.
CI_MAX_PAGES=${CODEV_CI_MAX_PAGES:-4}
case "$CI_MAX_PAGES" in ''|*[!0-9]*|0) CI_MAX_PAGES=4 ;; esac

# A separate, higher ceiling for the Forgejo-15 task scan, which is a TARGETED
# lookup for one known run rather than an open-ended filter: it stops the moment
# it has walked past that run, so a recent run costs one page and the ceiling
# only bites on old ones. Measured on the reference Forgejo, a page of 50 tasks
# spans about 6 runs (~8 jobs per run), so 4 pages reached only 24 runs back and
# reported truncation for anything older — technically honest and practically
# useless. 20 pages is ~120 runs of history at ~0.25s per page.
CI_TASKS_MAX_PAGES=${CODEV_CI_TASKS_MAX_PAGES:-20}
case "$CI_TASKS_MAX_PAGES" in ''|*[!0-9]*|0) CI_TASKS_MAX_PAGES=20 ;; esac

# The status vocabulary a caller may use, provider-independent. Taken from what
# Forgejo accepts; GitHub spells one of them differently and is translated in
# ci_status_for.
CI_STATUS_VOCABULARY="success failure pending queued in_progress skipped canceled"

# Print the error envelope on stdout, a human line on stderr, and return 1.
#
#   ci_fail <concept> <kind> <detail> [extra-json-object]
#
# `kind` is a stable machine token — timeout, not-found, unsupported-server,
# forge-error, bad-input — and `detail` is the sentence a person reads.
ci_fail() {
  _concept="$1"; _kind="$2"; _detail="$3"; _extra="$4"
  [ -n "$_extra" ] || _extra='{}'
  jq -cn --arg kind "$_kind" --arg detail "$_detail" --argjson extra "$_extra" \
    '{ok: false, error: $kind, detail: $detail} + $extra'
  echo "${_concept}: ${_detail}" >&2
  # Returns 0 DELIBERATELY. Every concept runs under `set -e`, so a non-zero
  # return here would abort the script at this line — before the caller's own
  # `exit 2` for a bad input could run, turning every input error into a
  # generic exit 1. Reporting and deciding the exit status are separate jobs;
  # this one only reports.
  return 0
}

# The timeout envelope. Kept separate from ci_fail so that every concept spells
# a timeout the same way and none of them can quietly turn one into a generic
# failure or an empty result — the specific thing #17, #8 and #12 all ran into.
ci_fail_timeout() {
  _concept="$1"; _what="$2"; _seconds="$3"
  ci_fail "$_concept" timeout \
    "${_what} did not return within ${_seconds}s" \
    "$(jq -cn --argjson s "$_seconds" '{seconds: $s, remedy: "raise CODEV_FORGE_TIMEOUT"}')"
}

# Validate a caller-supplied status against the shared vocabulary.
# Unknown values exit 2 naming the accepted set rather than being passed to the
# forge, where GitHub would reject them with its own wording and Forgejo would
# silently return everything.
ci_check_status() {
  _concept="$1"; _status="$2"
  [ -n "$_status" ] || return 0
  for _s in $CI_STATUS_VOCABULARY; do
    [ "$_s" = "$_status" ] && return 0
  done
  _msg="CODEV_CI_STATUS=${_status} is not one of: ${CI_STATUS_VOCABULARY}"
  jq -cn --arg d "$_msg" '{ok: false, error: "bad-input", detail: $d}'
  echo "${_concept}: ${_msg}" >&2
  exit 2
}

# Translate the shared vocabulary into what a provider expects on the wire.
#
# The vocabulary spells it `canceled` because that is what `tea actions runs
# list --help` documents. Both forges want `cancelled`: GitHub has always spelt
# it that way, and Forgejo — despite its own CLI help — answers
# `status=canceled` with `{"message":"unknown status: canceled"}` while
# `status=cancelled` returns 2240 runs. Measured, because the two spellings are
# exactly the kind of difference that turns into an empty list nobody questions.
ci_status_for() {
  _provider="$1"; _status="$2"
  if [ "$_status" = "canceled" ]; then
    printf 'cancelled'
  else
    printf '%s' "$_status"
  fi
}

# Is this job status terminal? Only a terminal job has an immutable log, and
# only an immutable log may be cached.
ci_status_is_terminal() {
  case "$1" in
    success|failure|skipped|canceled|cancelled|completed|timed_out|neutral|stale|startup_failure|failed) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Log cache
# ---------------------------------------------------------------------------
#
# A completed run log is immutable, so the realistic sequence — ci-failures,
# then ci-run-log with a tail, then ci-run-log with a grep — should cost exactly
# one download instead of three. Cached under TMPDIR rather than in the repo:
# these are large and disposable, and TMPDIR inherits the OS cleanup.
#
# In-progress jobs are NEVER cached and never read from cache. Caching a running
# job would hand back a log that stops mid-failure and looks complete, which is
# the failure mode this whole issue is about.

CI_CACHE_MAX_MB=${CODEV_CI_CACHE_MAX_MB:-32}
case "$CI_CACHE_MAX_MB" in ''|*[!0-9]*) CI_CACHE_MAX_MB=32 ;; esac

ci_cache_path() {
  _provider="$1"; _slug="$2"; _job="$3"
  _slug=$(printf '%s' "$_slug" | tr '/ ' '__')
  printf '%s/codev-ci-logs/%s/%s/%s.log' "${TMPDIR:-/tmp}" "$_provider" "$_slug" "$_job"
}

# Copy a cached log to stdout if it exists and caching is enabled.
ci_cache_read() {
  [ "$CODEV_CI_NO_CACHE" = "1" ] && return 1
  [ -s "$1" ] || return 1
  cat "$1"
}

# Store a log, but only for a terminal job and only under the size cap.
ci_cache_write() {
  _path="$1"; _src="$2"; _status="$3"
  [ "$CODEV_CI_NO_CACHE" = "1" ] && return 0
  ci_status_is_terminal "$_status" || return 0
  _bytes=$(wc -c < "$_src" | tr -d ' ')
  [ "$_bytes" -le $((CI_CACHE_MAX_MB * 1024 * 1024)) ] || return 0
  mkdir -p "$(dirname "$_path")" 2>/dev/null || return 0
  cp "$_src" "${_path}.tmp$$" 2>/dev/null && mv "${_path}.tmp$$" "$_path" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------------------
# Windows for ci-run-log
# ---------------------------------------------------------------------------
#
# Exactly one of head/tail/grep, and no default. A defaulted window is how this
# concept turns into "tail by habit", which is the thing the issue asks for it
# to be separate in order to prevent. Zero windows and two windows are both
# exit 2 with a named message.
ci_window_parse() {
  _concept="$1"
  CI_WIN_KIND=""
  CI_WIN_ARG=""
  _count=0
  if [ -n "$CODEV_CI_LOG_TAIL" ]; then CI_WIN_KIND=tail; CI_WIN_ARG="$CODEV_CI_LOG_TAIL"; _count=$((_count + 1)); fi
  if [ -n "$CODEV_CI_LOG_HEAD" ]; then CI_WIN_KIND=head; CI_WIN_ARG="$CODEV_CI_LOG_HEAD"; _count=$((_count + 1)); fi
  if [ -n "$CODEV_CI_LOG_GREP" ]; then CI_WIN_KIND=grep; CI_WIN_ARG="$CODEV_CI_LOG_GREP"; _count=$((_count + 1)); fi

  if [ "$_count" -eq 0 ]; then
    _msg="exactly one window is required: CODEV_CI_LOG_TAIL=N, CODEV_CI_LOG_HEAD=N, or CODEV_CI_LOG_GREP=<pattern>"
  elif [ "$_count" -gt 1 ]; then
    _msg="exactly one window may be set; got ${_count} of CODEV_CI_LOG_TAIL / CODEV_CI_LOG_HEAD / CODEV_CI_LOG_GREP"
  else
    case "$CI_WIN_KIND" in
      head|tail)
        case "$CI_WIN_ARG" in
          ''|*[!0-9]*|0)
            _upper=$(printf '%s' "$CI_WIN_KIND" | tr 'a-z' 'A-Z')
            _msg="CODEV_CI_LOG_${_upper} must be a positive number of lines, got '${CI_WIN_ARG}'" ;;
          *) return 0 ;;
        esac
        ;;
      *) return 0 ;;
    esac
  fi

  jq -cn --arg d "$_msg" '{ok: false, error: "bad-input", detail: $d}'
  echo "${_concept}: ${_msg}" >&2
  exit 2
}

CI_GREP_CONTEXT=${CODEV_CI_LOG_CONTEXT:-3}
case "$CI_GREP_CONTEXT" in ''|*[!0-9]*) CI_GREP_CONTEXT=3 ;; esac

# ---------------------------------------------------------------------------
# Turning text into a capped JSON payload
# ---------------------------------------------------------------------------

# Copy a file to <dest>, capped at <cap> bytes, whole lines only, from the head
# — for an extract the assertion is at the top and half a line is worse than a
# missing one. Echoes "<returnedLines> <true|false>".
#
# The count and the truncation flag are RETURNED, not assigned to globals: every
# caller runs this inside a command substitution, where a subshell assignment is
# discarded and the caller then hands jq an empty --argjson. That mistake was
# made here once and cost a debugging round; the shape now makes it impossible.
ci_cap_file() {
  _src="$1"; _cap="$2"; _dest="$3"
  _bytes=$(wc -c < "$_src" | tr -d ' ')
  if [ "$_bytes" -le "$_cap" ]; then
    cp "$_src" "$_dest"
    _trunc=false
  else
    awk -v cap="$_cap" '{ t += length($0) + 1; if (t > cap) exit; print }' "$_src" > "$_dest"
    _trunc=true
  fi
  printf '%s %s' "$(awk 'END {print NR}' "$_dest")" "$_trunc"
}

# ---------------------------------------------------------------------------
# Tool invocation
# ---------------------------------------------------------------------------

. "$(dirname "$0")/../_timeout.sh"

# Wall-clock ceiling for one forge CLI call. Same knob as the gitea concepts
# use, deliberately: an operator raising CODEV_FORGE_TIMEOUT for a slow forge
# should not have to discover that CI has its own.
CI_TIMEOUT=${CODEV_FORGE_TIMEOUT:-60}
case "$CI_TIMEOUT" in ''|*[!0-9]*) CI_TIMEOUT=60 ;; esac

# Run a forge CLI under the timeout. Returns the command status, or 124 for a
# timeout — which the caller MUST turn into ci_fail_timeout rather than folding
# into a generic failure. This function does not print the envelope itself
# because every caller captures its stdout.
ci_tool() {
  _rc=0
  forge_timeout "$CI_TIMEOUT" "$@" || _rc=$?
  return "$_rc"
}

# owner/repo for cache keys and API paths. Honors CODEV_REPO, else derives it
# from the origin remote. Unlike gitea_repo this never fails the concept — the
# only caller that cannot proceed without it says so itself — so an
# underivable slug degrades to "unknown-repo" for the cache path alone.
ci_repo_slug() {
  _repo="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
  case "$_repo" in
    */*) printf '%s' "$_repo" ;;
    *) printf 'unknown-repo' ;;
  esac
}


# ---------------------------------------------------------------------------
# Windowing a cleaned log into the ci-run-log response
# ---------------------------------------------------------------------------
#
#   ci_window_emit <concept> <tmpdir> <provider> <runId> <jobId> <jobName> <cached>
#
# Reads <tmpdir>/clean.log, applies the window ci_window_parse selected, and
# prints the response. Shared by both providers so that a tail means the same
# thing on GitHub and on Forgejo.
#
# `from` and `to` are line numbers into the FULL log, always, so a caller knows
# where in the log it is standing and whether more exists on either side. In
# grep mode the selected lines are not contiguous, so `contiguous: false` says
# so and `matchLines` lists exactly which lines matched — otherwise a reader
# would have to infer which of the returned lines were hits and which were
# context, and inference is what these concepts exist to remove.
ci_window_emit() {
  _concept="$1"; _tmp="$2"; _provider="$3"; _run="$4"; _job="$5"; _jobname="$6"; _cached="$7"
  _log="${_tmp}/clean.log"
  _total=$(awk 'END {print NR}' "$_log")
  _matchlines=null
  _matches=null
  _contiguous=true

  case "$CI_WIN_KIND" in
    head)
      _from=1
      _to=$CI_WIN_ARG
      [ "$_to" -gt "$_total" ] && _to=$_total
      sed -n "${_from},${_to}p" "$_log" > "${_tmp}/window.txt"
      ;;
    tail)
      _from=$((_total - CI_WIN_ARG + 1))
      [ "$_from" -lt 1 ] && _from=1
      _to=$_total
      sed -n "${_from},${_to}p" "$_log" > "${_tmp}/window.txt"
      ;;
    grep)
      if ! awk -v pat="$CI_WIN_ARG" -v ctx="$CI_GREP_CONTEXT" \
            -v out="${_tmp}/window.txt" -v nums="${_tmp}/matches.txt" '
            { line[NR] = $0; if ($0 ~ pat) hit[NR] = 1 }
            END {
              for (i = 1; i <= NR; i++)
                if (i in hit) {
                  lo = i - ctx; if (lo < 1) lo = 1
                  hi = i + ctx; if (hi > NR) hi = NR
                  for (j = lo; j <= hi; j++) sel[j] = 1
                  print i > nums
                }
              first = 0; last = 0
              for (i = 1; i <= NR; i++)
                if (i in sel) { print line[i] > out; if (!first) first = i; last = i }
              print first, last
            }' "$_log" > "${_tmp}/bounds.txt" 2>"${_tmp}/awk.err"; then
        ci_fail "$_concept" bad-input \
          "CODEV_CI_LOG_GREP is not a usable pattern: $(tr -d '\n' < "${_tmp}/awk.err")"
        exit 2
      fi
      _from=$(cut -d' ' -f1 "${_tmp}/bounds.txt")
      _to=$(cut -d' ' -f2 "${_tmp}/bounds.txt")
      [ -f "${_tmp}/window.txt" ] || : > "${_tmp}/window.txt"
      [ -f "${_tmp}/matches.txt" ] || : > "${_tmp}/matches.txt"
      _matches=$(wc -l < "${_tmp}/matches.txt" | tr -d ' ')
      _matchlines=$(jq -R -s -c 'split("\n") | map(select(. != "") | tonumber)' < "${_tmp}/matches.txt")
      _contiguous=false
      # No match is an answer, not a failure: an empty window with matches: 0.
      [ "$_from" -eq 0 ] && _from=0 && _to=0
      ;;
  esac

  _meta=$(ci_cap_file "${_tmp}/window.txt" "$CI_MAX_RESPONSE_BYTES" "${_tmp}/capped.txt")
  _returned=${_meta% *}
  _trunc=${_meta#* }
  _lines=$(jq -R -s -c 'split("\n") | if (.[-1] == "") then .[0:-1] else . end' < "${_tmp}/capped.txt")

  jq -cn \
    --arg provider "$_provider" --arg run "$_run" --argjson job "$_job" --arg jobName "$_jobname" \
    --arg kind "$CI_WIN_KIND" --arg arg "$CI_WIN_ARG" \
    --argjson total "$_total" --argjson returned "$_returned" --argjson truncated "$_trunc" \
    --argjson from "$_from" --argjson to "$_to" --argjson lines "$_lines" \
    --argjson matchLines "$_matchlines" --argjson matches "$_matches" \
    --argjson contiguous "$_contiguous" --argjson cached "$_cached" \
    '{ok: true, provider: $provider, runId: ($run | tonumber? // $run), jobId: $job, jobName: $jobName,
      window: {kind: $kind, arg: $arg},
      logLines: $total, returnedLines: $returned, from: $from, to: $to,
      contiguous: $contiguous, truncated: $truncated,
      matches: $matches, matchLines: $matchLines,
      cached: $cached, lines: $lines}'
}
