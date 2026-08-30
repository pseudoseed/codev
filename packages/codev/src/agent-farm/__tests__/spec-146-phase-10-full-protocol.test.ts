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
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harnessPath = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const runnerPath = join(repoRoot, 'packages/codev/src/agent-farm/__tests__/helpers/air-235-full-protocol.mjs');
const witnessPath = join(repoRoot, 'packages/codev/src/agent-farm/__tests__/helpers/air-235-pty-witness.mjs');
const protocolPath = join(repoRoot, 'codev-skeleton/protocols/bugfix/protocol.json');
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
  readonly observations?: {
    readonly gate?: {
      readonly elapsedMs: number;
      readonly measuredWith: string;
      readonly journalRecordsDuringGate: number;
    };
    readonly codewordOnDiskBeforeGate?: boolean | null;
  };
  readonly failure: string | null;
}

interface EvidenceFile {
  readonly recordedAt: string;
  readonly server: Record<string, unknown>;
  /** Repo-relative path → sha256 of the committed code this evidence describes. */
  readonly describes: Record<string, string>;
  /** Repo-relative path → sha256 of the built artifact that actually ran, or null. */
  readonly executed: Record<string, string | null>;
  /**
   * Set when the code has knowingly moved on and re-running is not worth it.
   *
   * Deliberately not a boolean and not a bare sha: it has to say WHAT changed and
   * WHY the evidence no longer describes it, and `146-driver-parity.md` has to
   * carry a matching note. Setting the hatch should cost the same as writing the
   * truth — the moment it is cheaper, it replaces the truth.
   */
  readonly supersededBy?: { readonly change: string; readonly why: string; readonly at: string };
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
  'gate-elapsed-at-least-its-target',
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
      /*
       * THE GATE, NOT THE RUN.
       *
       * The previous version compared end-to-end runtime against the gate
       * target, and the surrounding turns padded that well past an hour — so a
       * genuinely short gate passed. It was not hypothetical: the first recorded
       * runs measured 3,599,964 ms and 3,599,962 ms against a 3,600,000 ms
       * target, because `setTimeout` is not a promise about elapsed time, and
       * this assertion did not notice.
       *
       * The runner now holds the gate open on a monotonic clock until the target
       * is genuinely reached, and this reads the measurement it took.
       */
      const gate = run.observations?.gate;
      expect(gate, `the ${run.harness} run recorded no gate measurement`).toBeDefined();
      expect(gate!.measuredWith, 'the gate was not measured with a monotonic clock').toContain('hrtime');
      expect(
        gate!.elapsedMs,
        `the ${run.harness} run's gate lasted ${gate!.elapsedMs}ms against a ${run.gateSeconds * 1000}ms target`,
      ).toBeGreaterThanOrEqual(run.gateSeconds * 1000);
      expect(
        gate!.journalRecordsDuringGate,
        `${gate!.journalRecordsDuringGate} commands were dispatched during the ${run.harness} gate`,
      ).toBe(0);
    }
  });

  it('records the start of the 24-hour gate a later phase depends on', () => {
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
      // The generated ROW, not a bare mention. "claude" appears a dozen times in
      // that document in prose; a `toContain('claude')` would pass on a parity
      // record that had lost the claude run entirely, which is the one thing
      // this assertion exists to catch.
      expect(
        parity,
        `146-driver-parity.md has no results row for ${run.harness}/${run.model}`,
      ).toContain(`\`${run.harness}\` / \`${run.model}\``);
      expect(parity, `146-driver-parity.md does not name the ${run.driverKind} driver kind`)
        .toContain(run.driverKind);
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

  it('describes the code that actually produced it, by content and not by timestamp', () => {
    /*
     * HASHES, NOT MTIMES. Both review lanes flagged the previous version
     * independently and both were right: git does not preserve mtimes, so a
     * clean checkout randomises the comparison, and `touch` satisfies it
     * outright. It was an assertion that could not fail — the same defect this
     * PR fixes in two other places.
     *
     * A hash is the same answer on every machine and is satisfied by nothing
     * except the bytes. Change the runner and this fails until the runs are
     * redone, which is the point: the criteria are claims about what that code
     * did, and after an edit it is not that code.
     */
    const evidence = loadEvidence();
    const { describes } = evidence;
    // Named before it is used, so evidence written by an older collector fails
    // with a sentence instead of `Cannot convert undefined or null to object`.
    expect(
      describes,
      'this evidence has no `describes` block, so it does not say what code produced it. Regenerate it with '
        + 'tools/t3-server/collect-phase10-evidence.mjs.',
    ).toBeDefined();
    expect(Object.keys(describes).length, 'the evidence names no source at all').toBeGreaterThanOrEqual(20);

    /*
     * THE ESCAPE HATCH, AND WHY IT COSTS WHAT IT COSTS.
     *
     * Re-running is two 3600-second live runs against a pinned t3code checkout,
     * which most contributors cannot perform. A guard whose only remedy is
     * unavailable is a guard that gets deleted the first time it blocks someone,
     * and then there is no guard at all.
     *
     * So the evidence may declare itself superseded — but that declaration has to
     * say what changed and why, and `146-driver-parity.md` has to carry a matching
     * note naming the same change. If the two disagree, this is red. Setting the
     * hatch is therefore the same amount of work as writing the truth, which is
     * the only thing that stops it becoming the truth's replacement.
     */
    const superseded = evidence.supersededBy;
    if (superseded) {
      expect(
        superseded.change?.length ?? 0,
        '`supersededBy.change` must name WHAT changed, specifically enough for a reader to find it',
      ).toBeGreaterThanOrEqual(20);
      expect(
        superseded.why?.length ?? 0,
        '`supersededBy.why` must say why this evidence no longer describes the code — a sha is not a reason',
      ).toBeGreaterThanOrEqual(40);
      expect(Number.isNaN(new Date(superseded.at).getTime()), '`supersededBy.at` is not a date').toBe(false);
      const parity = readFileSync(parityPath, 'utf8');
      expect(
        parity.toLowerCase(),
        '146-driver-parity.md does not mention that this evidence is superseded. The evidence and the record '
          + 'people read must not disagree about whether these runs still describe the code.',
      ).toContain('superseded');
      expect(
        parity,
        `146-driver-parity.md does not name the change the evidence was superseded by: ${superseded.change}`,
      ).toContain(superseded.change);
      return;
    }

    for (const [relative, recorded] of Object.entries(describes)) {
      const absolute = join(repoRoot, relative);
      expect(existsSync(absolute), `the evidence names ${relative}, which does not exist`).toBe(true);
      const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      expect(
        actual,
        `${relative} has changed since the evidence was recorded, so these runs no longer describe it.\n`
          + `  recorded ${recorded.slice(0, 16)}…, on disk ${actual.slice(0, 16)}…\n`
          + '  Two ways out. Re-run and regenerate:\n'
          + '    T3_NODE=/abs/node tools/t3-server/full-protocol-run.sh 3803 claude   claude-haiku-4-5 3600 claude-1h\n'
          + '    T3_NODE=/abs/node tools/t3-server/full-protocol-run.sh 3804 opencode xai/grok-4.6    3600 opencode-1h\n'
          + '    node tools/t3-server/collect-phase10-evidence.mjs claude-1h opencode-1h --long-gate ...\n'
          + '  Or, if re-running is not worth it, declare the evidence superseded: add `supersededBy`\n'
          + '  to codev/research/146-phase10-live-evidence.json with `change` (what changed), `why`\n'
          + '  (why these runs no longer describe it) and `at`, AND add a matching note naming the same\n'
          + '  change to codev/research/146-driver-parity.md. Both, or this stays red.',
      ).toBe(recorded);
    }

    // The harness AND the implementation. The first version named only harness
    // files, which left the evidence green across a change to `turn.ts` — the
    // exact kind of change these runs are evidence ABOUT.
    for (const required of [
      'air-235-full-protocol.mjs',
      'air-235-resubscribe.mjs',
      'full-protocol-run.sh',
      'packages/porch-driver/src/turn.ts',
      'packages/porch-driver/src/thread.ts',
      'packages/t3-client/src/subscription.ts',
    ]) {
      expect(
        Object.keys(describes).some((k) => k.endsWith(required)),
        `the evidence does not record a hash for ${required}`,
      ).toBe(true);
    }
    // `dist` is gitignored, so what actually executed is recorded rather than
    // asserted — a test demanding dist hashes fails for anyone who has not built,
    // which turns a real guard into one people learn to skip.
    expect(loadEvidence().executed, 'the evidence does not record what actually executed').toBeDefined();
  });

  it('enacts the phases and checks the BUGFIX protocol actually defines', () => {
    /*
     * The runner reenacts the protocol rather than driving porch through it, so
     * without this the evidence could stay green while the protocol's own
     * definition moved underneath it. This does not close the whole gap — see
     * the PR body — but it closes the half that decays silently: a phase added,
     * renamed or removed in `protocol.json` fails here.
     */
    const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as {
      phases: ReadonlyArray<{ id: string; checks?: Record<string, unknown>; gate?: string }>;
    };
    const runner = readFileSync(runnerPath, 'utf8');
    expect(protocol.phases.map((p) => p.id), 'the BUGFIX protocol is no longer investigate → fix → pr')
      .toEqual(['investigate', 'fix', 'pr']);
    for (const phase of protocol.phases) {
      expect(runner, `the runner does not enact the "${phase.id}" phase`).toContain(`${phase.id} phase`);
    }
    // The fix phase is the one carrying checks, and the runner runs one before
    // it and one after. The gate is on the pr phase, and the runner elapses it.
    const fix = protocol.phases.find((p) => p.id === 'fix');
    expect(Object.keys(fix?.checks ?? {}), 'the fix phase no longer defines build/tests checks')
      .toEqual(expect.arrayContaining(['build', 'tests']));
    expect(protocol.phases.find((p) => p.id === 'pr')?.gate, 'the pr phase no longer carries a gate').toBe('pr');
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

  it('ignores a REPLAYED refusal that predates the waiter', async () => {
    /*
     * Delivery is at-least-once by design — the cursor advances after the
     * handler, so every resubscription redelivers. That means a `status: "error"`
     * from a PREVIOUS turn comes back on any reconnect, and without a sequence
     * guard it would abandon the waiter for a perfectly healthy turn that is
     * running right now.
     *
     * The fix introduced this hazard, so the fix owns the test: killing a live
     * turn with a refusal that belongs to history is a worse failure than the
     * ten-minute hang it replaced.
     */
    const { TurnTracker } = await import('@cluesmith/porch-driver/turn');
    const tracker = new TurnTracker();
    // The thread has history: a refusal at sequence 7.
    tracker.observe(sessionEvent('t4', { status: 'error', activeTurnId: null, lastError: 'an old refusal' }, 7));
    const started = tracker.expectTurn('t4');
    // That same event, redelivered after the new waiter was registered.
    tracker.observe(sessionEvent('t4', { status: 'error', activeTurnId: null, lastError: 'an old refusal' }, 7));
    // And the healthy turn proceeds.
    tracker.observe(sessionEvent('t4', { status: 'running', activeTurnId: 'turn-9', lastError: null }, 8));
    await expect(started.running).resolves.toBe('turn-9');
    tracker.observe(sessionEvent('t4', { status: 'ready', activeTurnId: null, lastError: null }, 9));
    await expect(started.settled).resolves.toBeUndefined();
  });

  it('still fails on a refusal that arrives AFTER the waiter', async () => {
    // Guards the guard above: a sequence filter set one notch too wide would
    // swallow the real refusal too, and put the ten-minute hang back.
    const { TurnTracker, SessionStartFailedError } = await import('@cluesmith/porch-driver/turn');
    const tracker = new TurnTracker();
    tracker.observe(sessionEvent('t5', { status: 'ready', activeTurnId: null, lastError: null }, 7));
    const started = tracker.expectTurn('t5');
    tracker.observe(sessionEvent('t5', { status: 'error', activeTurnId: null, lastError: 'a fresh refusal' }, 8));
    await expect(started.running).rejects.toThrow(SessionStartFailedError);
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

  it('restores the role prompt when the session refuses the turn', async () => {
    /*
     * `DriverThread` consumes `#pendingRole` once the dispatch is accepted,
     * because an accepted dispatch used to be the only confirmation that the
     * role went. `SessionStartFailedError` is a second, later confirmation in
     * the other direction: the command was accepted and the turn never ran, so
     * the role reached nobody.
     *
     * Leaving it consumed means a caller that retries — the natural response to
     * "the provider is disabled in T3 Code settings", once somebody enables it —
     * gets an agent working without its instructions. That is the worse of the
     * two ways to be wrong, and this class already chose against it in a comment
     * before this PR made the case reachable.
     */
    const { DriverThread } = await import('@cluesmith/porch-driver/thread');
    const { DispatchJournal } = await import('@cluesmith/porch-driver/commands');
    const { TurnTracker } = await import('@cluesmith/porch-driver/turn');
    const work = mkdtempSync(join(tmpdir(), 'air-235-role-'));
    try {
      const tracker = new TurnTracker();
      const thread = await DriverThread.create(
        {
          dispatcher: { call: async () => ({ ok: true }) },
          journal: new DispatchJournal(join(work, 'c.jsonl')),
          tracker,
        },
        {
          projectId: 'p1',
          title: 'role',
          harnessName: 'claude',
          model: 'claude-haiku-4-5',
          worktreePath: work,
          branch: 'b',
          threadId: 'role-thread',
          roleContent: 'YOU ARE THE BUILDER',
        },
      );
      expect(thread.roleDelivered, 'the role should still be pending before any turn').toBe(false);

      const started = await thread.beginTurn('do the thing');
      // Consumed on an accepted dispatch, which is the existing rule.
      expect(thread.roleDelivered, 'the role should be consumed once the dispatch is accepted').toBe(true);

      // ...and then the session refuses it.
      tracker.observe({
        kind: 'event',
        event: {
          sequence: started.startSequence + 1,
          aggregateId: 'role-thread',
          type: 'thread.session-set',
          payload: { session: { status: 'error', activeTurnId: null, lastError: 'disabled in settings' } },
        },
      });
      await expect(started.running).rejects.toThrow(/failed before the turn started/);
      // Give the rejection handler its microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        thread.roleDelivered,
        'the turn never ran, so the role reached nobody and must be pending again for the retry',
      ).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
    // The printf that writes the file, not the words anywhere in it — a comment
    // mentioning `"providers"` would satisfy a bare `toContain`.
    expect(launcher, 'the launcher does not write a provider opt-in')
      .toMatch(/printf\s+'\{"providers":\{"%s":\{"enabled":true\}\}\}/);

    /*
     * ORDER: written after `start`, loaded by `restart`. `start` wipes the state
     * directory, so a settings file written before it does not survive.
     *
     * Both positions are checked for existence first. `indexOf` returns -1 when
     * absent, and a `toBeGreaterThan(-1)` comparison passes for any real
     * position — so a launcher that had lost its `start` call entirely would
     * have satisfied the ordering. That is the same defect this file fixes twice
     * elsewhere, and it was here too.
     */
    const startAt = launcher.indexOf('t3-server.mjs start');
    const settingsAt = launcher.indexOf('SETTINGS=');
    const restartAt = launcher.indexOf('t3-server.mjs restart');
    expect(startAt, 'the launcher never starts a server').toBeGreaterThan(-1);
    expect(settingsAt, 'the launcher never writes a settings file').toBeGreaterThan(-1);
    expect(restartAt, 'the launcher never restarts to load the settings').toBeGreaterThan(-1);
    expect(settingsAt).toBeGreaterThan(startAt);
    expect(restartAt).toBeGreaterThan(settingsAt);
  });
});

describe('Spec 146 Phase 10 — live', () => {
  const status = harnessStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  /**
   * AN EXPLICIT PORT IS REQUIRED, AND THAT IS A SAFETY RULE RATHER THAN A STYLE ONE.
   *
   * This block calls `t3-server.mjs stop` and then `start`. Both act on whatever
   * `T3_HARNESS_PORT` and `T3_HARNESS_DIR` name, and both DEFAULT — to port 3799
   * and `tools/t3-server/.runtime`. On this machine 3799 is the architect's own
   * server. A live run with the variables unset would therefore stop a colleague's
   * server as its first act, and the failure would look like their session
   * dying for no reason.
   *
   * So an unset port is not defaulted, it is refused, and the refusal says why.
   * The recorded runs go through `full-protocol-run.sh`, which gives every run
   * its own port and its own directory for the same reason.
   */
  const explicitPort = process.env.T3_HARNESS_PORT?.trim();
  const canRunLive = status.ok && liveOptIn && Boolean(explicitPort);
  // The gate this test elapses. The RECORDED runs use 3600 and 86400; a test has
  // to be runnable, so it defaults short and says so. It is the same runner
  // either way — what the long runs prove and what this asserts are one code
  // path, not two.
  const gateSeconds = Number(process.env.T3_GATE_SECONDS?.trim() || '60');

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE + an explicit T3_HARNESS_PORT] runs a whole BUGFIX protocol on a '
      + 'thread with no PTY anywhere in it',
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
    if (!liveOptIn) {
      expect(process.env.T3_LIVE).not.toBe('1');
      return;
    }
    // Opted in and verified, but with no port named: that is a REFUSAL to run,
    // not a pass, and it must be visible as one.
    if (!explicitPort) {
      expect(
        canRunLive,
        'T3_LIVE=1 with no T3_HARNESS_PORT: this block would stop and start a server on the default '
          + 'port 3799, which is the architect\'s. Name a port nobody else is using.',
      ).toBe(false);
    }
  });
});
