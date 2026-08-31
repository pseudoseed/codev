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

# VALIDATE BEFORE ANY PATH IS BUILT FROM THESE.
#
# `$LABEL` is interpolated into `T3_HARNESS_DIR`, into the run's output paths and
# into `rm -rf "${RUNS:?}/work-$LABEL"`. `${RUNS:?}` guards an EMPTY `RUNS`; it
# says nothing about what `$LABEL` appends to it. A label carrying a path
# separator resolves wherever the `..` chain leads and the `rm -rf` follows it
# out of `.runtime-runs` — verified by deleting a directory five levels above it.
#
# So the check is a whitelist, not a `..` blocklist. A bare `..` cannot escape
# here (the `.runtime-`/`work-` prefixes absorb it, giving a literal `.runtime-..`),
# which is exactly the kind of near-miss that makes a blocklist look sufficient
# while `x/../..` walks straight past it.
#
# Nothing here is untrusted input — a developer types these arguments — so this is
# a typo that costs a directory, not an attack. That is still the failure worth
# refusing.
case $LABEL in
  '' | *[!A-Za-z0-9._-]* )
    echo "BAD_LABEL: the label must be one or more of [A-Za-z0-9._-] and nothing else; got '$LABEL'." >&2
    echo "  It becomes a directory name and a deletion path, so a separator in it deletes elsewhere." >&2
    exit 2 ;;
esac

# `$PORT` reaches `lsof -iTCP:` and `T3_HARNESS_PORT`; `$GATE` reaches the runner
# as `RUN_GATE_SECONDS`. Both are used as numbers by everything downstream, and a
# non-numeric one is diagnosed far from here, in whichever tool first tries to
# parse it.
# THE SHAPE IS CHECKED BEFORE THE VALUE, BECAUSE `[` CANNOT CHECK THE SHAPE.
#
# `[ "$PORT" -lt 1 ]` on a 30-digit port prints "integer expression expected",
# returns 2, and the `if` reads that as false — so the run CONTINUES, and the
# refusal that eventually arrives is about something else entirely. A guard whose
# failure mode is falling through is worse than no guard, because it reads as one.
#
# So the port is matched as at most five digits with no leading zero, and only
# then compared. By that point `[` cannot overflow.
case $PORT in
  [1-9] | [1-9][0-9] | [1-9][0-9][0-9] | [1-9][0-9][0-9][0-9] | [1-9][0-9][0-9][0-9][0-9] ) ;;
  * )
    echo "BAD_PORT: the port must be an integer in 1..65535, written without a leading zero; got '$PORT'." >&2
    exit 2 ;;
esac
if [ "$PORT" -gt 65535 ]; then
  echo "BAD_PORT: the port must be an integer in 1..65535; got '$PORT'." >&2
  exit 2
fi
# Nothing compares the gate numerically here, but it is bounded for the same
# reason: 10 digits is 31 years, so a longer one is a typo rather than a run.
case $GATE in
  '' | *[!0-9]* | ??????????* )
    echo "BAD_GATE: the gate must be a non-negative integer of at most 9 digits; got '$GATE'." >&2
    exit 2 ;;
esac

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

# STOP THE SERVER ON EVERY EXIT, NOT ONLY THE ONE THAT REACHES THE END.
#
# Without this the single `stop` at the bottom is reachable only when the runner
# returns. A Ctrl-C, a killed parent or a `pkill` during a run — which is an hour
# for the 1h runs and a day for the gate — leaves the server up. It then holds the
# port, and the next run's `ready` truthfully answers about the STRANGER rather
# than about itself. Worse, `stop` can only stop a server its own T3_HARNESS_DIR
# describes, so deleting `.runtime-<label>` afterwards orphans it beyond any
# `stop` at all and it can only be killed by pid. This happened twice during #238.
#
# The flag is what keeps the trap honest: an EXIT before `start` must not report a
# teardown that never happened, and the deliberate stops below must not fire twice.
STOP_ON_EXIT=0
RUNNER_PID=
stop_server() {
  # The runner first: it talks to the server, and a `pkill` aimed at this script
  # alone does not reach it. It is also why the runner below is a BACKGROUND job
  # this script `wait`s on — bash defers a trap until the current FOREGROUND
  # command returns, so a foreground runner would hold the handler for the rest
  # of the hour (or the day) and the teardown would arrive far too late to matter.
  if [ -n "$RUNNER_PID" ]; then
    kill "$RUNNER_PID" 2>/dev/null || true
    # Reap it before stopping the server. Without this the teardown races the
    # runner's last write and can leave a truncated `$LABEL.json` — an evidence
    # file that exists and is wrong, which is worse than one that is absent.
    wait "$RUNNER_PID" 2>/dev/null || true
    RUNNER_PID=
  fi
  [ "$STOP_ON_EXIT" = 1 ] || return 0
  STOP_ON_EXIT=0
  node tools/t3-server/t3-server.mjs stop >/dev/null 2>&1 || true
  return 0
}
# shellcheck disable=SC2329  # reached through the INT/TERM/HUP traps below.
on_signal() {
  stop_server
  trap - EXIT INT TERM HUP
  echo "INTERRUPTED $LABEL on SIG$1: the server this run owned was stopped." >&2
  exit "$2"
}
trap stop_server EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
# HUP as well: the 24-hour gate outlives the terminal that started it, and a
# closed terminal leaks the server exactly the way a Ctrl-C used to.
trap 'on_signal HUP 129' HUP

STOP_ON_EXIT=1
if ! node tools/t3-server/t3-server.mjs start >"$RUNS/$LABEL.server.log" 2>&1; then
  echo "START_FAILED: could not check: the server did not start; see $RUNS/$LABEL.server.log" >&2
  exit 3
fi

# OPT THE DRIVER IN. t3code ships some drivers OFF.
#
# `OpenCodeSettings.enabled` defaults to false at the pinned commit — "Off by
# default (like Cursor and Grok): the binding is not yet stable enough to probe
# on every install. Users opt in from Settings." Every run here gets its own
# `--base-dir`, so every run gets a state directory nobody has opted in for, and
# a turn on that driver is refused at `startSession` with
#
#   Provider instance 'opencode' is disabled in T3 Code settings.
#
# `start` wipes the state directory, so the file has to be written after it and
# picked up by a `restart` that preserves it. This writes only inside the data
# directory THIS run owns; the user's own T3 Code settings are never touched.
SETTINGS="$T3_HARNESS_DIR/data/userdata/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
printf '{"providers":{"%s":{"enabled":true}}}\n' \
  "$(node -e 'const m={claude:"claudeAgent",codex:"codex",opencode:"opencode"};process.stdout.write(m[process.argv[1]]??process.argv[1])' "$HARNESS")" \
  > "$SETTINGS"
if ! node tools/t3-server/t3-server.mjs restart >>"$RUNS/$LABEL.server.log" 2>&1; then
  stop_server
  echo "SETTINGS_NOT_APPLIED: could not check: the restart that loads $SETTINGS failed." >&2
  exit 3
fi

TOKEN=$(node tools/t3-server/t3-server.mjs ready 2>/dev/null | sed -n 's/.*"token": "\(.*\)".*/\1/p')
if [ -z "$TOKEN" ]; then
  stop_server
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
  >"$RUNS/$LABEL.run.log" 2>&1 &
RUNNER_PID=$!
wait "$RUNNER_PID"
STATUS=$?
RUNNER_PID=

stop_server
echo "DONE $LABEL status=$STATUS evidence=$RUNS/$LABEL.json"
exit $STATUS
