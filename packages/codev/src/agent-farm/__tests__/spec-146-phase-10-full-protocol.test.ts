/**
 * Spec 146 Phase 10 — a complete BUGFIX protocol on a t3code thread, on two drivers.
 *
 * WHAT RUNS WHERE, BECAUSE A GREEN SUITE IS EVIDENCE ONLY ABOUT WHAT IT RAN
 *
 * This file sits in `packages/codev/src/agent-farm/__tests__/`, which the default
 * `packages/codev/vitest.config.ts` suite covers, beside Phase 9's live tests.
 * The plan named `packages/porch-driver/__tests__/full-protocol.test.ts` instead.
 * That package has no vitest config, no `test` script and is not one of the five
 * suites `apps/client/__tests__/suite-coverage.test.ts` derives — and that guard
 * derives only from `packages/codev` and `apps/client`, so it would not have
 * noticed either. A test file there is a suite nothing runs, which reads as
 * coverage forever.
 *
 * TWO KINDS OF ASSERTION LIVE HERE
 *
 *   1. The LIVE block runs the whole protocol against a real server. It needs
 *      `T3_LIVE=1`, a pinned checkout and `T3_NODE`, so CI never reaches it — and
 *      when CI cannot reach it, that is reported as skipped-for-no-server, never
 *      as a pass.
 *
 *   2. The EVIDENCE block always runs, including in CI. Phase 10's deliverables
 *      are recorded runs — a one-hour gate on each of two drivers, and a 24-hour
 *      gate started here for Phase 13. Nothing about those can be re-executed in
 *      a unit suite, so what this suite CAN do is refuse evidence that has gone
 *      stale against the runner, lost a driver, or quietly turned a criterion
 *      into `undetermined`.
 *
 * `undetermined` IS NOT A PASS HERE
 *
 * The runner records `met`, `not-met` and `undetermined` separately, and this
 * test accepts only `met`. A criterion that could not be evaluated is a criterion
 * with no evidence behind it, and it must not be able to hide inside a green run.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harnessPath = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const runnerPath = join(repoRoot, 'packages/codev/src/agent-farm/__tests__/helpers/air-235-full-protocol.mjs');
const witnessPath = join(repoRoot, 'packages/codev/src/agent-farm/__tests__/helpers/air-235-pty-witness.mjs');
const evidencePath = join(repoRoot, 'codev', 'research', '146-phase10-live-evidence.json');
const parityPath = join(repoRoot, 'codev', 'research', '146-driver-parity.md');
const longGatePath = join(repoRoot, 'codev', 'research', '146-long-gate-evidence.md');

/** One recorded run of the runner. */
interface RunEvidence {
  readonly harness: string;
  readonly model: string;
  readonly driverKind: string;
  readonly gateSeconds: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly criteria: Record<string, { outcome: string; detail: string }>;
  readonly failure: string | null;
}

interface EvidenceFile {
  readonly recordedAt: string;
  readonly server: Record<string, unknown>;
  readonly runs: ReadonlyArray<RunEvidence>;
  readonly longGate: { readonly startedAt: string; readonly gateSeconds: number; readonly harness: string };
}

function loadEvidence(): EvidenceFile {
  return JSON.parse(readFileSync(evidencePath, 'utf8')) as EvidenceFile;
}

/** The criteria every recorded run must carry. Named, so a run that drops one fails. */
const REQUIRED_CRITERIA = [
  'investigate-produced-root-cause',
  'check-fails-before-the-fix',
  'check-passes-after-the-fix',
  'restart-loses-no-completion',
  'pr-branch-reached-origin',
  'gate-resumes-with-context',
  'gate-dispatched-nothing',
  'merge-lands-the-fix-on-main',
  'no-pty-code-path-ran',
  'pty-witness-can-see-a-pty',
] as const;

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harnessPath)) return { ok: false, reason: `could not check: missing ${harnessPath}` };
  try {
    execFileSync(process.execPath, [harnessPath, 'verify'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (code === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: 'could not check: verify failed' };
  }
}

describe('Spec 146 Phase 10 — the recorded full-protocol runs', () => {
  it('records a complete run on two distinct driver kinds, at least one of them not codex', () => {
    const { runs } = loadEvidence();
    const kinds = [...new Set(runs.map((run) => run.driverKind))];
    expect(kinds.length, `phase 10 requires two drivers; the evidence has ${JSON.stringify(kinds)}`)
      .toBeGreaterThanOrEqual(2);
    // "Second, non-Codex driver" is the deliverable's wording, and it is the
    // half that matters: only Codex was exercised in the spike, so a second run
    // that is also Codex would re-measure the one driver already known to work.
    expect(kinds.filter((kind) => kind !== 'codex').length, 'no non-codex driver among the recorded runs')
      .toBeGreaterThanOrEqual(1);
  });

  it('has every criterion MET on every recorded run — undetermined is not a pass', () => {
    for (const run of loadEvidence().runs) {
      expect(run.failure, `the ${run.harness} run failed before it finished: ${run.failure}`).toBeNull();
      for (const name of REQUIRED_CRITERIA) {
        const criterion = run.criteria[name];
        expect(criterion, `the ${run.harness} run recorded no "${name}" at all`).toBeDefined();
        expect(
          criterion.outcome,
          `${run.harness}/${run.driverKind} — "${name}" is ${criterion.outcome}, not met: ${criterion.detail}`,
        ).toBe('met');
      }
    }
  });

  it('elapsed a real gate of at least an hour on each driver', () => {
    for (const run of loadEvidence().runs) {
      // The provider session reaper logs `inactivityThresholdMs: 1800000` at
      // startup, so a gate under 30 minutes cannot cross it and would not test
      // what the reaper does to an idle thread. An hour clears it with margin.
      expect(run.gateSeconds, `the ${run.harness} run's gate was only ${run.gateSeconds}s`).toBeGreaterThanOrEqual(3600);
      const elapsedMs = new Date(run.finishedAt ?? 0).getTime() - new Date(run.startedAt).getTime();
      expect(
        elapsedMs,
        `the ${run.harness} run claims a ${run.gateSeconds}s gate but took only ${Math.round(elapsedMs / 1000)}s `
          + 'end to end, so the gate cannot have been elapsed',
      ).toBeGreaterThanOrEqual(run.gateSeconds * 1000);
    }
  });

  it('records the start of the 24-hour gate Phase 13 depends on', () => {
    const { longGate } = loadEvidence();
    expect(longGate.gateSeconds, 'the long gate is not 24 hours').toBe(86_400);
    expect(Number.isNaN(new Date(longGate.startedAt).getTime()), 'the long gate has no start time').toBe(false);
    // Its evidence lands when it completes; the doc has to exist now, because
    // "started" is the deliverable for this phase and an unrecorded start is
    // indistinguishable from one that never happened.
    expect(existsSync(longGatePath), 'codev/research/146-long-gate-evidence.md is missing').toBe(true);
    expect(readFileSync(longGatePath, 'utf8')).toContain(longGate.startedAt);
  });

  it('names every driver it ran in the parity record', () => {
    const parity = readFileSync(parityPath, 'utf8');
    for (const run of loadEvidence().runs) {
      expect(parity, `146-driver-parity.md does not mention the ${run.harness} run`).toContain(run.harness);
      expect(parity).toContain(run.model);
    }
  });

  it('regenerates from a script, and that script cannot report "missing" as "failed"', () => {
    /*
     * The evidence is regenerated whenever the runs are, because the staleness
     * guard below forces it. A regeneration procedure that lives in someone's
     * memory gets done differently the second time, and the difference lands in
     * the one file whose whole job is to be trustworthy — so it is a script.
     *
     * What is asserted here is its EXIT CODE, which is the part that decays
     * silently. A run that has not finished yet and a run that finished badly are
     * different facts. The collector exits 3 for the first, and if it ever
     * regressed to 1 a CI job would read "the phase 10 evidence is bad" from
     * "the phase 10 evidence is not there".
     */
    const collector = join(repoRoot, 'tools', 't3-server', 'collect-phase10-evidence.mjs');
    expect(existsSync(collector), 'the evidence collector is missing').toBe(true);
    const result = spawnSync(process.execPath, [collector, 'a-run-that-does-not-exist'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, 'a missing run must exit 3 (could not check), never 1 (it failed)').toBe(3);
    expect(result.stderr).toMatch(/could not check/);
    expect(result.stderr).toMatch(/This is not "the run failed"/);
  });

  it('is not older than the runner it describes', () => {
    const evidenceAge = statSync(evidencePath).mtimeMs;
    for (const source of [runnerPath, witnessPath]) {
      expect(
        evidenceAge,
        `${source} changed after the evidence was recorded. Re-run the protocol rather than trusting a stale `
          + 'result — the criteria are claims about what this code did, and it is not this code any more.',
      ).toBeGreaterThanOrEqual(statSync(source).mtimeMs - 1000);
    }
  });
});

describe('Spec 146 Phase 10 — the PTY witness has an intact window', () => {
  /**
   * The witness records what resolves AFTER `module.register`, so a static import
   * of anything but a builtin, placed above it, would load outside the recording
   * and the run's "no PTY code path ran" would be measuring a shorter window than
   * it claims. Cheap to state, invisible to break — a later edit adding
   * `import { WebSocket } from 'ws'` at the top is the natural thing to do.
   */
  it('imports nothing but node: builtins statically', () => {
    const source = readFileSync(runnerPath, 'utf8');
    const staticImports = [...source.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    expect(staticImports.length, 'the runner has no static imports at all; this guard is measuring nothing')
      .toBeGreaterThan(3);
    const nonBuiltin = staticImports.filter((specifier) => !specifier.startsWith('node:'));
    expect(
      nonBuiltin,
      'these load before module.register and are therefore outside the witness window; make them dynamic',
    ).toEqual([]);
  });

  it('registers the witness before it imports anything of its own', () => {
    const source = readFileSync(runnerPath, 'utf8');
    expect(source.indexOf('register(')).toBeLessThan(source.indexOf('await import('));
  });
});

describe('Spec 146 Phase 10 — a refusal is not a timeout', () => {
  /**
   * THE FINDING THIS PHASE EXISTS TO PRODUCE, AND THE ONE PART OF IT CI CAN GUARD.
   *
   * Running the protocol on a second driver did surface a driver-specific
   * failure while it was still cheap, exactly as the plan predicted — but the
   * failure worth keeping was not the driver's.
   *
   * t3code ships `OpenCodeSettings.enabled` defaulting to false ("Off by default
   * (like Cursor and Grok) ... Users opt in from Settings"), so a thread on the
   * opencode driver in a state directory nobody opted in for is refused at
   * `startSession`. The server says so, by name, twelve milliseconds after the
   * dispatch:
   *
   *   status: "error", lastError: "ProviderValidationError: ... Provider
   *   instance 'opencode' is disabled in T3 Code settings."
   *
   * `TurnTracker` read `activeTurnId` and nothing else. The refusal event
   * carries `activeTurnId: null`, which falls through the `seenRunning` latch
   * and does nothing — so the caller waited out its entire budget and reported
   * `Timed out after 599950ms waiting for the turn to start`. Ten minutes to not
   * learn something already on the wire, and the message named the wrong thing:
   * a definite refusal presented as "I stopped waiting".
   *
   * That is this project's own rule running backwards. "I could not tell" must
   * never be spelled like "no" — and here "no" was spelled like "I could not
   * tell", which is the more expensive direction, because it looks like patience.
   */
  const sessionEvent = (
    threadId: string,
    session: Record<string, unknown>,
    sequence: number,
  ) => ({
    kind: 'event',
    event: { sequence, aggregateId: threadId, type: 'thread.session-set', payload: { session } },
  });

  it('fails a not-yet-running turn with the server sentence, not a timeout', async () => {
    const { TurnTracker, SessionStartFailedError } = await import('@cluesmith/porch-driver/turn');
    const tracker = new TurnTracker();
    const started = tracker.expectTurn('t1');
    // Verbatim from the live run, including the `activeTurnId: null` that made
    // the old code ignore it.
    tracker.observe(sessionEvent('t1', { status: 'starting', activeTurnId: null, lastError: null }, 1));
    tracker.observe(
      sessionEvent(
        't1',
        {
          status: 'error',
          activeTurnId: null,
          lastError:
            "ProviderValidationError: Provider validation failed in ProviderService.startSession: "
            + "Provider instance 'opencode' is disabled in T3 Code settings.",
        },
        2,
      ),
    );
    await expect(started.running).rejects.toThrow(SessionStartFailedError);
    await expect(started.running).rejects.toThrow(/disabled in T3 Code settings/);
    // Both promises, not just the one being awaited. A caller holding `settled`
    // and not `running` would otherwise hang on exactly the event that explains
    // why it never will.
    await expect(started.settled).rejects.toThrow(SessionStartFailedError);
  });

  it('says an unexplained failure differently from an explained one', async () => {
    const { TurnTracker } = await import('@cluesmith/porch-driver/turn');
    const tracker = new TurnTracker();
    const started = tracker.expectTurn('t2');
    tracker.observe(sessionEvent('t2', { status: 'error', activeTurnId: null, lastError: null }, 1));
    // WHY is unknown; THAT it failed is not. Those are different facts and the
    // message has to carry which one this is.
    await expect(started.running).rejects.toThrow(/gave no reason, so WHY is unknown/);
  });

  it('does not turn a turn that ENDED in error into a start failure', async () => {
    /*
     * The guard on the guard. A session error AFTER the turn is running is the
     * turn ending, and the caller wants its result rather than an exception —
     * so the fix has to be scoped to before `seenRunning`, and a version that
     * was not would break every failed turn in the opposite direction.
     */
    const { TurnTracker } = await import('@cluesmith/porch-driver/turn');
    const tracker = new TurnTracker();
    const started = tracker.expectTurn('t3');
    tracker.observe(sessionEvent('t3', { status: 'running', activeTurnId: 'turn-1', lastError: null }, 1));
    await expect(started.running).resolves.toBe('turn-1');
    tracker.observe(sessionEvent('t3', { status: 'error', activeTurnId: null, lastError: 'the model errored' }, 2));
    await expect(started.settled).resolves.toBeUndefined();
  });

  it('the launcher opts the driver in, because t3code ships some drivers off', () => {
    /*
     * The other half of the same finding. Every run gets its own `--base-dir`,
     * so every run gets a state directory with no opt-in, and the default for
     * opencode is off. A harness that does not write the opt-in tests nothing on
     * that driver — and, before the fix above, took ten minutes per turn to say
     * so in the wrong words.
     */
    const launcher = readFileSync(join(repoRoot, 'tools', 't3-server', 'full-protocol-run.sh'), 'utf8');
    expect(launcher).toContain('"providers"');
    expect(launcher).toContain('"enabled":true');
    // Written after `start` and loaded by a `restart`: `start` wipes the state
    // directory, so a settings file written before it does not survive.
    expect(launcher.indexOf('SETTINGS=')).toBeGreaterThan(launcher.indexOf('t3-server.mjs start'));
    expect(launcher.indexOf('t3-server.mjs restart')).toBeGreaterThan(launcher.indexOf('SETTINGS='));
  });
});

describe('Spec 146 Phase 10 — live', () => {
  const status = harnessStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  const canRunLive = status.ok && liveOptIn;
  // The gate this test elapses. The RECORDED runs use 3600 and 86400; a test has
  // to be runnable, so it defaults short and says so. It is the same runner
  // either way — what the long runs prove and what this asserts are one code
  // path, not two.
  const gateSeconds = Number(process.env.T3_GATE_SECONDS?.trim() || '60');

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE] runs a whole BUGFIX protocol on a thread with no PTY anywhere in it',
    async () => {
      const harness = process.env.T3_LIVE_HARNESS?.trim() || 'claude';
      const model = process.env.T3_LIVE_MODEL?.trim() || 'claude-haiku-4-5';
      const work = mkdtempSync(join(tmpdir(), 'air-235-live-'));
      const out = join(work, 'evidence.json');
      const t3 = (command: string, timeoutMs: number) =>
        execFileSync(process.execPath, [harnessPath, command], { encoding: 'utf8', timeout: timeoutMs });
      try {
        try {
          t3('stop', 30_000);
        } catch {
          /* nothing running is fine */
        }
        t3('start', 120_000);
        const ready = t3('ready', 120_000);
        const { port, token } = JSON.parse(ready.slice(ready.indexOf('{'))) as { port: number; token: string };

        execFileSync(process.execPath, [runnerPath], {
          encoding: 'utf8',
          timeout: (gateSeconds + 2400) * 1000,
          env: {
            ...process.env,
            RUN_REPO_ROOT: repoRoot,
            RUN_PORT: String(port),
            RUN_TOKEN: token,
            RUN_HARNESS: harness,
            RUN_MODEL: model,
            RUN_GATE_SECONDS: String(gateSeconds),
            RUN_OUT: out,
            RUN_WORK: join(work, 'work'),
          },
        });

        const run = JSON.parse(readFileSync(out, 'utf8')) as RunEvidence;
        expect(run.failure, `the run under ${harness}/${model} did not finish`).toBeNull();
        for (const name of REQUIRED_CRITERIA) {
          expect(
            run.criteria[name]?.outcome,
            `${harness}/${model} — "${name}": ${run.criteria[name]?.detail}`,
          ).toBe('met');
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
        try {
          t3('stop', 30_000);
        } catch {
          /* teardown must not mask the assertion that got us here */
        }
      }
    },
    3_600_000,
  );

  it('records live readiness or the exact reason it could not check', () => {
    if (!status.ok) {
      expect(status.reason).toMatch(/^could not check:/);
      return;
    }
    expect(status.reason).toBe('verified');
    if (!liveOptIn) expect(process.env.T3_LIVE).not.toBe('1');
  });
});
