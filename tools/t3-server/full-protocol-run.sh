#!/usr/bin/env bash
#
# Spec 146 Phase 10 — one complete BUGFIX protocol on a t3code thread.
#
# Brings up a server this run OWNS, runs the protocol against it, tears it down.
# Every run gets its own port and its own `T3_HARNESS_DIR`, because Phase 10 runs
# several at once — one per driver, plus the 24-hour gate — and they would
# otherwise share a data directory and a pairing token.
#
#   tools/t3-server/full-protocol-run.sh <port> <harness> <model> <gate-seconds> <label>
#
# Examples, and these are the exact invocations behind
# `codev/research/146-phase10-live-evidence.json`:
#
#   tools/t3-server/full-protocol-run.sh 3803 claude   claude-haiku-4-5 3600  claude-1h
#   tools/t3-server/full-protocol-run.sh 3804 opencode xai/grok-4.6    3600  opencode-1h
#   tools/t3-server/full-protocol-run.sh 3805 claude   claude-haiku-4-5 86400 gate-24h
#
# `T3_NODE` must be an absolute interpreter path — the harness refuses to inherit
# its Node from PATH. Output lands in `tools/t3-server/.runtime-runs/<label>.json`,
# which is gitignored: promote the runs you are keeping into `codev/research/`.
#
# The exit status is the RUNNER's, not the server's. A run that could not start a
# server exits 3 (undetermined), which is not the same fact as a protocol that ran
# and failed.
set -u

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <port> <harness> <model> <gate-seconds> <label>" >&2
  exit 2
fi

PORT=$1; HARNESS=$2; MODEL=$3; GATE=$4; LABEL=$5
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 3

if [ -z "${T3_NODE:-}" ]; then
  echo "NO_INTERPRETER: could not check: T3_NODE is unset. It must be an absolute path to the" >&2
  echo "  Node binary that serves the pinned checkout; the harness never guesses one from PATH." >&2
  exit 3
fi

export T3_HARNESS_PORT="$PORT"
export T3_HARNESS_DIR="$ROOT/tools/t3-server/.runtime-$LABEL"
RUNS="$ROOT/tools/t3-server/.runtime-runs"
mkdir -p "$RUNS"

node tools/t3-server/t3-server.mjs stop >/dev/null 2>&1

# REFUSE A PORT THIS RUN DOES NOT OWN.
#
# `stop` can only stop a server its own T3_HARNESS_DIR describes. A server left
# behind by another label — or one whose runtime directory was deleted, which
# orphans it beyond any `stop` — keeps the port, the new server fails to bind
# with EADDRINUSE, and `ready` then answers about the STRANGER: "answering but
# printed no pairing token". Truthful, and the wrong diagnosis. Two runs were
# lost to it before this check existed.
#
# `lsof` needs its own three-way answer. A non-zero exit means "nothing is
# listening" OR "I could not run the check", and those must not be spelled the
# same way: an unreadable check that reads as a free port sends the run straight
# back into the failure this guard exists to prevent.
if LISTENER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); then
  if [ -n "$LISTENER" ]; then
    echo "PORT_IN_USE: something already listens on 127.0.0.1:$PORT and this run does not own it." >&2
    echo "$LISTENER" >&2
    echo "  Stop it under ITS own T3_HARNESS_DIR, or pick another port. A server whose runtime" >&2
    echo "  directory was deleted cannot be stopped by the harness at all and must be killed by pid." >&2
    exit 3
  fi
elif ! command -v lsof >/dev/null 2>&1; then
  echo "PORT_UNCHECKED: could not check: lsof is unavailable, so whether $PORT is free is unknown." >&2
  echo "  Proceeding; a bind failure below is the fallback signal." >&2
fi

if ! node tools/t3-server/t3-server.mjs start >"$RUNS/$LABEL.server.log" 2>&1; then
  echo "START_FAILED: could not check: the server did not start; see $RUNS/$LABEL.server.log" >&2
  exit 3
fi

TOKEN=$(node tools/t3-server/t3-server.mjs ready 2>/dev/null | sed -n 's/.*"token": "\(.*\)".*/\1/p')
if [ -z "$TOKEN" ]; then
  node tools/t3-server/t3-server.mjs stop >/dev/null 2>&1
  echo "NO_TOKEN: could not check: the server never printed a pairing token" >&2
  exit 3
fi

rm -rf "${RUNS:?}/work-$LABEL"
RUN_REPO_ROOT="$ROOT" \
RUN_PORT="$PORT" \
RUN_TOKEN="$TOKEN" \
RUN_HARNESS="$HARNESS" \
RUN_MODEL="$MODEL" \
RUN_GATE_SECONDS="$GATE" \
RUN_OUT="$RUNS/$LABEL.json" \
RUN_WORK="$RUNS/work-$LABEL" \
RUN_TURN_TIMEOUT_MS="${RUN_TURN_TIMEOUT_MS:-600000}" \
  node packages/codev/src/agent-farm/__tests__/helpers/air-235-full-protocol.mjs \
  >"$RUNS/$LABEL.run.log" 2>&1
STATUS=$?

node tools/t3-server/t3-server.mjs stop >/dev/null 2>&1
echo "DONE $LABEL status=$STATUS evidence=$RUNS/$LABEL.json"
exit $STATUS
