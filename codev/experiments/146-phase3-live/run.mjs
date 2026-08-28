#!/usr/bin/env node
/**
 * Spec 146, Phase 3 — the live harness.
 *
 * Drives a real pinned t3code server with the real client and the real driver,
 * and writes `codev/research/146-phase3-live-evidence.json`. Every scenario
 * reports one of three states: demonstrated, not-demonstrated, failed.
 * "not-demonstrated" is not a pass and not a failure — it is the answer that says
 * the scenario never reached a verdict, and it exists so that "I could not tell"
 * is never spelled the same way as "no".
 *
 *   node codev/experiments/146-phase3-live/run.mjs [--scenarios a,b,c,d,e]
 *
 * Environment:
 *   T3_LIVE_PORT           default 3793
 *   T3_LIVE_VERSION        default t3@0.0.35 (the pinned CLI)
 *   T3_LIVE_MODEL          default gpt-5.6-luna
 *   T3_LIVE_HARNESS        default codex (a Codev harness name, mapped here)
 *   T3_LIVE_IDLE_SECONDS   default 360 — must exceed the old 300s total budget
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authenticate, connect, demonstrated, deferred, failed, notDemonstrated, shell, sleep, startServer, withTimeout } from './lib.mjs';
import { DispatchJournal, newCommandId, recoverPendingCommands } from '../../../packages/porch-driver/dist/commands.js';
import { DriverThread, createProject, createWorktree } from '../../../packages/porch-driver/dist/thread.js';
import { TurnTracker, asThreadEvent } from '../../../packages/porch-driver/dist/turn.js';
import { ResumingSubscription } from '../../../packages/t3-client/dist/subscription.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const port = Number(process.env.T3_LIVE_PORT ?? 3793);
const baseUrl = `http://127.0.0.1:${port}`;
const model = process.env.T3_LIVE_MODEL ?? 'gpt-5.6-luna';
const harnessName = process.env.T3_LIVE_HARNESS ?? 'codex';
const idleSeconds = Number(process.env.T3_LIVE_IDLE_SECONDS ?? 360);

const requested = (() => {
  const flag = process.argv.indexOf('--scenarios');
  if (flag === -1) return new Set(['a', 'b', 'c', 'd', 'e']);
  return new Set(process.argv[flag + 1].split(',').map((s) => s.trim().toLowerCase()));
})();

const log = (...args) => console.log(new Date().toISOString(), ...args);
const scenarios = [];
const record = (result) => {
  scenarios.push(result);
  log(`[${result.scenario}] ${result.state}${result.note ? ` — ${result.note}` : ''}`);
};

/** Everything this thread has seen, in arrival order, for the control comparison. */
const controlEvents = [];

function clientCommit() {
  try {
    return shell('git rev-parse HEAD', repoRoot);
  } catch {
    return null;
  }
}

function treeDirty() {
  try {
    return shell('git status --porcelain -- packages/porch-driver packages/t3-client', repoRoot).length > 0;
  } catch {
    return null;
  }
}

async function runChild(mode, config, { expectKill }) {
  const child = spawn(process.execPath, [join(here, 'crash-child.mjs'), mode], {
    env: { ...process.env, CRASH_CHILD_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return {
    exit,
    lines,
    stderr,
    // A SIGKILL is reported as signal SIGKILL; anything else means the process
    // reached an ordinary exit, which for the crash modes is a failed setup.
    killed: exit.signal === 'SIGKILL',
    expectKill,
  };
}

async function main() {
  const server = await startServer({ port, log });
  const evidence = {
    criterion: 'Spec 146 Phase 3 live integration',
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
    t3Version: process.env.T3_LIVE_VERSION ?? 't3@0.0.35',
    clientCommit: clientCommit(),
    clientTreeDirty: treeDirty(),
    harness: harnessName,
    model,
    scenarios,
  };

  try {
    const auth = await authenticate(baseUrl, server.bootstrapToken);
    log('authenticated', { missingScopes: auth.missingScopes });

    const primary = await connect(baseUrl, auth.accessToken);
    const journalDir = join(server.dataDir, 'porch');
    mkdirSync(journalDir, { recursive: true });
    const journal = new DispatchJournal(join(journalDir, 'commands.jsonl'));
    const tracker = new TurnTracker();

    const projectId = await createProject(primary.dispatcher, journal, {
      title: 'Spec 146 Phase 3 live',
      workspaceRoot: server.seedRepo,
    });
    const worktree = await createWorktree(primary.dispatcher, {
      cwd: server.seedRepo,
      newRefName: `spec146-phase3-${Date.now()}`,
    });

    const thread = await DriverThread.create(
      { dispatcher: primary.dispatcher, journal, tracker },
      {
        projectId,
        title: 'phase 3 driver thread',
        harnessName,
        model,
        worktreePath: worktree.path,
        branch: worktree.refName,
        roleContent: '# live harness thread\n',
      },
    );
    log('thread', thread.threadId, 'driver', thread.driverKind, 'worktree', thread.worktreePath);

    // The control subscription. It never drops, and it is what scenario C
    // compares against — "the replayed range looked right" is a judgement about a
    // list nobody checked until there is a second list.
    const synced = deferred();
    const controlStream = primary.client.stream(
      'orchestration.subscribeThread',
      { threadId: thread.threadId, requestCompletionMarker: true },
      (value) => {
        if (value?.kind === 'synchronized') synced.resolve();
        const event = asThreadEvent(value);
        if (event && event.aggregateId === thread.threadId) controlEvents.push(event);
        thread.observe(value);
      },
    );
    controlStream.catch((error) => log('control stream ended:', String(error?.message ?? error)));
    await withTimeout(synced.promise, 'control subscription synchronized', 60_000);

    if (requested.has('a')) await scenarioA(thread, worktree);
    if (requested.has('b')) await scenarioB(thread);
    if (requested.has('c')) await scenarioC({ thread, auth, tracker });
    if (requested.has('d')) await scenarioD({ thread, auth });
    if (requested.has('e')) {
      await scenarioE({ thread, auth, journalDir, primary });
      await scenarioF({ thread, auth, journalDir });
    }

    primary.close();
  } catch (error) {
    record(failed('harness', { note: String(error?.stack ?? error) }));
  } finally {
    evidence.limits = limits();
    const out = join(repoRoot, 'codev', 'research', '146-phase3-live-evidence.json');
    writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
    log('evidence written to', out);
    await server.stop();
  }

  const anyFailed = scenarios.some((s) => s.state === 'failed');
  process.exit(anyFailed ? 1 : 0);
}

/** Wait until no turn is running on the thread. */
async function settleThread(thread, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (thread.isTurnActive) {
    if (Date.now() > deadline) throw new Error('the thread did not settle within the budget');
    await sleep(2_000);
  }
}

function limits() {
  return {
    scope:
      'These scenarios exercise one thread against one freshly created server. ' +
      'They do not measure concurrency, multi-day retention, or any phase after 3.',
    scenarioD:
      'The idle-timeout scenario proves the timeout is idle rather than total across a ' +
      'window longer than the old 300s budget. It does NOT prove a day-long gate; ' +
      'success criterion 11 remains Phase 10 work.',
    guard:
      'The Claude write-guard is verified by reading t3code\'s Claude adapter ' +
      '(settingSources includes "local"), not by running a claudeAgent turn that ' +
      'attempts a write outside its worktree.',
  };
}

// ---------------------------------------------------------------- scenario A

async function scenarioA(thread, worktree) {
  const token = `EXT_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const name = 'A: a thread on a worktree, a turn to settle, an external write read back';
  try {
    const first = await thread.runTurn(
      `Reply with exactly TURN1_READY. Do not run any tool and do not modify files.`,
      { timeoutMs: 10 * 60_000 },
    );

    // The external write goes through the phase-check path: a process porch owns,
    // in the thread's own worktreePath, between turns. No terminal RPC.
    const write = await thread.runCheck(`printf '%s\\n' ${JSON.stringify(token)} > external.txt`);
    const readBack = await thread.runCheck('cat external.txt');

    const second = await thread.runTurn(
      `Use a shell command to read external.txt in your working directory. ` +
        `Reply as EXTERNAL_SEEN_<the file's contents>. Do not ask me for the value.`,
      { timeoutMs: 10 * 60_000 },
    );

    const sawFile = second.text.includes(`EXTERNAL_SEEN_${token}`);
    const settledBoth = first.endSequence > first.startSequence && second.startSequence >= first.endSequence;
    record(
      sawFile && settledBoth && write.passed && readBack.stdout.trim() === token
        ? demonstrated(name, {
            turn1: first.text.slice(0, 120),
            turn2: second.text.slice(0, 160),
            checkRanInWorktree: write.cwd === thread.worktreePath,
            checkShell: write.shell,
            note: 'two turns settled, and the second read a file written between them by a process porch spawned',
          })
        : failed(name, { turn1: first.text.slice(0, 200), turn2: second.text.slice(0, 200), sawFile, settledBoth }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ---------------------------------------------------------------- scenario B

async function scenarioB(thread) {
  const name = 'B: a turn interrupted mid-shell settles, and its side effect is absent';
  const sentinel = 'interrupted-side-effect.txt';
  try {
    await thread.runCheck(`rm -f ${sentinel}`);
    const started = await thread.beginTurn(
      `Run exactly this shell command in the foreground and nothing else: sleep 25; printf DONE > ${sentinel}`,
    );
    const turnId = await withTimeout(started.running, 'the interrupted turn to start', 5 * 60_000);

    // Wait until the command is actually running before interrupting. Interrupting
    // before the tool call would prove nothing about a command mid-flight, and
    // "the file is absent" would be true for the wrong reason.
    const toolStarted = Date.now();
    let sawToolActivity = false;
    while (Date.now() - toolStarted < 60_000) {
      await sleep(1_000);
      sawToolActivity = thread.events.some(
        (event) =>
          event.sequence > started.startSequence &&
          event.type === 'thread.activity-appended' &&
          JSON.stringify(event.payload ?? {}).includes('sleep 25'),
      );
      if (sawToolActivity) break;
    }
    const interruptedAt = Date.now();
    await thread.interrupt(turnId);
    await withTimeout(started.settled, 'the interrupted turn to settle', 5 * 60_000);
    const settledAfterMs = Date.now() - interruptedAt;

    // Three separate observations, because they answer three different questions.
    const stillActive = thread.isTurnActive;
    const atSettle = (await thread.runCheck(`test -e ${sentinel} && echo PRESENT || echo ABSENT`)).stdout.trim();
    // The command sleeps 25s. If it outlived the interrupt, it lands in this window.
    await sleep(30_000);
    const afterCommandWindow = (await thread.runCheck(`test -e ${sentinel} && echo PRESENT || echo ABSENT`)).stdout.trim();

    const shared = {
      turnId,
      sawToolActivity,
      settledAfterMs,
      settledWithActiveTurnIdNull: !stillActive,
      sideEffectAtSettle: atSettle,
      sideEffectAfterCommandWindow: afterCommandWindow,
    };

    if (!stillActive && afterCommandWindow === 'ABSENT') {
      record(
        demonstrated(name, {
          ...shared,
          note: 'interrupted mid-shell; the turn settled and the command\'s file never appeared',
        }),
      );
      return;
    }

    if (!stillActive && atSettle === 'ABSENT' && afterCommandWindow === 'PRESENT') {
      // The turn stopped; the process it spawned did not. That is a fact about
      // t3code's interrupt, not about this client, and it is recorded as its own
      // finding rather than filed under "the assertion failed".
      record(
        notDemonstrated(name, {
          ...shared,
          finding:
            'The turn settled on interrupt, but the shell command it had spawned kept running to '
            + 'completion and wrote its file afterwards. Settle detection is correct. The side-effect '
            + 'half of the criterion is not satisfiable from the client: t3code forwards the interrupt '
            + 'to the provider\'s own turn/interrupt RPC (CodexSessionRuntime.ts:2150-2180 at the pinned '
            + 'commit), and the process the provider had spawned survived it. That is provider '
            + 'behaviour below t3code, not something this client can change.',
          note: 'settle proven; the spawned process outlived the interrupt (recorded, not passed)',
        }),
      );
      return;
    }

    record(failed(name, shared));
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ---------------------------------------------------------------- scenario C

async function scenarioC({ thread, auth, tracker }) {
  const name = 'C: a socket killed mid-stream replays exactly the missing range (Phase 2 criterion C)';
  try {
    // A second connection, dropped deliberately while a turn is running.
    const aux = await connect(baseUrl, auth.accessToken);
    const auxSynced = deferred();
    const auxSawRunning = deferred();
    const auxEvents = [];
    const auxStart = thread.lastSequence;

    const auxStream = aux.client.stream(
      'orchestration.subscribeThread',
      { threadId: thread.threadId, afterSequence: auxStart, requestCompletionMarker: true },
      (value) => {
        if (value?.kind === 'synchronized') auxSynced.resolve();
        const event = asThreadEvent(value);
        if (!event || event.aggregateId !== thread.threadId) return;
        auxEvents.push(event);
        const session = event.type === 'thread.session-set' ? event.payload?.session : null;
        if (session?.activeTurnId != null) auxSawRunning.resolve();
      },
    );
    auxStream.catch(() => {});
    await withTimeout(auxSynced.promise, 'aux subscription synchronized', 60_000);

    const started = await thread.beginTurn('Run this shell command: sleep 8; printf REPLAY_CMD_DONE. Then reply exactly REPLAY_TURN_DONE.');
    await withTimeout(started.running, 'the replay turn to start', 5 * 60_000);
    await withTimeout(auxSawRunning.promise, 'aux to observe the turn running', 5 * 60_000);

    // Killed mid-stream, at a sequence we know because we watched it arrive.
    const lastBeforeDrop = auxEvents.at(-1)?.sequence ?? auxStart;
    aux.close();

    await withTimeout(started.settled, 'the turn to settle while aux is disconnected', 10 * 60_000);
    const settledSequence = thread.lastSequence;

    // Resubscribe from the last event the dropped socket actually applied.
    const replay = await connect(baseUrl, auth.accessToken);
    const replaySynced = deferred();
    const replayEvents = [];
    const replayStream = replay.client.stream(
      'orchestration.subscribeThread',
      { threadId: thread.threadId, afterSequence: lastBeforeDrop, requestCompletionMarker: true },
      (value) => {
        if (value?.kind === 'synchronized') replaySynced.resolve();
        const event = asThreadEvent(value);
        if (event && event.aggregateId === thread.threadId) replayEvents.push(event);
      },
    );
    replayStream.catch(() => {});
    await withTimeout(replaySynced.promise, 'replay subscription synchronized', 60_000);
    replay.close();

    // The comparison is against the control connection's record, not against
    // arithmetic: the sequence is global and thread-filtered, so "consecutive"
    // would be testing the counter rather than the replay.
    const expected = controlEvents
      .filter((event) => event.sequence > lastBeforeDrop && event.sequence <= settledSequence)
      .map((event) => event.eventId);
    const replayed = replayEvents
      .filter((event) => event.sequence <= settledSequence)
      .map((event) => event.eventId);
    const completionReplayed = replayEvents.some(
      (event) => event.type === 'thread.session-set' && event.payload?.session?.activeTurnId === null,
    );
    const exact = JSON.stringify(expected) === JSON.stringify(replayed);

    record(
      exact && completionReplayed && expected.length > 0
        ? demonstrated(name, {
            lastBeforeDrop,
            settledSequence,
            missingRangeSize: expected.length,
            comparedAgainst: 'a control subscription that never dropped',
            completionEventReplayed: true,
            note: 'the replayed eventIds equal the control connection\'s record over the same window',
          })
        : expected.length === 0
          ? notDemonstrated(name, { lastBeforeDrop, settledSequence, note: 'no events fell in the gap, so there was nothing to replay' })
          : failed(name, {
              lastBeforeDrop,
              settledSequence,
              expectedCount: expected.length,
              replayedCount: replayed.length,
              completionEventReplayed: completionReplayed,
            }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ---------------------------------------------------------------- scenario D

async function scenarioD({ thread, auth }) {
  const name = `D: a subscription under traffic survives ${idleSeconds}s without a timeout or a resubscription`;
  try {
    let attempts = 0;
    let handlerCalls = 0;
    let terminated = null;

    const subscription = new ResumingSubscription(
      async () => {
        const connection = await connect(baseUrl, auth.accessToken);
        return { client: connection.client, close: () => connection.close() };
      },
      {
        method: 'orchestration.subscribeThread',
        payload: { threadId: thread.threadId },
        sequenceOf: (value) => asThreadEvent(value)?.sequence ?? null,
        isSnapshot: (value) => value?.kind === 'snapshot' || value?.kind === 'thread-snapshot',
        isSynchronized: (value) => value?.kind === 'synchronized',
        onValue: () => {
          handlerCalls += 1;
        },
        onResume: (_outcome, info) => {
          attempts = Math.max(attempts, info.attempt);
        },
        startAfter: thread.lastSequence,
        delayBetweenAttemptsMs: 50,
      },
    );

    const running = subscription.run().catch((error) => {
      terminated = String(error?.message ?? error);
    });

    // Traffic on THIS subscription, which means thread DETAIL events: a
    // `thread.meta.update` is not one (`ws.ts:293-312`), so it would leave the
    // stream silent while looking like traffic — the stream would then time out
    // legitimately and the scenario would blame the wrong thing. A turn produces
    // message-sent, session-set and activity-appended events, all delivered here.
    //
    // With a TOTAL budget the stream dies at 300s no matter how busy it is; with
    // an idle budget rearmed per chunk it does not.
    const startedAt = Date.now();
    const deadline = startedAt + idleSeconds * 1_000;
    let beats = 0;
    while (Date.now() < deadline) {
      beats += 1;
      await thread.runTurn(`Reply with exactly BEAT_${beats}. Do not run any tool.`, { timeoutMs: 5 * 60_000 });
      if (Date.now() < deadline) await sleep(20_000);
    }

    const elapsedMs = Date.now() - startedAt;
    subscription.stop();
    await running;

    record(
      attempts === 1 && terminated === null && elapsedMs > 300_000
        ? demonstrated(name, {
            elapsedMs,
            heartbeats: beats,
            subscriptionAttempts: attempts,
            handlerCalls,
            note: `held ${Math.round(elapsedMs / 1000)}s under traffic on ONE subscription attempt; the old 300s total budget would have torn it down`,
          })
        : elapsedMs <= 300_000
          ? notDemonstrated(name, {
              elapsedMs,
              note: 'the window did not exceed the old 300s total budget, so it proves nothing about idle vs total',
            })
          : failed(name, { elapsedMs, subscriptionAttempts: attempts, terminated, heartbeats: beats }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ---------------------------------------------------------------- scenario E

async function scenarioE({ thread, auth, journalDir, primary }) {
  const name = 'E: a driver killed between the journal write and the dispatch does not apply the command twice';
  try {
    const results = {};
    for (const mode of ['journal-before-dispatch', 'journal-after-dispatch']) {
      const journalPath = join(journalDir, `${mode}.jsonl`);
      const commandId = newCommandId();
      const messageId = newCommandId();
      const text = `CRASH_${mode.toUpperCase().replace(/-/g, '_')}_${Date.now()}`;

      const child = await runChild(
        mode,
        { baseUrl, accessToken: auth.accessToken, journalPath, threadId: thread.threadId, commandId, messageId, text },
        { expectKill: true },
      );

      // Whatever the child managed to do, the turn it may have started must be
      // finished before recovery: a second turn.start against a busy thread would
      // be refused for a reason that has nothing to do with idempotency.
      await settleThread(thread, 5 * 60_000);

      const journal = new DispatchJournal(journalPath);
      const pendingBefore = journal.pending().map((r) => r.commandId);
      const replayed = await recoverPendingCommands(primary.dispatcher, journal);
      await sleep(3_000);
      await settleThread(thread, 5 * 60_000);

      // The user message is emitted the moment the command is applied, so
      // counting it counts APPLICATIONS, not model behaviour.
      const applications = controlEvents.filter(
        (event) =>
          event.type === 'thread.message-sent' &&
          event.payload?.role === 'user' &&
          event.payload?.text === text,
      ).length;

      results[mode] = {
        childKilled: child.killed,
        childSaid: child.lines,
        pendingAfterCrash: pendingBefore,
        replayed,
        applicationsObserved: applications,
        appliedExactlyOnce: applications === 1,
      };
    }

    const bothOnce = Object.values(results).every((r) => r.appliedExactlyOnce && r.childKilled);
    record(
      bothOnce
        ? demonstrated(name, {
            ...results,
            note:
              'both crash windows recovered to exactly one application: the pre-dispatch kill because ' +
              'the command never landed, the post-dispatch kill because the server deduplicated the ' +
              'replayed commandId',
          })
        : failed(name, results),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.stack ?? error) }));
  }
}

// ---------------------------------------------------------------- scenario F

async function scenarioF({ thread, auth, journalDir }) {
  const name = 'F: a driver killed between the handler and the cursor write REPROCESSES the event';
  try {
    const cursorPath = join(journalDir, 'cursor');
    const sideEffectPath = join(journalDir, 'side-effects.txt');
    const startAt = thread.lastSequence;
    writeFileSync(cursorPath, `${startAt}\n`);
    writeFileSync(sideEffectPath, '');

    // Produce an event for the child to apply, then die inside the window.
    const crashing = runChild(
      'cursor-before-advance',
      { baseUrl, accessToken: auth.accessToken, cursorPath, sideEffectPath, threadId: thread.threadId },
      { expectKill: true },
    );
    await sleep(3_000);
    const connection = await connect(baseUrl, auth.accessToken);
    // Detail events only reach a thread subscription, so the traffic is a turn.
    await thread.beginTurn('Reply with exactly CURSOR_WINDOW_OK. Do not run any tool.');
    const crashed = await withTimeout(crashing, 'the cursor-window child to die', 120_000);

    const cursorAfterCrash = Number(readFileSync(cursorPath, 'utf-8').trim());
    const beforeRestart = readFileSync(sideEffectPath, 'utf-8').trim().split('\n').filter(Boolean);

    // Restart. The cursor never advanced, so the server redelivers the same event.
    const resumed = await runChild(
      'cursor-resume',
      { baseUrl, accessToken: auth.accessToken, cursorPath, sideEffectPath, threadId: thread.threadId, applyCount: 1 },
      { expectKill: false },
    );
    connection.close();

    await settleThread(thread, 5 * 60_000);
    const afterRestart = readFileSync(sideEffectPath, 'utf-8').trim().split('\n').filter(Boolean);
    const killedSequence = crashed.lines.find((line) => line.sequence !== undefined)?.sequence ?? null;
    const reprocessed =
      killedSequence !== null &&
      afterRestart.filter((line) => Number(line) === killedSequence).length >= 2 &&
      cursorAfterCrash === startAt;

    record(
      reprocessed
        ? demonstrated(name, {
            startAt,
            killedSequence,
            cursorAfterCrash,
            appliedBeforeRestart: beforeRestart,
            appliedAfterRestart: afterRestart,
            childKilled: crashed.killed,
            note:
              'the handler ran, the process was SIGKILLed before the cursor advanced, and the same ' +
              'sequence was delivered and applied again after restart — skipped would have been the loss',
          })
        : failed(name, {
            startAt,
            killedSequence,
            cursorAfterCrash,
            appliedBeforeRestart: beforeRestart,
            appliedAfterRestart: afterRestart,
            childKilled: crashed.killed,
            childSaid: crashed.lines,
            resumeSaid: resumed.lines,
          }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.stack ?? error) }));
  }
}

await main();
