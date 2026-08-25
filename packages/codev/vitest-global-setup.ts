/** Serialize Vitest commands that still share Tower ports and user-global state (#130). */
import { createServer, type Server } from 'node:net';

// Immediately below the test Tower range (14100+), and deliberately outside it.
export const TEST_SUITE_LOCK_PORT = 13_999;
const POLL_MS = 200;

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
): Promise<() => Promise<void>> {
  let announcedWait = false;
  let server: Server | null = null;
  while (!server) {
    server = await tryAcquire(port);
    if (!server) {
      if (!announcedWait) {
        console.warn('[codev tests] Another Vitest run owns shared Tower state; waiting.');
        announcedWait = true;
      }
      await sleep(POLL_MS);
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

export default async function setup(): Promise<() => Promise<void>> { return acquireTestSuiteLock(); }
