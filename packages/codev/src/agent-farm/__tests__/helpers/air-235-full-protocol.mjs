/**
 * Spec 146 Phase 10 — one complete BUGFIX protocol on a t3code thread, live.
 *
 * Standalone on purpose. The 1-hour and 24-hour gates are elapsed for real, so
 * the run outlives any sensible test timeout and has to be launchable detached;
 * `spec-146-phase-10-full-protocol.test.ts` drives this file rather than
 * reimplementing it, so what the test asserts and what the long runs record are
 * the same code.
 *
 * WHAT IT DOES, IN THE PROTOCOL'S OWN SHAPE
 *
 * `codev-skeleton/protocols/bugfix/protocol.json` is three phases — investigate,
 * fix, pr — with `checks` (build, tests) on the fix phase and a human `pr` gate.
 * That is what runs here, against a real git repository with a real seeded bug:
 *
 *   spawn      project.create + thread.create on a worktree of a real repo
 *   investigate  turn 1, no code, root cause to a file, plus a codeword
 *   check        `node --test` in the worktree — MUST FAIL here
 *   fix          turn 2, the minimal change
 *   check        `node --test` again — MUST PASS here
 *   pr           turn 3, commit and push the branch to a local bare origin
 *   GATE         >= RUN_GATE_SECONDS with no turn dispatched at all
 *   resume       turn 4 must produce the codeword from before the gate
 *   merge        --no-ff into main, and the test passes on the merged tree
 *
 * WHAT "PR, MERGE" MEANS HERE, AND WHAT IT DOES NOT
 *
 * The pr phase pushes the branch to a **local bare origin** and the merge is a
 * real `git merge --no-ff` that has to leave the test passing on main. It is not
 * `gh pr create` and it is not `gh pr merge`. Running those live would open a
 * real pull request against this repository on every execution of this harness,
 * including the 24-hour one — an outward-facing act, repeated, for a fixture bug
 * in a temporary directory.
 *
 * So what is demonstrated is the git half: an agent on a thread commits, pushes a
 * branch that reaches origin, and the branch merges into main with the fix on it.
 * What is NOT demonstrated is the GitHub half — `gh` auth, the PR body, the issue
 * link, `--merge` over `--squash`. Those are the same in the thread world as in
 * the PTY world, because `gh` is a process porch spawns either way; that is a
 * reason to believe they are unaffected, not evidence that they were tested.
 *
 * WHY THE TWO CHECKS ARE A PAIR
 *
 * A check that passes before the fix proves nothing about the fix, and a check
 * harness that silently no-ops passes both times and looks exactly like a
 * working one. So the pre-fix check must FAIL and the post-fix check must PASS,
 * and the run reports `not-met` if either half is wrong — including the half
 * that would otherwise read as good news.
 *
 * WHY THE GATE IS ELAPSED AND NOT FAKED
 *
 * The thing under test is what the SERVER does to an idle thread — the provider
 * session reaper logs `inactivityThresholdMs: 1800000` at startup, so a gate
 * shorter than 30 minutes cannot cross it. A fake clock moves ours, not theirs.
 *
 * OUTCOMES ARE THREE-VALUED THROUGHOUT
 *
 * Every criterion records `met`, `not-met` or `undetermined`. A turn that never
 * ran is not a criterion that failed; it is a criterion that was not evaluated,
 * and the two must not be spelled the same way.
 *
 * ENVIRONMENT
 *
 *   RUN_REPO_ROOT   codev repo root (for the built dist/ artifacts)
 *   RUN_PORT        a t3code server the caller already started
 *   RUN_TOKEN       that server's one-time pairing token
 *   RUN_HARNESS     codev harness name: claude | codex | opencode
 *   RUN_MODEL       the model for it
 *   RUN_GATE_SECONDS   how long the gate holds. Default 3600.
 *   RUN_OUT         where to write the evidence JSON
 *   RUN_WORK        scratch directory for the git repo and journals
 *   RUN_TURN_TIMEOUT_MS   per-turn budget. Default 600000.
 *   RUN_SKIP_RESTART=1    omit the mid-protocol subscriber restart
 */

// The witness is registered BEFORE anything of ours is imported, so every codev,
// porch-driver and t3-client module resolves inside its window. Every import
// below this line is dynamic for that reason; making one static would hoist it
// above the registration and out of the recording.
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const loadedModules = [];
const { port1, port2 } = new MessageChannel();
port1.on('message', (url) => loadedModules.push(url));
port1.unref();
register('./air-235-pty-witness.mjs', import.meta.url, { data: { port: port2 }, transferList: [port2] });

const env = (name, fallback) => {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`MISSING_ENV: ${name} is required and was not set.`);
};

const repoRoot = env('RUN_REPO_ROOT');
const port = Number(env('RUN_PORT'));
const token = env('RUN_TOKEN');
const harness = env('RUN_HARNESS');
const model = env('RUN_MODEL');
const gateSeconds = Number(env('RUN_GATE_SECONDS', '3600'));
const outPath = env('RUN_OUT');
const work = env('RUN_WORK');
const turnTimeoutMs = Number(env('RUN_TURN_TIMEOUT_MS', '600000'));
const skipRestart = process.env.RUN_SKIP_RESTART === '1';

const evidence = {
  spec: '146',
  phase: '10',
  harness,
  model,
  driverKind: null,
  gateSeconds,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  criteria: {},
  observations: {},
  rpcMethods: [],
  failure: null,
};

/** Record a criterion. `met`, `not-met` or `undetermined` — never a bare boolean. */
function record(name, outcome, detail) {
  evidence.criteria[name] = { outcome, detail };
}

function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the repository the bugfix happens in ────────────────────────────────────
//
// A real git repo with a real failing test. `add` subtracts; `node --test`
// catches it. Small enough that any driver fixes it, real enough that the check
// porch runs is a process exiting non-zero rather than a string comparison.

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=air-235', '-c', 'user.email=air-235@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });

const BUGGY_SOURCE = `export function add(a, b) {\n  // The bug: subtraction, not addition.\n  return a - b;\n}\n`;
const REGRESSION_TEST = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './sum.js';\n\ntest('add sums its two arguments', () => {\n  assert.equal(add(2, 3), 5);\n});\n`;

function seedRepository() {
  const originPath = join(work, 'origin.git');
  const checkout = join(work, 'checkout');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '--bare', '--initial-branch=main', originPath);
  git(work, 'clone', originPath, checkout);
  writeFileSync(join(checkout, 'sum.js'), BUGGY_SOURCE);
  writeFileSync(join(checkout, 'test.mjs'), REGRESSION_TEST);
  writeFileSync(join(checkout, 'package.json'), `{"name":"air-235-fixture","type":"module","private":true}\n`);
  git(checkout, 'add', 'sum.js', 'test.mjs', 'package.json');
  git(checkout, 'commit', '-m', 'Seed the fixture with the bug under repair');
  git(checkout, 'push', 'origin', 'main');
  const branch = 'builder/bugfix-air235';
  const worktree = join(work, 'worktree');
  git(checkout, 'worktree', 'add', '-b', branch, worktree, 'main');
  return { originPath, checkout, worktree, branch };
}

// ── the connection ──────────────────────────────────────────────────────────

async function main() {
  const { WebSocket } = await import('ws');
  const { T3Client } = await import(join(repoRoot, 'packages/t3-client/dist/client.js'));
  const auth = await import(join(repoRoot, 'packages/t3-client/dist/auth.js'));
  const { ResumingSubscription } = await import(join(repoRoot, 'packages/t3-client/dist/subscription.js'));
  const { DispatchJournal } = await import(join(repoRoot, 'packages/porch-driver/dist/commands.js'));
  const turnModule = await import(join(repoRoot, 'packages/porch-driver/dist/turn.js'));
  const { createProject, DriverThread } = await import(join(repoRoot, 'packages/porch-driver/dist/thread.js'));
  const { PersistentCursor } = await import(join(repoRoot, 'packages/porch-driver/dist/cursor.js'));

  const base = `http://127.0.0.1:${port}`;
  // The bootstrap grant is one-time; the access token is not. Every socket after
  // the first — including the one the restart opens — comes from a fresh ticket
  // issued against this same access token, so a resubscription does not need a
  // credential the server will refuse to mint twice.
  const access = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-air-235' });
  // Handed to the restart child. The bootstrap grant is one-time and already
  // spent here, so the child cannot pair for itself; the access token can mint
  // as many tickets as it needs.
  const accessToken = access.access_token;

  /** Open one authenticated socket, recording every RPC method it carries. */
  async function connect() {
    const ticket = await auth.issueWebSocketTicket(base, access.access_token);
    const socket = new WebSocket(auth.webSocketUrl(base, ticket.ticket));
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CONNECT_FAILED: the socket errored before opening')), {
        once: true,
      });
    });
    const client = new T3Client({
      send: (data) => socket.send(data),
      close: () => socket.close(),
      addEventListener: (type, listener) => socket.addEventListener(type, listener),
      get readyState() {
        return socket.readyState;
      },
    });
    // Every RPC this run issues goes through one of these two. That is what makes
    // "no terminal.* was ever called" a measurement rather than a reading of the
    // source: a terminal opened by any path would have to appear here.
    const streamPayloads = [];
    const wrapped = {
      call: (method, payload) => {
        evidence.rpcMethods.push(method);
        return client.call(method, payload);
      },
      stream: (method, payload, onValue, timeoutMs) => {
        evidence.rpcMethods.push(method);
        streamPayloads.push({ method, payload });
        return client.stream(method, payload, onValue, timeoutMs);
      },
      streamPayloads,
    };
    return { client, wrapped, close: () => socket.close() };
  }

  const repo = seedRepository();
  const journalPath = join(work, 'commands.jsonl');
  const cursorPath = join(work, 'cursor.json');
  const journal = new DispatchJournal(journalPath);
  const tracker = new turnModule.TurnTracker();
  const codeword = `MERIDIAN-${randomUUID().slice(0, 8).toUpperCase()}`;
  evidence.observations.codeword = codeword;
  evidence.observations.worktree = repo.worktree;

  let conn = await connect();

  /**
   * The dispatcher the thread holds, for the whole run.
   *
   * It has to outlive a connection. `DriverThread` keeps whatever dispatcher it
   * was constructed with, so handing it the first socket's client meant the pr
   * turn after the restart dispatched down a socket the restart had closed:
   *
   *   NotConnectedError: Cannot send Request: the t3code socket is not open.
   *
   * That is porch restarting and then being unable to drive the thread it just
   * resumed — the failure the restart criterion exists to catch, arriving one
   * step later than the criterion looks. So the indirection is the fix and not a
   * convenience: a thread outlives a connection, and the code has to say so.
   */
  const dispatcher = {
    call: (method, payload) => {
      if (conn === null) throw new Error('NO_CONNECTION: a command was dispatched while porch was disconnected.');
      return conn.wrapped.call(method, payload);
    },
    stream: (method, payload, onValue, timeoutMs) => {
      if (conn === null) throw new Error('NO_CONNECTION: a stream was opened while porch was disconnected.');
      return conn.wrapped.stream(method, payload, onValue, timeoutMs);
    },
  };

  let thread;
  let subscription = null;
  let subscriptionRun = null;
  const resumeOutcomes = [];


  /**
   * Start a subscription from a cursor position read off DISK.
   *
   * The position is never carried in a variable across a restart. Reloading it
   * from the file is the whole point: a resubscription that resumed from an
   * in-memory copy would prove nothing about a porch that died.
   */
  function subscribe() {
    const cursor = PersistentCursor.load(cursorPath);
    const startAfter = cursor.applied;
    const sub = new ResumingSubscription(
      async () => {
        if (conn === null) conn = await connect();
        // `close` is a NO-OP, deliberately, and this is a limit rather than an
        // oversight. The subscription shares the command socket, so an internal
        // `transport.close()` — which `ResumingSubscription` performs on a
        // handler failure and on `resetTo` — would take the dispatch path down
        // with it mid-protocol. The socket is therefore closed by the code that
        // owns it: the restart step and the `finally`.
        //
        // What this costs: on a handler failure the stream is not ended
        // promptly, so the redelivery-from-the-last-applied-sequence behaviour
        // would arrive on the next natural resubscription rather than at once.
        // No handler fails in this run and `observations.handlerErrors` records
        // it if one ever does, which is why the simpler shape is kept.
        return { client: dispatcher, close: () => {} };
      },
      {
        method: 'orchestration.subscribeThread',
        payload: { threadId: thread.threadId },
        sequenceOf: turnModule.sequenceOf,
        isSnapshot: turnModule.isSnapshot,
        isSynchronized: turnModule.isSynchronized,
        onValue: (value) => {
          thread.observe(value);
        },
        onResume: (outcome, info) => {
          resumeOutcomes.push({ kind: outcome.kind, lastSequence: outcome.lastSequence ?? null, ...info });
        },
        onHandlerError: (error, sequence) => {
          evidence.observations.handlerErrors ??= [];
          evidence.observations.handlerErrors.push({ sequence, error: String(error).slice(0, 300) });
        },
        startAfter,
        persist: (sequence) => {
          cursor.reset(sequence);
        },
        delayBetweenAttemptsMs: 250,
      },
    );
    subscription = sub;
    subscriptionRun = sub.run().catch((error) => {
      evidence.observations.subscriptionError = String(error).slice(0, 400);
    });
    return startAfter;
  }

  /**
   * Wait until the subscription has actually attached.
   *
   * Dispatching before the stream is live loses the `running` transition, and the
   * waiter then waits for a transition that already happened. It is not
   * hypothetical and it is driver-dependent: a probe written this way passed
   * under claude and timed out under opencode/grok-4.6, which completes a trivial
   * turn in ~14 s and therefore finished before the subscribe landed. A race a
   * slow driver hides is the exact class of defect this phase exists to find.
   */
  async function awaitAttached(baseline, timeoutMs = 90_000) {
    // The BASELINE, not `length > 0`. Waiting for a non-empty list returns
    // instantly on every subscription after the first, so the resumed one was
    // read before it existed and its outcome came back `undefined` — recorded as
    // `resumeOutcome: null`, which reads exactly like a subscription that
    // reported nothing.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (resumeOutcomes.length > baseline) return true;
      await sleep(100);
    }
    return false;
  }

  try {
    // ── spawn ───────────────────────────────────────────────────────────────
    const projectId = await createProject(dispatcher, journal, {
      title: `air-235-${harness}`,
      workspaceRoot: repo.checkout,
    });
    thread = await DriverThread.create(
      { dispatcher, journal, tracker },
      {
        projectId,
        title: `air-235 bugfix under ${harness}`,
        harnessName: harness,
        model,
        worktreePath: repo.worktree,
        branch: repo.branch,
      },
    );
    evidence.driverKind = thread.driverKind;
    evidence.observations.threadId = thread.threadId;
    subscribe();
    if (!(await awaitAttached(0))) {
      throw new Error('COULD_NOT_TELL: SUBSCRIBE_TIMEOUT — the thread subscription never attached.');
    }

    // ── investigate ─────────────────────────────────────────────────────────
    const rootCauseFile = join(repo.worktree, 'investigate.md');
    await thread.runTurn(
      `You are fixing a bug under the BUGFIX protocol, investigate phase. Write NO code in this phase.\n`
        + `Read sum.js and test.mjs in your working directory and work out why the test fails.\n`
        + `Write the root cause, in one sentence, to investigate.md. Do not modify sum.js or test.mjs.\n`
        + `Also remember this codeword for later in our conversation: ${codeword}. Do not write the codeword to any file yet.`,
      { timeoutMs: turnTimeoutMs },
    );
    record(
      'investigate-produced-root-cause',
      existsSync(rootCauseFile) ? 'met' : 'not-met',
      existsSync(rootCauseFile) ? readFileSync(rootCauseFile, 'utf8').slice(0, 300) : 'investigate.md was not written',
    );

    // ── check between turns: it must FAIL here ──────────────────────────────
    const preFix = await thread.runCheck('node --test test.mjs', { timeoutMs: 120_000 });
    evidence.observations.preFixCheck = {
      exitCode: preFix.exitCode,
      passed: preFix.passed,
      timedOut: preFix.timedOut,
      shell: preFix.shell,
    };
    // A check that was KILLED did not run to a verdict. `exitCode === null` and
    // `exit 1` are different facts and only one of them is "the bug is present".
    const preFixRan = !preFix.timedOut && preFix.exitCode !== null;
    record(
      'check-fails-before-the-fix',
      !preFixRan ? 'undetermined' : preFix.passed ? 'not-met' : 'met',
      !preFixRan
        ? `the pre-fix check did not reach a verdict (timedOut=${preFix.timedOut}, signal=${preFix.signal}), so `
          + 'whether it fails before the fix was NOT evaluated'
        : `node --test exited ${preFix.exitCode} in ${preFix.shell}`,
    );

    // ── fix, with PORCH restarting mid-turn ──────────────────────────────────
    // The sentinel is how the runner knows the turn's WORK is done without
    // asking the server. During the dead window there is deliberately no
    // connection, so every other way of knowing would mean reconnecting — and a
    // runner that reconnects to find out whether it can afford to stay
    // disconnected has not tested anything.
    const fixDone = join(repo.worktree, 'fix-done.txt');
    const fixPrompt =
      `BUGFIX protocol, fix phase. Make the minimal change to sum.js so the existing test in test.mjs passes.\n`
      + `Do not modify test.mjs. Do not refactor anything else. Do not commit yet.\n`
      + `When the edit is written, run this shell command as your last action: echo done > ${fixDone}`;
    if (skipRestart) {
      await thread.runTurn(fixPrompt, { timeoutMs: turnTimeoutMs });
      record('restart-loses-no-completion', 'undetermined', 'RUN_SKIP_RESTART=1 — the restart was not attempted');
    } else {
      const started = await thread.beginTurn(fixPrompt);
      await started.running;

      // WAS A TURN ACTUALLY IN FLIGHT WHEN PORCH DIED?
      //
      // Read BEFORE the teardown, not after. A driver fast enough to finish
      // between `running` and this line leaves `isTurnActive` false either way,
      // and taking that reading after the sleep would report "the completion
      // event survived a gap in coverage" about a completion event that was
      // observed live. opencode/grok-4.6 finishes a trivial turn in ~14 s, so
      // this is a real ordering, not a theoretical one.
      const activeAtDeath = thread.isTurnActive;
      const cursorAtDeath = existsSync(cursorPath) ? readFileSync(cursorPath, 'utf8').trim() : null;

      // porch dies here. The turn keeps running on the server with nothing
      // subscribed, so its completion event is emitted into an empty room.
      subscription.stop();
      conn.close();
      conn = null;
      await Promise.race([subscriptionRun, sleep(15_000)]);
      const resumesBefore = resumeOutcomes.length;

      // Stay dark until the turn has actually finished. A 20-second window was
      // shorter than a claude-haiku fix turn, so the resumed subscriber attached
      // while the turn was still running and saw the completion LIVE — which the
      // criterion correctly reported as not evaluated, and which no amount of
      // rerunning would have changed.
      const sentinelDeadline = Date.now() + turnTimeoutMs;
      while (!existsSync(fixDone) && Date.now() < sentinelDeadline) await sleep(1000);
      // The sentinel is the agent's last ACTION; the session's settle event comes
      // after it. This grace is what puts the completion event inside the dark
      // window rather than adjacent to it.
      await sleep(20_000);

      // ── porch comes back as a DIFFERENT PROCESS ─────────────────────────
      //
      // Not a rebuilt subscription in this one. The first version of this step
      // closed the socket and reopened it here, and review was right that it
      // proved stream reconnection rather than recovery: the `DriverThread`, the
      // `TurnTracker`, the waiter promises and the journal all survived, so
      // nothing had to be reconstructed from anything durable.
      //
      // This child shares none of that. It is given a URL, a token, a thread id
      // and the path to the cursor FILE, and it works out where to resume from
      // by reading it. Whether the completion event comes back is then a fact
      // about the persisted cursor and the server, which is what the criterion
      // is about.
      let recovery;
      try {
        const childOut = execFileSync(
          process.execPath,
          [join(import.meta.dirname, 'air-235-resubscribe.mjs')],
          {
            encoding: 'utf8',
            timeout: 180_000,
            env: {
              ...process.env,
              RESUB_REPO_ROOT: repoRoot,
              RESUB_URL: base,
              RESUB_ACCESS_TOKEN: accessToken,
              RESUB_THREAD_ID: thread.threadId,
              RESUB_CURSOR_PATH: cursorPath,
              RESUB_WAIT_MS: '120000',
              // The parent's observation, handed over rather than re-derived:
              // the `running` event is at or below the cursor by construction,
              // so the child cannot see it and must be told.
              RESUB_TURN_IN_FLIGHT: activeAtDeath ? '1' : '0',
            },
          },
        );
        recovery = JSON.parse(childOut.slice(childOut.indexOf('{')));
      } catch (error) {
        recovery = { error: `CHILD_FAILED: ${String(error).slice(0, 300)}` };
      }

      // Only now does THIS process resubscribe, to carry the rest of the
      // protocol. The criterion is scored from the child's report, not from
      // anything observed here.
      const resumedFrom = subscribe();
      if (!(await awaitAttached(resumesBefore))) {
        throw new Error('COULD_NOT_TELL: RESUBSCRIBE_TIMEOUT — the resumed subscription never attached.');
      }
      const settleSeen = await Promise.race([
        started.settled.then(() => true),
        sleep(turnTimeoutMs).then(() => false),
      ]);
      const resumePayload = conn.wrapped.streamPayloads.at(-1)?.payload ?? {};
      const resumeOutcome = resumeOutcomes[resumesBefore];
      evidence.observations.restart = {
        activeAtDeath,
        cursorAtDeath,
        freshProcessRecovery: recovery,
        parentResumedFrom: resumedFrom,
        parentAfterSequenceSent: resumePayload.afterSequence ?? null,
        parentResumeOutcome: resumeOutcome ?? null,
        settleSeen,
      };
      const childRecovered =
        recovery.error == null
        && recovery.synchronized === true
        && recovery.afterSequenceSent === recovery.cursorReadFromDisk
        && recovery.cursorReadFromDisk > 0;
      record(
        'restart-loses-no-completion',
        !activeAtDeath || recovery.error != null || !recovery.synchronized
          ? 'undetermined'
          : childRecovered && recovery.sawSettleInCatchUp
            ? 'met'
            : 'not-met',
        !activeAtDeath
          ? 'the turn had already settled when porch was torn down, so no completion event was ever at risk '
            + 'and the criterion was NOT evaluated'
          : recovery.error != null
            ? `the restarted process could not subscribe at all (${recovery.error}), so whether the completion `
              + 'event survives a restart is UNKNOWN — this is not "it was lost"'
            : !recovery.synchronized
              ? 'the restarted process subscribed and never reached the synchronization marker, so catch-up '
                + 'and live events could not be told apart and the criterion was NOT evaluated'
              : recovery.sawSettleInCatchUp
                ? `a process sharing nothing with this one read cursor ${recovery.cursorReadFromDisk} off disk `
                  + `(file contained ${JSON.stringify(recovery.rawCursorFile)}), resubscribed with `
                  + `afterSequence=${recovery.afterSequenceSent}, and the turn's completion event — sequence `
                  + `${recovery.settleSequence}, emitted while nothing was subscribed — came back in the `
                  + `CATCH-UP replay rather than live`
                : `the restarted process resumed from ${recovery.cursorReadFromDisk} and the completion event `
                  + `was NOT in its catch-up (replayed sequences: ${JSON.stringify(recovery.catchUpSequences)})`,
      );
    }

    // ── check between turns: it must PASS now ───────────────────────────────
    const postFix = await thread.runCheck('node --test test.mjs', { timeoutMs: 120_000 });
    evidence.observations.postFixCheck = {
      exitCode: postFix.exitCode,
      passed: postFix.passed,
      timedOut: postFix.timedOut,
    };
    const postFixRan = !postFix.timedOut && postFix.exitCode !== null;
    record(
      'check-passes-after-the-fix',
      !postFixRan ? 'undetermined' : postFix.passed ? 'met' : 'not-met',
      !postFixRan
        ? `the post-fix check did not reach a verdict (timedOut=${postFix.timedOut}, signal=${postFix.signal})`
        : `node --test exited ${postFix.exitCode}`,
    );

    // ── pr ──────────────────────────────────────────────────────────────────
    await thread.runTurn(
      `BUGFIX protocol, pr phase. Commit your fix on the current branch with the message\n`
        + `"[Bugfix air-235] Fix: add must sum its arguments", push it to origin, and write a PR body to pr.md\n`
        + `with the sections Summary, Root Cause, Fix and Test Plan. Use the shell.`,
      { timeoutMs: turnTimeoutMs },
    );
    let pushedSha = null;
    try {
      pushedSha = git(repo.originPath, 'rev-parse', repo.branch).trim();
    } catch {
      pushedSha = null;
    }
    record(
      'pr-branch-reached-origin',
      pushedSha ? 'met' : 'not-met',
      pushedSha ? `origin has ${repo.branch} at ${pushedSha}` : `origin has no ${repo.branch}`,
    );

    // ── THE GATE ────────────────────────────────────────────────────────────
    //
    // No command is dispatched for the whole window, and that is asserted from
    // the journal afterwards rather than believed: a gate that quietly
    // dispatched something would keep the session warm and the resume would
    // prove nothing.
    //
    // THE CODEWORD MUST NOT BE ON DISK.
    //
    // The criterion is that the thread REMEMBERS. If the codeword is sitting in
    // a file in the worktree, the post-gate turn can read it, and a thread that
    // had been reaped and reconnected would produce it just as readily — the
    // criterion would pass and mean nothing. This is the same shape as the
    // restart check that could only ever answer `undetermined`: an assertion
    // whose subject is available by another route is not an assertion.
    //
    // So the tree is searched first, and a hit makes the criterion
    // `undetermined` rather than `met`. The turn is still run; what is refused
    // is the claim.
    let codewordOnDisk = null;
    try {
      execFileSync('grep', ['-rlF', codeword, repo.worktree, repo.checkout], { encoding: 'utf8' });
      codewordOnDisk = true;
    } catch (error) {
      // grep exits 1 for "no match" and 2 for "could not search". Only the first
      // is "the codeword is not on disk"; the second is "I could not tell", and
      // it must not read like the first.
      codewordOnDisk = error.status === 1 ? false : null;
    }
    evidence.observations.codewordOnDiskBeforeGate = codewordOnDisk;

    // A MONOTONIC gate, and long enough.
    //
    // `setTimeout(3_600_000)` is not a promise that 3,600,000 ms elapse: the
    // recorded runs measured 3,599,964 ms and 3,599,962 ms, both SHORT of the
    // hour they claimed. The test that was supposed to catch that measured
    // end-to-end runtime instead, which the surrounding turns padded well past
    // an hour — so a genuinely short gate would have passed too.
    //
    // `hrtime.bigint()` is monotonic, so it is not moved by NTP or a suspend,
    // and the loop runs until the target is actually reached rather than until
    // one timer says it should have been.
    const gateOpenedAt = Date.now();
    const gateStartNs = process.hrtime.bigint();
    const gateTargetNs = BigInt(gateSeconds) * 1_000_000_000n;
    evidence.observations.gateOpenedAt = new Date(gateOpenedAt).toISOString();
    const journalBefore = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length;
    for (;;) {
      const remainingNs = gateTargetNs - (process.hrtime.bigint() - gateStartNs);
      if (remainingNs <= 0n) break;
      await sleep(Math.min(Number(remainingNs / 1_000_000n) + 1, 60_000));
    }
    const gateElapsedMs = Number((process.hrtime.bigint() - gateStartNs) / 1_000_000n);
    const journalAfter = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length;
    evidence.observations.gate = {
      elapsedMs: gateElapsedMs,
      measuredWith: 'process.hrtime.bigint (monotonic)',
      wallClockElapsedMs: Date.now() - gateOpenedAt,
      journalRecordsDuringGate: journalAfter - journalBefore,
    };

    const recallFile = join(repo.worktree, 'gate-recall.txt');
    let recalled = null;
    try {
      await thread.runTurn(
        `The gate is approved. Write the codeword I asked you to remember at the start of our conversation to\n`
          + `gate-recall.txt — only the codeword, nothing else. Use the shell.`,
        { timeoutMs: turnTimeoutMs },
      );
      recalled = existsSync(recallFile) ? readFileSync(recallFile, 'utf8').trim() : null;
    } catch (error) {
      evidence.observations.gateResumeError = String(error).slice(0, 400);
    }
    record(
      'gate-resumes-with-context',
      codewordOnDisk !== false
        ? 'undetermined'
        : recalled === null
          ? 'undetermined'
          : recalled.includes(codeword)
            ? 'met'
            : 'not-met',
      codewordOnDisk === true
        ? 'the codeword was already in a file in the tree before the gate, so the post-gate turn could have '
          + 'READ it rather than remembered it. The criterion cannot be evaluated from this run.'
        : codewordOnDisk === null
          ? 'the tree could not be searched for the codeword, so whether the answer was available on disk is '
            + 'unknown, and with it whether this criterion means anything'
          : recalled === null
            ? `the post-gate turn never produced a file, so whether context survived `
              + `${Math.round(gateElapsedMs / 1000)}s of idleness is UNKNOWN — this is not "context was lost"`
            : recalled.includes(codeword)
              ? `after ${Math.round(gateElapsedMs / 1000)}s idle — measured monotonically — the thread returned `
                + `the codeword established before the gate, which was verified to exist in no file in the tree`
              : `the thread came back without its context: wrote ${JSON.stringify(recalled.slice(0, 80))}`,
    );
    record(
      'gate-dispatched-nothing',
      journalAfter === journalBefore ? 'met' : 'not-met',
      `${journalAfter - journalBefore} commands were journalled during the gate`,
    );
    record(
      'gate-elapsed-at-least-its-target',
      gateElapsedMs >= gateSeconds * 1000 ? 'met' : 'not-met',
      `${gateElapsedMs}ms elapsed against a ${gateSeconds * 1000}ms target, measured with a monotonic clock`,
    );

    // ── merge ───────────────────────────────────────────────────────────────
    git(repo.checkout, 'fetch', 'origin', repo.branch);
    git(repo.checkout, 'merge', '--no-ff', '-m', `Merge ${repo.branch}`, 'FETCH_HEAD');
    git(repo.checkout, 'push', 'origin', 'main');
    let mergedCheck = null;
    try {
      execFileSync('node', ['--test', 'test.mjs'], { cwd: repo.checkout, encoding: 'utf8', timeout: 120_000 });
      mergedCheck = 0;
    } catch (error) {
      mergedCheck = error.status ?? null;
    }
    record(
      'merge-lands-the-fix-on-main',
      mergedCheck === 0 ? 'met' : 'not-met',
      `node --test on merged main exited ${mergedCheck}`,
    );

    // ── no PTY code path ran ────────────────────────────────────────────────
    //
    // WHAT THIS IS A CLAIM ABOUT.
    //
    // This process ran a whole protocol — spawn, three turns, two checks, a
    // gate, a merge — through `porch-driver` and `t3-client` and nothing else.
    // The claim is that THAT path reaches no PTY: not the module, not the
    // shellper, not the server's terminal RPCs.
    //
    // It is not a claim about `agent-farm`'s Tower delivery path, which this
    // runner never calls; Phase 9's live test covers that one, through a real
    // child process. And it is not a claim about a PTY opened by some other
    // process — a module witness sees one process. The `terminal.*` check is
    // what closes that second gap for the case that matters here, since the
    // server would have had to be asked through an RPC to open one for us.
    const require_ = createRequire(import.meta.url);
    const cjsLoaded = Object.keys(require_.cache);
    const ptyPattern = /node-pty|pty-session|shellper|@xterm/;
    const esmHits = loadedModules.filter((url) => ptyPattern.test(url));
    const cjsHits = cjsLoaded.filter((path) => ptyPattern.test(path));
    const terminalRpcs = evidence.rpcMethods.filter((method) => method.startsWith('terminal.'));
    evidence.observations.pty = {
      esmModulesRecorded: loadedModules.length,
      esmHits,
      cjsHits,
      distinctRpcMethods: [...new Set(evidence.rpcMethods)],
      terminalRpcs,
    };
    record(
      'no-pty-code-path-ran',
      loadedModules.length === 0
        ? 'undetermined'
        : esmHits.length === 0 && cjsHits.length === 0 && terminalRpcs.length === 0
          ? 'met'
          : 'not-met',
      loadedModules.length === 0
        ? 'the module witness recorded nothing, so it was not working and this was NOT evaluated'
        : `${loadedModules.length} ESM modules recorded, none matching ${ptyPattern}; no terminal.* RPC among `
          + `${new Set(evidence.rpcMethods).size} distinct methods`,
    );

    // The witness's own mutation check. An assertion over a recorder that cannot
    // see the thing it is looking for passes exactly as loudly as one that can.
    try {
      await import('node-pty');
      const sawIt = loadedModules.some((url) => /node-pty/.test(url));
      record(
        'pty-witness-can-see-a-pty',
        sawIt ? 'met' : 'not-met',
        sawIt
          ? 'deliberately importing node-pty after the assertion made the witness report it, so the clean result above '
            + 'is a measurement and not a blind spot'
          : 'node-pty was imported and the witness did NOT record it — the assertion above is vacuous',
      );
    } catch (error) {
      record(
        'pty-witness-can-see-a-pty',
        'undetermined',
        `node-pty could not be imported here (${String(error).slice(0, 160)}), so whether the witness would catch one `
          + 'was not evaluated',
      );
    }
  } catch (error) {
    evidence.failure = String(error?.stack ?? error).slice(0, 2000);
  } finally {
    subscription?.stop();
    await subscriptionRun?.catch(() => {});
    conn?.close();
    writeEvidence();
  }
}

await main();
// The subscription's transports and the witness port keep handles alive; the run
// is over and its evidence is on disk.
process.exit(evidence.failure ? 1 : 0);
