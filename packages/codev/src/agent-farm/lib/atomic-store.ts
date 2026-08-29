/**
 * Small-JSON store primitives shared by the credential stores (Spec 146 Phase 7).
 *
 * Phase 6 wrote these inside `approval-capability.ts`. Phase 7 needs the same
 * three properties for machine credentials and pairing tokens, and a second copy
 * would be two implementations of a lock — the failure shape where one gets a fix
 * the other does not. They live here once and both stores call them.
 *
 * The caller supplies its own signal strings rather than inheriting one from this
 * module. That is deliberate: the failure-matrix collector scans the file that
 * EMITS a code, so a shared helper that owned the literal would move every store's
 * lock/parse code out of the scanned set. Each store keeps its own vocabulary.
 *
 * Node builtins only. `porch` imports this transitively and must not pull in the
 * database or server layers.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** How long to keep trying for the lock before giving up. */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

/**
 * Read a JSON file, or return `fallback` when it does not exist.
 *
 * A MISSING file is absence and yields the fallback. A file that exists but will
 * not parse is NOT absence: `wrap` builds the error that says so. Returning the
 * fallback for both would spell "I could not tell" the same way as "never issued",
 * which is the distinction phase 6 had to fix in this exact code.
 */
export function readJsonOrThrow<T>(
  path: string,
  fallback: T,
  wrap: (path: string, cause: unknown) => Error,
): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw wrap(path, error);
  }
}

/**
 * Write JSON through a uniquely-named temp file and a rename.
 *
 * The temp name carries the pid and a random suffix. A FIXED `${path}.tmp` is a
 * collision between two concurrent writers, and the rename would then publish
 * whichever half-written file won.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Run a read-modify-write under an exclusive lock.
 *
 * Single-use MEANS single-use, and read-modify-write without a lock does not
 * deliver it: two concurrent processes could each read the same unconsumed token
 * and both succeed, and a concurrent issue could drop a revocation tombstone.
 * `wx` is the atomic primitive — the create fails if the lock exists — so this
 * does not depend on a check-then-act.
 *
 * @param lockedCode - the caller's own signal for "the lock could not be taken".
 *   Passed in rather than defined here so the emitting module keeps the literal.
 */
export function withStoreLock<T>(path: string, lockedCode: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock left behind by a killed process must not wedge the store forever.
      // Anything older than the stale window is reclaimed.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* the holder released it between the two calls; retry */ }
      if (Date.now() >= deadline) {
        throw new Error(`${lockedCode}: could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
      }
      // Yield rather than spin. These critical sections are two file operations
      // long, so a short blocking sleep costs nothing. `Atomics.wait` is the only
      // synchronous sleep available, and this path is synchronous by design (the
      // lock must span a read-modify-write that callers do not await).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
