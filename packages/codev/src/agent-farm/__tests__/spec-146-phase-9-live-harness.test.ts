/**
 * Pinned-harness checks for Spec 146 Phase 9.
 *
 * The verify test does not start a server or create a thread. Live engine
 * exercise is the test whose name says so. It requires T3_LIVE=1 in addition
 * to T3_NODE, so a configured interpreter cannot make the default unit suite
 * dispatch a paid provider turn. Missing prerequisites are honestly named.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createProject } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harness)) {
    return { ok: false, reason: `could not check: missing ${harness}` };
  }
  try {
    execFileSync(process.execPath, [harness, 'verify'], { encoding: 'utf8', timeout: 15_000 });
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
    execFileSync(process.execPath, [harness, 'runtime'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'interpreter resolved' };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    const signal = stderr.split('\n').find((line) => /[A-Z_]+: could not check:/.test(line));
    return {
      ok: false,
      reason: signal?.replace(/^\[t3-server\] /, '') ??
        'RUNTIME_UNAVAILABLE: could not check: runtime command failed without a named signal',
    };
  }
}

describe('Spec 146 Phase 9 — pinned harness verify', () => {
  const status = harnessStatus();

  it('names the skip when the pinned harness cannot be verified', () => {
    if (status.ok) {
      expect(status.reason).toBe('verified');
      return;
    }
    expect(status.reason).toMatch(/^could not check:/);
  });
});

describe('Spec 146 Phase 9 — porch-driver engine against the pinned harness', () => {
  const status = harnessStatus();
  const runtime = runtimeStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  const canRunLive = status.ok && runtime.ok && liveOptIn;

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE] interrupt leaves SHOULD_NOT_FINISH absent',
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
      if (!readyOut.includes('{')) {
        throw new Error('could not check: live server printed no ready JSON');
      }
      const { token, port } = JSON.parse(readyOut.slice(readyOut.indexOf('{'))) as {
        token: string;
        port: number;
      };
      const dir = mkdtempSync(join(tmpdir(), 'phase9-live-'));
      const worktreePath = join(dir, 'wt');
      mkdirSync(worktreePath);
      try {
        const { T3Client } = await import('../../../../t3-client/dist/client.js');
        const auth = await import('../../../../t3-client/dist/auth.js');
        const base = `http://127.0.0.1:${port}`;
        const access = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-phase9-live' });
        const ticket = await auth.issueWebSocketTicket(base, access.access_token);
        const url = auth.webSocketUrl(base, ticket.ticket);
        const socket = new WebSocket(url);
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
        const projectId = await createProject(dispatcher, journal, {
          title: 'phase-9-live',
          workspaceRoot: dir,
        });
        const engine = createPorchThreadEngine({
          dispatcher,
          journal,
          tracker,
          projectId,
          workspaceRoot: dir,
          defaultHarness: 'codex',
          defaultModel: 'gpt-5.6-luna',
        });
        const threadId = await engine.create({
          builderId: 'live-173',
          worktreePath,
          branch: 'builder/live-173',
        });
        expect(threadId.length).toBeGreaterThan(0);
        const started = join(worktreePath, 'STARTED');
        const marker = join(worktreePath, 'SHOULD_NOT_FINISH');
        await engine.startTurn(
          threadId,
          `echo STARTED > "${started}"; sleep 30; echo SHOULD_NOT_FINISH > "${marker}"`,
        );
        const startedDeadline = Date.now() + 30_000;
        while (!existsSync(started) && Date.now() < startedDeadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!existsSync(started)) {
          throw new Error(
            'COULD_NOT_TELL: START_TIMEOUT — turn did not write STARTED within 30000ms; ' +
              'the interrupt criterion was not evaluated.',
          );
        }
        await engine.interrupt(threadId);
        await new Promise((r) => setTimeout(r, 2000));
        expect(existsSync(marker)).toBe(false);
        socket.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
        execFileSync(process.execPath, [harness, 'stop'], { encoding: 'utf8', timeout: 30_000 });
      }
    },
    180_000,
  );

  it('records live readiness or the exact reason it could not check', () => {
    if (!status.ok) {
      expect(status.reason).toMatch(/^could not check:/);
      return;
    }
    if (!runtime.ok) {
      expect(runtime.reason).toMatch(/^NO_INTERPRETER: could not check:/);
      return;
    }
    expect(status.reason).toBe('verified');
    expect(runtime.reason).toBe('interpreter resolved');
    if (!liveOptIn) expect(process.env.T3_LIVE).not.toBe('1');
  });
});
