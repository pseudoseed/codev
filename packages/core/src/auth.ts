import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENT_FARM_DIR } from './constants.js';

const LOCAL_KEY_PATH = resolve(AGENT_FARM_DIR, 'local-key');

/**
 * Optional environment override for the shared Tower key. When `CODEV_TOWER_KEY`
 * is set it IS the key on both sides: Tower treats it as the expected key and
 * clients present it. This is the supported way to authenticate across a boundary
 * where the client does not share Tower's `local-key` file — a host CLI/SDK
 * reaching a Tower inside a container, or a Tower on a non-loopback bind
 * (`BRIDGE_MODE`). Set the SAME value on Tower and every client. It must be the
 * Tower's 64-hex key (the browser dashboard shell only injects a well-formed
 * key). Unset for same-host loopback use, where the `local-key` file is the
 * source of truth.
 */
function keyOverride(): string | null {
  const v = process.env.CODEV_TOWER_KEY;
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the local auth key. Honors the `CODEV_TOWER_KEY` env override; otherwise
 * reads it from disk, returning null if the file doesn't exist. Read-only — does
 * not create directories or generate keys. Safe for use in the VS Code extension.
 */
export function readLocalKey(): string | null {
  const override = keyOverride();
  if (override) return override;
  try {
    return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get or create the local auth key. Creates ~/.agent-farm/ and generates
 * a random key if missing. CLI-only — the extension should use readLocalKey().
 */
export function ensureLocalKey(): string {
  const override = keyOverride();
  if (override) return override;

  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(LOCAL_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    // Create via a fully-written temp file plus `link` (issue #6, round 2).
    //
    // `writeFileSync(..., { flag: 'wx' })` was exclusive but NOT atomic: it
    // creates the file and THEN writes it, so a concurrent caller's
    // `existsSync` sees a zero-byte file, skips this branch, and reads `''`.
    // Measured over 25 cold-start rounds of 8 processes: one round returned
    // lengths `64,0,64,0,64,64,64,64` — two callers got an EMPTY key while the
    // file on disk was a correct 64-char one.
    //
    // An empty key is worse than the mismatch the `wx` flag was added to fix:
    // it presents as "no key at all" and every request 401s with nothing
    // naming the cause. `link` is atomic and fails EEXIST when the target
    // exists, so the file becomes visible only once it is already complete.
    const tmp = `${LOCAL_KEY_PATH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, key, { mode: 0o600 });
      try {
        linkSync(tmp, LOCAL_KEY_PATH);
        return key;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Someone else won. Their key is the shared one — fall through and read
        // it. It is guaranteed complete, because it was linked from a file that
        // had already been written in full.
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort — the temp is gone on the success path anyway */
      }
    }
  }

  // Repair permissions on an existing key file: `mode` on writeFileSync only
  // applies at creation, so a key written before this hardening (or by another
  // tool) may be world-readable. Tighten it to 0600 on read (best effort;
  // chmod is a no-op on platforms that don't support POSIX modes).
  try {
    chmodSync(LOCAL_KEY_PATH, 0o600);
  } catch {
    /* best effort — platform may not support chmod */
  }

  // An empty read must never be RETURNED (#6). `link` above closes the window
  // that produced one, so reaching the retry means something else truncated the
  // file — and handing back `''` would spell "no key" identically to "the key
  // could not be read", which is the failure this whole issue is about.
  for (let attempt = 0; ; attempt++) {
    const value = readFileSync(LOCAL_KEY_PATH, 'utf-8').trim();
    if (value) return value;
    if (attempt >= 20) {
      throw new Error(
        `Local key at ${LOCAL_KEY_PATH} is empty. Delete it and re-run to have Tower regenerate it.`,
      );
    }
    sleepMs(5);
  }
}

/** Block briefly without pulling in a timer — this path is sync by contract. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
