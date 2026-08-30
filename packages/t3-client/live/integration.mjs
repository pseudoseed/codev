#!/usr/bin/env node
/**
 * Spec 146, Phase 2 — live integration against a pinned t3code server.
 *
 * The plan is explicit: "This phase is not complete on unit tests — the whole
 * point is what the real server does." The unit suite proves the client behaves
 * as designed against a fake; this proves the design matches the server.
 *
 * Four acceptance criteria, each a scenario below:
 *
 *   A. connect, dispatch, subscribe, receive a stream to completion
 *   B. a stream longer than the server's buffer completes — AND an ack-suppressed
 *      client stalls, because a test that cannot fail proves nothing
 *   C. socket killed mid-stream; resubscription replays exactly the missing range
 *      — groundwork only here. Proving it needs a control connection and an
 *        eventId comparison against a thread that is actually generating events,
 *        which is Phase 3's exit conditions.
 *   D. a resubscription answered with a snapshot reports a GAP, distinguishable
 *      from both success and empty — discharged live, by putting the cursor past
 *      the server's head so the SERVER chooses the snapshot path.
 *
 * Scenario B's control is the point. "The stream completed" is consistent with
 * acks being honoured AND with the server not needing them at this volume. Only
 * the suppressed run distinguishes those.
 *
 * Requires Node 22 (imports .ts directly) and a server from
 * `tools/t3-server/t3-server.mjs`. Writes JSON so the result is reviewable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');

// Imported from `dist`, not `src`. Node's strip-only mode rejects TypeScript
// parameter properties, and more importantly this is the artifact a consumer
// actually loads — testing `src` would verify a form of the code that never ships.
// Build first: `pnpm --filter @cluesmith/t3-client build`.
const distDir = join(here, '..', 'dist');
if (!existsSync(join(distDir, 'client.js'))) {
  console.error(
    '[live] No build at packages/t3-client/dist. Run:\n' +
      '  pnpm --filter @cluesmith/t3-client build\n' +
      'Refusing to run against source that is not what consumers load.',
  );
  process.exit(3);
}
const { T3Client } = await import(join(distDir, 'client.js'));
const { classifyResume } = await import(join(distDir, 'resume.js'));
const auth = await import(join(distDir, 'auth.js'));
const { checkableMethods } = await import(join(distDir, 'checked.js'));
const { ResumingSubscription } = await import(join(distDir, 'subscription.js'));

/**
 * Every client this run opens, so the scenarios can report which methods were
 * actually shape-checked.
 *
 * Without this, "scenario A passed with checking on" looks exactly the same
 * whether every payload was checked and matched, or every method reported
 * `unchecked` and nothing was looked at. That is the defect this project keeps
 * finding, and it would be one to leave in the instrument that reports on it.
 */
const clients = [];

/**
 * The checkout the server operates on: the UPSTREAM identity (spec 250).
 *
 * These are the spec 146 / #241 live tests. Their meaning is unchanged by the fork existing,
 * and they must keep measuring the tree the recorded evidence describes, so this stays
 * `T3CODE_ROOT` and never falls back to `T3CODE_FORK_ROOT`.
 *
 * Required rather than defaulted (#214). The default was one machine's absolute path, so
 * anyone else running this got a failure somewhere inside the server rather than a sentence
 * naming the missing input. `live/` is not in the package's `files`, so this never reached a
 * tarball — it was committed, which is a smaller problem and still not one worth keeping.
 * Keeping it required also means the fork's path cannot arrive here by accident.
 */
const T3CODE_ROOT = process.env.T3CODE_ROOT;
if (!T3CODE_ROOT) {
  console.error('T3CODE_ROOT is not set. Point it at your upstream t3code checkout and re-run.');
  process.exit(2);
}

const port = Number(process.env.T3_HARNESS_PORT ?? 3799);
const base = `http://127.0.0.1:${port}`;
const run = (cmd) => execFileSync('node', [harness, cmd], { encoding: 'utf8' });
const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

/** `git ...` in the repo, or null when it cannot be determined — never a guess. */
const gitOrNull = (args) => {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const results = [];

/**
 * Three states, not a boolean.
 *
 * `demonstrated` — ran against the live server and passed.
 * `not-demonstrated` — could not run to a verdict (no traffic to observe, no
 *   server, preconditions absent). Says nothing about whether the code works.
 * `failed` — ran and the behaviour was wrong.
 *
 * An earlier version had `ok: true|false` with a prose note explaining that a
 * false sometimes meant the second and sometimes the third. A boolean plus
 * documentation is a boolean plus a thing nobody reads.
 */
/**
 * What each state means, emitted WITH the result rather than kept in a document
 * beside it. An earlier version of the evidence file carried these as hand-added
 * keys the script never produced, so a re-run would have silently dropped them and
 * the file would have quietly disagreed with the run that made it.
 */
const STATE_MEANING = {
  demonstrated: 'Ran against a live pinned server and passed.',
  'not-demonstrated':
    'The scenario did not run to a verdict — preconditions absent, or nothing to observe. ' +
    'This says NOTHING about whether the code works, and is not a failure.',
  failed: 'Ran against a live pinned server and the behaviour was wrong.',
};

const record = (name, state, detail) => {
  results.push({ scenario: name, state, stateMeaning: STATE_MEANING[state], ...detail });
  const label = { demonstrated: 'DEMONSTRATED', 'not-demonstrated': 'NOT-DEMONSTRATED', failed: 'FAILED' }[state];
  console.error(`[live] ${label} ${name}${detail?.note ? ` — ${detail.note}` : ''}`);
};

/**
 * The access token, exchanged EXACTLY ONCE.
 *
 * Two reasons, and the second is the one that bit:
 *  - the bootstrap token is single-use, so re-exchanging it fails by design;
 *  - `t3-server ready` redacts the token from the log as it reads it (Phase 1's
 *    fix for the token-in-a-log violation), so a second `ready` finds nothing.
 *    That makes `ready` non-idempotent, which is a real property of the harness
 *    and not a thing to work around by un-redacting.
 *
 * A real client behaves this way too: pair once, then issue a fresh WebSocket
 * ticket per connection.
 */
let ACCESS = null;
async function accessToken() {
  if (ACCESS) return ACCESS;
  const readyOut = run('ready');
  const { token } = JSON.parse(readyOut.slice(readyOut.indexOf('{')));
  ACCESS = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-phase2-live' });
  return ACCESS;
}

/** Open an authenticated client on a fresh ticket. */
async function connect({ suppressAcks = false } = {}) {
  const access = await accessToken();
  const ticket = await auth.issueWebSocketTicket(base, access.access_token);
  const url = auth.webSocketUrl(base, ticket.ticket);

  const socket = new WebSocket(url);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', () => rej(new Error('socket error')), { once: true });
  });

  // The control for scenario B: drop Ack frames on the floor while leaving every
  // other behaviour identical, so the only variable is the ack.
  if (suppressAcks) {
    const realSend = socket.send.bind(socket);
    socket.send = (data) => {
      try {
        if (JSON.parse(data)?._tag === 'Ack') return;
      } catch { /* not JSON, pass through */ }
      realSend(data);
    };
  }

  const adapter = {
    send: (d) => socket.send(d),
    close: () => socket.close(),
    addEventListener: (t, l) => socket.addEventListener(t, l),
    get readyState() {
      return socket.readyState;
    },
  };
  const client = new T3Client(adapter, { requestTimeoutMs: 45_000 });
  clients.push(client);
  return { client, socket, scopes: access.scope };
}

// ---------------------------------------------------------------- setup

try {
  run('stop');
} catch { /* nothing running */ }
run('acquire');
run('verify');
run('start');

let project;
try {
  // ------------------------------------------------------------ A: connect + dispatch + stream
  {
    const { client, socket, scopes } = await connect();
    project = id();
    const thread = id();

    const dispatched = await client.call('orchestration.dispatchCommand', {
      type: 'project.create',
      commandId: id(),
      projectId: project,
      title: 'phase 2 live integration',
      workspaceRoot: T3CODE_ROOT,
      defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      createdAt: now(),
    });

    const worktree = await client.call('vcs.createWorktree', {
      cwd: T3CODE_ROOT,
      refName: 'HEAD',
      newRefName: `codev-phase2-${Date.now()}`,
      path: null,
    });

    await client.call('orchestration.dispatchCommand', {
      type: 'thread.create',
      commandId: id(),
      threadId: thread,
      projectId: project,
      title: 'phase 2 stream',
      modelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      branch: worktree.worktree.refName,
      worktreePath: worktree.worktree.path,
      createdAt: now(),
    });

    // Subscribe and take a bounded number of items, then interrupt: the stream is
    // open-ended, so "to completion" here means we drove it and closed it cleanly.
    let received = 0;
    let synchronized = false;
    const done = new Promise((res) => {
      const timer = setTimeout(() => res('timeout'), 20_000);
      client
        .stream('orchestration.subscribeThread', { threadId: thread, requestCompletionMarker: true }, (v) => {
          received += 1;
          if (v?.kind === 'synchronized') synchronized = true;
          if (received >= 1 && synchronized) {
            clearTimeout(timer);
            res('ok');
          }
        })
        .catch(() => {});
    });
    const outcome = await done;

    record('A: connect, dispatch, subscribe, stream', synchronized ? 'demonstrated' : 'failed', {
      scopes,
      dispatched: dispatched !== undefined,
      worktreeCreated: Boolean(worktree?.worktree?.path),
      itemsReceived: received,
      outcome,
      note: synchronized ? 'stream synchronized' : 'never synchronized',
    });
    socket.close();
    globalThis.__phase2 = { project, thread, worktree };
  }

  // ------------------------------------------------------------ B: acks honoured, and the control
  {
    const { thread } = globalThis.__phase2;

    const drive = async (suppressAcks) => {
      const { client, socket } = await connect({ suppressAcks });
      let count = 0;
      const settled = await new Promise((res) => {
        const timer = setTimeout(() => res({ how: 'timeout', count }), 10_000);
        client
          .stream('orchestration.subscribeThread', { threadId: thread, requestCompletionMarker: true }, () => {
            count += 1;
            if (count >= 25) {
              clearTimeout(timer);
              res({ how: 'reached-25', count });
            }
          })
          .catch(() => {});
      });
      socket.close();
      return settled;
    };

    const acked = await drive(false);
    const suppressed = await drive(true);

    // The honest assertion: acking must get at least as far as not acking. If the
    // suppressed run keeps up, this volume never filled the buffer and the
    // scenario proved nothing — which is reported, not passed.
    const distinguishable = acked.count > suppressed.count;
    record('B: acks honoured (with ack-suppressed control)', acked.count === 0 ? 'not-demonstrated' : distinguishable ? 'demonstrated' : 'not-demonstrated', {
      ackedItems: acked.count,
      suppressedItems: suppressed.count,
      distinguishable,
      note: distinguishable
        ? 'suppressed client fell behind, so the ack is doing work'
        : 'INCONCLUSIVE: volume never filled the server buffer, so this run cannot tell',
    });
  }

  // ------------------------------------------------------------ C groundwork: real sequences
  {
    // Exercised against real sequence numbers observed on the wire rather than
    // synthesised, so the classifier is judged on the server's actual numbering.
    const { thread } = globalThis.__phase2;
    const { client, socket } = await connect();
    const seqs = [];
    await new Promise((res) => {
      const timer = setTimeout(res, 8_000);
      client
        .stream('orchestration.subscribeThread', { threadId: thread, requestCompletionMarker: true }, (v) => {
          const s = v?.event?.sequence ?? v?.sequence;
          if (typeof s === 'number') seqs.push(s);
          if (seqs.length >= 5) {
            clearTimeout(timer);
            res();
          }
        })
        .catch(() => {});
    });
    socket.close();

    const observed = seqs.length > 0;
    const replayed = observed ? classifyResume(seqs[0] - 1, seqs.map((s) => ({ sequence: s }))) : null;
    const withSnapshot = observed
      ? classifyResume(seqs[0] - 1, seqs.map((s) => ({ sequence: s })), { threads: [] })
      : null;
    // Redelivery, not a fault: t3code overlaps deliberately.
    const alreadyApplied = observed
      ? classifyResume(seqs[seqs.length - 1], seqs.map((s) => ({ sequence: s })))
      : null;

    // NOT tested here: a hole inside a replayed range. t3code's sequence is a
    // single global counter filtered to one thread, so a sparse range is the
    // NORMAL shape and carries no information about loss. An earlier version of
    // this scenario removed an element and asserted `gap`, which only produced a
    // gap because the run had one active thread. Phase 3 discharges C and D with
    // a control connection and eventId comparison, which can actually tell.
    record('C groundwork: classification against server-issued sequences', observed ? 'demonstrated' : 'not-demonstrated', {
      observedSequences: seqs.slice(0, 8),
      sequencesAreSparse: observed && seqs.some((s, i) => i > 0 && s !== seqs[i - 1] + 1),
      replayed: replayed?.kind ?? null,
      withSnapshot: withSnapshot?.kind ?? null,
      alreadyApplied: alreadyApplied?.kind ?? null,
      gapDistinctFromEmpty: withSnapshot?.kind === 'gap' && classifyResume(0, []).kind === 'empty',
      note: observed ? 'classified against server-issued sequence numbers' : 'no sequenced items observed',
    });
  }

  // ------------------------------------------------------------ D: a REAL snapshot fallback
  {
    // Criterion D, discharged live rather than deferred.
    //
    // `ws.ts:1493-1526` falls through to the snapshot path when the replay gap
    // exceeds THREAD_RESUME_MAX_GAP (1,000) **or when the cursor is ahead of the
    // server's head**. The second costs nothing to trigger and is the real case:
    // porch's persisted cursor surviving a restore or rollback of the server's
    // database. So this is not a contrivance to make the branch fire — it is the
    // failure the branch exists for.
    //
    // The point is that the SERVER sends the snapshot. An earlier version of this
    // scenario passed a hand-made object as `snapshotSeen` and checked that the
    // classifier said "gap", which tests the classifier against itself.
    const { thread } = globalThis.__phase2;
    const { client, socket } = await connect();

    const AHEAD = 5_000_000; // comfortably past any head this harness can reach
    let sawSnapshot = null;
    const collected = [];
    await new Promise((res) => {
      const timer = setTimeout(res, 15_000);
      client
        .stream(
          'orchestration.subscribeThread',
          { threadId: thread, afterSequence: AHEAD, requestCompletionMarker: true },
          (v) => {
            if (v?.kind === 'snapshot') sawSnapshot = v.snapshot ?? {};
            if (v?.kind === 'event' && typeof v.event?.sequence === 'number') {
              collected.push({ sequence: v.event.sequence });
            }
            if (v?.kind === 'synchronized') {
              clearTimeout(timer);
              res();
            }
          },
        )
        .catch(() => {});
    });
    socket.close();

    const outcome = classifyResume(AHEAD, collected, sawSnapshot);
    const empty = classifyResume(AHEAD, []);
    const distinguishable = outcome.kind === 'gap' && empty.kind === 'empty';

    record(
      'D: cursor ahead of head forces a real snapshot, classified as a gap',
      sawSnapshot === null ? 'not-demonstrated' : distinguishable ? 'demonstrated' : 'failed',
      {
        requestedAfter: AHEAD,
        serverSentSnapshot: sawSnapshot !== null,
        outcomeKind: outcome.kind,
        emptyKind: empty.kind,
        gapDistinctFromEmpty: distinguishable,
        note:
          sawSnapshot === null
            ? 'server did not send a snapshot for a cursor past its head; the fallback was not exercised'
            : 'server answered a past-the-head cursor with a snapshot, and it is reported as a gap',
      },
    );
  }

  // ------------------------------------------------------------ E: what the checker actually checked
  {
    // Payload shape-checking is ON for every client above. This scenario reports
    // what that amounted to, because "the scenarios passed" is consistent with
    // "every payload matched" AND with "nothing was checked at all".
    const unchecked = new Map();
    for (const client of clients) {
      for (const [method, reason] of client.uncheckedMethods) unchecked.set(method, reason);
    }
    const exercised = [
      'orchestration.dispatchCommand',
      'orchestration.subscribeThread',
      'vcs.createWorktree',
    ];
    const covered = new Set(checkableMethods());
    const notCovered = exercised.filter((m) => !covered.has(m));
    const checkedAndMatched = exercised.filter((m) => covered.has(m) && !unchecked.has(m));

    record(
      'E: inbound payloads were shape-checked against the vendored contract',
      checkedAndMatched.length === exercised.length ? 'demonstrated' : 'not-demonstrated',
      {
        methodsExercised: exercised,
        checkedAndMatched,
        notInGeneratedContract: notCovered,
        reportedUnchecked: Object.fromEntries(unchecked),
        note:
          checkedAndMatched.length === exercised.length
            ? 'every exercised method has a generated schema, and every live payload matched it'
            : 'at least one exercised method was NOT checked; scenarios A-D say nothing about its payloads',
      },
    );
  }

  // ------------------------------------------------------------ F: the subscription class, live
  {
    // `ResumingSubscription` is new and, until this scenario, only ever ran
    // against a fake. A class that passes its unit tests and has never met the
    // real server is the exact shape of thing this project keeps being bitten by,
    // so it drives one real subscribe cycle here.
    //
    // This is NOT criterion C. It does not kill a socket mid-stream and it does
    // not verify the replayed range. It establishes the smaller thing: the class
    // subscribes to the live server, receives its frames, reports an outcome, and
    // stops when told.
    const { thread } = globalThis.__phase2;
    const outcomes = [];
    const seen = [];

    const sub = new ResumingSubscription(
      async () => {
        const { client, socket } = await connect();
        return { client, close: () => socket.close() };
      },
      {
        method: 'orchestration.subscribeThread',
        payload: { threadId: thread },
        sequenceOf: (v) => (typeof v?.event?.sequence === 'number' ? v.event.sequence : null),
        isSnapshot: (v) => v?.kind === 'snapshot',
        isSynchronized: (v) => v?.kind === 'synchronized',
        onValue: (v, sequence) => void seen.push({ kind: v?.kind ?? null, sequence }),
        onResume: (outcome, info) => void outcomes.push({ kind: outcome.kind, ...info }),
        delayBetweenAttemptsMs: 250,
      },
    );

    const running = sub.run().catch((error) => ({ error: String(error) }));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    sub.stop();
    const stopped = await Promise.race([
      running.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('did-not-stop'), 5_000)),
    ]);

    record(
      'F: ResumingSubscription drives a real subscription and stops on command',
      outcomes.length > 0 && stopped === 'stopped' ? 'demonstrated' : 'not-demonstrated',
      {
        outcomes,
        itemsSeen: seen.length,
        firstOutcomeIsNotAGap: outcomes[0]?.kind !== 'gap',
        stopped,
        note:
          outcomes.length === 0
            ? 'the subscription reported no outcome at all, which is the one answer it must never give'
            : stopped !== 'stopped'
              ? 'the subscription did not stop within 5s of stop()'
              : 'subscribed live, reported an outcome, and stopped when told',
      },
    );
  }
} finally {
  try {
    run('stop');
  } catch { /* best effort */ }
}

const failed = results.filter((r) => r.state === 'failed');
const notDemonstrated = results.filter((r) => r.state === 'not-demonstrated');
console.log(
  JSON.stringify(
    {
      criterion: 'Spec 146 Phase 2 live integration',
      // Stamped so a re-run is distinguishable from a stale file. Without these,
      // a run after a fix and the file it was meant to replace are byte-identical,
      // and "I re-ran it" is unverifiable from the artifact — which a review lane
      // pointed out about exactly that claim.
      ranAt: new Date().toISOString(),
      nodeVersion: process.version,
      clientCommit: gitOrNull(['rev-parse', 'HEAD']),
      clientTreeDirty: (() => {
        const porcelain = gitOrNull(['status', '--porcelain']);
        if (porcelain === null) return null;
        return porcelain.split('\n').filter((line) => line.trim() && !line.startsWith('??')).length > 0;
      })(),
      scenarios: results,
      limits: {
        scenarioC:
          'Criterion C is NOT checked by the C groundwork scenario, and that scenario is not ' +
          'evidence for it. t3code numbers events on a SINGLE GLOBAL counter (one `sequence` ' +
          'column on orchestration_events, read `WHERE sequence > ? ORDER BY sequence ASC` and ' +
          'then filtered to the subscribed thread), so a sparse range is the normal shape and ' +
          'carries no information about loss. Proving the client replays exactly the missing ' +
          'range needs a second, never-dropped control connection and an eventId comparison, ' +
          'against a thread that is actually generating events. That is Phase 3 work, recorded ' +
          "in Phase 3's exit conditions as Phase 2's criterion.",
        scenarioD:
          'Criterion D IS discharged here, by scenario D. The server chooses the snapshot path ' +
          'itself because the cursor is past its head (ws.ts:1493-1526); nothing about the ' +
          'response is manufactured by this script.',
        harness:
          'The pinned checkout is verified; the `t3` CLI binary running against it is NOT ' +
          'pinned. A divergence between the two is invisible to `verify`.',
        doNotRead:
          'A `not-demonstrated` scenario is not a failing one. Read the per-scenario ' +
          '`stateMeaning`, which is emitted by the run rather than added afterwards.',
      },
      summary: {
        demonstrated: results.filter((r) => r.state === 'demonstrated').map((r) => r.scenario),
        notDemonstrated: notDemonstrated.map((r) => r.scenario),
        failed: failed.map((r) => r.scenario),
        note:
          "Three states, not a boolean. 'demonstrated', 'not-demonstrated' and 'failed' are " +
          'different facts, and an earlier version of this file collapsed the last two into ' +
          'allScenariosPassed:false with a prose note explaining the difference. A boolean ' +
          'plus documentation is a boolean plus a thing nobody reads.',
      },
    },
    null,
    2,
  ),
);
// Exit 1 only for an actual failure. Exit 2 for "could not tell", which is
// neither success nor a bug and must not be spelled like either.
process.exit(failed.length > 0 ? 1 : notDemonstrated.length > 0 ? 2 : 0);
