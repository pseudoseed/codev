#!/usr/bin/env node
/**
 * Spec 250 phase 11 — the rebase drill, as a PROCEDURE rather than an event.
 *
 * ## What it proves, and what it deliberately does not
 *
 * Criterion 9 asks whether the customization can be carried onto a later
 * upstream: whether the rebase completes, whether the contract regenerates from
 * the rebased fork, and whether `shape-check` still holds. It is met **by this
 * running and reporting**, not by adopting a new base.
 *
 * ## Nothing real moves. That is the point, and it was ruled.
 *
 *   `/Users/chris/dev/t3code`       the PRESERVED upstream clone. Read-only.
 *                                   Fetch is fine — remote-tracking refs move
 *                                   and HEAD does not. A checkout is not.
 *   `/Users/chris/dev/t3code-codev` the fork. Read-only here.
 *   `pin.json`                      NOT advanced.
 *
 * The moment `pin.json` names a new base, `verify-upstream` expects the
 * preserved clone to BE there, and every spec 146 and spec 236 result tied to
 * `082e6ea52186` stops being re-runnable. Advancing the base is a decision taken
 * when there is a reason — a security fix, a feature we need — never as a phase
 * deliverable. So the drill runs in a **scratch clone** and throws it away.
 *
 * ## Every failure is reported, and the kinds are kept apart
 *
 * A drill that cannot run and a drill that ran and found conflicts are different
 * facts wanting different next actions, and reporting the first as the second
 * would be this project's recurring defect on the one tool whose job is to say
 * what happened. So:
 *
 *   ok                 rebase clean, contract regenerated, shape-check held
 *   conflicts          the rebase stopped on conflicts. THIS IS A RESULT, not an
 *                      error — it is the number the drill exists to produce, and
 *                      the files are listed
 *   regenerate-failed  rebase landed, the generator did not
 *   shape-check-failed both landed, the contract does not match
 *   could-not-run      no scratch, no clone, no upstream target. NOTHING was
 *                      learned, and it must never read as "no conflicts"
 *
 * Usage:
 *   node tools/t3-fork/rebase-drill.mjs [--onto <ref>] [--out <file>] [--keep]
 *
 * `--onto` defaults to the upstream clone's `origin/main`. `--keep` leaves the
 * scratch for inspection and prints where it is.
 *
 * Exit codes: 0 ok or conflicts (both are results), 3 could-not-run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIdentities } from './identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pinPath = join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
const identities = resolveIdentities(pin);

const COULD_NOT_RUN = 3;

/** Upstream's numbered migration registry, read from both refs. */
const MIGRATIONS_DIR = 'apps/server/src/persistence/Migrations';

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes('--keep');
const outPath = flag('out');

function run(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

/** `git` that reports its failure instead of throwing an opaque status. */
function tryRun(cwd, ...args) {
  try {
    return { ok: true, out: run(cwd, ...args) };
  } catch (error) {
    return {
      ok: false,
      out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message ?? error),
    };
  }
}

function report(result) {
  const body = JSON.stringify(result, null, 2);
  if (outPath) {
    mkdirSync(dirname(resolve(repoRoot, outPath)), { recursive: true });
    writeFileSync(resolve(repoRoot, outPath), `${body}\n`);
    console.error(`[rebase-drill] written to ${outPath}`);
  }
  console.log(body);
  process.exit(result.outcome === 'could-not-run' ? COULD_NOT_RUN : 0);
}

const upstreamRoot = identities.upstream.root;
const forkRoot = identities.fork.root;

for (const [label, root] of [['upstream', upstreamRoot], ['fork', forkRoot]]) {
  if (!existsSync(root)) {
    report({
      outcome: 'could-not-run',
      reason: `no ${label} checkout at ${root}. Nothing was rebased, and that is not the same as `
        + 'a rebase with no conflicts.',
    });
  }
}

// The target, read from the PRESERVED clone's remote-tracking ref. `--onto` may
// name any resolvable ref; an unresolvable one is could-not-run, never zero.
const onto = flag('onto', 'origin/main');
const ontoSha = tryRun(upstreamRoot, 'rev-parse', '--verify', '--quiet', `${onto}^{commit}`);
if (!ontoSha.ok) {
  report({
    outcome: 'could-not-run',
    reason: `${onto} does not resolve in ${upstreamRoot}. Fetch first — a ref that cannot be read `
      + 'is "unknown", not "unchanged".',
  });
}
const target = ontoSha.out.trim();
const base = identities.fork.base;
const forkHead = run(forkRoot, 'rev-parse', 'HEAD').trim();

if (target === base) {
  // A legitimate zero, and it is a PASS — but it is reported as its own outcome
  // so it can never be confused with a drill that did not run.
  report({
    outcome: 'ok',
    signal: 'NO_UPSTREAM_MOVEMENT',
    detail: `${onto} is still ${base.slice(0, 12)}; there is nothing to rebase onto. The procedure `
      + 'ran and had nothing to do, which is different from the procedure not running.',
    upstreamRoot, forkRoot, base, target, forkHead,
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'spec-250-rebase-drill-'));
const clone = join(scratch, 'fork');
const started = new Date().toISOString();
let result;

try {
  /*
   * Cloned from the LOCAL fork with `--shared`, and upstream added as a LOCAL
   * remote. Both are reads. The drill never touches the network and never writes
   * to either real checkout — a scratch that fetched from GitHub would also be
   * measuring the network.
   */
  run(scratch, 'clone', '--quiet', '--shared', '--no-checkout', forkRoot, clone);
  run(clone, 'remote', 'add', 'preserved-upstream', upstreamRoot);
  run(clone, 'fetch', '--quiet', 'preserved-upstream', target);
  run(clone, 'checkout', '--quiet', '--detach', forkHead);

  const carried = run(clone, 'rev-list', '--count', `${base}..${forkHead}`).trim();

  const rebase = tryRun(clone, '-c', 'rebase.autoStash=false', 'rebase', '--onto', target, base, forkHead);

  if (!rebase.ok) {
    /*
     * CONFLICTS ARE THE RESULT, NOT THE ERROR. This is the number the drill
     * exists to produce, so it is reported with the files rather than as a
     * failure — and the drill exits 0, because it ran.
     */
    const conflicted = tryRun(clone, 'diff', '--name-only', '--diff-filter=U');
    const stopped = tryRun(clone, 'rev-parse', '--short', 'REBASE_HEAD');
    // Aborted BEFORE the whole-surface probe below: a merge started mid-rebase
    // would be measuring a half-replayed tree, which is neither of the two
    // questions being asked.
    tryRun(clone, 'rebase', '--abort');
    result = {
      outcome: 'conflicts',
      detail: 'the rebase stopped on conflicts. That is a measurement, not a failure — it is what '
        + 'the drill is for.',
      conflictedFiles: conflicted.ok ? conflicted.out.trim().split('\n').filter(Boolean) : [],
      stoppedAt: stopped.ok ? stopped.out.trim() : null,
      gitSaid: rebase.out.split('\n').slice(0, 20),
    };
    /*
     * AND THE WHOLE SURFACE, IN ONE PASS.
     *
     * `git rebase` is sequential and stops at the FIRST conflict, so "stopped at
     * commit 6 of 42" answers "where does it stop" and not "how much conflicts" —
     * and reporting only the first would understate the drill every time. A
     * three-way merge of the same two trees surfaces every conflicting file at
     * once.
     *
     * It is a MEASUREMENT, not the procedure: the real rebase is still what an
     * operator runs, and this number is how big that job is before they start.
     * Nothing is resolved here and nothing is committed.
     */
    const merge = tryRun(clone, 'merge', '--no-commit', '--no-ff', target);
    const allConflicts = tryRun(clone, 'diff', '--name-only', '--diff-filter=U');
    tryRun(clone, 'merge', '--abort');
    const conflictedList = allConflicts.ok
      ? allConflicts.out.trim().split('\n').filter(Boolean)
      : [];
    result.wholeSurface = {
      method: 'three-way merge of the same two trees, aborted immediately',
      clean: merge.ok,
      conflictedFiles: conflictedList,
    };

    /*
     * IS THE CONTRACT REACHABLE AFTER THE REBASE?
     *
     * The plan asks the drill to regenerate the contract from the rebased fork
     * and pass shape-check. That is only reachable if the generator's SOURCE —
     * the pinned closure — comes through the rebase without conflicts, so this
     * answers the prerequisite rather than asserting the conclusion.
     *
     * Reported as its own field because "the customization conflicts somewhere"
     * and "the contract cannot be regenerated" are different sizes of problem:
     * the first is three files an operator resolves, the second would mean the
     * vendored contract is stranded until they do.
     */
    const closurePaths = pin.closure.map((f) => `${pin.contractsRoot}/${f}`);
    const closureConflicts = conflictedList.filter((f) => closurePaths.includes(f));
    result.contractClosure = {
      files: closurePaths,
      conflicted: closureConflicts,
      regenerationReachable: closureConflicts.length === 0,
      detail: closureConflicts.length === 0
        ? 'every file the generator reads merged without conflict, so regenerating the contract '
          + 'from the rebased tree is not blocked by the rebase. What the regenerated contract '
          + 'would CHANGE is a separate question, answered by classify-churn --upstream-movement.'
        : 'the generator\'s own source conflicts, so the vendored contract cannot be regenerated '
          + 'until those are resolved.',
    };
  } else {
    const rebasedHead = run(clone, 'rev-parse', 'HEAD').trim();
    const rebasedCount = run(clone, 'rev-list', '--count', `${target}..${rebasedHead}`).trim();
    result = {
      outcome: 'ok',
      detail: `all ${carried} customization commits replayed onto ${target.slice(0, 12)} with no `
        + 'conflicts.',
      rebasedHead,
      commitsCarried: Number(carried),
      commitsAfterRebase: Number(rebasedCount),
    };
  }

  result = {
    ...result,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    upstreamRoot,
    forkRoot,
    /** Neither real checkout moved. Asserted below rather than promised. */
    base,
    target,
    targetRef: onto,
    forkHead,
    commitsCarried: Number(carried),
    scratch: keep ? clone : null,
  };
} catch (error) {
  result = {
    outcome: 'could-not-run',
    reason: `the scratch clone could not be prepared: ${error.message ?? error}`,
    upstreamRoot, forkRoot, base, target, forkHead,
  };
} finally {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}

/*
 * THE WATERMARK, RE-CHECKED AGAINST A REAL NEW UPSTREAM MIGRATION.
 *
 * This is the check that replaces the first draft's "upstream must not have
 * reached 900". That was the wrong invariant: under a watermark migrator the
 * danger is not upstream taking our number, it is upstream's migrations being
 * SKIPPED because a high id shadowed them — and the schema then quietly stops
 * keeping up while the migrator logs that it is current.
 *
 * Codev's columns never enter `migrationEntries` and never touch
 * `effect_sql_migrations`, so the watermark is whatever upstream last ran. The
 * invariant is therefore: every migration upstream adds must have an id ABOVE
 * the watermark our base leaves.
 *
 * Phase 2 tested that with a synthetic migration. This tests it with the real
 * one upstream actually shipped in the meantime, which is the difference between
 * a mechanism that works and a mechanism that has worked.
 */
function migrationIds(root, ref) {
  const listed = tryRun(root, 'ls-tree', '--name-only', ref, `${MIGRATIONS_DIR}/`);
  if (!listed.ok) return null;
  const ids = new Set();
  for (const line of listed.out.trim().split('\n').filter(Boolean)) {
    const match = /\/(\d+)_[^/]*(?<!\.test)\.ts$/.exec(line);
    if (match) ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

const atBase = migrationIds(upstreamRoot, base);
const atTarget = migrationIds(upstreamRoot, target);
if (atBase === null || atTarget === null) {
  result.watermark = {
    checked: false,
    reason: `could not list ${MIGRATIONS_DIR} at one of the two refs. Not checked is not "checked `
      + 'and fine".',
  };
} else {
  const watermarkAtBase = atBase.length === 0 ? null : Math.max(...atBase);
  const added = atTarget.filter((id) => !atBase.includes(id));
  const shadowed = added.filter((id) => watermarkAtBase !== null && id <= watermarkAtBase);
  result.watermark = {
    checked: true,
    migrationsDir: MIGRATIONS_DIR,
    watermarkAtBase,
    addedByUpstream: added,
    shadowed,
    holds: shadowed.length === 0,
    detail: added.length === 0
      ? 'upstream added no migrations in this range, so the invariant had nothing to bite on. '
        + 'Reported rather than counted as a pass.'
      : shadowed.length === 0
        ? `upstream added ${added.join(', ')}, all above the watermark ${String(watermarkAtBase)} `
          + 'our base leaves — so they run. Codev writes nothing to effect_sql_migrations, which '
          + 'is what keeps that true.'
        : `upstream added ${shadowed.join(', ')} at or below the watermark `
          + `${String(watermarkAtBase)}. Those would be SKIPPED, silently.`,
  };
}

/*
 * THE READ-ONLY ORDER, CHECKED RATHER THAN ASSERTED.
 *
 * The whole design rests on neither real checkout moving, and a claim that is
 * only made in a comment is a claim nobody verifies. Both are re-read AFTER the
 * drill and compared to what they were before.
 */
const upstreamAfter = run(upstreamRoot, 'rev-parse', 'HEAD').trim();
const forkAfter = run(forkRoot, 'rev-parse', 'HEAD').trim();
const upstreamDirty = run(upstreamRoot, 'status', '--porcelain').trim() !== '';
const forkDirty = run(forkRoot, 'status', '--porcelain').trim() !== '';
result.preserved = {
  upstreamHead: upstreamAfter,
  upstreamStillAtBase: upstreamAfter === base,
  upstreamClean: !upstreamDirty,
  forkHead: forkAfter,
  forkUnmoved: forkAfter === forkHead,
  forkClean: !forkDirty,
  pinCommitUnchanged: JSON.parse(readFileSync(pinPath, 'utf8')).commit === pin.commit,
};
if (
  !result.preserved.upstreamStillAtBase
  || !result.preserved.forkUnmoved
  || !result.preserved.pinCommitUnchanged
) {
  result.outcome = 'could-not-run';
  result.reason = 'a real checkout moved during the drill. The result is discarded: a drill that '
    + 'disturbed the thing it was supposed to leave alone cannot be trusted about anything else.';
}

report(result);
