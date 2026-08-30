/**
 * Issue #241, live — a turn started through the production engine SETTLES.
 *
 * ## Why this test has to exist even though the unit suite is green
 *
 * Every in-memory test here scripts the stream itself, so all of them assert that
 * `thread.session-set` with `activeTurnId` going non-null then null clears the
 * record. None of them can assert that a real t3code server emits that, in that
 * order, on a real turn — and the whole issue is that production and the test
 * harness disagreed about what existed. A suite that only ever talks to itself is
 * how "the driver is correct" and "no turn ever settles" were both true at once.
 *
 * So this drives the real `createPorchThreadEngine`, over a real
 * `ThreadSubscriptionPool`, over a real socket to the pinned harness, and waits for
 * `record.activeTurnId` to come back to null on its own.
 *
 * ## The skip is named, never silent
 *
 * `T3_LIVE=1` on top of `T3_NODE`, so a configured interpreter alone cannot make the
 * default suite dispatch a paid provider turn. When it cannot run it says which
 * prerequisite is missing, in the vocabulary the phase-9 live tests already use: a
 * green suite absorbs an honest "could not check" exactly as completely as it
 * absorbs a pass.
 *
 * ## `T3_HARNESS_DIR`, WHICH COSTS TWO RUNS TO LEARN THE HARD WAY
 *
 * `tools/t3-server/t3-server.mjs:39` resolves its runtime directory as
 * `T3_HARNESS_DIR ?? <the script's own dir>/.runtime` — relative to the SCRIPT, and
 * every builder worktree carries its own copy of that script. So from
 * `.builders/<id>/` the harness looks in `.builders/<id>/tools/t3-server/.runtime`,
 * which is empty, while a server started from the main checkout is still answering on
 * port 3799. The harness then reports `printed no pairing token`, which reads as "the
 * server is broken" and is actually "I looked somewhere else".
 *
 * `harnessRuntimeStatus` below turns that into a named skip that says the variable's
 * name, because a wrong diagnosis delivered confidently is worse than a missing one.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createProject } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from '../porch-thread-engine.js';
import { createThreadSubscriptionPool } from '../thread-subscriptions.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harness)) return { ok: false, reason: `could not check: missing ${harness}` };
  try {
    execFileSync(process.execPath, [harness, 'verify'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (code === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: `could not check: verify failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * Whether the harness will look for its server where the server actually is.
 *
 * Checked BEFORE the run rather than inferred from its failure. Without this the
 * symptom is `printed no pairing token` from a harness that is working correctly,
 * against a server that is running correctly, and the reader is sent to look at both.
 */
function harnessRuntimeStatus(): { ok: boolean; reason: string } {
  const explicit = process.env.T3_HARNESS_DIR?.trim();
  if (explicit) {
    if (existsSync(explicit)) return { ok: true, reason: 'T3_HARNESS_DIR is set and exists' };
    return {
      ok: false,
      reason: `NO_HARNESS_RUNTIME: could not check: T3_HARNESS_DIR is set to ${explicit}, which does not exist.`,
    };
  }
  // The default the harness itself computes, from ITS OWN directory.
  const implied = join(repoRoot, 'tools', 't3-server', '.runtime');
  if (existsSync(implied)) return { ok: true, reason: 'the default runtime directory exists' };
  return {
    ok: false,
    reason:
      `NO_HARNESS_RUNTIME: could not check: T3_HARNESS_DIR is unset and ${implied} does not exist. `
      + `The harness resolves its runtime directory relative to its own script, and every builder `
      + `worktree carries a copy of that script — so from a worktree it looks here, finds nothing, `
      + `and reports "printed no pairing token" about a server that may be running fine somewhere `
      + `else. Set T3_HARNESS_DIR to the runtime directory of the checkout whose harness owns the `
      + `server (usually <main checkout>/tools/t3-server/.runtime).`,
  };
}

function runtimeStatus(): { ok: boolean; reason: string } {
  try {
    execFileSync(process.execPath, [harness, 'runtime'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'interpreter resolved' };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    const signal = stderr.split('\n').find((line) => /[A-Z_]+: could not check:/.test(line));
    return {
      ok: false,
      reason: signal?.replace(/^\[t3-server\] /, '')
        ?? 'RUNTIME_UNAVAILABLE: could not check: runtime command failed without a named signal',
    };
  }
}

describe('Issue #241 live — a turn settles through the production subscriber', () => {
  const status = harnessStatus();
  const runtime = runtimeStatus();
  const harnessRuntime = harnessRuntimeStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  const canRunLive = status.ok && runtime.ok && harnessRuntime.ok && liveOptIn;

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE + T3_HARNESS_DIR] the record activeTurnId returns to null on its own',
    async () => {
      execFileSync(process.execPath, [harness, 'stop'], { encoding: 'utf8', timeout: 30_000 });
      execFileSync(process.execPath, [harness, 'start'], { encoding: 'utf8', timeout: 60_000 });
      let readyOut = '';
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          readyOut = execFileSync(process.execPath, [harness, 'ready'], { encoding: 'utf8', timeout: 20_000 });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!readyOut.includes('{')) throw new Error('could not check: live server printed no ready JSON');
      const { token, port } = JSON.parse(readyOut.slice(readyOut.indexOf('{'))) as { token: string; port: number };

      const dir = mkdtempSync(join(tmpdir(), 'spec241-live-'));
      const worktreePath = join(dir, 'wt');
      mkdirSync(worktreePath);
      try {
        const { T3Client } = await import('../../../../t3-client/dist/client.js');
        const auth = await import('../../../../t3-client/dist/auth.js');
        const base = `http://127.0.0.1:${port}`;
        const access = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-241-live' });
        const ticket = await auth.issueWebSocketTicket(base, access.access_token);
        const socket = new WebSocket(auth.webSocketUrl(base, ticket.ticket));
        await new Promise<void>((res, rej) => {
          socket.addEventListener('open', () => res(), { once: true });
          socket.addEventListener('error', () => rej(new Error('socket error')), { once: true });
        });
        const client = new T3Client({
          send: (d: string) => socket.send(d),
          close: () => socket.close(),
          addEventListener: (t: string, l: (ev: unknown) => void) => socket.addEventListener(t, l as never),
          get readyState() {
            return socket.readyState;
          },
        });

        const dispatcher = { call: (method: string, payload: unknown) => client.call(method, payload) };
        const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
        const tracker = new TurnTracker();
        const projectId = await createProject(dispatcher, journal, { title: 'spec-241-live', workspaceRoot: dir });

        // ONE socket for commands and the subscription, exactly as Tower has it, so
        // the per-stream `close` this module relies on is exercised rather than
        // sidestepped by a second connection.
        let engine: ReturnType<typeof createPorchThreadEngine>;
        const pool = createThreadSubscriptionPool({
          subscriber: {
            stream: (method, payload, onValue, timeoutMs, onRequestId) =>
              client.stream(method, payload, onValue, timeoutMs, onRequestId),
            cancel: (requestId: number) => client.cancel(requestId),
          },
          workspaceRoot: dir,
          observe: (value) => engine.observe(value),
          log: () => {},
        });
        engine = createPorchThreadEngine({
          dispatcher,
          journal,
          tracker,
          projectId,
          workspaceRoot: dir,
          defaultHarness: 'codex',
          defaultModel: 'gpt-5.6-luna',
          subscriptions: pool,
        });

        const threadId = await engine.create({
          builderId: 'live-241',
          worktreePath,
          branch: 'builder/live-241',
        });
        // The subscription is up before any turn is dispatched. That ordering is the
        // point of the change, so it is asserted rather than assumed.
        expect(pool.attached(threadId)).toBe(true);

        const done = join(worktreePath, 'DONE');
        await engine.startTurn(threadId, `echo DONE > "${done}"`);
        const record = engine.get(threadId);
        expect(record).toBeDefined();
        expect(record!.activeTurnId).not.toBeNull();

        // THE CRITERION. Nothing pokes the record: it clears because a
        // `thread.session-set` with a null `activeTurnId` arrived on the subscription
        // after one with a non-null, and `TurnTracker` resolved the waiter. Before
        // this change it could not clear, because nothing was subscribed.
        const settleDeadline = Date.now() + 150_000;
        while (record!.activeTurnId !== null && Date.now() < settleDeadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (record!.activeTurnId !== null) {
          throw new Error(
            `TURN_DID_NOT_SETTLE: activeTurnId was still ${record!.activeTurnId} after 150000ms. ` +
              `This is the defect issue #241 reports, not a slow server: a settle that has not ` +
              `arrived and a settle that can never arrive are being spelled the same way here, and ` +
              `only the subscription can tell them apart.`,
          );
        }
        expect(existsSync(done)).toBe(true);

        // And the cursor is on disk, non-zero, which is what makes a Tower restart a
        // resume rather than a cold resubscribe.
        const cursor = readFileSync(pool.cursorPath(threadId), 'utf-8').trim();
        expect(Number(cursor)).toBeGreaterThan(0);

        pool.stopAll();
        socket.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
        execFileSync(process.execPath, [harness, 'stop'], { encoding: 'utf8', timeout: 30_000 });
      }
    },
    300_000,
  );

  it('records live readiness or the exact reason it could not check', () => {
    if (!status.ok) {
      expect(status.reason).toMatch(/^could not check:/);
      return;
    }
    if (!runtime.ok) {
      expect(runtime.reason).toMatch(/could not check:/);
      return;
    }
    if (!harnessRuntime.ok) {
      // Named, and it names the VARIABLE. The failure this replaces was the harness
      // reporting "printed no pairing token" while looking in a worktree's empty copy
      // of its own runtime directory.
      expect(harnessRuntime.reason).toMatch(/^NO_HARNESS_RUNTIME: could not check:/);
      expect(harnessRuntime.reason).toContain('T3_HARNESS_DIR');
      return;
    }
    expect(status.reason).toBe('verified');
    expect(runtime.reason).toBe('interpreter resolved');
    if (!liveOptIn) expect(process.env.T3_LIVE).not.toBe('1');
  });
});
