/**
 * Vitest-wide exclusion for Codev's process-global integration resources.
 *
 * Several suites still use fixed Tower ports and some production modules resolve
 * user-global state at import time.  Worker isolation cannot separate two Vitest
 * commands in different worktrees, so let a second command wait instead of
 * interleaving with the first one and reporting plausible phantom failures (#130).
 */

import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const OWNER_FILE = 'owner.json';
const OWNER_WRITE_GRACE_MS = 10_000;
const POLL_MS = 200;

interface LockOwner {
  pid: number;
  token: string;
  cwd: string;
  startedAt: string;
}

function defaultLockPath(): string {
  const user = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return resolve(tmpdir(), `codev-vitest-${user}.lock`);
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function currentOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(resolve(lockPath, OWNER_FILE), 'utf8');
    const owner = JSON.parse(raw) as LockOwner;
    if (Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') {
      return owner;
    }
  } catch {
    // mkdir is atomic but writing owner.json is not. Give a new owner time to
    // finish publishing its identity before considering the directory stale.
  }
  return null;
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  const owner = await currentOwner(lockPath);
  if (owner) {
    if (ownerIsAlive(owner.pid)) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  try {
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age < OWNER_WRITE_GRACE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Acquire the cross-process lock and return its idempotent release function. */
export async function acquireTestSuiteLock(
  lockPath = defaultLockPath(),
): Promise<() => Promise<void>> {
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  let announcedWait = false;

  for (;;) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(resolve(lockPath, OWNER_FILE), JSON.stringify(owner), { flag: 'wx' });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (!announcedWait) {
        const holder = await currentOwner(lockPath);
        const detail = holder ? ` (pid ${holder.pid}, ${holder.cwd})` : '';
        console.warn(`[codev tests] Another Vitest run owns shared Tower state${detail}; waiting.`);
        announcedWait = true;
      }
      await sleep(POLL_MS);
    }
  }

  let released = false;
  const releaseSync = (): void => {
    if (released) return;
    try {
      const held = JSON.parse(
        readFileSync(resolve(lockPath, OWNER_FILE), 'utf8'),
      ) as LockOwner;
      if (held.token === owner.token) rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // A missing lock is already released; never remove a replacement owner.
    }
    released = true;
  };
  process.once('exit', releaseSync);

  return async () => {
    if (released) return;
    const held = await currentOwner(lockPath);
    if (held?.token === owner.token) await rm(lockPath, { recursive: true, force: true });
    released = true;
    process.off('exit', releaseSync);
  };
}

export default async function setup(): Promise<() => Promise<void>> {
  return acquireTestSuiteLock();
}
