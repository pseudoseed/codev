#!/bin/sh
# Forge concept: pr-exists (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_BRANCH_NAME (required)
#         CODEV_PR_BASE (optional — the PR's base branch; defaults to the
#                        repository's default branch)
# Output: "true" or "false"
#
# Returns true for OPEN or MERGED pulls only; closed-not-merged pulls are
# excluded, matching the github and gitlab scripts (bugfix #568, #653).
#
# WHY THIS DOES NOT LIST PULLS (issue #12)
#
# The previous implementation walked `repos/{repo}/pulls?state=all` page by page
# and filtered client-side. That is not merely inefficient — on a real Forgejo it
# does not finish. The cost of that endpoint is per RETURNED PR OBJECT, not per
# request: measured against Forgejo 15.x, `limit=1` answers in 0.78s and
# `limit=50` in 32.8s, i.e. ~0.65s per pull, because Gitea materialises head and
# base commit info for each one. A 1599-PR repository therefore cost ~17 minutes
# for a single yes/no question, which read as a hang and was killed at 25s and at
# 120s with nothing on stdout. Raising the page size cannot help; the fix is to
# stop enumerating.
#
# `GET repos/{repo}/pulls/{base}/{head}` answers the same question in one request
# (~1.2s), and answers it BETTER. The old scan matched on `.head.ref`, and the
# comment it carried noted — correctly — that Gitea rewrites `.head.ref` to
# "refs/pull/N/head" once a merged PR's source branch is deleted, so a merged PR
# could not be found by branch name at all. But `.head.label` retains the
# original branch name, and this endpoint matches on the stored head branch
# rather than on `.head.ref`. Verified against Forgejo 15.x: PR 3869, merged with
# its branch deleted, reports `.head.ref == "refs/pull/3869/head"` and
# `.head.label == "builder/aspir-3860"`, and is returned by
# `pulls/main/builder/aspir-3860`. Slashes in the head branch need no escaping.
#
# LIMITATION: the endpoint requires a base branch, so a PR targeting something
# other than the repository's default branch (sequential-PR work branched off an
# integration branch) needs CODEV_PR_BASE. A miss makes this print "false", which
# fails porch's pr_exists gate loudly rather than proceeding on a wrong answer.
# Falling back to a list scan on the 404 path was rejected deliberately: it would
# reintroduce the ~17-minute walk on the failure path, where it would be least
# expected.
#
# "false" means "no such PR". It never means "I could not tell" — an
# unreachable repo or a failed request exits non-zero with a message on stderr,
# because a gate that reads "could not tell" as "no" is how a silent wrong answer
# gets made.
set -e
. "$(dirname "$0")/_lib.sh"

if [ -z "$CODEV_BRANCH_NAME" ]; then
  echo "pr-exists: CODEV_BRANCH_NAME is required" >&2
  exit 2
fi

REPO="$(gitea_repo)" || exit 1

# Always resolve the repo object, even when CODEV_PR_BASE makes the default
# branch unnecessary. Gitea returns a BYTE-IDENTICAL 404 body for "this repo
# does not exist or you cannot see it" and for "this branch has no PR", so the
# lookup's 404 is only readable as "no PR" once the repo is known to resolve.
# gitea_default_branch does both in one ~0.2s request.
DEFAULT_BASE="$(gitea_default_branch "$REPO")" || exit 1
BASE=${CODEV_PR_BASE:-$DEFAULT_BASE}

RESPONSE="$(gitea_api "repos/${REPO}/pulls/${BASE}/${CODEV_BRANCH_NAME}")" || exit 1

case "$(gitea_api_error "$RESPONSE")" in
  notfound)
    # The repo resolved above, so this 404 is the real answer.
    echo false
    exit 0
    ;;
  error)
    echo "pr-exists: Gitea could not answer for '${BASE}...${CODEV_BRANCH_NAME}': ${RESPONSE}" >&2
    exit 1
    ;;
esac

RESULT="$(printf '%s' "$RESPONSE" | jq -r '
  if type == "object" and (.number | type) == "number"
  then (.state == "open" or .merged == true)
  else empty
  end
' 2>/dev/null)" || RESULT=

if [ -z "$RESULT" ]; then
  echo "pr-exists: unexpected response from the Gitea API: ${RESPONSE}" >&2
  exit 1
fi

echo "$RESULT"
