#!/bin/sh
# Forge concept: recently-merged (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_SINCE_DATE (optional — RFC3339, or a bare YYYY-MM-DD)
# Output: JSON [{number, title, url, body, createdAt, mergedAt, headRefName}]
#         (MergedPrItem in forge-contracts.ts)
#
# WHY THIS DOES NOT PAGE `pulls?state=closed` (issue #12)
#
# It used to, walking every page and filtering to merged in jq. On the reference
# Forgejo that is 1598 closed pulls at ~1s each — about 26 minutes for a panel
# that wants the last 24 hours. It never surfaced as a hang because
# executeForgeCommand kills a concept at 30s and returns null, so afx status and
# every dashboard poll rendered an EMPTY merged-PR panel with nothing on stderr.
# A silent wrong answer, on every poll, indefinitely.
#
# Two endpoints replace it, because the two things needed live in different
# places:
#
#   1. `issues?type=pulls&state=closed&since=<cutoff>` — the cheap index. ~1.8s
#      per 50 against the same repo the pulls list charges ~50s for, because it
#      does not materialise head/base commit info. Carries number, title, body,
#      created_at, html_url and pull_request.merged_at: everything the contract
#      wants except the head branch. `since` is a SERVER-side filter, so the
#      window bounds the work rather than the client discarding most of it.
#   2. `pulls/{n}` per surviving match, for the head branch only, fetched
#      GITEA_CONCURRENCY at a time (see gitea_fetch_pulls).
#
# `since` filters on updated_at, not merged_at. That is sound here and not an
# approximation: merging a PR updates it, so merged_at <= updated_at always, and
# no PR merged inside the window can have updated_at outside it. The reverse is
# not true — a PR merged long ago and commented on yesterday comes back — so
# merged_at is still checked against the cutoff below.
#
# BOUNDS. Every path through this script is bounded, and it says so when a bound
# bites:
#
#   * No CODEV_SINCE_DATE   -> a default window of GITEA_MERGED_DEFAULT_DAYS (7),
#                              announced on stderr. It does NOT mean "all time":
#                              that is the 26-minute walk, and answering it
#                              slowly is not better than refusing it.
#   * Window too wide       -> more than GITEA_MERGED_MAX_PRS (300) merged PRs in
#                              the window stops with exit status 3.
#   * Index still paging    -> tea_api_paged's own deadline, also status 3.
#
# EXIT STATUS 3 IS THE TRUNCATION MARKER, and stdout is empty when it is
# returned. "Nothing merged" is `[]` with status 0; "I stopped looking" is status
# 3 with a stderr line saying what bound bit. They must not be spelled the same
# way — a short list and a truncated list are indistinguishable once printed,
# which is the exact shape of the bug this script is replacing.
set -e
. "$(dirname "$0")/_lib.sh"

# Default lookback when the caller names no date. Sized so that the widest
# routine caller still fits inside the 30s ceiling executeForgeCommand puts on
# every concept: a week is ~107 merged PRs on the reference repo, ~14s at
# GITEA_CONCURRENCY=8. A month is ~476, which cannot fit at any concurrency this
# script would be polite enough to use — so it is refused loudly, not attempted.
GITEA_MERGED_DEFAULT_DAYS=${CODEV_FORGE_MERGED_DAYS:-7}
case "$GITEA_MERGED_DEFAULT_DAYS" in
  ''|*[!0-9]*|0) GITEA_MERGED_DEFAULT_DAYS=7 ;;
esac

GITEA_MERGED_MAX_PRS=${CODEV_FORGE_MERGED_MAX:-300}
case "$GITEA_MERGED_MAX_PRS" in
  ''|*[!0-9]*|0) GITEA_MERGED_MAX_PRS=300 ;;
esac

REPO="$(gitea_repo)" || exit 1

# --- cutoff ----------------------------------------------------------------
# Normalise to exactly YYYY-MM-DDTHH:MM:SSZ. Both this and Gitea's timestamps
# are then UTC, second-precision and fixed-width, which is what makes the plain
# string comparison in the jq below a correct chronological one.
#
# `jq -n now` rather than date(1) for the default window: BSD date wants
# `-v-7d` and GNU date wants `-d '7 days ago'`, and jq is already a hard
# dependency of every script here.
if [ -n "$CODEV_SINCE_DATE" ]; then
  case "$CODEV_SINCE_DATE" in
    ????-??-??)            CUTOFF="${CODEV_SINCE_DATE}T00:00:00Z" ;;
    ????-??-??T??:??:??Z)  CUTOFF="$CODEV_SINCE_DATE" ;;
    ????-??-??T??:??:??*)  CUTOFF="$(printf '%.19s' "$CODEV_SINCE_DATE")Z" ;;
    *)
      echo "recently-merged: could not read CODEV_SINCE_DATE='${CODEV_SINCE_DATE}' as a date; expected YYYY-MM-DD or RFC3339" >&2
      exit 2
      ;;
  esac
else
  CUTOFF="$(jq -rn --argjson s "$((GITEA_MERGED_DEFAULT_DAYS * 86400))" 'now - $s | todate')"
  echo "recently-merged: no CODEV_SINCE_DATE given; limiting to the last ${GITEA_MERGED_DEFAULT_DAYS} days (since ${CUTOFF}). Set CODEV_SINCE_DATE, or raise CODEV_FORGE_MERGED_DAYS." >&2
fi

# --- cheap index -----------------------------------------------------------
rc=0
INDEX="$(tea_api_paged "repos/${REPO}/issues" "type=pulls&state=closed&since=${CUTOFF}")" || rc=$?
case $rc in
  0) ;;
  3) echo "recently-merged: the closed-pull index for '${REPO}' since ${CUTOFF} was truncated; narrow CODEV_SINCE_DATE rather than trusting a partial list" >&2; exit 3 ;;
  # 4 = the body was not a list, i.e. an error object, now on stdout to classify.
  4)
    case "$(gitea_api_error "$INDEX")" in
      notfound) echo "recently-merged: repository '${REPO}' has no readable pull index" >&2 ;;
      *)        echo "recently-merged: Gitea could not list closed pulls for '${REPO}': ${INDEX}" >&2 ;;
    esac
    exit 1
    ;;
  *) exit 1 ;;
esac

BASE_RECORDS="$(printf '%s' "$INDEX" | jq --arg cutoff "$CUTOFF" '
  [ .[]
    | select(type == "object" and (.number | type) == "number")
    | select(.pull_request != null and .pull_request.merged_at != null)
    | select(.pull_request.merged_at >= $cutoff)
    | {
        number,
        title: (.title // ""),
        url: (.pull_request.html_url // .html_url // ""),
        body: (.body // ""),
        createdAt: .created_at,
        mergedAt: .pull_request.merged_at
      }
  ]
  | sort_by(.mergedAt) | reverse
')"

COUNT="$(printf '%s' "$BASE_RECORDS" | jq 'length')"
if [ "$COUNT" -eq 0 ]; then
  echo '[]'
  exit 0
fi
if [ "$COUNT" -gt "$GITEA_MERGED_MAX_PRS" ]; then
  echo "recently-merged: ${COUNT} PRs merged since ${CUTOFF}, over the ${GITEA_MERGED_MAX_PRS} ceiling. Refusing to return a partial list — narrow CODEV_SINCE_DATE, or raise CODEV_FORGE_MERGED_MAX." >&2
  exit 3
fi

# --- head branches ---------------------------------------------------------
# The one field the index cannot supply. analytics.ts derives the protocol from
# it (protocolFromBranch), so an empty value is not a harmless omission.
NUMBERS="$(printf '%s' "$BASE_RECORDS" | jq -r '.[].number')"
# shellcheck disable=SC2086  # word splitting is the point: one arg per number
PULLS="$(gitea_fetch_pulls "$REPO" $NUMBERS)" || exit 1

# Reduce to a compact {number: branch} map BEFORE it reaches argv. Passing the
# raw PR objects through `--argjson` overflows ARG_MAX: a week of merges on the
# reference repo is 107 full PR objects and `jq: Argument list too long` was the
# result. The map is one short string per PR, so at the GITEA_MERGED_MAX_PRS
# ceiling it is ~13KB — nowhere near the limit.
#
# `.head.ref` reads "refs/pull/N/head" once a merged PR's branch is deleted,
# which is the normal state of every PR this concept returns; `.head.label`
# keeps the branch name. Prefer the label.
HEADS="$(printf '%s' "$PULLS" | jq -c '
  map({ key: (.number | tostring), value: (.head.label // .head.ref // "") }) | from_entries
')"

printf '%s' "$BASE_RECORDS" | jq --argjson heads "$HEADS" '
  map(. + { headRefName: ($heads[.number | tostring] // "") })
'
