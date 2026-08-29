/** Issue #130: separate Vitest commands must not share Tower state concurrently. */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireTestSuiteLock,
  TEST_SUITE_LOCK_PORT,
  SuiteLockBusyError,
  SUITE_LOCK_BUSY_EXIT,
} from '../../vitest-global-setup.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
const LOCK_MODULE = pathToFileURL(resolve(PACKAGE_ROOT, 'vitest-global-setup.ts')).href;
const CONFIGS = ['vitest.config.ts', 'vitest.e2e.config.ts', 'vitest.cli.config.ts'];

let testDir: string | undefined;

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      try {
        readFileSync(path);
        resolveWait();
      } catch {
        if (Date.now() - started >= timeoutMs) reject(new Error(`Timed out waiting for ${path}`));
        else setTimeout(poll, 20);
      }
    };
    poll();
  });
}

function lockProcess(label: string, port: number, log: string, barrier: string) {
  const script = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const { acquireTestSuiteLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const release = await acquireTestSuiteLock(${port});
    appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${label}:acquired\n`)});
    writeFileSync(${JSON.stringify(resolve(testDir!, `${label}.ready`))}, 'ready');
    while (!existsSync(${JSON.stringify(barrier)})) {
      await new Promise(r => setTimeout(r, 20));
    }
    appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${label}:released\n`)});
    await release();
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function completed(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolveDone, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveDone();
      else reject(new Error(`Lock child exited ${code}: ${stderr}`));
    });
  });
}

function waitForStderr(child: ReturnType<typeof spawn>, text: string): Promise<void> {
  return new Promise((resolveWait, reject) => {
    child.stderr?.on('data', (chunk) => {
      if (String(chunk).includes(text)) resolveWait();
    });
    child.once('exit', (code) => reject(new Error(`Child exited ${code} before writing ${text}`)));
  });
}

describe('issue #130 concurrent suite exclusion', () => {
  it('wires the same global lock into every Codev Vitest entry point', () => {
    for (const config of CONFIGS) {
      const source = readFileSync(resolve(PACKAGE_ROOT, config), 'utf8');
      expect(source, config).toContain("globalSetup: ['./vitest-global-setup.ts']");
    }
  });

  it('makes a second process wait until the first suite releases shared state', async () => {
    testDir = mkdtempSync(resolve(tmpdir(), 'codev-i130-lock-'));
    const log = resolve(testDir, 'order.log');
    const holderBarrier = resolve(testDir, 'holder.release');
    const waiterBarrier = resolve(testDir, 'waiter.release');

    const port = TEST_SUITE_LOCK_PORT - 1;
    const holder = lockProcess('holder', port, log, holderBarrier);
    const holderDone = completed(holder);
    await waitForFile(resolve(testDir, 'holder.ready'));

    const waiter = lockProcess('waiter', port, log, waiterBarrier);
    const waiterDone = completed(waiter);
    await waitForStderr(waiter, 'owns shared Tower state');
    const whileHolderOwnsLock = readFileSync(log, 'utf8');

    writeFileSync(holderBarrier, 'release');
    await waitForFile(resolve(testDir, 'waiter.ready'));
    writeFileSync(waiterBarrier, 'release');
    await Promise.all([holderDone, waiterDone]);

    expect(whileHolderOwnsLock).toBe('holder:acquired\n');
    expect(readFileSync(log, 'utf8')).toBe(
      'holder:acquired\nholder:released\nwaiter:acquired\nwaiter:released\n',
    );
  }, 20_000);

  it('releases the lock when its process crashes', async () => {
    testDir = mkdtempSync(resolve(tmpdir(), 'codev-i130-crash-'));
    const log = resolve(testDir, 'order.log');
    const port = TEST_SUITE_LOCK_PORT - 1;
    const crashed = lockProcess('crashed', port, log, resolve(testDir, 'never'));
    await waitForFile(resolve(testDir, 'crashed.ready'));
    const exited = new Promise<void>((done) => crashed.once('exit', () => done()));
    crashed.kill('SIGKILL');
    await exited;

    const barrier = resolve(testDir, 'successor.release');
    const successor = lockProcess('successor', port, log, barrier);
    const successorDone = completed(successor);
    await waitForFile(resolve(testDir, 'successor.ready'));
    writeFileSync(barrier, 'release');
    await successorDone;
    expect(readFileSync(log, 'utf8')).toContain('successor:acquired\n');
  }, 20_000);

  it('fails with an actionable error instead of waiting forever', async () => {
    const port = TEST_SUITE_LOCK_PORT - 2;
    const occupant = createServer();
    await new Promise<void>((resolveListen, reject) => {
      occupant.once('error', reject);
      occupant.listen({ port, host: '127.0.0.1', exclusive: true }, resolveListen);
    });

    try {
      try {
        await acquireTestSuiteLock(port, 50);
        throw new Error('lock wait should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SuiteLockBusyError);
        expect(err).toMatchObject({
          exitCode: SUITE_LOCK_BUSY_EXIT,
          message: expect.stringContaining(
            `Another Vitest run or unrelated process likely holds it; check with: lsof -i :${port}`,
          ),
        });
      }
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        occupant.close((error) => error ? reject(error) : resolveClose());
      });
    }
  });

});
