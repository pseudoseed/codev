# Extraction ladder for the CI concepts (#13). SOURCED, not executed.
#
# Turns a raw CI job log into the few lines that say why the job failed, or into
# an honest refusal. Shared by github/ and gitea/ so the two providers cannot
# drift: the runners differ, the failure text does not.
#
# WHY THIS EXISTS AT ALL, ON BOTH PROVIDERS
#
# Issue #13 says `gh run view --log-failed` "already does the extraction for
# you" and tells the implementer not to duplicate it. Measured on run
# 32515040122 of this repository, it does not: it returned 2528 lines / 293 KB
# with every single line tagged "UNKNOWN STEP", i.e. it selected the failing
# JOB and returned all of it. (The architect independently reproduced this on
# run 32448538074: 919 lines, all 919 tagged UNKNOWN STEP.) `gh` attributes log
# lines to steps by matching filenames, and falls back to UNKNOWN STEP when that
# mapping fails. So codev extracts on GitHub too, and the concepts fetch
# `repos/{owner}/{repo}/actions/jobs/{id}/logs` instead — one job, no invented
# step column, and the same shape Forgejo 16 serves.
#
# THE THREE THINGS THAT MAKE NAIVE EXTRACTION LIE
#
# All three are from the same real log, and all three are pinned by tests:
#
#  1. ANSI. The payload line is not `FAIL src/…`, it is
#     `\033[41m\033[1m FAIL \033[22m\033[49m src/…`. A matcher that does not
#     strip ANSI first matches NOTHING and reports "no recognized failure" on a
#     log that plainly contains one. Cleaning is not cosmetic; it is the
#     difference between working and silently giving up.
#  2. "First line matching an error pattern" returns line 1257 of 2528:
#     `[artifact-canvas] Error: host blew up` — a fixture string printed by a
#     PASSING test. The real failure is at 2471. Hence rung 4 anchors its
#     patterns at the START of the line: that fixture's "Error:" is mid-line, so
#     anchoring alone kills it, and anchoring holds even in logs with no test
#     summary to measure against.
#  3. `Test Files … passed` appears FOUR times before the failing summary. Any
#     rule that takes the first match reports a passing suite as the failure.
#
# And the rule that governs the whole ladder: when nothing matches, return
# nothing. A builder handed 50 arbitrary lines treats them as the diagnosis and
# reasons from noise; a builder told extraction failed goes and reads the log,
# which is correct and cheaper. See lessons-critical.md.

# Clean a raw log on stdin into extractable text on stdout.
#
# Strips, in order: a UTF-8 BOM (GitHub's logs open with one), ANSI CSI/OSC
# escape sequences, carriage returns, and the leading RFC3339 timestamp that
# BOTH providers prefix to every line
# (`2026-08-21T18:47:09.5820646Z Current runner version: …`).
#
# Deliberately does NOT strip gh's `job<TAB>step<TAB>` prefix: the concepts do
# not use `--log-failed`, so no such prefix exists, and a rule that ate tab-
# separated leading fields would eat real log content on a runner that prints
# tables.
ci_clean_log() {
  _esc=$(printf '\033')
  LC_ALL=C sed \
    -e '1s/^\xef\xbb\xbf//' \
    -e "s/${_esc}\][^${_esc}]*${_esc}\\\\//g" \
    -e "s/${_esc}\[[0-9;?]*[ -\/]*[@-~]//g" \
    -e "s/${_esc}[()][A-Za-z0-9]//g" \
    -e 's/\r$//' \
    -e 's/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][.0-9]*Z //'
}

# Run the ladder over a CLEANED log file.
#
#   ci_extract <cleanfile>
#
# On a match, prints a header line `<rung>\t<fromLine>\t<toLine>` followed by
# the extracted lines. On no match, prints NOTHING and returns 1 — which is the
# `extracted: false` path, not an error.
#
# Line numbers are 1-based into the cleaned log, and the cleaner is line-count
# preserving, so they are also line numbers into the raw log — which is what
# makes the `ci-run-log` handoff land where `ci-failures` was looking.
ci_extract() {
  awk '
    function is_noise_marker(s) {
      # `##[error]Process completed with exit code 1.` is the runner reporting
      # that the step failed. True, and not a diagnosis of anything — returning
      # it alone would be an arbitrary line dressed as an answer.
      return (s ~ /^##\[error\](Process completed with exit code|The (job|operation) was canceled)/)
    }
    { line[NR] = $0 }
    END {
      n = NR
      if (n == 0) exit 1

      # ---- pass 1: index the landmarks -------------------------------------
      first_marker = 0
      last_fail_summary = 0        # vitest "Test Files … failed" / jest "Tests: … failed"
      last_pass_boundary = 0       # the last "N passed" summary of ANY suite
      last_failed_banner = 0       # vitest "⎯⎯ Failed Tests N ⎯⎯"
      first_ts_error = 0
      first_go_fail = 0
      for (i = 1; i <= n; i++) {
        s = line[i]
        if (!first_marker && s ~ /^##\[error\]/ && !is_noise_marker(s)) first_marker = i
        if (s ~ /Failed Tests/) last_failed_banner = i
        if (s ~ /(Test Files|Tests:|Test Suites:)/) {
          if (s ~ /fail/) last_fail_summary = i
          else if (s ~ /pass/) last_pass_boundary = i
        }
        if (s ~ /^[0-9]+ (passing|tests? passed)/) last_pass_boundary = i
        if (!first_ts_error && s ~ /error TS[0-9]+:/) first_ts_error = i
        if (!first_go_fail && s ~ /^ *--- FAIL: /) first_go_fail = i
      }

      # ---- rung 1: a recognised test runner --------------------------------
      # Anchored on the summary that says "failed" — NOT the first summary, of
      # which there were four saying "passed" in the log this was built from.
      if (last_fail_summary) {
        start = 0
        if (last_failed_banner && last_failed_banner < last_fail_summary) start = last_failed_banner
        if (!start) {
          # earliest FAIL after the last passing summary that precedes the
          # failing one, so a re-run of the same suite does not drag in the
          # passing run above it
          floor = 0
          for (i = 1; i < last_fail_summary; i++)
            if (line[i] ~ /(Test Files|Tests:|Test Suites:)/ && line[i] ~ /pass/) floor = i
          for (i = floor + 1; i < last_fail_summary; i++)
            if (line[i] ~ /(^| )FAIL( |$)/ || line[i] ~ /^ *(✕|×) /) { start = i; break }
        }
        if (start) { emit("vitest", start, last_fail_summary); exit 0 }
      }

      # ---- rung 2: go test -------------------------------------------------
      # The Forgejo fixture this was verified against is a Go suite, and it is
      # the case that best justifies the whole ladder: the failure sits at line
      # 1292 of 1599 and the last 25 lines of that log are git credential
      # cleanup, so a tail returns nothing at all. The block runs from the
      # --- FAIL: line to the package summary (FAIL<TAB>pkg<TAB>0.302s).
      if (first_go_fail) {
        to = first_go_fail
        for (i = first_go_fail + 1; i <= n && i <= first_go_fail + 40; i++) {
          to = i
          if (line[i] ~ /^FAIL\t/ || line[i] ~ /^ok  \t/) break
        }
        emit("go-test", first_go_fail, to)
        exit 0
      }

      # ---- rung 3: a compiler ----------------------------------------------
      if (first_ts_error) {
        to = first_ts_error
        for (i = first_ts_error + 1; i <= n && i <= first_ts_error + 20; i++) {
          if (line[i] ~ /error TS[0-9]+:/ || line[i] ~ /^[ \t]/) to = i; else break
        }
        emit("tsc", first_ts_error, to)
        exit 0
      }

      # ---- rung 4: the runner error marker ---------------------------------
      # GitHub puts the message INSIDE the marker (##[error]AssertionError:
      # expected null to be unauth), so the marker line is itself the answer and
      # what FOLLOWS it is the useful context. What precedes it, on the log this
      # was built from, is a vitest duration line and two blank lines. This sits
      # below runner recognition, not above it, because rung 1 returns the whole
      # Failed Tests block (test name, assertion, expected/received, file:line)
      # where this returns one sentence. Issue #13 priority order agrees:
      # recognise the runner first.
      if (first_marker) {
        to = first_marker + 3; if (to > n) to = n
        emit("runner-marker", first_marker, to)
        exit 0
      }

      # ---- rung 5: the first ANCHORED error, preferring after the last pass -
      # Anchoring at the start of the line is what makes this safe: the false
      # positive this ladder was built against ("[artifact-canvas] Error: host
      # blew up", printed by a passing test) has its "Error:" mid-line and
      # cannot match. Searching after the last passing summary is an additional
      # preference, not the safety property — logs from a failed install or a
      # crashed runner have no summary at all, and refusing to answer for that
      # whole class would buy no safety.
      for (pass = 1; pass <= 2; pass++) {
        start = (pass == 1) ? last_pass_boundary + 1 : 1
        if (pass == 2 && last_pass_boundary == 0) break
        for (i = start; i <= n; i++) {
          s = line[i]
          if (s ~ /^(Error|error|ERROR|Exception|FATAL|fatal( error)?|panic|Traceback \(most recent call last\)|npm ERR!|##\[error\])[: ]/ ||
              s ~ /^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception): / ||
              s ~ /^error(\[[A-Z0-9]+\])?: /) {
            if (is_noise_marker(s)) continue
            from = i - 3; if (from < 1) from = 1
            to = i + 3; if (to > n) to = n
            emit("first-error", from, to)
            exit 0
          }
        }
      }

      # ---- rung 6: give up honestly ----------------------------------------
      exit 1
    }
    function emit(rung, from, to,   i) {
      printf "%s\t%d\t%d\n", rung, from, to
      for (i = from; i <= to; i++) print line[i]
    }
  ' "$1"
}
