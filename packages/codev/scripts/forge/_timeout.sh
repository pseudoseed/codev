# Shared wall-clock timeout for forge concept scripts.
#
# SOURCED, not executed, so it has no shebang and defines only functions. POSIX
# sh only — the concept scripts are #!/bin/sh and forge runs them via `sh -c`.
# The leading underscore keeps it out of the concept namespace (forge.ts builds
# presets from an explicit KNOWN_CONCEPTS allowlist, so this file is never
# registered as a concept).
#
# This started life inside gitea/_lib.sh (#12), where it fixed a `tea api` call
# that stalled a whole porch phase. The CI concepts (#13) need the identical
# guarantee around `gh`, and a second copy of a hand-rolled process watchdog is
# the last thing this repo needs — so it lives here and both providers source
# it. `gitea_timeout` remains a one-line alias in gitea/_lib.sh so #12's scripts
# and the comments that reference it by name still read true.

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
forge_timeout() {
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
  # Kill the watchdog and REAP it. Without the wait, the shell prints its own
  # "Terminated: 15" notice about the killed background job onto the caller's
  # stderr, on every single call — noise that a concept returning structured
  # JSON should not be emitting, and that trains a reader to ignore the stream
  # where the real diagnostics also arrive.
  kill "$_wd_pid" 2>/dev/null
  wait "$_wd_pid" 2>/dev/null || :

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
