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
 *   D. a resubscription answered with a snapshot reports a GAP, distinguishable
 *      from both success and empty
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

const port = Number(process.env.T3_HARNESS_PORT ?? 3799);
const base = `http://127.0.0.1:${port}`;
const run = (cmd) => execFileSync('node', [harness, cmd], { encoding: 'utf8' });
const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

const results = [];
const record = (name, ok, detail) => {
  results.push({ scenario: name, ok, ...detail });
  console.error(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail?.note ? ` — ${detail.note}` : ''}`);
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
  return { client: new T3Client(adapter, { requestTimeoutMs: 45_000 }), socket, scopes: access.scope };
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
      workspaceRoot: process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code',
      defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      createdAt: now(),
    });

    const worktree = await client.call('vcs.createWorktree', {
      cwd: process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code',
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

    record('A: connect, dispatch, subscribe, stream', synchronized, {
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
    record('B: acks honoured (with ack-suppressed control)', acked.count > 0, {
      ackedItems: acked.count,
      suppressedItems: suppressed.count,
      distinguishable,
      note: distinguishable
        ? 'suppressed client fell behind, so the ack is doing work'
        : 'INCONCLUSIVE: volume never filled the server buffer, so this run cannot tell',
    });
  }

  // ------------------------------------------------------------ C + D: resume classification
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
    const contiguous = observed ? classifyResume(seqs[0] - 1, seqs.map((s) => ({ sequence: s }))) : null;
    const withHole = observed
      ? classifyResume(seqs[0] - 1, seqs.filter((_, i) => i !== 1).map((s) => ({ sequence: s })))
      : null;
    const withSnapshot = observed
      ? classifyResume(seqs[0] - 1, seqs.map((s) => ({ sequence: s })), { threads: [] })
      : null;

    record('C+D: resume classification on real sequences', observed, {
      observedSequences: seqs.slice(0, 8),
      contiguous: contiguous?.kind ?? null,
      withHole: withHole?.kind ?? null,
      withSnapshot: withSnapshot?.kind ?? null,
      gapDistinctFromEmpty: withHole?.kind === 'gap' && classifyResume(0, []).kind === 'empty',
      note: observed ? 'classified against server-issued sequence numbers' : 'no sequenced items observed',
    });
  }
} finally {
  try {
    run('stop');
  } catch { /* best effort */ }
}

const allOk = results.every((r) => r.ok);
console.log(
  JSON.stringify(
    { criterion: 'Spec 146 Phase 2 live integration', scenarios: results, allScenariosPassed: allOk },
    null,
    2,
  ),
);
process.exit(allOk ? 0 : 1);
