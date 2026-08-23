#!/usr/bin/env bash
#
# Decide whether a non-zero `vitest run` exit is a worker crash after a fully
# green suite, or a real test failure (issue #27).
#
# Vitest's forks pool has a known crash during cleanup after all tests pass
# (native module teardown). The suite is green, the exit code is not, and CI
# goes red for a reason no test caused.
#
# ## Why the previous guard could never fire
#
#     grep -q "Test Files.*passed" out && ! grep -q "failed" out
#
# The second condition greps the bare word `failed` across the WHOLE captured
# output, which includes every line the tests themselves print. Measured against
# a real, fully GREEN CI run (32666076117): five case-sensitive matches, none of
# them a failing test.
#
#     Context refresh ABORTED (reentry-failed).
#     Context refresh ABORTED (clear-failed).
#     Warning: `git fetch origin does-not-exist` failed; proceeding ...
#     Warning: `git fetch origin no-such-head` failed; proceeding ...
#
# So `! grep -q failed` was false on every green run and the tolerance branch
# was unreachable. It cost a real diagnosis during PIR #13: the branch was red
# at HEAD while a local run was green, and the builder spent a pass on a defect
# that was not its own.
#
# ## What this does instead
#
# Reads only vitest's own summary lines, and matches a failure COUNT rather than
# a word that any test is free to print:
#
#      Test Files  292 passed | 3 skipped (295)
#           Tests  5751 passed | 48 skipped (5799)
#
# versus
#
#      Test Files  1 failed | 286 passed (290)
#           Tests  2 failed | 5749 passed (5799)
#
# ## Fails closed
#
# A crash BEFORE the summary is printed leaves no summary to read, and that is
# indistinguishable from a suite that never ran. It exits non-zero. Tolerating a
# missing summary is how "vitest died on startup" gets reported as "all tests
# passed" — the failure this repo has spent a backlog fixing elsewhere.

set -uo pipefail

OUTPUT_FILE="${1:?usage: vitest-crash-tolerance.sh <vitest-output-file> <vitest-exit-code>}"
VITEST_EXIT="${2:?usage: vitest-crash-tolerance.sh <vitest-output-file> <vitest-exit-code>}"

if [ "$VITEST_EXIT" -eq 0 ]; then
  exit 0
fi

if [ ! -s "$OUTPUT_FILE" ]; then
  echo "vitest exited ${VITEST_EXIT} and produced no output — not a cleanup crash." >&2
  exit "$VITEST_EXIT"
fi

# Strip ANSI. Vitest colours the counts, so `292 passed` arrives with escape
# sequences between the number and the word.
PLAIN=$(sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g' "$OUTPUT_FILE")

# The two summary lines, and only those. `Test Files` is emitted once per run,
# at the end.
SUMMARY=$(printf '%s\n' "$PLAIN" | grep -E '^[[:space:]]*(Test Files|Tests)[[:space:]]+[0-9]' || true)

if [ -z "$SUMMARY" ]; then
  echo "vitest exited ${VITEST_EXIT} and printed no summary — the suite did not finish." >&2
  exit "$VITEST_EXIT"
fi

# Require BOTH lines. Vitest always emits them together, so one alone means the
# run was cut short — or that a test printed something summary-shaped. Matching
# on content a test is free to emit is the original bug; this is the same trap
# facing the other way.
if ! printf '%s\n' "$SUMMARY" | grep -qE '^[[:space:]]+Test Files[[:space:]]+[0-9]'; then
  echo "vitest exited ${VITEST_EXIT} with no 'Test Files' summary — the suite did not finish." >&2
  exit "$VITEST_EXIT"
fi

if ! printf '%s\n' "$SUMMARY" | grep -qE '^[[:space:]]+Tests[[:space:]]+[0-9]'; then
  echo "vitest exited ${VITEST_EXIT} with no 'Tests' summary — the suite did not finish." >&2
  exit "$VITEST_EXIT"
fi

# A failure COUNT in the summary, e.g. `1 failed`. Test names and log lines
# containing the word cannot reach here: only the summary lines are examined.
if printf '%s\n' "$SUMMARY" | grep -qE '[0-9]+ failed'; then
  echo "vitest reported failing tests:" >&2
  printf '%s\n' "$SUMMARY" >&2
  exit "$VITEST_EXIT"
fi

echo "::warning::Vitest exited ${VITEST_EXIT} after a fully green suite (known forks-pool cleanup crash). Summary:"
printf '%s\n' "$SUMMARY"
exit 0
