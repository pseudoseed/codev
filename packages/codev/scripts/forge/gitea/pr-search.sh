#!/bin/sh
# Forge concept: pr-search (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_SEARCH_QUERY
# Output: JSON [{number, title, state, url, headRefName, baseRefName}]
#         (PrSearchItem in forge-contracts.ts)
#
# Forgejo has no GitHub-style PR search, so the query is PARSED rather than
# forwarded. The grammar covers exactly the five query strings this codebase
# builds, and anything outside it returns [] rather than a guess:
#
#   head:<branch>                consult findPRForCurrentBranch (consult/index.ts)
#   head:<branch> is:merged      afx cleanup, merged check
#   head:<branch> is:open        afx cleanup, open check
#   <issue-number>               consult findPRForIssue
#   in:body #<issue> is:open     afx spawn, collision check
#
# STATE DEFAULT — upstream cluesmith/codev#1331 (fixes #759). With no `is:`
# qualifier the search spans ALL states, because `consult --type pr` runs after
# the PR is merged and an open-only search fails there with "No PR found for
# branch". An explicit `is:` qualifier overrides that default in both
# directions, which is what makes the two afx cleanup queries and the afx spawn
# query mean what they say.
#
# That default is also why afx spawn's query carries `is:open`. #1331's review
# established that spawn-worktree.ts leaned on the OLD open-only default to mean
# "open PRs", so making the search all-states without touching it aborts every
# re-spawn of an issue that ever had a merged PR, with a factually wrong "Found
# N open PR(s)". The qualifier is passed explicitly there now; this script must
# keep honouring it.
#
# ORDERING — open PRs first, then by descending number. Callers read prs[0]
# (consult/index.ts findPRForCurrentBranch and findPRForIssue both do), and once
# results span states "first" has to mean something. The open PR is the live one;
# among closed ones the highest number is the most recent.
set -e
. "$(dirname "$0")/_lib.sh"

# How many candidate PRs from an issue-number search get resolved to full PR
# objects. Each costs ~1s against a real Forgejo. An issue with more than this
# many PRs referencing it is a pathological case, and taking the newest ones is
# the right truncation — but say so on stderr rather than quietly shortening.
SEARCH_MAX_CANDIDATES=${CODEV_FORGE_SEARCH_MAX:-10}

QUERY=${CODEV_SEARCH_QUERY:-}

# --- parse -----------------------------------------------------------------
HEAD_BRANCH=
TERM=
WANT_OPEN=0
WANT_MERGED=0
WANT_CLOSED=0
HAS_STATE=0
UNKNOWN=0

for token in $QUERY; do
  case "$token" in
    head:*)   HEAD_BRANCH=${token#head:} ;;
    is:open)   WANT_OPEN=1;   HAS_STATE=1 ;;
    is:merged) WANT_MERGED=1; HAS_STATE=1 ;;
    is:closed) WANT_CLOSED=1; HAS_STATE=1 ;;
    # `in:body` names where GitHub should look. Forgejo's `q=` already searches
    # title and body together, so it is accepted and carries no extra meaning.
    in:body)  ;;
    '#'[0-9]*) TERM=${token#\#} ;;
    [0-9]*)
      case "$token" in
        *[!0-9]*) UNKNOWN=1 ;;
        *) TERM=$token ;;
      esac
      ;;
    *) UNKNOWN=1 ;;
  esac
done

if [ "$HAS_STATE" -eq 0 ]; then
  WANT_OPEN=1; WANT_MERGED=1; WANT_CLOSED=1
fi

if [ -z "$HEAD_BRANCH" ] && [ -z "$TERM" ]; then
  if [ -n "$QUERY" ]; then
    echo "pr-search: gitea does not understand the query '${QUERY}' — returning no matches rather than guessing" >&2
  fi
  echo '[]'
  exit 0
fi
if [ "$UNKNOWN" -eq 1 ]; then
  echo "pr-search: ignoring unrecognised term(s) in '${QUERY}'" >&2
fi

REPO="$(gitea_repo)" || exit 1
# Resolves the base branch AND proves the repo is reachable — Gitea's 404 for an
# unknown repo is byte-identical to its 404 for a branch with no PR, so without
# this a typo'd CODEV_REPO would return an empty result set that looks like a
# confident "no matches". See gitea_default_branch.
DEFAULT_BASE="$(gitea_default_branch "$REPO")" || exit 1

# Shared jq: Gitea's raw state ("open"/"closed" plus a `merged` bool) normalised
# to the three values callers can act on, then filtered and ordered.
SHAPE_AND_FILTER='
  def normstate: if .state == "open" then "open"
                 elif .merged == true then "merged"
                 else "closed" end;
  [ .[]
    | select(type == "object" and (.number | type) == "number")
    | {
        number,
        title: (.title // ""),
        state: normstate,
        url: (.html_url // .url // ""),
        # `.head.ref` becomes "refs/pull/N/head" once a merged PR'"'"'s branch is
        # deleted; `.head.label` keeps the branch name. Prefer the label and fall
        # back to the ref. (A cross-repo fork PR labels as "owner:branch"; codev
        # builders push to the same repo, so the plain form is what we see.)
        headRefName: (.head.label // .head.ref // ""),
        baseRefName: (.base.ref // "")
      }
  ]
  | map(select(
      (.state == "open"   and $want_open   == 1) or
      (.state == "merged" and $want_merged == 1) or
      (.state == "closed" and $want_closed == 1)
    ))
  | sort_by(if .state == "open" then 0 else 1 end, -.number)
'

emit() {
  printf '%s' "$1" | jq \
    --argjson want_open "$WANT_OPEN" \
    --argjson want_merged "$WANT_MERGED" \
    --argjson want_closed "$WANT_CLOSED" \
    "$SHAPE_AND_FILTER"
}

# --- branch lookup ---------------------------------------------------------
if [ -n "$HEAD_BRANCH" ]; then
  BASE=${CODEV_PR_BASE:-$DEFAULT_BASE}
  RESPONSE="$(gitea_api "repos/${REPO}/pulls/${BASE}/${HEAD_BRANCH}")" || exit 1
  case "$(gitea_api_error "$RESPONSE")" in
    notfound) echo '[]'; exit 0 ;;
    error)
      echo "pr-search: Gitea could not answer for '${BASE}...${HEAD_BRANCH}': ${RESPONSE}" >&2
      exit 1
      ;;
  esac
  emit "[${RESPONSE}]"
  exit 0
fi

# --- issue-number lookup ---------------------------------------------------
# Two steps, because the two things needed live in different places. The cheap
# index (`issues?type=pulls`) can be searched by text and carries title/body, but
# no head or base ref; the PR object carries the refs but its list endpoint costs
# ~1s per PR. So: search the index, decide which PRs belong to the issue, then
# resolve only those.
if [ "$WANT_OPEN" -eq 1 ] && [ "$WANT_MERGED" -eq 0 ] && [ "$WANT_CLOSED" -eq 0 ]; then
  INDEX_STATE=open
elif [ "$WANT_OPEN" -eq 0 ]; then
  INDEX_STATE=closed
else
  INDEX_STATE=all
fi

INDEX="$(gitea_api "repos/${REPO}/issues?type=pulls&state=${INDEX_STATE}&q=${TERM}&limit=${GITEA_PAGE_LIMIT}")" || exit 1
case "$(gitea_api_error "$INDEX")" in
  notfound) echo '[]'; exit 0 ;;
  error)
    echo "pr-search: Gitea could not search pulls for '${TERM}': ${INDEX}" >&2
    exit 1
    ;;
esac

# Gitea's `q=` is a substring match, so it answers "3386" with PRs mentioning
# 33861. Word-bound both forms — "#N" as a cross-reference and a bare N as this
# repo titles them ("[Spec N] ...") — so #3386 never matches #33861.
CANDIDATES="$(printf '%s' "$INDEX" | jq -r --arg n "$TERM" '
  def bounded($s): ($s // "") | test("(?<![0-9])#?" + $n + "(?![0-9])");
  [ .[]
    | select(type == "object" and (.number | type) == "number")
    | select(bounded(.title) or bounded(.body))
    | .number
  ]
  | sort | reverse | .[]
' 2>/dev/null)" || CANDIDATES=

if [ -z "$CANDIDATES" ]; then
  echo '[]'
  exit 0
fi

COUNT=$(printf '%s\n' "$CANDIDATES" | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$SEARCH_MAX_CANDIDATES" ]; then
  echo "pr-search: ${COUNT} PRs reference #${TERM}; resolving the ${SEARCH_MAX_CANDIDATES} most recent (raise CODEV_FORGE_SEARCH_MAX to widen)" >&2
  CANDIDATES=$(printf '%s\n' "$CANDIDATES" | head -n "$SEARCH_MAX_CANDIDATES")
fi

# shellcheck disable=SC2086  # word splitting is the point: one arg per number
PULLS="$(gitea_fetch_pulls "$REPO" $CANDIDATES)" || exit 1
emit "$PULLS"
