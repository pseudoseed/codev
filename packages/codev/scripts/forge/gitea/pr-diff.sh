#!/bin/sh
# Forge concept: pr-diff (Gitea/Forgejo via tea CLI)
# forge-executable: tea
# Input:  CODEV_PR_NUMBER (required)
#         CODEV_DIFF_NAME_ONLY (optional, "1" for a bare list of changed paths)
# Output: raw diff text, or one path per line in name-only mode
#
# Two endpoints, because Forgejo splits what `gh pr diff` merges:
#   full diff  -> `pulls/{n}.diff`, which returns unified diff text (~0.3s)
#   name-only  -> `pulls/{n}/files`, which returns a JSON array of file objects
#                 (~0.5s). Parsing filenames back out of the diff text was
#                 rejected: `.filename` is authoritative for renames and for
#                 paths containing spaces, where "diff --git a/… b/…" is not.
#
# Name-only output is a bare newline-separated path list, matching
# `gh pr diff --name-only`, because consult's fetchPRData splits it on newlines
# (consult/index.ts). `--name-only` output has no header line to skip.
#
# `tea api` EXITS 0 ON HTTP ERRORS and prints the error body (established by
# pr-create.sh). Emitting that body would hand the caller an error page dressed
# as a diff — a model would then review Gitea's 404 as if it were the change. So
# both paths assert the response really is what they asked for and exit non-zero
# otherwise.
set -e
. "$(dirname "$0")/_lib.sh"

if [ -z "$CODEV_PR_NUMBER" ]; then
  echo "pr-diff: CODEV_PR_NUMBER is required" >&2
  exit 2
fi

REPO="$(gitea_repo)" || exit 1

fail() {
  echo "pr-diff: $1" >&2
  exit 1
}

if [ "$CODEV_DIFF_NAME_ONLY" = "1" ]; then
  # The changed-file list is paginated like every other Gitea list endpoint.
  # `|| rc=$?` rather than a bare assignment: this script runs under `set -e`,
  # which would abort on tea_api_paged's status-3 truncation signal before the
  # case below ever ran — turning a named diagnostic into a silent exit.
  rc=0
  FILES="$(tea_api_paged "repos/${REPO}/pulls/${CODEV_PR_NUMBER}/files" "")" || rc=$?
  case $rc in
    0) ;;
    3) fail "the changed-file list for PR #${CODEV_PR_NUMBER} was truncated; a partial file list would understate the review scope" ;;
    # 4 = the body was not a list, i.e. an error object. It is on stdout, so it
    # can finally be classified into a message that names the PR.
    4)
      case "$(gitea_api_error "$FILES")" in
        notfound) fail "PR #${CODEV_PR_NUMBER} not found in ${REPO}" ;;
        *)        fail "Gitea could not list files for PR #${CODEV_PR_NUMBER}: ${FILES}" ;;
      esac
      ;;
    *) exit 1 ;;
  esac
  printf '%s' "$FILES" | jq -r '.[] | .filename // empty'
  exit 0
fi

DIFF="$(gitea_api "repos/${REPO}/pulls/${CODEV_PR_NUMBER}.diff")" || exit 1

# A unified diff is not JSON, so the JSON-shaped checks in gitea_api_error only
# fire on the error path — which is exactly what makes them a usable test here.
case "$(gitea_api_error "$DIFF")" in
  notfound) fail "PR #${CODEV_PR_NUMBER} not found in ${REPO}" ;;
esac
# An empty body is not a diff. A PR with no changes still returns diff text; a
# blank response means the request did not produce one.
if [ -z "$DIFF" ]; then
  fail "Gitea returned an empty diff for PR #${CODEV_PR_NUMBER}"
fi
# Guard the remaining error shape: a JSON object where a diff was expected.
if printf '%s' "$DIFF" | jq -e 'type == "object"' >/dev/null 2>&1; then
  fail "Gitea returned an error instead of a diff for PR #${CODEV_PR_NUMBER}: ${DIFF}"
fi

printf '%s\n' "$DIFF"
