/**
 * Issue #6 — the Tower API answers 401 in CI, on code that passes locally.
 *
 * `Tower Integration Tests` failed on `main` with `expected 401 to be 404`
 * across 13 of 16 cases in `tower-api.e2e.test.ts`. Every request was rejected
 * as unauthorized, so no test reached the behaviour it was checking. The same
 * commit passed on `cluesmith/codev` and passed locally, which is what made it
 * look environmental.
 *
 * It is a check-then-write race in `ensureLocalKey`:
 *
 *     if (!existsSync(LOCAL_KEY_PATH)) {
 *       const key = randomBytes(32).toString('hex');
 *       writeFileSync(LOCAL_KEY_PATH, key, { mode: 0o600 });
 *       return key;                                    // <- its OWN key
 *     }
 *
 * Two concurrent callers both pass `existsSync`, both generate a different key,
 * and both write. The file ends up holding the LOSER's key while the winner
 * returned its own. A Tower started with the returned value then cannot
 * authenticate a client that reads the file — and `vitest-e2e-setup.ts` calls
 * `ensureLocalKey()` on every patched fetch, so every request 401s.
 *
 * Invisible on a warm machine: the file already exists and the branch never
 * runs. It appears on a cold runner with several e2e suites starting in
 * parallel and no `~/.agent-farm` at all — which is exactly CI, and exactly why
 * "passes locally" was not evidence.
 *
 * These drive real concurrent PROCESSES. The defect is a filesystem race
 * between separate processes; a mocked test would assert the shape of the code
 * rather than whether the race is closed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIST = path.resolve(HERE, '..', '..', 'dist', 'auth.js');

let farmDir: string;

beforeEach(() => {
  farmDir = fs.mkdtempSync(path.join(tmpdir(), 'i6-key-'));
  fs.rmSync(farmDir, { recursive: true, force: true }); // must NOT exist yet
});

afterEach(() => {
  fs.rmSync(farmDir, { recursive: true, force: true });
});

const hasDist = fs.existsSync(AUTH_DIST);

const execFileAsync = promisify(execFile);

/**
 * Start N processes that all call ensureLocalKey() against an empty dir.
 *
 * Genuinely CONCURRENT — they are all launched before any is awaited. Running
 * them one after another does not race at all: the first creates the file and
 * every later one takes the read path, so a sequential version of this helper
 * passes against the very code it is meant to catch.
 *
 * Each waits on a shared start barrier (a file appearing) so the processes are
 * inside `ensureLocalKey` at the same moment rather than merely started at the
 * same moment — node startup dominates otherwise and staggers them apart.
 */
async function raceForKey(n: number): Promise<string[]> {
  const barrier = path.join(path.dirname(farmDir), `barrier-${path.basename(farmDir)}`);
  fs.rmSync(barrier, { force: true });

  const script = `
    const fs = await import('node:fs');
    const { ensureLocalKey } = await import(${JSON.stringify(AUTH_DIST)});
    while (!fs.existsSync(${JSON.stringify(barrier)})) {}
    process.stdout.write(ensureLocalKey());
  `;

  const running = Array.from({ length: n }, () =>
    execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CODEV_AGENT_FARM_DIR: farmDir, CODEV_TOWER_KEY: '' },
      encoding: 'utf-8',
      timeout: 30_000,
    }),
  );

  // Let every child reach the spin, then release them together.
  await new Promise(r => setTimeout(r, 900));
  fs.writeFileSync(barrier, 'go');

  try {
    return (await Promise.all(running)).map(r => String(r.stdout).trim());
  } finally {
    fs.rmSync(barrier, { force: true });
  }
}

describe.runIf(hasDist)('#6: every caller must end up with the key that is on disk', () => {
  it('a single caller returns exactly what it wrote', async () => {
    const [key] = await raceForKey(1);
    const onDisk = fs.readFileSync(path.join(farmDir, 'local-key'), 'utf-8').trim();

    expect(key).toBe(onDisk);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a later caller reads the existing key rather than minting a second one', async () => {
    const [first] = await raceForKey(1);
    const [second] = await raceForKey(1);

    expect(second).toBe(first);
  });

  it('the key on disk never changes once created', async () => {
    await raceForKey(1);
    const before = fs.readFileSync(path.join(farmDir, 'local-key'), 'utf-8').trim();
    await raceForKey(4);
    const after = fs.readFileSync(path.join(farmDir, 'local-key'), 'utf-8').trim();

    expect(after).toBe(before);
  });
});

describe.runIf(hasDist)('#6: the concurrent case, which is the one CI hit', () => {
  it('eight cold-start callers all agree, and agree with the file', async () => {
    // The old code could return up to eight DIFFERENT keys here, with the file
    // holding whichever write landed last. One Tower and one client picking
    // different ones is a 401 on every request.
    const keys = await raceForKey(8);
    const onDisk = fs.readFileSync(path.join(farmDir, 'local-key'), 'utf-8').trim();

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(onDisk);
  }, 60_000);

  it('repeated cold starts stay consistent, not merely usually consistent', async () => {
    // A race does not fail every time. Running the cold start repeatedly is the
    // difference between "did not reproduce" and "cannot happen".
    for (let round = 0; round < 5; round++) {
      fs.rmSync(farmDir, { recursive: true, force: true });
      const keys = await raceForKey(6);
      const onDisk = fs.readFileSync(path.join(farmDir, 'local-key'), 'utf-8').trim();

      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe(onDisk);
    }
  }, 180_000);
});

describe.runIf(hasDist)('#6: the directory is created with the key, not assumed', () => {
  it('creates ~/.agent-farm when it does not exist at all', async () => {
    expect(fs.existsSync(farmDir)).toBe(false);

    await raceForKey(1);

    expect(fs.existsSync(path.join(farmDir, 'local-key'))).toBe(true);
  });
});
