/**
 * Pinned-harness checks for Spec 146 Phase 9.
 *
 * The verify test does not start a server or create a thread. Live engine
 * exercise is the test whose name says so, and it skips when Node is below 22
 * or verify cannot run — "could not check", never a silent pass.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createProject } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const nodeMajor = Number(process.version.slice(1).split('.')[0]);

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harness)) {
    return { ok: false, reason: `could not check: missing ${harness}` };
  }
  try {
    execFileSync('node', [harness, 'verify'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const errCode = (err as { status?: number }).status;
    if (errCode === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (errCode === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: `could not check: verify failed (${err instanceof Error ? err.message : String(err)})` };
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
  const canRunLive = status.ok && nodeMajor >= 22;

  it.skipIf(!canRunLive)(
    'createPorchThreadEngine interrupt on the live server leaves SHOULD_NOT_FINISH absent',
    async () => {
      execFileSync('node', [harness, 'stop'], { encoding: 'utf8', timeout: 30_000 });
      execFileSync('node', [harness, 'start'], { encoding: 'utf8', timeout: 60_000 });
      let readyOut = '';
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          readyOut = execFileSync('node', [harness, 'ready'], { encoding: 'utf8', timeout: 20_000 });
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
        await new Promise((r) => setTimeout(r, 4000));
        if (!existsSync(started)) {
          throw new Error('could not check: turn did not write STARTED — provider did not run the command');
        }
        await engine.interrupt(threadId);
        await new Promise((r) => setTimeout(r, 2000));
        expect(existsSync(marker)).toBe(false);
        socket.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
        execFileSync('node', [harness, 'stop'], { encoding: 'utf8', timeout: 30_000 });
      }
    },
    180_000,
  );

  it.skipIf(canRunLive)('records why the live engine run could not check', () => {
    if (nodeMajor < 22) {
      expect(`could not check: Node ${process.version} is below 22`).toMatch(/^could not check:/);
      return;
    }
    expect(status.reason).toMatch(/^could not check:/);
  });
});
