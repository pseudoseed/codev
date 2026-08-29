#!/usr/bin/env node
/**
 * Spec 146, Phase 4 — minimal repro: does `expectTurn().settled` resolve for a turn
 * started by a MESSAGE?
 *
 * WHY THIS EXISTS
 *
 * The queue can close a real race by waiting on the turn its own dispatch started
 * instead of on `isTurnActive`, which is a projection and lags the server. Wiring
 * that to `TurnTracker.expectTurn` failed live: every message waited out the drain's
 * bound and the ten-message backlog took 300 s instead of 11 s. Two hypotheses
 * failed against a six-minute feedback loop, so this stops guessing and captures the
 * raw events instead.
 *
 *   node codev/experiments/146-phase4-expectturn-repro/run.mjs
 *
 * Environment: T3_LIVE_PORT (default 3890), plus the same T3_LIVE_* vars the phase 4
 * harness uses. Needs node 22 — the pinned server uses `node:sqlite`.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * WHAT THE FIRST RUN FOUND, WHICH IS NOT WHAT I EXPECTED
 *
 * **`settled` resolves fine for a message-started turn** — case B, in 1.5 s, with a
 * clean `activeTurnId` non-null → null trace. The premise I had written into the
 * evidence document, that it "never resolved for these turns", was wrong.
 *
 * What actually breaks is **displacement**. `TurnTracker` keeps ONE waiter per
 * thread, and `expectTurn` abandons the previous one with `TurnDisplacedError`. So
 * two registrants on one thread cannot coexist — and that is precisely the shape the
 * queue created, calling `expectTurn` on the same tracker its `DriverThread` uses.
 * Case A shows it: registering a waiter and then calling `beginTurn`, which
 * registers its own, rejects the first in 32 ms.
 *
 * So the cases are:
 *
 *   A. expectTurn, then a SECOND registrant (`beginTurn`) — the contention case.
 *   B. expectTurn, then `sendMessage`, sole registrant — the message path.
 *
 * Both dispatch the same command type, so the difference between them is not the
 * command. It is how many things wanted to watch the thread.
 *
 * It asserts nothing about the queue and changes no production code. Its output is
 * evidence for an outside reviewer, so it records what it saw rather than a verdict:
 * a run where BOTH settle is a real result and must not be reported as a failure to
 * reproduce.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authenticate, connect, sleep, startServer } from '../146-phase3-live/lib.mjs';
import { DispatchJournal } from '../../../packages/porch-driver/dist/commands.js';
import { sendMessage } from '../../../packages/porch-driver/dist/deliver.js';
import { DriverThread, createProject, createWorktree } from '../../../packages/porch-driver/dist/thread.js';
import { TurnTracker, activeTurnIdOf, asThreadEvent } from '../../../packages/porch-driver/dist/turn.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const port = Number(process.env.T3_LIVE_PORT ?? 3890);
const baseUrl = `http://127.0.0.1:${port}`;
const model = process.env.T3_LIVE_MODEL ?? 'gpt-5.6-luna';
const harnessName = process.env.T3_LIVE_HARNESS ?? 'codex';

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Settle or not, WITHOUT ever reporting "still pending" as "finished". */
async function outcome(promise, ms) {
  const marker = Symbol('pending');
  const result = await Promise.race([
    promise.then(
      (value) => ({ state: 'resolved', value: value ?? null }),
      (error) => ({ state: 'rejected', error: String(error?.message ?? error) }),
    ),
    sleep(ms).then(() => marker),
  ]);
  return result === marker ? { state: 'PENDING', waitedMs: ms } : result;
}

async function main() {
  const server = await startServer({ port, log });
  const auth = await authenticate(baseUrl, server.bootstrapToken);
  const primary = await connect(baseUrl, auth.accessToken);

  const journalDir = join(server.dataDir, 'porch');
  mkdirSync(journalDir, { recursive: true });
  const journal = new DispatchJournal(join(journalDir, 'commands.jsonl'));
  const tracker = new TurnTracker();

  const projectId = await createProject(primary.dispatcher, journal, {
    title: 'Spec 146 expectTurn repro',
    workspaceRoot: server.seedRepo,
  });
  const worktree = await createWorktree(primary.dispatcher, {
    cwd: server.seedRepo,
    newRefName: `spec146-expectturn-${Date.now()}`,
  });

  const thread = await DriverThread.create(
    { dispatcher: primary.dispatcher, journal, tracker },
    {
      projectId,
      title: 'expectTurn repro thread',
      harnessName,
      model,
      worktreePath: worktree.path,
      branch: worktree.refName,
    },
  );
  log('thread', thread.threadId);

  // EVERY event carrying an activeTurnId, with its sequence. This is the raw data
  // the two failed hypotheses lacked.
  const activeTurnEvents = [];
  primary.client.stream(
    'orchestration.subscribeThread',
    { threadId: thread.threadId, requestCompletionMarker: true },
    (value) => {
      thread.observe(value);
      const event = asThreadEvent(value);
      if (!event || event.aggregateId !== thread.threadId) return;
      const activeTurnId = activeTurnIdOf(event);
      if (activeTurnId === undefined) return;
      activeTurnEvents.push({
        at: new Date().toISOString(),
        type: event.type ?? null,
        sequence: event.sequence ?? null,
        activeTurnId,
      });
    },
  );
  await sleep(1_500);

  const cases = [];

  // ---------------------------------------------------------------- A: beginTurn
  {
    const before = activeTurnEvents.length;
    const expectation = tracker.expectTurn(thread.threadId);
    log('[A] expectTurn registered, dispatching via beginTurn');
    await thread.beginTurn('Reply with the single word: ready.');
    const running = await outcome(expectation.running, 60_000);
    const settled = await outcome(expectation.settled, 120_000);
    cases.push({
      case: 'A: a second registrant (beginTurn) displaces the first waiter',
      running,
      settled,
      isTurnActiveAfter: thread.isTurnActive,
      activeTurnEvents: activeTurnEvents.slice(before),
    });
    log('[A] running', running.state, 'settled', settled.state);
  }

  // Let the thread go quiet, so B is not measuring A's tail.
  {
    const deadline = Date.now() + 120_000;
    while (thread.isTurnActive && Date.now() < deadline) await sleep(500);
    await sleep(2_000);
  }

  // -------------------------------------------------------------- B: sendMessage
  {
    const before = activeTurnEvents.length;
    const expectation = tracker.expectTurn(thread.threadId);
    log('[B] expectTurn registered, dispatching via sendMessage');
    await sendMessage(primary.dispatcher, journal, {
      threadId: thread.threadId,
      text: 'Reply with the single word: done.',
      idempotencyKey: `repro-${Date.now()}`,
    });
    const running = await outcome(expectation.running, 60_000);
    const settled = await outcome(expectation.settled, 120_000);
    cases.push({
      case: 'B: sole registrant, turn started by sendMessage',
      running,
      settled,
      isTurnActiveAfter: thread.isTurnActive,
      activeTurnEvents: activeTurnEvents.slice(before),
    });
    log('[B] running', running.state, 'settled', settled.state);
  }

  const displaced = /displaced/i.test(String(cases[0].settled.error ?? ''));
  const messageTurnSettled = cases[1].settled.state === 'resolved';

  // Four states, never two. "Did not reproduce", "showed the opposite" and "could
  // not tell" are three different claims and must not share a spelling.
  const result = displaced && messageTurnSettled
    ? 'DIAGNOSED: expectTurn works for message-started turns (B settled). The failure is DISPLACEMENT — TurnTracker holds one waiter per thread, so a second registrant abandons the first (A rejected with TurnDisplacedError). The queue called expectTurn on the same tracker its DriverThread uses.'
    : !messageTurnSettled
      ? 'CONTRADICTED: a message-started turn did NOT settle even as sole registrant — the displacement account is not the whole story'
      : 'INCONCLUSIVE: B settled but A did not show displacement; this run does not establish the mechanism';

  const record = {
    spec: 146,
    phase: 'phase_4',
    question:
      'Why did wiring the queue to TurnTracker.expectTurn stall the live backlog? Specifically: does settled resolve for a turn started by sendMessage, and what happens when two things watch one thread?',
    result,
    findingForReviewers:
      'TurnTracker.expectTurn keeps ONE waiter per thread and abandons the previous with TurnDisplacedError. Any design where the queue and the DriverThread both watch the same thread on the same tracker is therefore unsound as written, regardless of how the turn was started. Please check that reading against turn.ts rather than taking it.',
    serverVersion: process.env.T3_LIVE_VERSION ?? 't3@0.0.35',
    threadId: thread.threadId,
    capturedAt: new Date().toISOString(),
    cases,
  };

  const out = join(repoRoot, 'codev/research/146-phase4-expectturn-repro.json');
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  log('result:', record.result);
  log('written to', out);

  await server.stop?.();
  process.exit(0);
}

main().catch((error) => {
  log('repro failed to run:', error?.stack ?? error);
  // A harness that could not run is not a negative result about the question.
  process.exit(1);
});
