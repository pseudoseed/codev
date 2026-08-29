#!/usr/bin/env node
/**
 * Spec 146, Phase 4 — the live harness for the five delivery semantics.
 *
 * Success criterion 12b gates criterion 13: if these five do not hold, the mailbox
 * stays and the deletion phase is not attempted. So they are demonstrated against a
 * REAL pinned t3code server with the real client and the real driver, not against a
 * fake dispatcher — a fake proves the queue's own logic and says nothing about
 * whether the server accepts, orders, or deduplicates anything.
 *
 *   node codev/experiments/146-phase4-live/run.mjs [--scenarios 1,2,3,4,5]
 *
 * Environment:
 *   T3_LIVE_PORT      default 3820
 *   T3_LIVE_VERSION   default t3@0.0.35 (the pinned CLI)
 *   T3_LIVE_MODEL     default gpt-5.6-luna
 *   T3_LIVE_HARNESS   default codex
 *
 * Reuses Phase 3's `lib.mjs` rather than copying it: the server bootstrap, the
 * auth exchange and the three-state result vocabulary are the same problem, and a
 * second copy would drift.
 *
 * NOTE ON NODE: the pinned server needs `node:sqlite`, so node 20 cannot host it.
 * Run under node 22. Failing that way looks like a broken harness and is a wrong
 * interpreter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authenticate,
  connect,
  demonstrated,
  failed,
  notDemonstrated,
  shell,
  sleep,
  startServer,
} from '../146-phase3-live/lib.mjs';
import { DispatchJournal } from '../../../packages/porch-driver/dist/commands.js';
import { commandIdForKey, sendMessage } from '../../../packages/porch-driver/dist/deliver.js';
import { ThreadMessageQueue } from '../../../packages/porch-driver/dist/queue.js';
import { ScheduleStore, ScheduledDelivery } from '../../../packages/porch-driver/dist/scheduled.js';
import { DriverThread, createProject, createWorktree } from '../../../packages/porch-driver/dist/thread.js';
import { TurnTracker, asThreadEvent } from '../../../packages/porch-driver/dist/turn.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const port = Number(process.env.T3_LIVE_PORT ?? 3820);
const baseUrl = `http://127.0.0.1:${port}`;
const model = process.env.T3_LIVE_MODEL ?? 'gpt-5.6-luna';
const harnessName = process.env.T3_LIVE_HARNESS ?? 'codex';

const requested = (() => {
  const flag = process.argv.indexOf('--scenarios');
  if (flag === -1) return new Set(['1', '2', '3', '4', '5']);
  return new Set(process.argv[flag + 1].split(',').map((s) => s.trim()));
})();

const log = (...args) => console.log(new Date().toISOString(), ...args);
const scenarios = [];
const record = (result) => {
  scenarios.push(result);
  log(`[${result.scenario}] ${result.state}${result.note ? ` — ${result.note}` : ''}`);
};

function clientCommit() {
  try {
    return shell('git rev-parse HEAD', repoRoot);
  } catch {
    return null;
  }
}

function treeDirty() {
  try {
    // The harness is included, not just the code under test. An uncommitted change
    // to the measuring instrument makes the record just as unreproducible as an
    // uncommitted change to the driver, and this check previously covered only the
    // latter — so it could report a clean tree for a run nobody else could repeat.
    const scope = 'packages/porch-driver packages/t3-client codev/experiments/146-phase4-live';
    return shell(`git status --porcelain -- ${scope}`, repoRoot).length > 0;
  } catch {
    return null;
  }
}

/**
 * The user messages the server recorded for this thread, in sequence order.
 *
 * This is the ONLY honest way to check ordering: the server's own event log, not
 * the order the client believes it sent things in. A client-side list would pass
 * against a queue that reordered on the wire.
 */
function userMessagesFrom(events) {
  return events
    .filter((event) => event.type === 'thread.message-sent' && event.payload?.role === 'user')
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => String(event.payload?.text ?? ''));
}

async function main() {
  const server = await startServer({ port, log });
  const evidence = {
    criterion: 'Spec 146 success criterion 12b — the five delivery semantics',
    gates: 'Criterion 13 (mailbox deletion) depends on this. If any property fails, the mailbox stays.',
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
      title: 'Spec 146 Phase 4 live',
      workspaceRoot: server.seedRepo,
    });
    const worktree = await createWorktree(primary.dispatcher, {
      cwd: server.seedRepo,
      newRefName: `spec146-phase4-${Date.now()}`,
    });

    const thread = await DriverThread.create(
      { dispatcher: primary.dispatcher, journal, tracker },
      {
        projectId,
        title: 'phase 4 delivery thread',
        harnessName,
        model,
        worktreePath: worktree.path,
        branch: worktree.refName,
      },
    );
    log('thread', thread.threadId, 'driver', thread.driverKind);

    // One subscription, feeding the thread and a local record of every event. The
    // server's log is what the ordering assertions read.
    const seen = [];
    primary.client.stream(
      'orchestration.subscribeThread',
      { threadId: thread.threadId, requestCompletionMarker: true },
      (value) => {
        thread.observe(value);
        const event = asThreadEvent(value);
        if (event && event.aggregateId === thread.threadId) seen.push(event);
      },
    );
    await sleep(1_500);

    const ctx = { thread, journal, primary, seen, journalDir, baseUrl, auth, server };

    // QUIESCE BETWEEN SCENARIOS, because a message IS a turn.
    //
    // On this path `sendMessage` dispatches `thread.turn.start`, so scenario 1's
    // ten messages are ten TURNS the server runs one after another. Without a wait
    // the next scenario starts a turn behind that backlog, its own events do not
    // arrive, and the subscription idles out — which is exactly how the first full
    // run died, 300 s into a `subscribeThread` that was healthy and simply had
    // nothing to carry. Each scenario passes alone; only the sequence failed.
    const quiesce = async (label) => {
      const deadline = Date.now() + 240_000;
      while (thread.isTurnActive && Date.now() < deadline) await sleep(1_000);
      if (thread.isTurnActive) log(`[${label}] still active after 240s — continuing anyway`);
      await sleep(1_000);
    };

    if (requested.has('1')) {
      await scenarioOrdering(ctx);
      await quiesce('after 1');
    }
    if (requested.has('2')) {
      await scenarioQueuedDuringTurn(ctx);
      await quiesce('after 2');
    }
    if (requested.has('3')) {
      await scenarioDurableAck(ctx);
      await quiesce('after 3');
    }
    if (requested.has('4')) {
      await scenarioIdempotency(ctx);
      await quiesce('after 4');
    }
    if (requested.has('5')) await scenarioUnreachable(ctx);

    primary.close();
  } catch (error) {
    record(failed('harness', { note: String(error?.stack ?? error) }));
  } finally {
    evidence.limits = limits();
    const out = join(repoRoot, 'codev', 'research', '146-phase4-live-evidence.json');
    writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
    log('evidence written to', out);
    await server.stop();
  }

  const anyFailed = scenarios.some((s) => s.state === 'failed');
  process.exit(anyFailed ? 1 : 0);
  // Unreachable, but see `main().catch` below: the in-flight rejection that lands
  // as the sockets close is teardown noise, and it must not be able to crash the
  // process AFTER the evidence file is written. A run whose evidence is complete
  // and whose exit looks like a crash reports failure it did not have.
}

// ------------------------------------------------------------- 1: ordering

async function scenarioOrdering({ thread, journal, primary, seen }) {
  const name = '1: messages to one builder are delivered in the order sent';
  const tag = `ord-${Date.now()}`;
  try {
    const queue = new ThreadMessageQueue(
      () => ({ threadId: thread.threadId, isTurnActive: thread.isTurnActive }),
      primary.dispatcher,
      journal,
    );

    // CONCURRENT, not sequential. A sequential loop cannot produce the reordering
    // that matters and would pass against a queue with no ordering guarantee.
    const texts = Array.from({ length: 10 }, (_, i) => `${tag}-${i}`);
    await Promise.all(texts.map((text) => queue.send({ threadId: thread.threadId, text, idempotencyKey: text })));
    await queue.flush();
    await sleep(3_000);

    const arrived = userMessagesFrom(seen).filter((t) => t.startsWith(tag));
    record(
      arrived.length === texts.length && arrived.every((t, i) => t === texts[i])
        ? demonstrated(name, {
            sent: texts.length,
            arrived: arrived.length,
            order: 'exact',
            comparedAgainst: "the server's own event log, in sequence order",
            note: 'ten concurrent sends arrived in send order, checked against the server event log',
          })
        : failed(name, { expected: texts, arrived }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ------------------------------------------------- 2: queued during a turn

async function scenarioQueuedDuringTurn({ thread, journal, primary, seen }) {
  const name = '2: a message sent during an active turn is queued and delivered on settle';
  const tag = `q-${Date.now()}`;
  try {
    // `awaitSettle` is what lets the backlog drain at all: each queued message is a
    // turn, so without it the drain stops on the turn its own dispatch started.
    const queue = new ThreadMessageQueue(
      () => ({
        threadId: thread.threadId,
        isTurnActive: thread.isTurnActive,
        awaitSettle: async () => {
          const deadline = Date.now() + 120_000;
          while (thread.isTurnActive && Date.now() < deadline) await sleep(500);
        },
        // NOT WIRED HERE, DELIBERATELY, AND THE REASON IS RECORDED RATHER THAN THE
        // WIRING QUIETLY OMITTED.
        //
        // The queue supports `expectTurn` so the drain can wait on the turn its own
        // dispatch started instead of on `isTurnActive`, which is a projection and
        // lags behind the server. That closes a real race, and it is unit-tested.
        //
        // Wiring it to `tracker.expectTurn` here does NOT work against the live
        // server: `settled` resolves only after the turn is seen RUNNING, and for
        // these message-started turns it never resolved, so every message waited out
        // the drain's bound and scenario 2 failed twice at 300 s. The bound is what
        // keeps that from being a permanent stall, but a fallback firing on every
        // message is not a working signal.
        //
        // Why it never resolves is NOT diagnosed, and this comment does not pretend
        // otherwise. Until it is, this harness uses the settle poll that is actually
        // demonstrated, and the race stays closed only in the unit-tested path.
        // Phase 14 wires the production path and should settle this first.
      }),
      primary.dispatcher,
      journal,
    );

    const started = await thread.beginTurn('Count slowly from 1 to 20, one number per line. Do not use any tool.');
    await started.running;

    const texts = Array.from({ length: 10 }, (_, i) => `${tag}-${i}`);
    const receipts = await Promise.all(
      texts.map((text) => queue.send({ threadId: thread.threadId, text, idempotencyKey: text })),
    );

    // NOT INTERLEAVED: nothing reached the server while the turn was running.
    const duringTurn = userMessagesFrom(seen).filter((t) => t.startsWith(tag)).length;
    const allQueued = receipts.every((r) => r.kind === 'queued-by-porch');

    await started.settled;
    await queue.flush();

    // WAIT FOR ARRIVAL, do not sleep a guess.
    //
    // A fixed 3s wait was right when a queued message was a bare message. Under the
    // ruling that a message IS a turn, these ten drain as ten SEQUENTIAL turns, so
    // three seconds measured a half-finished backlog and reported the property
    // broken when it held: the first run recorded duringTurn 0 and allQueued true —
    // both correct — with 5 of 10 arrived. The assertion is unchanged and still
    // demands all ten in order; only the moment of measurement moved.
    const deadline = Date.now() + 300_000;
    let arrived = userMessagesFrom(seen).filter((t) => t.startsWith(tag));
    while (arrived.length < texts.length && Date.now() < deadline) {
      await sleep(2_000);
      arrived = userMessagesFrom(seen).filter((t) => t.startsWith(tag));
    }
    const ordered = arrived.length === texts.length && arrived.every((t, i) => t === texts[i]);

    record(
      duringTurn === 0 && allQueued && ordered
        ? demonstrated(name, {
            queuedDuringTurn: receipts.length,
            reachedServerDuringTurn: duringTurn,
            arrivedAfterSettle: arrived.length,
            order: 'exact',
            note:
              'ten messages sent during a live turn reached the server ZERO times before settle, ' +
              'then arrived in order — none lost, none interleaved',
          })
        : failed(name, { duringTurn, allQueued, arrived, expected: texts }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ------------------------------------------------------- 3: durable acknowledgement

async function scenarioDurableAck({ thread, journal, primary, seen, baseUrl, auth }) {
  const name = '3: the acknowledgement means the server accepted it durably';
  const key = `ack-${Date.now()}`;
  try {
    const receipt = await sendMessage(primary.dispatcher, journal, {
      threadId: thread.threadId,
      text: key,
      idempotencyKey: key,
    });

    // Durable means it survives a NEW connection reading the server's own log —
    // not that our socket saw a reply. So the check is made over a second
    // connection that was not involved in the send.
    const verifier = await connect(baseUrl, auth.accessToken);
    const replayed = [];
    verifier.client.stream(
      'orchestration.subscribeThread',
      { threadId: thread.threadId, afterSequence: 0, requestCompletionMarker: true },
      (value) => {
        const event = asThreadEvent(value);
        if (event && event.aggregateId === thread.threadId) replayed.push(event);
      },
    );
    await sleep(3_000);
    verifier.close();

    const onServer = userMessagesFrom(replayed).includes(key);
    record(
      receipt.kind === 'accepted-by-server' && onServer
        ? demonstrated(name, {
            receiptKind: receipt.kind,
            verifiedOver: 'a second connection replaying the thread from sequence 0',
            claimsAgentRead: false,
            note:
              'the receipt names server acceptance and nothing else; the message is in the ' +
              "server's log as read back by a connection that did not send it",
          })
        : failed(name, { receiptKind: receipt.kind, onServer }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ----------------------------------------------------------- 4: idempotency

async function scenarioIdempotency({ thread, journal, primary, seen }) {
  const name = '4: a retry under the same idempotency key delivers once';
  const key = `idem-${Date.now()}`;
  try {
    // Two INDEPENDENT journals, which is what a retry after a crash actually looks
    // like: the second process cannot consult the first one's local dedup, so the
    // server is the thing being tested. Sharing a journal would prove only that the
    // local short-circuit works.
    const firstJournal = new DispatchJournal(join(journal.path, '..', `idem-a-${Date.now()}.jsonl`));
    const secondJournal = new DispatchJournal(join(journal.path, '..', `idem-b-${Date.now()}.jsonl`));

    const a = await sendMessage(primary.dispatcher, firstJournal, {
      threadId: thread.threadId,
      text: key,
      idempotencyKey: key,
    });
    const b = await sendMessage(primary.dispatcher, secondJournal, {
      threadId: thread.threadId,
      text: key,
      idempotencyKey: key,
    });
    await sleep(3_000);

    const deliveries = userMessagesFrom(seen).filter((t) => t === key).length;
    record(
      deliveries === 1 && a.commandId === b.commandId && a.commandId === commandIdForKey(key)
        ? demonstrated(name, {
            sends: 2,
            deliveries,
            sharedCommandId: a.commandId,
            derivedFromKey: true,
            note:
              'the same key derived the same commandId from two independent journals, and the ' +
              "server's log holds exactly one delivery",
          })
        : failed(name, { deliveries, commandIds: [a.commandId, b.commandId] }),
    );
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

// ------------------------------------------------------------ 5: unreachable

async function scenarioUnreachable({ thread, journalDir, baseUrl, auth }) {
  const name = '5: with the server unreachable, a send fails loudly at the call site';
  try {
    const doomed = await connect(baseUrl, auth.accessToken, { requestTimeoutMs: 4_000 });
    const journal = new DispatchJournal(join(journalDir, `unreachable-${Date.now()}.jsonl`));
    const queue = new ThreadMessageQueue(
      () => ({ threadId: thread.threadId, isTurnActive: false }),
      doomed.dispatcher,
      journal,
    );

    // Cut the socket underneath the client. This is the unreachable case as it
    // actually happens, not a stubbed rejection.
    doomed.socket.close();
    await sleep(300);

    const started = Date.now();
    let raised = null;
    try {
      await queue.send({ threadId: thread.threadId, text: 'into the void', idempotencyKey: `void-${Date.now()}` });
    } catch (error) {
      raised = error;
    }
    const elapsed = Date.now() - started;

    record(
      raised && queue.depth === 0
        ? demonstrated(name, {
            raisedAtCallSite: true,
            errorName: raised.name,
            elapsedMs: elapsed,
            queueDepthAfter: queue.depth,
            silentlyQueued: false,
            note:
              'the send threw at the call site within a bounded time and nothing was left holding ' +
              "the message — the mailbox's hold-and-retry is deliberately not reproduced",
          })
        : failed(name, { raised: raised ? raised.name : null, queueDepth: queue.depth, elapsed }),
    );
    doomed.close();
  } catch (error) {
    record(failed(name, { note: String(error?.message ?? error) }));
  }
}

function limits() {
  return {
    scope:
      'One thread against one freshly created server. These scenarios establish the five ' +
      'delivery semantics of success criterion 12b and nothing beyond them.',
    scheduled:
      'Durable scheduled delivery is covered by unit tests against a real on-disk store with ' +
      'an injected clock, NOT here: the property is "a pre-due message survives a restart", and ' +
      'demonstrating it live would mean holding a server for the length of a real delay. The ' +
      'store is the same fsynced append-only shape as the dispatch journal, which IS exercised ' +
      'live in Phase 3 scenarios E and F.',
    ordering:
      'Ordering is checked against the server\'s own event log in sequence order, not against ' +
      'the order the client believes it sent. A client-side list would pass against a queue ' +
      'that reordered on the wire.',
    readReceipts:
      'No scenario claims the AGENT read anything. Criterion 12b is about the server accepting ' +
      'durably, and the receipt type is named so that the stronger claim cannot be made by ' +
      'accident.',
  };
}

/**
 * Teardown noise must not be able to report a failure the run did not have.
 *
 * Closing the sockets rejects whatever request was still in flight, and that
 * rejection lands AFTER the evidence file is written. Unhandled, it crashes node
 * with a stack trace on a run whose scenarios all passed — a result a reader would
 * reasonably record as a failed run. The evidence file is the verdict; this makes
 * the exit code agree with it.
 */
process.on('unhandledRejection', (reason) => {
  const name = reason?.name ?? '';
  if (name === 'NotConnectedError' || name === 'RequestTimeoutError') {
    log('teardown:', String(reason?.message ?? reason).split('\n')[0]);
    return;
  }
  throw reason;
});

await main();
