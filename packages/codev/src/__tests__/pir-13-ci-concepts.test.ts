/**
 * Issue #13 — CI concepts for the forge layer.
 *
 * What is pinned here, and why each one is worth a test:
 *
 * 1. **The extraction ladder, against two REAL logs.** Both fixtures are
 *    verbatim captures, not hand-written samples: a 2528-line GitHub vitest
 *    failure (run 32515040122 of this repository) and a 1599-line Forgejo Go
 *    failure (codeberg.org/forgejo/forgejo job 11952749). They are stored
 *    gzipped because the exact bytes are the point — the ANSI escapes, the
 *    misleading lines, and the position of the real failure inside the file.
 *
 *    The three traps they carry are why this ladder is not three greps:
 *      - Every payload line is ANSI-wrapped. The FAIL token in the raw bytes is
 *        `ESC[41m ESC[1m FAIL ESC[22m ESC[49m src/…`, which no /^ FAIL/ rule
 *        matches. A matcher that skips the cleaning step reports "no recognized
 *        failure" on a log that plainly contains one.
 *      - The first line containing "Error:" is `[artifact-canvas] Error: host
 *        blew up`, printed by a PASSING test 1214 lines above the real failure.
 *      - "Test Files … passed" appears FOUR times before the summary that says
 *        failed.
 *
 * 2. **Refusal is a first-class outcome.** When nothing matches, the response
 *    carries `extracted: false`, the job identity, `logLines` and a
 *    ready-to-run `next`, and contains NO log lines at all. Returning "the last
 *    50 lines" instead is the failure mode this issue exists to remove: a
 *    builder treats them as the diagnosis and reasons from noise.
 *
 * 3. **A timeout reports as a timeout.** Through the script (envelope on
 *    stdout) and through the dispatcher (`executeForgeCommandDetailed().
 *    timedOut`). `executeForgeCommand` flattens every failure to `null`, which
 *    is how #12 shipped a `pr-exists` whose null read as "no PR exists".
 *
 * 4. **An old Forgejo is never mistaken for a green run.** Forgejo gained the
 *    Actions job-log API in 16.0; on 15.x these concepts return
 *    `unsupported-server` naming both versions, NOT an empty `failures` array.
 *
 * 5. **The measured Forgejo footguns.** `limit` is ignored unless `page` is
 *    also sent, and a `pull_request` run records `#<pr-number>` where a branch
 *    name would be. Neither is visible in a test that only checks output shape,
 *    so the requests themselves are asserted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { getForgeCommand, resolveAllConcepts, executeForgeCommandDetailed } from '../lib/forge.js';
import { runForgeConcept } from '../commands/forge.js';

const codevPkgRoot = path.resolve(import.meta.dirname, '..', '..');
const forgeScripts = path.join(codevPkgRoot, 'scripts', 'forge');
const githubDir = path.join(forgeScripts, 'github');
const giteaDir = path.join(forgeScripts, 'gitea');
const fixtures = path.join(import.meta.dirname, 'fixtures', 'pir-13');

const CI_CONCEPTS = ['ci-runs', 'ci-run-view', 'ci-failures', 'ci-run-log'] as const;

const ESC = '';

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fixtureLog(name: string): string {
  return zlib.gunzipSync(fs.readFileSync(path.join(fixtures, `${name}.log.gz`))).toString('utf-8');
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pir13-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, any> | null;
}

/** Run a provider script with a stubbed CLI on PATH. */
function run(dir: string, script: string, env: Record<string, string> = {}): RunResult {
  const result = spawnSync('sh', [path.join(dir, script)], {
    cwd: tmp,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      TMPDIR: path.join(tmp, 'cache'),
      CODEV_REPO: 'o/r',
      GH_LOG: path.join(tmp, 'gh.log'),
      TEA_LOG: path.join(tmp, 'tea.log'),
      // Every CODEV_CI_* the scripts read, cleared, so a variable set in the
      // developer's own shell cannot change what a test asserts.
      CODEV_CI_NO_CACHE: '1',
      CODEV_BRANCH_NAME: '', CODEV_CI_STATUS: '', CODEV_CI_WORKFLOW: '', CODEV_CI_LIMIT: '',
      CODEV_CI_RUN_ID: '', CODEV_CI_JOB_ID: '', CODEV_PR_BASE: '',
      CODEV_CI_LOG_TAIL: '', CODEV_CI_LOG_HEAD: '', CODEV_CI_LOG_GREP: '', CODEV_CI_LOG_CONTEXT: '',
      CODEV_FORGE_TIMEOUT: '', CODEV_CI_MAX_PAGES: '', CODEV_CI_TASKS_MAX_PAGES: '',
      CODEV_CI_MAX_STEP_BYTES: '', CODEV_CI_MAX_BYTES: '',
      ...env,
    },
  });
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(result.stdout);
  } catch { /* not every assertion needs JSON */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/** Write an executable stub onto the test PATH. */
function stub(name: string, body: string): void {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
}

function fileLines(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('#13 — the CI concepts are registered, and disabled where unimplemented', () => {
  it.each(CI_CONCEPTS)('routes %s to the github script by default', (concept) => {
    const command = getForgeCommand(concept, null);
    expect(command).toBe(path.join(githubDir, `${concept}.sh`));
    expect(fs.existsSync(command!)).toBe(true);
    expect(fs.statSync(command!).mode & 0o111, 'script is not executable').not.toBe(0);
  });

  it.each(CI_CONCEPTS)('routes %s to the gitea script for provider gitea', (concept) => {
    const command = getForgeCommand(concept, { provider: 'gitea' });
    expect(command).toBe(path.join(giteaDir, `${concept}.sh`));
    expect(fs.statSync(command!).mode & 0o111, 'script is not executable').not.toBe(0);
  });

  // The important half. A concept with no script does NOT resolve to nothing —
  // it falls through to the github default, so an unimplemented ci-runs on a
  // GitLab repo would silently run `gh run list`. Issue #13 asks for gitlab to
  // degrade loudly; `disabled` is what loud looks like here.
  it.each(['gitlab', 'linear'])(
    'DISABLES every CI concept for %s rather than letting it fall through to gh',
    (provider) => {
      for (const concept of CI_CONCEPTS) {
        expect(getForgeCommand(concept, { provider }), `${provider}/${concept} resolved to a command`).toBeNull();
        const resolution = resolveAllConcepts({ provider }).find((r) => r.concept === concept);
        expect(resolution?.source).toBe('disabled');
      }
    },
  );

  it('doctor resolves every CI script to its real CLI, not to a shell builtin', () => {
    for (const provider of ['github', 'gitea'] as const) {
      const expected = provider === 'github' ? 'gh' : 'tea';
      for (const concept of CI_CONCEPTS) {
        const resolution = resolveAllConcepts({ provider }).find((r) => r.concept === concept);
        expect(resolution?.executable, `${provider}/${concept}`).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The extraction ladder, against the real logs
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq())('#13 — extraction returns the assertion, not the log and not the wrong line', () => {
  /** Run the ladder the way the concepts do: clean, then extract. */
  function extract(raw: string): { rung: string; from: number; to: number; text: string } | null {
    const rawPath = path.join(tmp, 'raw.log');
    const cleanPath = path.join(tmp, 'clean.log');
    fs.writeFileSync(rawPath, raw);
    const script = [
      `. ${JSON.stringify(path.join(forgeScripts, '_ci-extract.sh'))}`,
      `ci_clean_log < ${JSON.stringify(rawPath)} > ${JSON.stringify(cleanPath)}`,
      `ci_extract ${JSON.stringify(cleanPath)}`,
    ].join('\n');
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf-8' });
    if (!r.stdout.trim()) return null;
    const [header, ...rest] = r.stdout.split('\n');
    const [rung, from, to] = header.split('\t');
    return { rung, from: Number(from), to: Number(to), text: rest.join('\n') };
  }

  it('finds the vitest assertion in a 2528-line GitHub log', () => {
    const raw = fixtureLog('github-vitest-failure');
    expect(raw.split('\n').length).toBeGreaterThan(2500);

    const got = extract(raw);
    expect(got, 'extraction returned nothing on a log containing a plain vitest failure').not.toBeNull();
    expect(got!.rung).toBe('vitest');
    expect(got!.text).toContain('AssertionError: expected null to be');
    expect(got!.text).toContain('agy-auth-cache.test.ts');
    expect(got!.text).toContain('Test Files  1 failed');
    // 23 lines out of 2528. The whole point.
    expect(got!.to - got!.from).toBeLessThan(60);
  });

  it('does NOT return the passing test fixture string that a first-error rule picks', () => {
    // `[artifact-canvas] Error: host blew up` is printed by a test that PASSES,
    // 1214 lines above the real failure. It is the single most plausible wrong
    // answer this ladder can give.
    const raw = fixtureLog('github-vitest-failure');
    expect(raw, 'the fixture no longer carries the decoy this test exists for').toContain('host blew up');
    expect(extract(raw)!.text).not.toContain('host blew up');
  });

  it('does NOT anchor on any of the earlier "Test Files … passed" lines', () => {
    const raw = fixtureLog('github-vitest-failure');
    const lines = raw.split('\n');
    const failing = lines.findIndex((l) => l.includes('Test Files') && l.includes('failed') && !l.includes('grep'));
    const earlier = lines.slice(0, failing).filter((l) => l.includes('Test Files'));
    // Four of them: three passing suite summaries, plus a shell line echoing
    // `grep -q "Test Files.*passed"`, which is its own flavour of the same trap.
    expect(earlier.length, 'the fixture no longer carries the trap this test exists for').toBe(4);

    const got = extract(raw)!;
    expect(got.text).toContain('1 failed');
    expect(got.from).toBeGreaterThan(failing - 40);
  });

  it('matches through ANSI escapes — the raw fixture has them and cleaning is load-bearing', () => {
    const raw = fixtureLog('github-vitest-failure');
    expect(raw, 'the fixture was normalised and no longer proves anything').toContain(`${ESC}[`);
    // The FAIL token in the raw bytes is wrapped, so no plain /FAIL / anchor
    // matches it until ci_clean_log has run.
    expect(raw).toMatch(new RegExp(`${ESC}\\[[0-9;]*m[^\\n]{0,20}FAIL`));
    const got = extract(raw)!;
    expect(got.text).toContain('FAIL');
    expect(got.text, 'escapes survived into the answer').not.toContain(ESC);
  });

  it('finds the Go failure in a 1599-line Forgejo log whose last 25 lines are git cleanup', () => {
    const raw = fixtureLog('forgejo-go-failure');
    const lines = raw.split('\n');
    // The case for extraction over tailing, stated as an assertion.
    expect(lines.slice(-25).join('\n')).not.toContain('--- FAIL');

    const got = extract(raw)!;
    expect(got.rung).toBe('go-test');
    expect(got.text).toContain('--- FAIL: TestReadPointerFromBuffer');
    expect(got.text).toContain('Should be false');
    expect(got.text).toContain('FAIL\tforgejo.org/modules/lfs');
  });

  it('returns NOTHING when nothing is recognisable, rather than an arbitrary slice', () => {
    const noise = Array.from(
      { length: 400 },
      (_, i) => `2026-08-21T18:47:0${i % 10}.0000000Z step ${i} did a thing`,
    ).join('\n');
    expect(extract(noise)).toBeNull();
  });

  it('refuses a bare "Process completed with exit code 1" as a diagnosis', () => {
    const log = ['Running the thing', 'more output', '##[error]Process completed with exit code 1.'].join('\n');
    expect(extract(log)).toBeNull();
  });

  it('accepts a line-anchored error where a mid-line one is ignored', () => {
    const decoy = [
      '[pkg] Error: this one is printed by a passing test',
      'ok',
      'Error: the real one',
      'trailing',
    ].join('\n');
    const got = extract(decoy)!;
    expect(got.rung).toBe('first-error');
    expect(got.text).toContain('Error: the real one');
    // The decoy may appear as leading CONTEXT — three lines either side is the
    // rule — but it must not be the line the rung anchored on. `to` is the
    // anchor plus context, so the anchor is the real one at line 3.
    expect(got.to).toBe(4);
  });

  it('strips the RFC3339 timestamp both providers prefix to every line', () => {
    const got = extract(['2026-08-21T18:47:09.5820646Z Error: boom', '2026-08-21T18:47:10.0000000Z after'].join('\n'))!;
    expect(got.text).toContain('Error: boom');
    expect(got.text).not.toContain('2026-08-21T18:47:09');
  });
});

// ---------------------------------------------------------------------------
// ci-failures, end to end against a stubbed gh
// ---------------------------------------------------------------------------

/** A gh stub serving `run view --json` and `api …/logs` from files. */
function stubGh(runJson: unknown, logFile?: string): void {
  fs.writeFileSync(path.join(tmp, 'run.json'), JSON.stringify(runJson));
  stub('gh', [
    'printf "%s\\n" "$*" >> "$GH_LOG"',
    'if [ "$1" = "run" ] && [ "$2" = "view" ] && [ "$4" = "--json" ]; then cat "$(dirname "$0")/run.json"; exit 0; fi',
    'if [ "$1" = "run" ] && [ "$2" = "list" ]; then cat "$(dirname "$0")/run.json"; exit 0; fi',
    logFile
      ? `if [ "$1" = "api" ]; then cat ${JSON.stringify(logFile)}; exit 0; fi`
      : 'if [ "$1" = "api" ]; then echo "no log" >&2; exit 1; fi',
    'echo "unexpected gh invocation: $*" >&2',
    'exit 9',
  ].join('\n'));
}

const ONE_FAILING_JOB = {
  databaseId: 32515040122,
  number: 42,
  displayTitle: 'a commit',
  workflowName: 'Tests',
  name: 'Tests',
  status: 'completed',
  conclusion: 'failure',
  headBranch: 'builder/pir-13',
  headSha: 'abc123',
  event: 'push',
  url: 'https://github.com/o/r/actions/runs/32515040122',
  createdAt: '2026-08-21T18:46:21Z',
  jobs: [
    { databaseId: 1, name: 'Lint', status: 'completed', conclusion: 'success', startedAt: null, completedAt: null, steps: [] },
    {
      databaseId: 96874679182, name: 'Unit Tests', status: 'completed', conclusion: 'failure',
      startedAt: '2026-08-21T18:47:08Z', completedAt: '2026-08-21T18:49:07Z',
      steps: [
        { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success' },
        { name: 'Run unit tests with coverage', number: 15, status: 'completed', conclusion: 'failure' },
      ],
    },
  ],
};

describe.skipIf(!hasJq())('#13 — ci-failures returns a bounded extract with its provenance', () => {
  function writeFixtureTo(name: string): string {
    const p = path.join(tmp, `${name}.log`);
    fs.writeFileSync(p, fixtureLog(name));
    return p;
  }

  it('turns a 293 KB job log into a response of about a kilobyte', () => {
    const logPath = writeFixtureTo('github-vitest-failure');
    stubGh(ONE_FAILING_JOB, logPath);

    const r = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(r.status).toBe(0);
    expect(r.json!.ok).toBe(true);
    expect(r.json!.extracted).toBe(true);
    expect(r.json!.jobsFailed).toBe(1);

    const f = r.json!.failures[0];
    expect(f.jobId).toBe(96874679182);
    expect(f.jobName).toBe('Unit Tests');
    // The failing STEP name comes from structured JSON, not from parsing a log:
    // `gh run view --log-failed` labels its lines UNKNOWN STEP whenever its
    // filename-to-step mapping misses, which on the run this was captured from
    // was every line of all 2528.
    expect(f.stepName).toBe('Run unit tests with coverage');
    expect(f.stepNumber).toBe(15);
    expect(f.matchedBy).toBe('vitest');
    expect(f.text).toContain('AssertionError: expected null to be');
    expect(f.logLines).toBe(2528);
    expect(f.returnedLines).toBeLessThan(60);

    expect(fs.statSync(logPath).size).toBeGreaterThan(200_000);
    expect(r.stdout.length, 'the response is no longer bounded').toBeLessThan(8_192);
  });

  it('always reports logLines, returnedLines and truncated together', () => {
    stubGh(ONE_FAILING_JOB, writeFixtureTo('github-vitest-failure'));
    const f = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' }).json!.failures[0];
    for (const key of ['logLines', 'returnedLines', 'truncated']) {
      expect(f, `a trimmed answer without ${key} reads as a whole one`).toHaveProperty(key);
    }
  });

  it('marks truncated when the cap bites, and keeps whole lines', () => {
    stubGh(ONE_FAILING_JOB, writeFixtureTo('github-vitest-failure'));
    const r = run(githubDir, 'ci-failures.sh', {
      CODEV_CI_RUN_ID: '32515040122',
      CODEV_CI_MAX_STEP_BYTES: '200',
    });
    const f = r.json!.failures[0];
    expect(f.truncated).toBe(true);
    expect(f.returnedLines).toBeLessThan(23);
    expect(f.text.length).toBeLessThanOrEqual(260);
    expect(f.logLines).toBe(2528);
  });

  it('hands over instead of guessing when nothing is recognisable', () => {
    const noise = path.join(tmp, 'noise.log');
    fs.writeFileSync(noise, `${Array.from({ length: 900 }, (_, i) => `2026-08-21T18:47:00.000Z doing thing ${i}`).join('\n')}\n`);
    stubGh(ONE_FAILING_JOB, noise);

    const r = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(r.json!.extracted).toBe(false);
    expect(r.json!.reason).toBe('no recognized failure pattern');
    expect(r.json!.failures[0]).toEqual({ jobId: 96874679182, jobName: 'Unit Tests', logLines: 900 });
    expect(r.json!.next).toContain('CODEV_CI_JOB_ID=96874679182');
    // The rule this whole issue turns on: no arbitrary lines, ever.
    expect(r.stdout).not.toContain('doing thing');
    expect(r.json!.failures[0]).not.toHaveProperty('text');
  });

  it('says a green run is green, and distinguishes it from a run still going', () => {
    stubGh({ ...ONE_FAILING_JOB, conclusion: 'success', jobs: [ONE_FAILING_JOB.jobs[0]] });
    const green = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(green.status).toBe(0);
    expect(green.json!.jobsFailed).toBe(0);
    expect(green.json!.reason).toBe('no job in this run failed');

    stubGh({ ...ONE_FAILING_JOB, status: 'in_progress', conclusion: null, jobs: [ONE_FAILING_JOB.jobs[0]] });
    const running = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(running.json!.reason).toBe('run has not finished');
  });

  it('rejects a job id that is not in the run instead of answering "nothing failed"', () => {
    stubGh(ONE_FAILING_JOB, writeFixtureTo('github-vitest-failure'));
    const r = run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_JOB_ID: '999' });
    expect(r.status).not.toBe(0);
    expect(r.json!.error).toBe('not-found');
    expect(r.json!.ok).toBe(false);
  });

  it.each([
    ['ci-failures.sh', { CODEV_CI_RUN_ID: '../../etc/passwd' }],
    ['ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_JOB_ID: 'x; echo pwned', CODEV_CI_LOG_TAIL: '5' }],
    ['ci-run-view.sh', { CODEV_CI_RUN_ID: 'https://github.com/o/r/actions/runs/123' }],
  ])('%s rejects a non-numeric id before it reaches a URL or jq', (script, env) => {
    stubGh(ONE_FAILING_JOB);
    const r = run(githubDir, script, env);
    expect(r.status).toBe(2);
    expect(r.json!.error).toBe('bad-input');
    expect(r.json!.detail).toContain('must be a numeric id');
    expect(fileLines(path.join(tmp, 'gh.log'))).toEqual([]);
  });

  it('emits an envelope when the forge CLI exits 0 with something that is not JSON', () => {
    // An auth prompt, an empty body, an HTML error page. Without a guard this
    // reaches jq, dies under `set -e`, and leaves jq's diagnostic on stderr
    // with NOTHING on stdout — the one shape these concepts promised never to
    // produce.
    stub('gh', 'echo "gh: not logged into any hosts"');
    const r = run(githubDir, 'ci-run-view.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(r.status).not.toBe(0);
    expect(r.json!.error).toBe('forge-error');
    expect(r.json!.detail).toContain('did not return JSON');
  });

  it('translates the shared canceled into gh cancelled', () => {
    stubGh([]);
    run(githubDir, 'ci-runs.sh', { CODEV_CI_STATUS: 'canceled' });
    const calls = fileLines(path.join(tmp, 'gh.log'));
    expect(calls.some((c) => c.includes('--status cancelled'))).toBe(true);
  });

  it('fetches the per-job log endpoint, never --log-failed', () => {
    stubGh(ONE_FAILING_JOB, writeFixtureTo('github-vitest-failure'));
    run(githubDir, 'ci-failures.sh', { CODEV_CI_RUN_ID: '32515040122' });
    const calls = fileLines(path.join(tmp, 'gh.log'));
    expect(calls.some((c) => c.includes('actions/jobs/96874679182/logs'))).toBe(true);
    expect(calls.some((c) => c.includes('--log-failed')), '--log-failed returns the whole job, UNKNOWN STEP-tagged').toBe(false);
  });

  it('caches a terminal job log so the second question costs no download', () => {
    const logPath = writeFixtureTo('github-vitest-failure');
    stubGh(ONE_FAILING_JOB, logPath);
    const env = { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_NO_CACHE: '' };

    const first = run(githubDir, 'ci-failures.sh', env);
    expect(first.json!.cached).toBe(false);
    const second = run(githubDir, 'ci-failures.sh', env);
    expect(second.json!.cached).toBe(true);
    expect(second.json!.failures[0].text).toBe(first.json!.failures[0].text);
  });

  it('never caches a job that is still running', () => {
    const running = {
      ...ONE_FAILING_JOB,
      status: 'in_progress',
      jobs: [{ ...ONE_FAILING_JOB.jobs[1], status: 'in_progress', conclusion: null }],
    };
    stubGh(running, writeFixtureTo('github-vitest-failure'));
    const env = { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_JOB_ID: '96874679182', CODEV_CI_NO_CACHE: '' };
    run(githubDir, 'ci-failures.sh', env);
    const second = run(githubDir, 'ci-failures.sh', env);
    expect(second.json!.cached, 'a half-written log was cached and will read as complete forever').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ci-run-log
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq())('#13 — ci-run-log takes exactly one window, and says where it looked', () => {
  function stubWithFixture(): void {
    const p = path.join(tmp, 'gh-fixture.log');
    fs.writeFileSync(p, fixtureLog('github-vitest-failure'));
    stubGh(ONE_FAILING_JOB, p);
  }

  it('refuses with no window, and refuses BEFORE calling the forge', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(r.status).toBe(2);
    expect(r.json!.error).toBe('bad-input');
    expect(r.json!.detail).toContain('exactly one window');
    expect(fileLines(path.join(tmp, 'gh.log')), 'a malformed request cost an API call').toEqual([]);
  });

  it('refuses two windows — a default is how deliberate decays into always', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', {
      CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_TAIL: '5', CODEV_CI_LOG_HEAD: '5',
    });
    expect(r.status).toBe(2);
    expect(r.json!.detail).toContain('exactly one window may be set');
  });

  it('refuses a non-numeric line count, naming the variable in the caller spelling', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_TAIL: 'lots' });
    expect(r.status).toBe(2);
    expect(r.json!.detail).toContain('CODEV_CI_LOG_TAIL');
  });

  it('tail returns the last N lines with absolute line numbers', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_TAIL: '5' });
    expect(r.status).toBe(0);
    expect(r.json!.logLines).toBe(2528);
    expect(r.json!.returnedLines).toBe(5);
    expect(r.json!.from).toBe(2524);
    expect(r.json!.to).toBe(2528);
    expect(r.json!.contiguous).toBe(true);
    expect(r.json!.lines).toHaveLength(5);
  });

  it('head returns the first N lines', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_HEAD: '3' });
    expect(r.json!.from).toBe(1);
    expect(r.json!.to).toBe(3);
    expect(r.json!.lines[0]).toContain('Current runner version');
  });

  it('grep returns context, marks itself non-contiguous, and lists which lines matched', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', {
      CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_GREP: 'AssertionError', CODEV_CI_LOG_CONTEXT: '1',
    });
    expect(r.json!.matches).toBe(2);
    expect(r.json!.matchLines).toEqual([2472, 2497]);
    expect(r.json!.contiguous).toBe(false);
    expect(r.json!.returnedLines).toBe(6);
  });

  it('honours the context width', () => {
    stubWithFixture();
    const narrow = run(githubDir, 'ci-run-log.sh', {
      CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_GREP: 'AssertionError', CODEV_CI_LOG_CONTEXT: '0',
    });
    expect(narrow.json!.returnedLines).toBe(2);
  });

  it.each(['tail', 'head', 'grep'])('survives an EMPTY log in %s mode', (kind) => {
    // Without a guard, head/tail build `sed -n "1,0p"` — tolerated by BSD sed,
    // REJECTED by GNU sed, so on Linux the script aborted under `set -e` with
    // nothing on stdout. Found by the claude review lane on a macOS box, where
    // the defect is invisible.
    fs.writeFileSync(path.join(tmp, 'empty.log'), '');
    stubGh(ONE_FAILING_JOB, path.join(tmp, 'empty.log'));
    const env: Record<string, string> = { CODEV_CI_RUN_ID: '32515040122' };
    if (kind === 'tail') env.CODEV_CI_LOG_TAIL = '10';
    if (kind === 'head') env.CODEV_CI_LOG_HEAD = '10';
    if (kind === 'grep') env.CODEV_CI_LOG_GREP = 'anything';

    const r = run(githubDir, 'ci-run-log.sh', env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json!.ok).toBe(true);
    expect(r.json!.logLines).toBe(0);
    expect(r.json!.returnedLines).toBe(0);
    expect(r.json!.lines).toEqual([]);
    expect(r.json!.truncated).toBe(false);
  });

  it('builds no reversed sed range for an empty log', () => {
    // The portable-behaviour assertion, since the box this runs on may be the
    // one that tolerates it: reject the range itself, not just its effect.
    const lib = fs.readFileSync(path.join(forgeScripts, '_ci-lib.sh'), 'utf-8');
    expect(lib).toMatch(/if \[ "\$_total" -eq 0 \]; then/);
  });

  it('reports no match as an empty window rather than as a failure', () => {
    stubWithFixture();
    const r = run(githubDir, 'ci-run-log.sh', {
      CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_GREP: 'zzz-definitely-not-present',
    });
    expect(r.status).toBe(0);
    expect(r.json!.ok).toBe(true);
    expect(r.json!.matches).toBe(0);
    expect(r.json!.lines).toEqual([]);
    expect(r.json!.logLines).toBe(2528);
  });

  it('refuses to pick a job when several passed and none failed', () => {
    const green = {
      ...ONE_FAILING_JOB,
      conclusion: 'success',
      jobs: [
        { databaseId: 1, name: 'A', status: 'completed', conclusion: 'success', steps: [] },
        { databaseId: 2, name: 'B', status: 'completed', conclusion: 'success', steps: [] },
      ],
    };
    stubGh(green, path.join(tmp, 'nothing.log'));
    const r = run(githubDir, 'ci-run-log.sh', { CODEV_CI_RUN_ID: '32515040122', CODEV_CI_LOG_TAIL: '5' });
    expect(r.status).toBe(2);
    expect(r.json!.detail).toContain('set CODEV_CI_JOB_ID');
    expect(r.json!.jobs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq())('#13 — a timeout reports as a timeout, not as an empty result', () => {
  it('names the timeout on stdout and on stderr, and exits non-zero', () => {
    // A stub that spawns a child and waits: killing the wrapper alone leaves the
    // child holding the stdout pipe, which is the shape that made an earlier
    // watchdog print its message and hang anyway (#12).
    stub('gh', 'sleep 60 &\nwait');
    const started = Date.now();
    const r = run(githubDir, 'ci-runs.sh', { CODEV_FORGE_TIMEOUT: '2' });
    const elapsed = Date.now() - started;

    expect(r.status).not.toBe(0);
    expect(r.json!.ok).toBe(false);
    expect(r.json!.error).toBe('timeout');
    expect(r.json!.seconds).toBe(2);
    expect(r.json!.detail).toContain('gh run list');
    expect(r.json!.remedy).toContain('CODEV_FORGE_TIMEOUT');
    expect(r.stderr).toContain('did not return within 2s');
    expect(elapsed, 'the timeout did not actually unblock the caller').toBeLessThan(30_000);
  }, 40_000);

  it('does not leave the shell watchdog notice on a concept stderr', () => {
    stubGh(ONE_FAILING_JOB);
    const r = run(githubDir, 'ci-run-view.sh', { CODEV_CI_RUN_ID: '32515040122' });
    expect(r.status).toBe(0);
    expect(r.stderr, 'the watchdog is reporting its own death onto a clean path').toBe('');
  });

  it('codev forge puts its own ceiling ABOVE the script watchdog, so the named envelope wins', async () => {
    // The inversion the claude lane caught: executeForgeCommandDetailed defaults
    // to 30s and the scripts default to a 60s CODEV_FORGE_TIMEOUT, so at the
    // DEFAULTS Node killed the command first and the script's named timeout
    // envelope never printed. The earlier timeout test forced a 2s watchdog,
    // which hid it. This one pins the ordering itself.
    const watchdog = 4;
    // The stub lives one directory DOWN from a copy of _timeout.sh, because
    // _ci-lib.sh resolves its sibling as `$(dirname "$0")/../_timeout.sh` —
    // the same layout every real provider directory has.
    const providerDir = path.join(tmp, 'fake-provider');
    fs.mkdirSync(providerDir, { recursive: true });
    fs.copyFileSync(path.join(forgeScripts, '_timeout.sh'), path.join(tmp, '_timeout.sh'));
    const slow = path.join(providerDir, 'slow-forge.sh');
    fs.writeFileSync(
      slow,
      [
        '#!/bin/sh',
        `. ${JSON.stringify(path.join(forgeScripts, '_ci-lib.sh'))}`,
        'rc=0',
        'ci_tool sleep 30 || rc=$?',
        '[ "$rc" -eq 124 ] && ci_fail_timeout ci-runs "the slow forge" "$CI_TIMEOUT"',
        'exit 1',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.chmodSync(slow, 0o755);

    const root = path.join(tmp, 'ws-timeout');
    fs.mkdirSync(path.join(root, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codev', 'config.json'), JSON.stringify({ forge: { 'ci-runs': slow } }));

    const previous = process.env.CODEV_FORGE_TIMEOUT;
    process.env.CODEV_FORGE_TIMEOUT = String(watchdog);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runForgeConcept('ci-runs', {
        cwd: root,
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
      });
      // The SCRIPT reported, not Node: a named envelope on stdout, and an exit
      // status from the script rather than a signal kill.
      expect(JSON.parse(out.join('')), 'the outer ceiling fired first and ate the named envelope').toMatchObject({
        ok: false,
        error: 'timeout',
        seconds: watchdog,
      });
      expect(code).toBe(1);
      expect(code, 'Node killed it — 124 is the outer backstop, not the inner watchdog').not.toBe(124);
    } finally {
      if (previous === undefined) delete process.env.CODEV_FORGE_TIMEOUT;
      else process.env.CODEV_FORGE_TIMEOUT = previous;
    }
  }, 60_000);

  it('executeForgeCommandDetailed distinguishes a timeout from a failure and from silence', async () => {
    const slow = path.join(tmp, 'slow.sh');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    fs.chmodSync(slow, 0o755);

    const timedOut = await executeForgeCommandDetailed('ci-runs', {}, {
      forgeConfig: { 'ci-runs': slow },
      timeoutMs: 500,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.unavailable).toBe(false);

    const failing = path.join(tmp, 'fail.sh');
    fs.writeFileSync(failing, '#!/bin/sh\necho \'{"ok":false,"error":"forge-error"}\'\nexit 1\n', { mode: 0o755 });
    fs.chmodSync(failing, 0o755);

    const failed = await executeForgeCommandDetailed('ci-runs', {}, { forgeConfig: { 'ci-runs': failing } });
    expect(failed.ok).toBe(false);
    expect(failed.timedOut, 'a plain failure was reported as a timeout').toBe(false);
    // stdout survives a non-zero exit — the whole reason the envelope is printed
    // there rather than only on stderr.
    expect((failed.data as Record<string, unknown>).error).toBe('forge-error');

    const disabled = await executeForgeCommandDetailed('ci-runs', {}, { forgeConfig: { 'ci-runs': null } });
    expect(disabled.unavailable).toBe(true);
    expect(disabled.timedOut).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Forgejo: the measured footguns, and the version gate
// ---------------------------------------------------------------------------

/**
 * A fake `tea` serving the `tea api` slice these scripts use.
 *
 * TEA_ROUTES is a `<glob>\t<body-file>` table, first match wins, body emitted
 * verbatim from a FILE — a log contains newlines, which a line-oriented table
 * would silently truncate. Every requested endpoint is appended to TEA_LOG, so
 * a test can assert what was called AND what was not.
 */
const TEA_STUB = [
  'if [ "$1" != "api" ]; then echo "unexpected tea invocation: $*" >&2; exit 9; fi',
  'for a in "$@"; do ep=$a; done',
  'printf "%s\\n" "$ep" >> "$TEA_LOG"',
  'while IFS="\t" read -r pattern bodyfile; do',
  '  [ -n "$pattern" ] || continue',
  '  case "$ep" in',
  '    $pattern) cat "$bodyfile"; exit 0 ;;',
  '  esac',
  'done < "$TEA_ROUTES"',
  'printf "404 page not found\\n"',
  'exit 0',
].join('\n');

function stubTea(routes: Array<[string, unknown | { raw: string }]>): void {
  const table: string[] = [];
  routes.forEach(([pattern, body], i) => {
    const file = path.join(tmp, `route-${i}.body`);
    const content = typeof body === 'object' && body !== null && 'raw' in (body as any)
      ? (body as { raw: string }).raw
      : JSON.stringify(body);
    fs.writeFileSync(file, content);
    table.push(`${pattern}\t${file}`);
  });
  fs.writeFileSync(path.join(tmp, 'routes.tsv'), `${table.join('\n')}\n`);
  stub('tea', TEA_STUB);
}

const FORGEJO_15_VERSION = { version: '15.0.2+gitea-1.22.0' };

/** One page of `actions/runs`, reduced to the fields the scripts read. */
function forgejoRuns(runs: Array<Record<string, unknown>>): Record<string, unknown> {
  return { total_count: runs.length, workflow_runs: runs };
}

function forgejoRun(id: number, index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, index_in_repo: index, title: `run ${index}`, workflow_id: 'ci.yml',
    status: 'failure', prettyref: 'main', commit_sha: 'deadbeef', event: 'push',
    html_url: `https://forge.example.com/o/r/actions/runs/${index}`, created: '2026-08-18T21:47:24Z',
    ...extra,
  };
}

describe.skipIf(!hasJq())('#13 — Forgejo, as it actually behaves', () => {
  function teaEnv(extra: Record<string, string> = {}): Record<string, string> {
    return { TEA_ROUTES: path.join(tmp, 'routes.tsv'), ...extra };
  }

  it('always sends page= with limit=, because Forgejo ignores limit without it', () => {
    // Measured: `actions/runs?limit=3` returned all 6922 runs on the reference
    // Forgejo. This is the kind of default that turns into a #12.
    stubTea([['repos/o/r/actions/runs?*', forgejoRuns([forgejoRun(11130, 6881)])]]);
    run(giteaDir, 'ci-runs.sh', teaEnv({ CODEV_CI_LIMIT: '3' }));
    const calls = fileLines(path.join(tmp, 'tea.log'));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls.filter((c) => c.includes('limit='))) {
      expect(call, `a list request without page=: ${call}`).toContain('page=');
    }
  });

  it('matches a branch by its PULL REQUEST ref, which is what Forgejo records', () => {
    // A pull_request run records `#3855`, not `builder/air-364`. Filtering on
    // the branch name alone matches nothing on a repo that runs CI on PRs.
    stubTea([
      ['repos/o/r', { default_branch: 'main' }],
      ['repos/o/r/pulls/main/builder/air-364', { number: 3855, state: 'open', head: { label: 'builder/air-364' } }],
      ['repos/o/r/actions/runs?*', forgejoRuns([
        forgejoRun(11142, 6886, { prettyref: '#3855', event: 'pull_request', status: 'success' }),
        forgejoRun(11100, 6870, { prettyref: '#9999', event: 'pull_request' }),
        forgejoRun(11000, 6800, { prettyref: 'main' }),
      ])],
    ]);

    const r = run(giteaDir, 'ci-runs.sh', teaEnv({ CODEV_BRANCH_NAME: 'builder/air-364' }));
    expect(r.status).toBe(0);
    expect(r.json!.runs).toHaveLength(1);
    expect(r.json!.runs[0].id).toBe(11142);
    expect(r.json!.runs[0].branch).toBe('#3855');
  });

  it('says so when a branch has no PR, instead of returning a bare empty list', () => {
    stubTea([
      ['repos/o/r', { default_branch: 'main' }],
      ['repos/o/r/actions/runs?*', forgejoRuns([forgejoRun(11000, 6800, { prettyref: 'main' })])],
    ]);
    const r = run(giteaDir, 'ci-runs.sh', teaEnv({ CODEV_BRANCH_NAME: 'builder/no-pr' }));
    expect(r.json!.runs).toEqual([]);
    expect(r.json!.note, 'an empty list with no explanation reads as "CI never ran"').toContain('no pull request');
  });

  it('emits conclusion: null rather than inventing one Forgejo does not have', () => {
    stubTea([['repos/o/r/actions/runs?*', forgejoRuns([forgejoRun(11130, 6881)])]]);
    const r = run(giteaDir, 'ci-runs.sh', teaEnv());
    expect(r.json!.runs[0].conclusion).toBeNull();
    expect(r.json!.runs[0].status).toBe('failure');
  });

  it('ci-run-view recovers jobs from the task list when the jobs API is absent', () => {
    stubTea([
      ['repos/o/r/actions/runs/11130', forgejoRun(11130, 6881)],
      // no repos/o/r/actions/runs/11130/jobs route -> the stub 404s, as 15.0.2 does
      ['repos/o/r/actions/tasks?*', {
        total_count: 2,
        workflow_runs: [
          { id: 40084, name: 'E2E coverage-drift guard', run_number: 6881, status: 'failure', run_started_at: 'x', updated_at: 'y' },
          { id: 40082, name: 'Lint', run_number: 6881, status: 'success', run_started_at: 'x', updated_at: 'y' },
        ],
      }],
    ]);

    const r = run(giteaDir, 'ci-run-view.sh', teaEnv({ CODEV_CI_RUN_ID: '11130' }));
    expect(r.status).toBe(0);
    expect(r.json!.jobSource).toBe('tasks-scan');
    expect(r.json!.jobs).toHaveLength(2);
    // A task id is not a job id and the log API does not accept one, so it is
    // never reported as `id`.
    expect(r.json!.jobs[0].id).toBeNull();
    expect(r.json!.jobs[0].taskId).toBe(40084);
    expect(r.json!.jobs[0].status).toBe('failure');
  });

  it('ci-failures on Forgejo 15 says unsupported-server, names both versions, and still names the failing job', () => {
    stubTea([
      ['repos/o/r/actions/runs/11130', forgejoRun(11130, 6881)],
      ['repos/o/r/actions/tasks?*', {
        total_count: 1,
        workflow_runs: [{ id: 40084, name: 'E2E coverage-drift guard', run_number: 6881, status: 'failure', run_started_at: 'x', updated_at: 'y' }],
      }],
      ['version', FORGEJO_15_VERSION],
    ]);

    const r = run(giteaDir, 'ci-failures.sh', teaEnv({ CODEV_CI_RUN_ID: '11130' }));
    expect(r.status).not.toBe(0);
    expect(r.json!.ok).toBe(false);
    expect(r.json!.error).toBe('unsupported-server');
    expect(r.json!.serverVersion).toBe('15.0.2+gitea-1.22.0');
    expect(r.json!.needs).toBe('>=16.0');
    expect(r.json!.detail).toContain('Forgejo 16.0');
    // The rule the architect held this to: an unsupported server must never
    // look like a run with no failures.
    expect(r.json!, 'an old server produced an empty failures array').not.toHaveProperty('failures');
    expect(r.json!.jobsFailed).toBe(1);
    expect(r.json!.failingJobs[0].jobName).toBe('E2E coverage-drift guard');
  });

  it('ci-run-log on Forgejo 15 says unsupported-server rather than an empty window', () => {
    stubTea([
      ['repos/o/r/actions/runs/11130', forgejoRun(11130, 6881)],
      ['repos/o/r/actions/tasks?*', { total_count: 0, workflow_runs: [] }],
      ['version', FORGEJO_15_VERSION],
    ]);
    const r = run(giteaDir, 'ci-run-log.sh', teaEnv({ CODEV_CI_RUN_ID: '11130', CODEV_CI_LOG_TAIL: '20' }));
    expect(r.json!.error).toBe('unsupported-server');
    expect(r.json!).not.toHaveProperty('lines');
  });

  it('ci-failures on Forgejo 16 extracts from the job-log endpoint', () => {
    stubTea([
      ['repos/o/r/actions/runs/6554924', forgejoRun(6554924, 189242)],
      ['repos/o/r/actions/runs/6554924/jobs', [
        { id: 11952743, task_id: 8848592, name: 'backend-checks', status: 'success' },
        { id: 11952749, task_id: 8848703, name: 'test-unit', status: 'failure' },
      ]],
      ['repos/o/r/actions/jobs/11952749/logs', { raw: fixtureLog('forgejo-go-failure') }],
    ]);

    const r = run(giteaDir, 'ci-failures.sh', teaEnv({ CODEV_CI_RUN_ID: '6554924' }));
    expect(r.status).toBe(0);
    expect(r.json!.extracted).toBe(true);
    const f = r.json!.failures[0];
    // The log route takes the JOB id (11952749), not the task id (8848703).
    expect(f.jobId).toBe(11952749);
    expect(f.jobName).toBe('test-unit');
    expect(f.matchedBy).toBe('go-test');
    expect(f.text).toContain('--- FAIL: TestReadPointerFromBuffer');
    expect(f.logLines).toBe(1599);
    expect(fileLines(path.join(tmp, 'tea.log')).some((c) => c.includes('actions/jobs/11952749/logs'))).toBe(true);
  });

  it('ci-run-log on Forgejo 16 windows the same log', () => {
    stubTea([
      ['repos/o/r/actions/runs/6554924', forgejoRun(6554924, 189242)],
      ['repos/o/r/actions/runs/6554924/jobs', [{ id: 11952749, task_id: 8848703, name: 'test-unit', status: 'failure' }]],
      ['repos/o/r/actions/jobs/11952749/logs', { raw: fixtureLog('forgejo-go-failure') }],
    ]);
    const r = run(giteaDir, 'ci-run-log.sh', teaEnv({ CODEV_CI_RUN_ID: '6554924', CODEV_CI_LOG_GREP: '--- FAIL', CODEV_CI_LOG_CONTEXT: '0' }));
    expect(r.json!.matches).toBe(1);
    expect(r.json!.lines[0]).toContain('--- FAIL: TestReadPointerFromBuffer');
  });

  it('sends status=cancelled, because Forgejo rejects the spelling its own CLI documents', () => {
    // `tea actions runs list --help` says `canceled`; the API answers that with
    // {"message":"unknown status: canceled"} and answers `cancelled` with 2240
    // runs. Both measured. This is the kind of difference that becomes an empty
    // list nobody questions.
    stubTea([['repos/o/r/actions/runs?*', forgejoRuns([])]]);
    run(giteaDir, 'ci-runs.sh', teaEnv({ CODEV_CI_STATUS: 'canceled' }));
    const calls = fileLines(path.join(tmp, 'tea.log'));
    expect(calls.some((c) => c.includes('status=cancelled'))).toBe(true);
    expect(calls.some((c) => c.includes('status=canceled'))).toBe(false);
  });

  it('rejects a status outside the shared vocabulary instead of passing it to the forge', () => {
    stubTea([['repos/o/r/actions/runs?*', forgejoRuns([])]]);
    const r = run(giteaDir, 'ci-runs.sh', teaEnv({ CODEV_CI_STATUS: 'broken' }));
    expect(r.status).toBe(2);
    expect(r.json!.error).toBe('bad-input');
    expect(r.json!.detail).toContain('in_progress');
    expect(fileLines(path.join(tmp, 'tea.log'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// codev forge <concept>
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq())('#13 — codev forge runs a concept through the real resolver', () => {
  /** A workspace with a .codev/config.json, so resolution has something to resolve. */
  function workspace(forge: Record<string, unknown>): string {
    const root = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(root, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codev', 'config.json'), JSON.stringify({ forge }));
    return root;
  }

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
  }

  it('HONOURS a per-repo override — the reason this command exists', () => {
    // Naming the script by path bypasses the config lookup, the provider preset
    // and any override. A project that overrides ci-failures would have its
    // override silently ignored, and would get GitHub's script against a
    // Forgejo repo. The reference Forgejo repo carried three such overrides
    // until #12 shipped, so this is not hypothetical.
    const custom = path.join(tmp, 'my-ci-failures.sh');
    fs.writeFileSync(custom, '#!/bin/sh\necho \'{"ok":true,"mine":true}\'\n', { mode: 0o755 });
    fs.chmodSync(custom, 0o755);

    const io = capture();
    return runForgeConcept('ci-failures', { cwd: workspace({ 'ci-failures': custom }), ...io }).then((code) => {
      expect(code).toBe(0);
      expect(JSON.parse(io.out.join(''))).toEqual({ ok: true, mine: true });
    });
  });

  it('names a concept disabled for the provider and exits non-zero', async () => {
    const io = capture();
    const code = await runForgeConcept('team-activity', { cwd: workspace({ provider: 'gitea' }), ...io });
    expect(code).not.toBe(0);
    expect(io.out.join('')).toBe('');
    expect(io.err.join('')).toContain('team-activity');
    expect(io.err.join(''), 'a disabled concept must name WHY it is unavailable').toContain('gitea');
  });

  it('lists the valid concepts when given an unknown name', async () => {
    const io = capture();
    const code = await runForgeConcept('ci-failure', { cwd: workspace({}), ...io });
    expect(code).toBe(2);
    expect(io.err.join('')).toContain('not a known forge concept');
    expect(io.err.join('')).toContain('ci-failures');
    expect(io.err.join('')).toContain('pr-exists');
  });

  it('prints stdout verbatim and propagates the exit code, envelope included', async () => {
    // A concept that fails still has something to say — the ci-* scripts print
    // their error envelope on stdout precisely so the class of failure survives
    // a non-zero exit. Swallowing stdout on failure would throw it away at the
    // last step.
    const failing = path.join(tmp, 'failing.sh');
    fs.writeFileSync(failing, '#!/bin/sh\necho \'{"ok":false,"error":"timeout","seconds":60}\'\nexit 1\n', { mode: 0o755 });
    fs.chmodSync(failing, 0o755);

    const io = capture();
    const code = await runForgeConcept('ci-runs', { cwd: workspace({ 'ci-runs': failing }), ...io });
    expect(code).toBe(1);
    expect(JSON.parse(io.out.join('')).error).toBe('timeout');
  });

  it('passes the ambient CODEV_* environment through to the script', async () => {
    const echoer = path.join(tmp, 'echo-env.sh');
    fs.writeFileSync(echoer, '#!/bin/sh\nprintf \'{"runId":"%s"}\' "$CODEV_CI_RUN_ID"\n', { mode: 0o755 });
    fs.chmodSync(echoer, 0o755);

    const previous = process.env.CODEV_CI_RUN_ID;
    process.env.CODEV_CI_RUN_ID = '32515040122';
    try {
      const io = capture();
      const code = await runForgeConcept('ci-failures', { cwd: workspace({ 'ci-failures': echoer }), ...io });
      expect(code).toBe(0);
      expect(JSON.parse(io.out.join('')).runId).toBe('32515040122');
    } finally {
      if (previous === undefined) delete process.env.CODEV_CI_RUN_ID;
      else process.env.CODEV_CI_RUN_ID = previous;
    }
  });
});
