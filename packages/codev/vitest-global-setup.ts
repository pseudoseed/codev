/** Serialize Vitest commands that still share Tower ports and user-global state (#130). */
import { createServer, type Server } from 'node:net';
import { SUITE_LOCK_BUSY_EXIT, SUITE_LOCK_TIMEOUT_NEEDLE } from './src/lib/suite-lock.js';

export { SUITE_LOCK_BUSY_EXIT, SUITE_LOCK_TIMEOUT_NEEDLE };

/**
 * Documented harness opt-ins. These are how a suite deliberately reaches a
 * real binary or the real cloud; they are not builder-session identity.
 * Everything else under `CODEV_*` is scrubbed (#189).
 */
const CODEV_HARNESS_OPT_INS = new Set([
  'CODEV_ALLOW_REAL_AGY',
  'CODEV_ALLOW_REAL_OPENCODE',
  'CODEV_ALLOW_TEST_CLOUD_MUTATION',
  'CODEV_TEST_ISOLATION',
]);

/**
 * Drop every `CODEV_*` variable so a builder session cannot leak identity
 * into the suite (#189). `detectCurrentBuilderId` prefers
 * `CODEV_WORKTREE_ROOT` over cwd by design (#47); tests that drive identity
 * with `process.chdir()` only work if the runner's session vars are gone.
 *
 * Opt-in flags the harness already special-cases are restored. Invoked
 * from this file's `globalSetup` (workers inherit it) and from
 * `vitest-setup.ts` so a later test file cannot inherit a leak from an
 * earlier one in the same worker.
 */
export function scrubCodevNamespace(env: NodeJS.ProcessEnv = process.env): void {
  const kept: Record<string, string> = {};
  for (const key of CODEV_HARNESS_OPT_INS) {
    const value = env[key];
    if (value !== undefined) kept[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEV_')) delete env[key];
  }
  Object.assign(env, kept);
}

// Immediately below the test Tower range (14100+), and deliberately outside it.
export const TEST_SUITE_LOCK_PORT = 13_999;
const POLL_MS = 200;
// The full suite currently takes ~200s; keep this above its duration and raise it as the suite grows.
const WAIT_TIMEOUT_MS = 900_000;

export class SuiteLockBusyError extends Error {
  readonly exitCode = SUITE_LOCK_BUSY_EXIT;
  constructor(message: string) {
    super(message);
    this.name = 'SuiteLockBusyError';
  }
}

function tryAcquire(port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server));
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Hold a loopback listening socket for the suite lifetime. The kernel makes
 * acquisition atomic and releases the mutex even when a test process crashes.
 */
export async function acquireTestSuiteLock(
  port = TEST_SUITE_LOCK_PORT,
  waitTimeoutMs = WAIT_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  let announcedWait = false;
  let server: Server | null = null;
  const deadline = Date.now() + waitTimeoutMs;
  while (!server) {
    server = await tryAcquire(port);
    if (!server) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SuiteLockBusyError(
          `[codev tests] ${SUITE_LOCK_TIMEOUT_NEEDLE} on port ${port}. `
          + `Another Vitest run or unrelated process likely holds it; check with: lsof -i :${port}`,
        );
      }
      if (!announcedWait) {
        console.warn('[codev tests] Another Vitest run owns shared Tower state; waiting.');
        announcedWait = true;
      }
      await sleep(Math.min(POLL_MS, remainingMs));
    }
  }

  const heldServer = server;
  let released = false;
  return () => new Promise<void>((resolve, reject) => {
    if (released) return resolve();
    released = true;
    heldServer.close((error) => error ? reject(error) : resolve());
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  scrubCodevNamespace();
  try {
    return await acquireTestSuiteLock();
  } catch (err) {
    if (err instanceof SuiteLockBusyError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }
}
