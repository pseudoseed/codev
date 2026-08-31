#!/usr/bin/env node
/**
 * Spec 146 — the pinned t3code server harness.
 *
 * Phases 1 through 4 all say "against a live server on the pinned commit", and
 * before this existed nothing provided one. Worse, nothing checked: a phase could
 * pass against whatever server happened to be listening, which makes the pin a
 * comment rather than a control.
 *
 * So `verify` is the load-bearing verb here, not `start`. The architect's
 * instruction is explicit — do not let a later phase quietly test against the
 * wrong server, and make that failure loud.
 *
 * Commands:
 *   acquire   clone/fetch the pinned commit into a checkout
 *   verify    assert both checkouts, and any running server, match pin.json
 *   verify-upstream / verify-fork   assert one identity only
 *   start     start a server from the pinned checkout on a private data dir
 *             (--keep-data opens an existing one instead of wiping it)
 *   restart   stop and start again, KEEPING the data dir
 *   stop      stop it
 *   status    report what is running and whether it matches the pin
 *
 * Exit codes: 0 ok, 1 mismatch or failure, 3 "could not determine".
 * Three codes, not two, because "I could not tell" must not exit the same way as
 * "verified fine".
 *
 * ---------------------------------------------------------------------------
 * Spec 250 — two identities.
 *
 * `acquire`, `start` and `status` are pinned to `upstreamBase`, NOT to
 * `pin.commit`. `acquire()` runs `checkout --detach` against the upstream clone;
 * once `pin.commit` names the fork head, leaving that line on `pin.commit` would
 * write a FORK sha into the read-only upstream clone, from an ordinary test run.
 * The server this harness starts is the upstream one, because it is what the spec
 * 146 and 236 evidence reproduces against.
 *
 * `verify` is the verb that knows about both: upstream at `upstreamBase`, fork at
 * `commit`, and `merge-base(commit, upstreamBase) === upstreamBase` so a rebase
 * that dropped the base cannot pass quietly.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MISMATCH, OK, UNDETERMINED, classifyForkHead, resolveIdentities } from '../t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/**
 * `T3_PIN_FILE` overrides which pin this run asserts against.
 *
 * It exists so the two-identity failure modes can be tested for real. "Fork is
 * dirty at its pin" and "the fork's merge-base is not upstreamBase" are only
 * reachable with checkouts that actually sit on the pinned shas, and a test
 * cannot make a throwaway repository produce t3code's shas. The alternative was
 * to assert those paths by reading the source, which proves nothing about what
 * the process does.
 */
const pinPath = process.env.T3_PIN_FILE ?? join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));

const { upstream, fork } = resolveIdentities(pin);

/**
 * The upstream clone. Every verb below except `verify`'s fork half works against
 * this one, and it is pinned to `upstreamBase` rather than `pin.commit`.
 */
const t3Root = upstream.root;
const runtimeDir = process.env.T3_HARNESS_DIR ?? join(here, '.runtime');
const pidFile = join(runtimeDir, 'server.pid');
const portFile = join(runtimeDir, 'server.port');
const runtimeFile = join(runtimeDir, 'server-runtime.json');
const port = Number(process.env.T3_HARNESS_PORT ?? 3799);

function say(message) {
  console.error(`[t3-server] ${message}`);
}

function die(code, message) {
  say(message);
  process.exit(code);
}

function gitIn(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// ------------------------------------------------------------------ acquire

/**
 * Acquire the UPSTREAM checkout at `upstreamBase`.
 *
 * The commit named here is `upstream.commit`, never `pin.commit`. This function
 * is the only one in the file that writes to a checkout, `smoke.mjs` and
 * `live/integration.mjs` both call it, and once the fork diverges `pin.commit`
 * names a sha that exists only in the fork. Checking that out here would move the
 * read-only clone off its pin and invalidate every piece of recorded evidence,
 * silently, from a test run nobody thought was destructive.
 */
function acquire() {
  const wanted = upstream.commit;
  if (!existsSync(t3Root)) {
    die(
      UNDETERMINED,
      `No upstream checkout at ${t3Root}. Clone it first:\n` +
        `  git clone ${upstream.repo} ${t3Root}\n` +
        `Then re-run. This harness never clones into a path it did not create.`,
    );
  }
  try {
    gitIn(t3Root, 'cat-file', '-e', `${wanted}^{commit}`);
    say(`upstream base ${wanted.slice(0, 12)} already present`);
  } catch {
    say(`fetching ${wanted.slice(0, 12)}...`);
    gitIn(t3Root, 'fetch', 'origin');
  }

  // Actually check it out. An earlier version fetched and then said "acquire ok",
  // leaving the tree wherever it already was — so `acquire` reported success
  // without acquiring anything, and only `verify` would have noticed.
  const head = gitIn(t3Root, 'rev-parse', 'HEAD');
  if (head !== wanted) {
    const dirty = gitIn(t3Root, 'status', '--porcelain');
    if (dirty) {
      die(
        MISMATCH,
        `Upstream checkout has uncommitted changes; refusing to check out ${wanted.slice(0, 12)} over them.\n${dirty}`,
      );
    }
    say(`checking out ${wanted.slice(0, 12)} (was ${head.slice(0, 12)})`);
    gitIn(t3Root, 'checkout', '--detach', wanted);
  }

  verifyUpstream();
}

// ------------------------------------------------------------------ verify

/**
 * Resolve one identity's HEAD, or die with the right code.
 *
 * Split out of `verifyCheckout` because the fork answers a different question
 * about its HEAD than the upstream clone does.
 */
function headOf(identity) {
  const label = identity.name;
  if (!existsSync(identity.root)) {
    die(
      UNDETERMINED,
      `NO_${label.toUpperCase()}_CHECKOUT: could not check: nothing at ${identity.root}. ` +
        `Set ${identity.rootVar} or create the checkout. This is "unknown", not "fine".`,
    );
  }
  try {
    return gitIn(identity.root, 'rev-parse', 'HEAD');
  } catch (error) {
    die(
      UNDETERMINED,
      `NO_${label.toUpperCase()}_HEAD: could not check: could not read HEAD of ${identity.root}: ${error.message}`,
    );
  }
  return null; // unreachable; `die` exits
}

/** Assert a checkout's tree is clean, or die. Never returns "clean" for unknown. */
function assertClean(identity) {
  const label = identity.name;
  let dirty = '';
  try {
    dirty = gitIn(identity.root, 'status', '--porcelain');
  } catch (error) {
    // A `git status` that fails answered nothing. Falling through to the empty
    // string here reported "clean" for a checkout nobody could read — the
    // comment said undetermined and the code said fine, which is the exact
    // spelling mistake the third exit code exists to prevent.
    die(
      UNDETERMINED,
      `NO_${label.toUpperCase()}_STATUS: could not check: \`git status\` failed in ${identity.root}: ` +
        `${error.message}. Whether the tree is clean is unknown, and unknown is not clean.`,
    );
  }
  if (dirty) {
    die(
      MISMATCH,
      `DIRTY_${label.toUpperCase()}_CHECKOUT (identity: ${label})\n` +
        `${identity.root} is at its pinned commit but has uncommitted changes:\n${dirty}\n` +
        `Results from it are not reproducible.`,
    );
  }
}

/**
 * The fork's HEAD against `pin.commit`, in three outcomes rather than two.
 *
 * `pin.commit` means "the vendored contract was generated from this commit", and
 * only regeneration moves it. So between the fork's first customization commit
 * and that regeneration, the fork checkout is legitimately AHEAD of the pin.
 *
 * Spelling that the same as a wrong commit would fire a mismatch for several
 * phases straight, and a signal that fires constantly is one people stop reading
 * — then it fires for a real reason and nobody looks. So:
 *
 *   descends from pin.commit   FORK_AHEAD_OF_CONTRACT. Exit 0 while
 *                              `contractSource` is `upstream`; exit 1 once
 *                              regeneration has set it to `fork`.
 *   does not descend           FORK_CHECKOUT_MISMATCH, exit 1, always.
 */
function verifyForkHead() {
  const head = headOf(fork);
  if (head === fork.commit) return head;

  let descendant = false;
  try {
    gitIn(fork.root, 'merge-base', '--is-ancestor', fork.commit, head);
    descendant = true;
  } catch (error) {
    // Exit 1 from `--is-ancestor` is the answer "no". Anything else is the tool
    // failing, which is not an answer at all.
    if (error.status !== 1) {
      die(
        UNDETERMINED,
        `NO_FORK_ANCESTRY: could not check: could not decide whether ${head.slice(0, 12)} descends ` +
          `from ${fork.commit.slice(0, 12)} in ${fork.root}: ${error.message}`,
      );
    }
  }

  const verdict = classifyForkHead({
    head, commit: fork.commit, descendant, contractSource: fork.contractSource,
  });

  if (verdict.state === 'wrong-commit') {
    die(
      MISMATCH,
      `${verdict.signal} (identity: fork)\n` +
        `  pin.json: ${fork.commit}\n` +
        `  ${fork.root}: ${head}\n` +
        `The fork is not on the contract commit and does not descend from it.`,
    );
  }

  if (!verdict.ok) {
    die(
      MISMATCH,
      `${verdict.signal} (identity: fork)\n` +
        `  contract commit: ${fork.commit}\n` +
        `  fork HEAD:       ${head}\n` +
        `pin.contractSource is "fork", so the vendored contract was generated from ${fork.commit.slice(0, 12)} ` +
        `and the checkout has moved past it. Regenerate and move the pin together, or check the ` +
        `contract commit back out.`,
    );
  }

  say(
    `${verdict.signal}: fork is ${head.slice(0, 12)}, ahead of contract commit ` +
      `${fork.commit.slice(0, 12)}. Expected while pin.contractSource is "upstream" — the contract ` +
      `has not been regenerated from the fork yet (that is phase 5).`,
  );
  return head;
}

/**
 * Assert one checkout sits clean on the commit its identity pins it to.
 *
 * Every failure names WHICH identity failed. With one checkout "CHECKOUT_MISMATCH"
 * was unambiguous; with two it is a sentence that does not say what to fix.
 */
function verifyCheckout(identity, mismatchSignal) {
  const head = headOf(identity);

  if (head !== identity.commit) {
    die(
      MISMATCH,
      `${mismatchSignal} (identity: ${identity.name})\n` +
        `  pin.json: ${identity.commit}\n` +
        `  ${identity.root}: ${head}\n` +
        `Any phase that tested against this was not testing the pinned contract.`,
    );
  }

  assertClean(identity);
  return head;
}

/** The read-only clone of pingdotgg/t3code, pinned at `upstreamBase`. */
function verifyUpstream(mismatchSignal = 'CHECKOUT_MISMATCH') {
  const head = verifyCheckout(upstream, mismatchSignal);
  // `upstreamBaseDate`, not `commitDate`: this line is about the UPSTREAM checkout.
  say(`verified upstream: ${upstream.root} is clean at ${head.slice(0, 12)} (${pin.upstreamBaseDate})`);
  return head;
}

/**
 * The private customization checkout, pinned at `commit`.
 *
 * Beyond "clean at the pin" it asserts the fork still *descends* from
 * `upstreamBase`. A rebase, a squash, or a fresh branch cut from somewhere else
 * all leave a fork that is clean at a commit nobody can relate to upstream, and
 * without this check that state verifies green while every churn range computed
 * from it is meaningless. An unresolvable merge-base is `3`, not `1`: we could
 * not tell, which is not the same as "it failed".
 */
function verifyFork() {
  const head = verifyForkHead();
  assertClean(fork);

  let mergeBase;
  try {
    mergeBase = gitIn(fork.root, 'merge-base', head, fork.base);
  } catch (error) {
    die(
      UNDETERMINED,
      `NO_FORK_MERGE_BASE: could not check: could not resolve merge-base of ${head.slice(0, 12)} ` +
        `and upstreamBase ${fork.base.slice(0, 12)} in ${fork.root}: ${error.message}`,
    );
  }

  if (mergeBase !== fork.base) {
    die(
      MISMATCH,
      `FORK_BASE_MISMATCH (identity: fork)\n` +
        `  upstreamBase:      ${fork.base}\n` +
        `  merge-base:        ${mergeBase}\n` +
        `The fork no longer descends from the upstream base it claims. Every fork-drift\n` +
        `range measured against ${fork.base.slice(0, 12)} would be a diff between unrelated trees.`,
    );
  }

  say(
    `verified fork: ${fork.root} is clean at ${head.slice(0, 12)} on ${fork.base.slice(0, 12)}` +
      `${head === fork.base ? ' (not yet diverged)' : ''}`,
  );
  return head;
}

/**
 * Both identities. `start` and `acquire` deliberately verify only upstream.
 *
 * The signal is the UPSTREAM half's. `ready` passes `CHECKOUT_MOVED_DURING_RUN`,
 * which is a different fact from a checkout that was wrong before the server
 * started. The fork half has its own three-outcome vocabulary and does not take
 * a caller's signal, because "ahead of the contract" and "wrong commit" are not
 * the same event and neither is the caller's to name.
 */
function verify(mismatchSignal) {
  const upstreamHead = verifyUpstream(mismatchSignal ?? 'CHECKOUT_MISMATCH');
  const forkHead = verifyFork();
  return { upstream: upstreamHead, fork: forkHead };
}

// ------------------------------------------------------------------ start / stop

function parsedVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

/** The checkout currently declares a caret range. Unknown syntax stays advisory/unknown. */
function engineMatch(version, range) {
  const actual = parsedVersion(version);
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)?.slice(1).map(Number);
  if (!actual || !wanted) return null;
  const [major, minor, patch] = actual;
  const [wantMajor, wantMinor, wantPatch] = wanted;
  const atLeast = major > wantMajor ||
    (major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch)));
  const belowUpper = wantMajor > 0 ? major < wantMajor + 1
    : wantMinor > 0 ? major === 0 && minor < wantMinor + 1
      : major === 0 && minor === 0 && patch < wantPatch + 1;
  return atLeast && belowUpper;
}

/** Resolve the server interpreter once, then invoke it by absolute path. */
function serverRuntime() {
  const requested = process.env.T3_NODE?.trim();
  if (!requested) {
    die(
      UNDETERMINED,
      'NO_INTERPRETER: could not check: T3_NODE is not set. The harness never inherits its server Node from PATH.',
    );
  }

  let node;
  try {
    if (!isAbsolute(requested)) throw new Error('not absolute');
    node = realpathSync(requested);
  } catch {
    die(
      UNDETERMINED,
      `NO_INTERPRETER: could not check: T3_NODE=${requested} is not an absolute path to an executable.`,
    );
  }

  let version;
  try {
    version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch {
    die(UNDETERMINED, `NO_INTERPRETER: could not check: ${node} could not execute \`--version\`.`);
  }

  let packageJson;
  const packagePath = join(t3Root, 'package.json');
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    die(
      UNDETERMINED,
      `CHECKOUT_UNAVAILABLE: could not check: cannot read t3code package metadata at ${packagePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declaredEngine = packageJson.engines?.node ?? 'not declared';
  const matchesDeclaredEngine = engineMatch(version, declaredEngine);
  const npx = join(dirname(node), 'npx');
  let npxCli;
  try {
    npxCli = realpathSync(npx);
  } catch {
    die(UNDETERMINED, `NO_INTERPRETER: could not check: ${node} has no sibling npx executable.`);
  }

  const info = { node, version, declaredEngine, matchesDeclaredEngine, npxCli };
  if (matchesDeclaredEngine === false) {
    say(
      `ADVISORY: Node ${version} is outside t3code engines.node ${declaredEngine}; ` +
        'continuing because server readiness, not the advisory range, is the gate.',
    );
  }
  return info;
}

/**
 * Is this PID one of ours?
 *
 * `stop` used to SIGTERM every process listening on the configured port, on the
 * reasoning that the real server is a grandchild of the pid we recorded. That is
 * true and it was still wrong: on a machine where something unrelated happens to
 * hold 3799, it would have killed a service this project does not own. Review
 * caught it.
 *
 * Ownership is proven from the command line: it must be a t3 serve for OUR data
 * directory. Anything we cannot prove is ours is reported and left alone.
 */
/**
 * Can this harness PROVE the process is its own pinned server?
 *
 * This decides what gets a SIGTERM, so the claim it makes has to be the claim it
 * performs. It used to be `cmd.includes(runtimeDir)` under a docblock promising "a
 * `t3 serve` for OUR data directory" — and a substring of a path is not that. Anything
 * whose argv merely mentions the directory satisfied it: `tail -f
 * <runtimeDir>/server.log`, an editor opened on the log, a `grep` over the tree. Each
 * would then have taken the group signal. Round 3 established that liveness is not
 * ownership; a substring is not ownership either, and the docblock asserted the stronger
 * thing.
 *
 * What is actually checked now, on both processes the harness creates — the `npm exec`
 * wrapper and the `node .../t3` grandchild that holds the port:
 *
 *   npm exec t3@0.0.36 serve --host 127.0.0.1 --port 3801 --base-dir <dataDir> <checkout>
 *   node .../node_modules/.bin/t3 serve --host 127.0.0.1 --port 3801 --base-dir <dataDir> <checkout>
 *
 * - a bare `serve` argument, and
 * - `--base-dir <dataDir>` (or `--base-dir=<dataDir>`) as an actual argument pair, not a
 *   path appearing anywhere in the line.
 *
 * Both, because either alone is satisfiable by something that is not our server. This is
 * still an argv heuristic and not a kernel-level proof of parentage — but it is the claim
 * the docblock makes, which the substring was not.
 */
function ownsProcess(pid) {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!cmd) return false;
    const dataDir = join(runtimeDir, 'data');
    const args = cmd.split(/\s+/);
    const serves = args.includes('serve');
    // The pair form and the `=` form, both as whole arguments.
    const boundToOurData = args.some((arg, i) =>
      (arg === '--base-dir' && args[i + 1] === dataDir) || arg === `--base-dir=${dataDir}`);
    return serves && boundToOurData;
  } catch {
    return false; // cannot read it, cannot claim it
  }
}

/**
 * PIDs listening on our port that we can prove belong to this harness.
 *
 * THREE ANSWERS, because `lsof` exits non-zero for two different reasons and only one
 * of them means "nothing is listening". It also exits 1 when it is missing, refused, or
 * cannot read a proc table — and that was folded into an empty result, so a tool that
 * could not answer read as a port that is free. `restart` then started a second server
 * on a port the first may still hold, which is the "I could not tell" spelled as "no"
 * that this whole harness exists to refuse.
 *
 * `known` is false only when the tool itself failed. An empty listing with `known: true`
 * is a real, checked, negative answer.
 */
function ownedPortHolders() {
  let holders = [];
  try {
    holders = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    // `lsof` exits 1 with EMPTY output when nothing matches — the ordinary case — and
    // exits 1 with something on stderr, or fails to spawn at all, when it could not look.
    const spawnFailed = err && (err.code === 'ENOENT' || err.code === 'EACCES');
    const said = String(err?.stderr ?? '').trim();
    if (spawnFailed || said !== '') return { ours: [], foreign: [], known: false, why: said || String(err?.code ?? err) };
    return { ours: [], foreign: [], known: true };
  }
  const ours = holders.filter(ownsProcess);
  const foreign = holders.filter((p) => !ours.includes(p));
  return { ours, foreign, known: true };
}

/**
 * The pid in the pid file, if a process with that id is alive.
 *
 * LIVENESS ONLY. `process.kill(pid, 0)` says a process exists, not that it is ours,
 * and pids are reused. Use {@link readOwnedPid} before signalling.
 */
function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * The pid in the pid file, if it is alive AND this harness can prove it owns it.
 *
 * `stop` signalled whatever `readPid` returned, and `readPid` proves liveness rather
 * than ownership. A stale pid file whose pid has been reused by something unrelated
 * passes that check, and `stop` then sends SIGTERM to that process GROUP — killing
 * someone else's work on the strength of a number in a file this harness wrote
 * earlier. `ownsProcess` already exists for the port sweep, which refuses to kill what
 * it cannot prove it owns; the pid path is the one place that rule was not applied.
 *
 * Returns `{ pid, owned }` so a caller can tell "nothing there" from "something there
 * that is not mine" — those are different facts and only the second is worth saying.
 */
function readOwnedPid() {
  const pid = readPid();
  if (pid === null) return { pid: null, owned: false };
  return { pid, owned: ownsProcess(pid) };
}

/**
 * Confirm the spawned server is still alive a moment after `spawn` returned.
 *
 * `spawn` succeeding means a process was created, not that it stayed. Reporting
 * "started pid N" for a process that has already exited is a check announcing a
 * result it never measured, which is the failure mode this whole harness exists
 * to avoid making.
 */
function assertChildSurvived(pid, runtime) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      // Redact first: the log is read below and may hold a pairing token.
      pairingToken();
      const log = join(runtimeDir, 'server.log');
      const tail = existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter((line) => /error|fatal|cannot/i.test(line)).slice(-3).join('\n')
        : '';
      die(
        MISMATCH,
        `SERVER_START_FAILED: t3@${pin.cliVersion} under Node ${runtime.version} ` +
          `exited immediately after starting (pid ${pid}).\n` +
          (tail ? `  From its log:\n    ${tail.replace(/\n/g, '\n    ')}` : '  Its log records nothing.'),
      );
    }
    execFileSync('sleep', ['0.25']);
  }
}

/**
 * Start the pinned server.
 *
 * `keepData` is the whole difference between a cold start and a restart, and it
 * defaults to false because every existing caller wants a cold one: the phase-1
 * cold-start evidence is only evidence if the database is empty each time.
 *
 * A restart passes `true`, because a server that comes back with an erased
 * database is not the same server. Testing "does a thread survive a restart"
 * against a wiped data dir measures the wipe, and reports it as the thread's
 * fate.
 */
function start({ keepData = false } = {}) {
  // Upstream only. The server this harness starts IS the upstream one, and
  // requiring a fork checkout to exist before a spec 146 evidence run could start
  // would couple the older evidence to the newer customization for no reason.
  verifyUpstream();
  const runtime = serverRuntime();

  const existing = readPid();
  if (existing) die(MISMATCH, `A harness server is already running (pid ${existing}). Run \`stop\` first.`);

  mkdirSync(runtimeDir, { recursive: true });
  const dataDir = join(runtimeDir, 'data');
  if (keepData) {
    // Refuse rather than quietly cold-start. "There was nothing to preserve" and
    // "the state was preserved" must not exit the same way — a restart that
    // silently began from an empty database is exactly the false negative this
    // flag exists to prevent.
    if (!existsSync(dataDir)) {
      die(UNDETERMINED, `NO_DATA_TO_KEEP: could not check: ${dataDir} does not exist, so there is no server state to preserve. This would have been a cold start wearing a restart's name.`);
    }
  } else {
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });

  say(`starting on 127.0.0.1:${port} with data dir ${dataDir}${keepData ? ' (preserved)' : ''}`);

  const log = join(runtimeDir, 'server.log');
  // 0600: the server prints a pairing token on stdout and this file receives it
  // until `ready` redacts it. Narrow the window AND the audience.
  writeFileSync(log, '', { mode: 0o600 });

  // The child's stdio goes STRAIGHT to a file descriptor, never through a pipe
  // this process holds. An earlier version attached `child.stdout.on('data')`
  // handlers here: the server came up fine and then died the moment its parent
  // did, because writing to a broken pipe kills it. A harness whose server only
  // survives while the shell that started it survives is not a harness.
  const logFd = openSync(log, 'a');

  // Loopback only. Spec 146's Security constraints make loopback the default and
  // exposing an interface an explicit action; a test harness never exposes one.
  const child = spawn(
    runtime.node,
    [runtime.npxCli, '--yes', `t3@${pin.cliVersion}`, 'serve', '--host', '127.0.0.1', '--port', String(port), '--base-dir', dataDir, t3Root],
    {
      cwd: t3Root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // npm launches package bins through `#!/usr/bin/env node`. Put the chosen
      // interpreter first so that final hop cannot fall back to the harness's Node.
      env: { ...process.env, PATH: `${dirname(runtime.node)}:${process.env.PATH ?? ''}` },
    },
  );

  closeSync(logFd);
  writeFileSync(pidFile, String(child.pid));
  writeFileSync(portFile, String(port));
  writeFileSync(runtimeFile, `${JSON.stringify({ ...runtime, cliVersion: pin.cliVersion }, null, 2)}\n`);
  child.unref();

  assertChildSurvived(child.pid, runtime);

  say(`started pid ${child.pid}; log at ${log}`);
  say(`runtime: Node ${runtime.version}; pinned CLI: t3@${pin.cliVersion}`);
}

/**
 * Wait until the server answers, with a bound. Returns true when it is up.
 *
 * `start` returning is NOT evidence the server is up — `npx` may still be
 * downloading. A phase that dispatches immediately after `start` would fail for
 * a reason that has nothing to do with what it was testing.
 */
async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (response.status > 0) return true;
    } catch {
      /* not up yet */
    }
    if (!readPid()) {
      pairingToken();
      const log = join(runtimeDir, 'server.log');
      const tail = existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter((line) => /error|fatal|cannot/i.test(line)).slice(-3).join('\n')
        : '';
      die(
        MISMATCH,
        `SERVER_START_FAILED: server process exited before answering.\n` +
          (tail ? `  From its log:\n    ${tail.replace(/\n/g, '\n    ')}` : '  Its log records nothing.'),
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Read the pairing token, then REDACT it from the log.
 *
 * The spec's Security constraint is explicit: pairing tokens are "never written
 * to a repository, a log, or a shell history file". t3 prints the token on
 * stdout and this harness sends stdout to a file, so it lands in a log — a
 * direct violation, and review caught it.
 *
 * We cannot stop t3 printing it. What we can do is make the log stop holding it:
 * read once, overwrite that line in place, and return the value in memory only.
 * The file is also mode 0600 and gitignored.
 *
 * The residual window is stated rather than hidden: the token is on disk from
 * the moment the server prints it until `ready` runs, typically a few seconds.
 * Closing that completely would mean not persisting the server's stdout at all,
 * which costs the diagnostics that made three separate harness bugs findable.
 */
function pairingToken() {
  const log = join(runtimeDir, 'server.log');
  if (!existsSync(log)) return null;
  const contents = readFileSync(log, 'utf8');
  const token = /Token:\s*([A-Z0-9]+)/.exec(contents)?.[1] ?? null;
  if (token) {
    const redacted = contents
      .split(token).join('<redacted-pairing-token>')
      .replace(/(Pairing URL: \S*?#token=)\S+/g, '$1<redacted>');
    writeFileSync(log, redacted, { mode: 0o600 });
  }
  return token;
}

async function ready() {
  const up = await waitReady();
  if (!up) die(MISMATCH, `SERVER_START_FAILED: server did not answer on 127.0.0.1:${port} within the timeout.`);
  // UPSTREAM only, matching `start`. This asserts the checkout the running server
  // was started from has not moved underneath it, and that checkout is the
  // upstream clone. Verifying the fork here would make an upstream server start
  // fail the moment our customization branch moves ahead of `pin.commit` — a fork
  // move is not `CHECKOUT_MOVED_DURING_RUN`, and it says nothing about the process
  // that is answering on this port.
  verifyUpstream('CHECKOUT_MOVED_DURING_RUN');
  const token = pairingToken();
  if (!token) die(UNDETERMINED, 'Server is answering but printed no pairing token; cannot authenticate.');
  say(`ready on 127.0.0.1:${port}; pairing token present`);
  console.log(JSON.stringify({ port, token, pairingUrl: `http://127.0.0.1:${port}/pair#token=${token}` }, null, 2));
}

function stop() {
  rmSync(runtimeFile, { force: true });
  const { pid, owned } = readOwnedPid();
  if (pid !== null && !owned) {
    // The file names a live process this harness cannot claim. Signalling it is the
    // one irreversible thing `stop` can do wrong, and a reused pid is exactly how it
    // would happen. Drop the stale file, say so, and fall through to the port sweep —
    // which refuses foreign holders by the same rule.
    say(
      `REFUSING to signal pid ${pid} from ${pidFile}: it is alive but not ours (a reused pid, or a ` +
        `stale file). Removing the stale pid file; the port sweep below still applies.`,
    );
    rmSync(pidFile, { force: true });
  }
  if (!pid || !owned) {
    // Still sweep the port: a previous run may have left a listener with no
    // matching pid file, and reporting "nothing running" while a server holds
    // the port is the same lie as a check that passes without looking.
    const { ours, foreign } = ownedPortHolders();
    for (const holder of ours) {
      try { process.kill(holder, 'SIGTERM'); } catch { /* gone */ }
    }
    if (foreign.length > 0) {
      say(
        `REFUSING to kill pid(s) ${foreign.join(', ')} on port ${port}: not ours.\n` +
          `  Something outside this harness is listening there. Stop it yourself, or set\n` +
          `  T3_HARNESS_PORT to a free port. This harness does not kill what it cannot prove it owns.`,
      );
    }
    const pidNote = pid === null ? 'no pid file' : `pid ${pid} not ours`;
    say(ours.length > 0 ? `${pidNote}, but released port ${port} (pids ${ours.join(', ')})` : 'nothing running');
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
  rmSync(pidFile, { force: true });

  // The recorded pid is the `npx` wrapper; the server is its grandchild and can
  // outlive a group signal. Without this the port stays bound, and a later
  // "cold" start would silently reuse the previous server — making a
  // start-twice proof a proof of nothing.
  const { ours, foreign } = ownedPortHolders();
  for (const holder of ours) {
    try { process.kill(holder, 'SIGTERM'); } catch { /* gone */ }
  }
  if (ours.length > 0) say(`released port ${port} (pids ${ours.join(', ')})`);
  if (foreign.length > 0) say(`left pid(s) ${foreign.join(', ')} on port ${port} alone: not ours`);

  say(`stopped pid ${pid}`);
}

/**
 * Restart the running server without erasing its state.
 *
 * `stop` then `start` is not this: `start` wipes the data dir, so the pair is a
 * cold start with a restart's shape. Spec 146 phase 9's item 4 — "an architect
 * thread survives a server restart" — cannot be evaluated against that at all,
 * because the thread is deleted by the harness rather than by anything the
 * criterion is about.
 */
function restart() {
  // A running server, first. `stop` leaves the data dir in place, so a data dir is
  // NOT evidence that anything is running — `stop` then `restart` would have
  // succeeded with no server having been replaced, and reported a restart that did
  // not happen. What item 4 asks about is a process being replaced, and that has to
  // be true before this exits 0.
  const { pid, owned } = readOwnedPid();
  const holders = ownedPortHolders();
  if (!holders.known) {
    die(
      UNDETERMINED,
      `PORT_STATE_UNKNOWN: could not check: lsof could not report who holds port ${port} ` +
        `(${holders.why}). Whether a server is running there is unknown, and a restart must not ` +
        `begin from a guess.`,
    );
  }
  if ((!pid || !owned) && holders.ours.length === 0) {
    die(
      UNDETERMINED,
      `NOT_RUNNING: could not check: no harness server this process owns is running on port ${port}` +
        (pid !== null && !owned ? ` (pid ${pid} in ${pidFile} is alive but not ours)` : '') +
        (holders.foreign.length > 0
          ? `; pid(s) ${holders.foreign.join(', ')} hold it and are not ours.`
          : '.') +
        `\n  A restart of nothing is not a restart. Use \`start\` for a cold one.`,
    );
  }

  const dataDir = join(runtimeDir, 'data');
  if (!existsSync(dataDir)) {
    die(UNDETERMINED, `NO_DATA_TO_KEEP: could not check: ${dataDir} does not exist, so there is no server state to preserve.`);
  }

  stop();

  // `stop` signals; it does not wait. Starting before the old listener lets go
  // gives `start` a port already bound, and that failure has nothing to do with
  // the restart.
  const deadline = Date.now() + 30_000;
  let last = ownedPortHolders();
  while (Date.now() < deadline) {
    last = ownedPortHolders();
    if (last.known && last.ours.length === 0) break;
    execFileSync('sleep', ['0.25']);
  }
  if (!last.known) {
    // The tool failing to answer is not a negative answer. Proceeding here would start
    // a second server against a port whose state is unknown.
    die(
      UNDETERMINED,
      `PORT_STATE_UNKNOWN: could not check: lsof could not report who holds port ${port} ` +
        `(${last.why}). Whether the old server let go is unknown, and an unknown is not a release.`,
    );
  }
  if (last.ours.length > 0) {
    die(
      UNDETERMINED,
      `PORT_NOT_RELEASED: could not check: pid(s) ${last.ours.join(', ')} still hold port ${port} ` +
        `30s after stop. The old server was not replaced, and starting on top of it would test the ` +
        `wrong process.`,
    );
  }

  start({ keepData: true });
}

/**
 * Report what is running and whether the checkouts sit on their pins.
 *
 * `pin` / `checkout` / `matchesPin` keep their spec 146 meaning — the UPSTREAM
 * checkout against `upstreamBase` — because that is what the recorded evidence
 * and the running server describe. The fork is reported alongside as its own
 * object rather than folded into the same three keys, and its absence is
 * `available: false`, not a mismatch: the fork not being there is a different
 * fact from the fork being wrong.
 */
function status() {
  const pid = readPid();
  if (!existsSync(t3Root)) {
    console.log(JSON.stringify({ checkout: null, matchesPin: 'unknown', fork: null, server: null }, null, 2));
    process.exit(UNDETERMINED);
  }
  const head = gitIn(t3Root, 'rev-parse', 'HEAD');
  const matches = head === upstream.commit;

  let forkStatus = { root: fork.root, available: false, head: null, matchesPin: 'unknown' };
  if (existsSync(fork.root)) {
    try {
      const forkHead = gitIn(fork.root, 'rev-parse', 'HEAD');
      let descendant = false;
      try {
        gitIn(fork.root, 'merge-base', '--is-ancestor', fork.commit, forkHead);
        descendant = true;
      } catch { /* exit 1 is the answer "no"; anything else leaves state below */ }
      const verdict = classifyForkHead({
        head: forkHead, commit: fork.commit, descendant, contractSource: fork.contractSource,
      });
      forkStatus = {
        root: fork.root,
        available: true,
        head: forkHead,
        pin: fork.commit,
        matchesPin: forkHead === fork.commit,
        contractSource: fork.contractSource,
        state: verdict.state,
        ok: verdict.ok,
        signal: verdict.signal,
      };
    } catch {
      /* left as available:false / matchesPin:'unknown' — an unreadable HEAD is not a "no" */
    }
  }

  console.log(
    JSON.stringify(
      {
        pin: upstream.commit,
        checkout: head,
        matchesPin: matches,
        upstreamBase: upstream.commit,
        forkPin: fork.commit,
        fork: forkStatus,
        server: pid ? { pid, port: Number(readFileSync(portFile, 'utf8').trim()) } : null,
        runtime: existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, 'utf8')) : null,
      },
      null,
      2,
    ),
  );
  process.exit(matches ? OK : MISMATCH);
}

const command = process.argv[2];
switch (command) {
  case 'acquire': acquire(); break;
  case 'verify': verify(); break;
  // Per-identity verbs, so a caller that only depends on one checkout does not
  // acquire a dependency on the other. `smoke.mjs` and the live integration
  // script are upstream-only by design and use `verify-upstream`; bare `verify`
  // stays both, which is what the phase's acceptance criterion asserts.
  case 'verify-upstream': verifyUpstream(); break;
  case 'verify-fork': verifyFork(); break;
  // `--keep-data` starts on an EXISTING data dir without wiping it. `restart`
  // cannot serve this: it is stop-then-start and refuses when nothing is running,
  // which is exactly the case spec 250's criterion 8b needs — open a database this
  // process did not just create, with the pinned pre-fork binary. `start` alone
  // wipes the data dir, and a criterion about opening an existing file cannot be
  // tested by a verb that deletes it first.
  case 'start': start({ keepData: process.argv.includes('--keep-data') }); break;
  case 'restart': restart(); break;
  case 'ready': await ready(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'runtime': console.log(JSON.stringify(serverRuntime(), null, 2)); break;
  default:
    console.error('usage: t3-server.mjs <acquire|verify|verify-upstream|verify-fork|start [--keep-data]|restart|ready|stop|status|runtime>');
    process.exit(UNDETERMINED);
}
