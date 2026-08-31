/**
 * Issue #271 — the role an architect is created with, read back out of the
 * server's own projection.
 *
 * ## Why this test exists at all
 *
 * Every hierarchy assertion spec 250 shipped used SEEDED threads: a fixture
 * dispatched `thread.create` with `role` on it, or wrote `codev_role` into
 * `projection_threads` directly. Both prove the projector stores what it is
 * handed. Neither proves that the command a human actually runs —
 * `afx workspace add-architect` — hands it anything.
 *
 * It does not. On real hardware the thread was created and `codev_role` came back
 * empty, so t3code's sidebar drew an ordinary thread and nothing could ever nest
 * under it.
 *
 * So this test drives the PRODUCTION entry point, `createArchitectThread`, against
 * a live fork server, and then reads the column out of the server's own SQLite
 * file the way the issue's reproducer does. Nothing here writes `role` on a
 * payload; if a layer between `createArchitectThread` and `projection_threads`
 * drops it, this fails.
 *
 * ## Why it reads SQLite rather than an RPC
 *
 * The projection row is what the sidebar renders from, and it is the thing that
 * was observed empty. A query that went back through the server's read path could
 * be satisfied by a value the server still had in memory. The file is the end of
 * the line.
 *
 * ## Unavailable is a SKIP, never a pass
 *
 * The fork server needs `T3_NODE` and a clean fork checkout. When it cannot
 * start, this run has learned nothing about the fix — and "I could not tell" must
 * not be spelled like "no". Each bail-out names its own reason.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mintPairingCredential,
  startForkServer,
  stopForkStack,
  type ForkStackReady,
} from '../../__tests__/e2e/spec-250-fork-stack.js';
import { closeThreadBackend, ensureThreadBackendReady } from '../thread-backend.js';
import { createArchitectThread } from '../thread-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

/**
 * The server's projection database.
 *
 * `t3-server.mjs` starts the fork with `--base-dir <runtime>/data`, and the
 * server puts its state under `userdata/`. Named here rather than discovered so a
 * moved file fails loudly instead of matching some other database.
 */
function projectionDbPath(): string {
  const runtimeDir = process.env.T3_HARNESS_DIR ?? join(repoRoot, 'tools/t3-server/.runtime');
  return resolve(runtimeDir, 'data/userdata/state.sqlite');
}

/**
 * One column of one row, read out of the running server's file.
 *
 * Read-only and through `sqlite3`, so nothing here can write to a database a live
 * server owns, and the WAL the server is holding open is read the same way the
 * issue's reproducer read it.
 */
function projectionRole(threadId: string): { present: boolean; role: string | null } {
  const out = execFileSync(
    'sqlite3',
    [
      `file:${projectionDbPath()}?mode=ro`,
      '-cmd',
      '.timeout 5000',
      // Two markers, because "no row" and "a row whose role is NULL" are
      // different failures and a single string could not tell them apart.
      `select 'ROW', coalesce(codev_role, 'NULL-ROLE') from projection_threads `
      + `where thread_id = '${threadId}';`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (out === '') return { present: false, role: null };
  const [, role] = out.split('|');
  return { present: true, role: role === 'NULL-ROLE' ? null : (role ?? null) };
}

/** A workspace that is a real git repository, because the backend registers one. */
function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'issue-271-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  mkdirSync(join(ws, '.codev'), { recursive: true });
  writeFileSync(join(ws, '.codev', 'config.json'), '{}\n');
  return ws;
}

let workspace: string | undefined;

afterAll(() => {
  if (workspace !== undefined) closeThreadBackend(workspace);
  stopForkStack();
});

describe('issue 271: an architect created by the production path carries its role', () => {
  it(
    'writes codev_role="architect" into projection_threads',
    { timeout: 300_000 },
    async () => {
      const server = await startForkServer();
      if (!server.available) {
        // A skip that says why. See the header: this is not a pass.
        console.warn(`[issue-271] skipped: ${server.reason}`);
        return;
      }
      const stack: ForkStackReady = { ...server, webUrl: '' };

      // A FRESH single-use pairing credential, which is what the backend's
      // `bootstrapToken` is in production against this server — the harness's own
      // start token was already spent on `stack.accessToken`.
      const bootstrapToken = await mintPairingCredential(stack);

      workspace = scratchWorkspace();
      process.env.CODEV_T3_URL = stack.serverBase;
      process.env.CODEV_T3_TOKEN = bootstrapToken;
      // `thread.create` requires `modelSelection`, so a workspace with no
      // `threads.model` cannot create a thread at all. Production reads this from
      // config; the env override is the same field by another layer.
      process.env.CODEV_T3_MODEL = 'gpt-5.6-luna';

      const installed = await ensureThreadBackendReady(workspace);
      expect(installed, 'the thread backend did not install, so nothing below was exercised')
        .toBe('installed');

      const threadId = await createArchitectThread({ name: 'lan', workspaceRoot: workspace });
      expect(typeof threadId, 'createArchitectThread returned no thread id').toBe('string');

      const row = projectionRole(threadId);
      expect(row.present, `no projection row for thread ${threadId}`).toBe(true);
      expect(
        row.role,
        'the architect reached projection_threads with no role — issue #271. The sidebar '
        + 'renders this as an ordinary thread and nothing can nest under it.',
      ).toBe('architect');
    },
  );
});
