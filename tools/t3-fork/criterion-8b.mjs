#!/usr/bin/env node
/**
 * Spec 250, criterion 8b — the kill test, exercised rather than argued.
 *
 * The criterion: "the server is killed partway through applying the columns and
 * the resulting database still opens against the PRE-FORK server binary."
 *
 * Two review lanes correctly refused an in-process simulation on an in-memory
 * database as evidence for it. This does the real thing:
 *
 *   1. Cold-start the PINNED PRE-FORK server (t3@0.0.36) through the spec 146
 *      harness. It creates and migrates its own database on disk.
 *   2. Stop it, and SIGKILL a child partway through applying the Codev columns,
 *      leaving exactly one of the two on disk.
 *   3. Restart the PINNED PRE-FORK server on that half-applied file, keeping the
 *      data dir, and require it to answer. This is the criterion: a binary that
 *      knows nothing about `codev_role` must still open the database.
 *   4. Run the fork's real guard against the same file and require it to add the
 *      missing column and only that one.
 *   5. Start the pre-fork server once more on the now fully-applied file.
 *
 * Why this discriminates: inside the migrator the whole run is wrapped in
 * `sql.withTransaction` and SQLite DDL is transactional, so a kill would roll
 * both statements back and step 3 would pass without the code being careful.
 * Outside it, two ALTERs are two atomic steps and step 2 really does leave one.
 *
 * Emits JSON evidence so the result is reviewable rather than asserted.
 *
 * Usage:
 *   export T3_NODE=/absolute/path/to/node
 *   node tools/t3-fork/criterion-8b.mjs > codev/research/250-criterion-8b-evidence.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIdentities } from './identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));
const { fork } = resolveIdentities(pin);

const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const runtimeDir = process.env.T3_HARNESS_DIR ?? join(repoRoot, 'tools', 't3-server', '.runtime');
const dbPath = join(runtimeDir, 'data', 'userdata', 'state.sqlite');

const CODEV_COLUMNS = ['codev_role', 'codev_parent_thread_id'];

const say = (message) => console.error(`[criterion-8b] ${message}`);

function runHarness(...args) {
  return execFileSync(process.execPath, [harness, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function columnsOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('PRAGMA table_info(projection_threads)').all().map((row) => row.name);
  } finally {
    db.close();
  }
}

/** Start the pinned pre-fork server and require it to answer. */
function preForkServerOpens(label, { keepData }) {
  try { runHarness('stop'); } catch { /* nothing running */ }
  // `--keep-data` rather than `restart`: restart is stop-then-start and refuses
  // when nothing is running, and the whole point here is opening a database this
  // run did NOT just create.
  if (keepData) runHarness('start', '--keep-data');
  else runHarness('start');
  const readyOut = runHarness('ready');
  const { token } = JSON.parse(readyOut.slice(readyOut.indexOf('{')));
  const opened = Boolean(token);
  say(`${label}: pre-fork server ${opened ? 'opened the database and answered' : 'did NOT answer'}`);
  runHarness('stop');
  return opened;
}

const evidence = {
  criterion:
    'Spec 250 criterion 8b: the server is killed partway through applying the Codev columns and ' +
    'the resulting database still opens against the pre-fork server binary.',
  preForkCliVersion: pin.cliVersion,
  upstreamBase: pin.upstreamBase,
  forkRoot: fork.root,
  dbPath,
  steps: {},
};

try {
  // 1. A database created and migrated by the pinned PRE-FORK binary.
  say('starting the pinned pre-fork server to create a real database...');
  evidence.steps.preForkServerCreatedDatabase = preForkServerOpens('cold start', { keepData: false });
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath} after a cold start`);

  const before = columnsOf(dbPath);
  evidence.steps.columnsBeforeGuard = CODEV_COLUMNS.filter((c) => before.includes(c));
  if (evidence.steps.columnsBeforeGuard.length !== 0) {
    throw new Error('the pre-fork database already has Codev columns; this run proves nothing');
  }

  // 2. Kill a real process partway through applying them.
  say('applying the first column in a child, then SIGKILLing it...');
  const child = spawn(process.execPath, [join(here, 'crash-apply-child.mjs'), dbPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const killed = await new Promise((resolveKill, rejectKill) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectKill(new Error('child never announced the first column'));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('APPLIED_FIRST_COLUMN')) {
        clearTimeout(timer);
        // SIGKILL, not SIGTERM: no handler, no cleanup, no chance to finish.
        child.kill('SIGKILL');
        child.on('exit', (code, signal) => resolveKill({ code, signal }));
      }
    });
  });
  evidence.steps.childKilledBySignal = killed.signal;
  if (killed.signal !== 'SIGKILL') throw new Error(`child exited by ${killed.signal ?? killed.code}, not SIGKILL`);

  const half = columnsOf(dbPath);
  evidence.steps.columnsAfterKill = CODEV_COLUMNS.filter((c) => half.includes(c));
  evidence.steps.halfApplied = evidence.steps.columnsAfterKill.length === 1;
  if (!evidence.steps.halfApplied) {
    throw new Error(
      `expected exactly one Codev column after the kill, found ${evidence.steps.columnsAfterKill.length}. ` +
        'Without a genuinely half-applied file the rest of this run proves nothing.',
    );
  }
  say(`half-applied on disk: ${evidence.steps.columnsAfterKill.join(', ')}`);

  // 3. THE CRITERION. A binary that has never heard of codev_role opens it.
  evidence.steps.preForkServerOpensHalfApplied = preForkServerOpens('half-applied', { keepData: true });

  // 4. The fork's real guard finishes the job.
  say('running the fork guard against the half-applied file...');
  const guardOut = execFileSync(
    process.execPath,
    [join(fork.root, 'apps', 'server', 'scripts', 'apply-codev-guard.ts'), dbPath],
    { encoding: 'utf8', cwd: fork.root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const guard = JSON.parse(guardOut.trim().split('\n').pop());
  evidence.steps.guardResume = guard;
  evidence.steps.guardAddedOnlyTheMissingColumn =
    guard.added.length === 1 && guard.present.length === 1;

  const after = columnsOf(dbPath);
  evidence.steps.columnsAfterResume = CODEV_COLUMNS.filter((c) => after.includes(c));

  // 5. And the pre-fork binary still opens the fully-applied file.
  evidence.steps.preForkServerOpensFullyApplied = preForkServerOpens('fully applied', { keepData: true });

  evidence.passed =
    evidence.steps.preForkServerCreatedDatabase === true &&
    evidence.steps.halfApplied === true &&
    evidence.steps.preForkServerOpensHalfApplied === true &&
    evidence.steps.guardAddedOnlyTheMissingColumn === true &&
    evidence.steps.columnsAfterResume.length === 2 &&
    evidence.steps.preForkServerOpensFullyApplied === true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  say(`FAILED: ${evidence.error}`);
} finally {
  try { runHarness('stop'); } catch { /* already stopped */ }
}

console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.passed ? 0 : 1);
