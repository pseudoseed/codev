/**
 * Issue #219 — #179 items 3 and 4, run live against the pinned t3code server.
 *
 *   item 3: an architect is a thread whose worktree is the workspace root.
 *   item 4: an architect thread survives a server restart and resumes with context.
 *
 * WHY THIS CANNOT BE AN IN-MEMORY TEST
 *
 * Both criteria are claims about a server. The in-memory engine records whatever
 * it is handed and validates nothing, so it answered "yes" to item 3 while the
 * real server refused every architect thread `createArchitectThread` asked for —
 * `thread.create` types `branch` as `NullOr(TrimmedNonEmptyString)` and codev's
 * architect says "no branch" with `''`. An in-memory pass is not evidence here.
 *
 * WHAT COUNTS AS OBSERVING EACH CRITERION
 *
 * Item 3 is read from the SERVER's own record of the thread
 * (`orchestration.subscribeShell`), not from the engine's local map. The map is a
 * copy of the input; the snapshot is what the server stored.
 *
 * Item 4 is a codeword that exists only in the pre-restart conversation. A thread
 * that comes back and cannot produce it has reconnected, not resumed, and this
 * test reports that as its own failure rather than as a pass. Three outcomes are
 * kept apart: the turn produced the codeword (met), the turn produced something
 * else (not met), and the turn never ran (COULD_NOT_TELL — the criterion was not
 * evaluated).
 *
 * THE RESTART IS A RESTART
 *
 * `stop` then `start` would wipe the data dir and delete the thread, reporting the
 * harness's own erasure as the criterion failing. `t3-server.mjs restart` keeps
 * the data dir, and refuses with exit 3 when there is none to keep.
 *
 * RUNNING IT
 *
 *   pnpm --filter @cluesmith/codev-types build
 *   pnpm --filter @cluesmith/t3-client build
 *   pnpm --filter @cluesmith/porch-driver build
 *   pnpm --filter @cluesmith/codev build
 *   T3_NODE=/absolute/path/to/node T3_HARNESS_PORT=3801 T3_LIVE=1 \
 *     pnpm --filter @cluesmith/codev exec vitest run \
 *     src/agent-farm/__tests__/spec-146-phase-9-live-architect-thread.test.ts
 *
 * It starts, restarts and stops a server on `T3_HARNESS_PORT`. Point it at a port
 * nobody else is using — it will take down whatever the harness owns there.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createProject } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harnessPath = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harnessPath)) {
    return { ok: false, reason: `could not check: missing ${harnessPath}` };
  }
  try {
    execFileSync(process.execPath, [harnessPath, 'verify'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const errCode = (err as { status?: number }).status;
    if (errCode === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (errCode === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: `could not check: verify failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

function runtimeStatus(): { ok: boolean; reason: string } {
  try {
    execFileSync(process.execPath, [harnessPath, 'runtime'], { encoding: 'utf8', timeout: 15_000 });
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

function harness(command: string, timeoutMs: number): string {
  return execFileSync(process.execPath, [harnessPath, command], { encoding: 'utf8', timeout: timeoutMs });
}

/** Bring the server to answering, and read the pairing token it printed. */
async function readyDetails(): Promise<{ port: number; token: string }> {
  let out = '';
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      out = harness('ready', 30_000);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!out.includes('{')) {
    throw new Error('COULD_NOT_TELL: READY_TIMEOUT — the live server printed no ready JSON.');
  }
  return JSON.parse(out.slice(out.indexOf('{'))) as { port: number; token: string };
}

interface Connection {
  readonly dispatcher: { call: (m: string, p: unknown) => Promise<unknown> };
  shellThreads(): Promise<ReadonlyArray<Record<string, unknown>>>;
  close(): void;
}

/**
 * One authenticated connection.
 *
 * A fresh one per server lifetime, because the harness surfaces a pairing token
 * once per start and a pairing grant is one-time — the constraint documented on
 * `ThreadBackendConfig.bootstrapToken`.
 */
async function connect(port: number, token: string): Promise<Connection> {
  const { T3Client } = await import('../../../../t3-client/dist/client.js');
  const auth = await import('../../../../t3-client/dist/auth.js');
  const base = `http://127.0.0.1:${port}`;
  const access = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-air-219' });
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
  return {
    dispatcher: { call: (method: string, payload: unknown) => client.call(method, payload) },
    // The subscription never exits, so this takes the first snapshot frame and
    // leaves the stream to be torn down with the socket.
    async shellThreads() {
      const snapshot = await new Promise<{ threads: ReadonlyArray<Record<string, unknown>> }>((res, rej) => {
        let settled = false;
        void client
          .stream('orchestration.subscribeShell', {}, (value: unknown) => {
            const frame = value as { kind?: string; snapshot?: { threads: ReadonlyArray<Record<string, unknown>> } };
            if (!settled && frame?.kind === 'snapshot' && frame.snapshot) {
              settled = true;
              res(frame.snapshot);
            }
          }, 60_000)
          .catch((err: unknown) => {
            if (!settled) rej(err);
          });
      });
      return snapshot.threads;
    },
    close: () => socket.close(),
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return existsSync(path);
}

describe('Spec 146 Phase 9 — #179 items 3 and 4 against the pinned server', () => {
  const status = harnessStatus();
  const runtime = runtimeStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  const canRunLive = status.ok && runtime.ok && liveOptIn;

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE] an architect thread is rooted at the workspace and resumes with context across a server restart',
    async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'air-219-ws-'));
      const codeword = `ZEBRA-${randomUUID().slice(0, 8).toUpperCase()}`;
      const ack = join(workspaceRoot, 'ack.txt');
      const recall = join(workspaceRoot, 'recall.txt');
      let first: Connection | undefined;
      let second: Connection | undefined;

      try {
        // A cold start, so the thread observed below is one this run created.
        try {
          harness('stop', 30_000);
        } catch {
          /* nothing running is fine; `stop` refuses only what it does not own */
        }
        harness('start', 120_000);
        const { port, token } = await readyDetails();

        // ── Item 3 ────────────────────────────────────────────────────────────
        first = await connect(port, token);
        const journal = new DispatchJournal(join(workspaceRoot, 'commands.jsonl'));
        const projectId = await createProject(first.dispatcher, journal, {
          title: 'air-219-architect',
          workspaceRoot,
        });
        const engine = createPorchThreadEngine({
          dispatcher: first.dispatcher,
          journal,
          tracker: new TurnTracker(),
          projectId,
          workspaceRoot,
          defaultHarness: 'codex',
          defaultModel: 'gpt-5.6-luna',
        });
        // The shape `createArchitectThread` produces: the workspace root as the
        // worktree, and no branch.
        const threadId = await engine.create({
          builderId: 'architect-air219',
          worktreePath: workspaceRoot,
          branch: '',
          role: 'architect',
        });

        const beforeThreads = await first.shellThreads();
        const beforeRecord = beforeThreads.find((t) => t.id === threadId);
        expect(beforeRecord, 'item 3: the server has no record of the architect thread').toBeDefined();
        // From the server's own snapshot, not the engine's copy of its input.
        expect(beforeRecord!.worktreePath, 'item 3: the architect thread is not rooted at the workspace root').toBe(
          workspaceRoot,
        );

        // ── Item 4, first half: give the thread something only it can know ────
        await engine.startTurn(
          threadId,
          `Remember this codeword for later in our conversation: ${codeword}. `
          + `Do not write it to any file yet. To confirm you have it, run this shell command now: `
          + `echo ok > ${ack}`,
        );
        if (!(await waitForFile(ack, 300_000))) {
          throw new Error(
            'COULD_NOT_TELL: FIRST_TURN_TIMEOUT — the pre-restart turn never ran, so nothing was '
            + 'established for the restart to preserve. Item 4 was NOT evaluated.',
          );
        }
        first.close();
        first = undefined;

        // ── The restart ───────────────────────────────────────────────────────
        // Data dir preserved. `stop` + `start` would delete the thread and the
        // result would read as item 4 failing.
        harness('restart', 120_000);
        const after = await readyDetails();
        second = await connect(after.port, after.token);

        const afterThreads = await second.shellThreads();
        const afterRecord = afterThreads.find((t) => t.id === threadId);
        expect(afterRecord, 'item 4: the thread did not survive the server restart').toBeDefined();
        expect(afterRecord!.worktreePath, 'item 4: the surviving thread lost its worktree').toBe(workspaceRoot);

        // ── Item 4, second half: does it still know? ──────────────────────────
        const resumedEngine = createPorchThreadEngine({
          dispatcher: second.dispatcher,
          journal: new DispatchJournal(join(workspaceRoot, 'commands-after.jsonl')),
          tracker: new TurnTracker(),
          projectId: String(afterRecord!.projectId ?? projectId),
          workspaceRoot,
          defaultHarness: 'codex',
          defaultModel: 'gpt-5.6-luna',
        });
        // A fresh process's engine has never heard of this thread. `attach`, not
        // `create`: creating would mint a second thread and prove nothing.
        await resumedEngine.attach({
          threadId,
          worktreePath: workspaceRoot,
          branch: '',
          builderId: 'architect-air219',
        });
        await resumedEngine.startTurn(
          threadId,
          `Write the codeword I asked you to remember earlier to ${recall} — only the codeword, `
          + `nothing else. Use the shell.`,
        );
        if (!(await waitForFile(recall, 300_000))) {
          throw new Error(
            'COULD_NOT_TELL: SECOND_TURN_TIMEOUT — the post-restart turn never produced a file, so '
            + 'whether context survived is unknown. This is NOT "context was lost".',
          );
        }
        // A reconnect that lost context writes something here too. The value is
        // the criterion.
        expect(
          readFileSync(recall, 'utf8').trim(),
          'item 4: the thread came back without its context — it reconnected, it did not resume',
        ).toContain(codeword);
      } finally {
        first?.close();
        second?.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
        try {
          harness('stop', 30_000);
        } catch {
          /* teardown must not mask the assertion that got us here */
        }
      }
    },
    900_000,
  );

  it('records live readiness or the exact reason it could not check', () => {
    if (!status.ok) {
      expect(status.reason).toMatch(/^could not check:/);
      return;
    }
    if (!runtime.ok) {
      expect(runtime.reason).toMatch(/^[A-Z_]+: could not check:/);
      return;
    }
    expect(status.reason).toBe('verified');
    expect(runtime.reason).toBe('interpreter resolved');
    if (!liveOptIn) expect(process.env.T3_LIVE).not.toBe('1');
  });
});
