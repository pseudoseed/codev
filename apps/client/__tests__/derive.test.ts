import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveRowStatus, statusWord } from '../src/status/derive.js';
import type { PorchStatusProjection, ThreadIdentity } from '../src/connection/types.js';

function porch(gates: PorchStatusProjection['gates']): PorchStatusProjection {
  return {
    projectId: '220',
    title: 'phase 11',
    protocol: 'air',
    phase: 'implement',
    currentPlanPhase: null,
    gates,
    artifactRoot: '/w/.builders/air-220',
    statusPath: '/w/.builders/air-220/codev/projects/220/status.yaml',
  };
}

function identity(over: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return {
    threadId: 'th-1',
    role: 'builder',
    roleId: 'builder-air-220',
    workspacePath: '/w',
    management: 'managed',
    ...over,
  };
}

describe('deriveRowStatus', () => {
  it('names the pending gate rather than reporting a bare block', () => {
    const status = deriveRowStatus(
      identity({ porch: porch({ 'plan-approval': { status: 'pending', requested_at: '2026-08-29T10:00:00Z' } }) }),
      'available',
    );
    expect(status.kind).toBe('blocked');
    expect(status.gate).toBe('plan-approval');
    expect(statusWord(status)).toBe('GATE PLAN-APPROVAL');
  });

  it('carries the structured question and its choices, not only the gate name', () => {
    const request = {
      question: 'Ship the driver behind a flag?',
      choices: [
        { label: 'Behind a flag', consequence: 'Nothing changes for existing users', recommended: true },
        { label: 'On by default', consequence: 'Every workspace picks it up at once' },
      ],
    };
    const status = deriveRowStatus(
      identity({ porch: porch({ 'spec-approval': { status: 'pending', requested_at: '2026-08-29T10:00:00Z', request } }) }),
      'available',
    );
    expect(status.gateRequest?.question).toBe('Ship the driver behind a flag?');
    expect(status.gateRequest?.choices).toHaveLength(2);
  });

  it('lets porch outrank a session that says settled', () => {
    const status = deriveRowStatus(
      identity({
        session: { status: 'idle', settled: true },
        porch: porch({ 'plan-approval': { status: 'pending', requested_at: '2026-08-29T10:00:00Z' } }),
      }),
      'available',
    );
    expect(status.kind).toBe('blocked');
  });

  /*
   * THE REAL SHAPE, read off two live status.yaml files on 2026-08-29.
   *
   * Porch declares a project's gates at init, so every AIR project carries
   * `gates.pr.status: pending` from its first commit until the PR merges. Both
   * `219` and `220` looked exactly like this while both were mid-implementation,
   * and reading `pending` alone reported both as blocked on a human.
   */
  it('does not call a declared-but-unrequested gate a block', () => {
    const status = deriveRowStatus(
      identity({ session: { status: 'running', settled: false }, porch: porch({ pr: { status: 'pending' } }) }),
      'available',
    );
    expect(status.kind).toBe('turning');
    expect(status.gate).toBeUndefined();
  });

  it('blocks on the same gate once porch requests it', () => {
    const status = deriveRowStatus(
      identity({
        session: { status: 'running', settled: false },
        porch: porch({ pr: { status: 'pending', requested_at: '2026-08-30T00:51:52.013Z' } }),
      }),
      'available',
    );
    expect(status.kind).toBe('blocked');
    expect(status.gate).toBe('pr');
    expect(status.gateRequestedAt).toBe('2026-08-30T00:51:52.013Z');
  });

  it('ignores approved gates', () => {
    const status = deriveRowStatus(
      identity({ session: { status: 'running', settled: false }, porch: porch({ 'spec-approval': { status: 'approved' } }) }),
      'available',
    );
    expect(status.kind).toBe('turning');
  });

  it('picks the newest pending gate deterministically', () => {
    const status = deriveRowStatus(
      identity({
        porch: porch({
          'spec-approval': { status: 'pending', requested_at: '2026-08-01T00:00:00Z' },
          'plan-approval': { status: 'pending', requested_at: '2026-08-29T00:00:00Z' },
        }),
      }),
      'available',
    );
    expect(status.gate).toBe('plan-approval');
  });

  /*
   * THE FULL MAPPING TABLE, both halves of every input.
   *
   * `settled` is deliberately ABSENT from the status column: it is not a t3code
   * session status and never was — settledness lives on the THREAD. The previous
   * table listed it as one, which meant the client recognised a word no server
   * sends and had no branch for four words every server does.
   */
  it.each([
    // status,        settled, expected kind
    ['running', false, 'turning'],
    ['running', true, 'turning'],
    ['starting', false, 'working'],
    ['starting', true, 'working'],
    ['ready', false, 'working'],
    ['ready', true, 'settled'],
    ['idle', false, 'working'],
    ['idle', true, 'settled'],
    ['stopped', false, 'stopped'],
    ['stopped', true, 'settled'],
    ['interrupted', false, 'stopped'],
    ['interrupted', true, 'settled'],
  ] as const)('maps session %s (settled=%s) to %s', (status, settled, kind) => {
    expect(deriveRowStatus(identity({ session: { status, settled } }), 'available').kind).toBe(kind);
  });

  it('reports an errored session as ERROR rather than laundering it into SETTLED', () => {
    // Even with the thread settled: a session that failed did not finish, and
    // `error` outranks settledness precisely so a crash cannot read as a result.
    const status = deriveRowStatus(
      identity({ session: { status: 'error', settled: true, lastError: 'provider crashed' } }),
      'available',
    );
    expect(status.kind).toBe('error');
    expect(statusWord(status)).toBe('ERROR');
    expect(status.why).toContain('provider crashed');
  });

  it('reports an errored session with no detail without inventing one', () => {
    const status = deriveRowStatus(
      identity({ session: { status: 'error', settled: false } }),
      'available',
    );
    expect(status.kind).toBe('error');
    expect(status.why).toContain('gave no detail');
  });

  it('lets a running turn outrank settledness, because settledAt is a past fact', () => {
    const status = deriveRowStatus(
      identity({ session: { status: 'running', settled: true } }),
      'available',
    );
    expect(status.kind).toBe('turning');
  });

  it('refuses to bucket a session status it does not recognise', () => {
    const status = deriveRowStatus(
      identity({ session: { status: 'hibernating', settled: false } }),
      'available',
    );
    expect(status.kind).toBe('unknown');
    expect(status.why).toContain('hibernating');
  });

  /*
   * THE ENUMERATION IS READ FROM THE CONTRACT, NOT TYPED HERE.
   *
   * A list you type is a claim; one you read is a fact. If t3code adds a session
   * status, this fails — which is where a mapping gap should surface, rather than
   * as UNKNOWN on somebody's screen.
   */
  it('renders a word for every session status the generated t3 contract declares', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
          'packages', 'types', 'src', 't3', 'generated', 'schema.json'),
        'utf8',
      ),
    ) as { $defs: Record<string, { properties?: { status?: { enum?: string[] } } }> };

    const session = schema.$defs.subscribeThreadOutput__Objects_6;
    const declared = session?.properties?.status?.enum;
    expect(
      declared,
      'the generated contract no longer declares the session status enum where this test reads '
      + 'it. That is this test needing a new path, not a mapping change — find the session '
      + 'object in packages/types/src/t3/generated/schema.json and point it there.',
    ).toBeDefined();
    // AN ANCHOR AGAINST A BLIND READ. `length > 0` alone would pass on a schema
    // shape change that yielded one junk value, and the loop below would then
    // verify nothing. These two are the statuses the previous mapping had no
    // branch for, so their presence is what makes this test's coverage real.
    expect(declared).toContain('idle');
    expect(declared).toContain('error');
    expect(declared!.length).toBeGreaterThanOrEqual(7);

    for (const status of declared!) {
      for (const settled of [false, true]) {
        const derived = deriveRowStatus(identity({ session: { status, settled } }), 'available');
        expect(
          derived.kind,
          `session status "${status}" (settled=${settled}) has no word in this client, so it `
          + 'renders UNKNOWN. t3code declares it, so add it to the mapping table in derive.ts '
          + 'rather than to this test.',
        ).not.toBe('unknown');
      }
    }
  });

  /*
   * THE STALE RULE. A cached snapshot that cannot say how old it is reintroduces
   * exactly the failure this band exists to prevent, so the withheld answer is
   * the finished-looking one and only that one.
   */
  describe('stale content', () => {
    const observation = { observedAt: '2026-08-29T10:00:00Z', ageMs: 240_000 };

    it('never derives SETTLED from content it has stopped watching', () => {
      const status = deriveRowStatus(
        identity({ session: { status: 'idle', settled: true } }),
        'stale',
        observation,
      );
      expect(status.kind).toBe('unknown');
      expect(status.why).toContain('4m ago');
      expect(status.whyIsRowSpecific).toBe(true);
    });

    it('keeps an active word, because the best available answer is still the answer', () => {
      expect(
        deriveRowStatus(identity({ session: { status: 'running', settled: false } }), 'stale', observation).kind,
      ).toBe('turning');
      expect(
        deriveRowStatus(identity({ session: { status: 'stopped', settled: false } }), 'stale', observation).kind,
      ).toBe('stopped');
    });

    it('says the age is unknown rather than implying it is small', () => {
      const status = deriveRowStatus(
        identity({ session: { status: 'ready', settled: true } }),
        'stale',
      );
      expect(status.kind).toBe('unknown');
      expect(status.why).toContain('an unknown length of time ago');
    });

    it('leaves a porch gate outranking staleness', () => {
      const status = deriveRowStatus(
        identity({
          session: { status: 'idle', settled: true },
          porch: porch({ pr: { status: 'pending', requested_at: '2026-08-29T10:00:00Z' } }),
        }),
        'stale',
        observation,
      );
      expect(status.kind).toBe('blocked');
    });
  });

  /*
   * Each unobservable status sends a reader somewhere different, so none of them
   * may share a sentence. This asserts they are pairwise distinct rather than
   * asserting six specific strings, which would be a test of the wording.
   */
  it('gives every unobservable status its own reason', () => {
    const statuses = [
      'not-provided', 'not-configured', 'misconfigured', 'connecting', 'cooling-down', 'unreachable',
    ] as const;
    const reasons = statuses.map((t3code) => deriveRowStatus(identity(), t3code).why);
    for (const reason of reasons) expect(reason).toBeTruthy();
    expect(new Set(reasons).size).toBe(statuses.length);
    // A machine-wide cause is stated once at the machine, never repeated per row.
    for (const t3code of statuses) {
      expect(deriveRowStatus(identity(), t3code).whyIsRowSpecific).toBeUndefined();
    }
  });

  it('separates "t3code returned nothing for this thread" from every machine-wide cause', () => {
    const status = deriveRowStatus(identity(), 'available');
    expect(status.kind).toBe('unknown');
    expect(status.whyIsRowSpecific).toBe(true);
  });

  it('does not spell "could not observe" the same way as "settled"', () => {
    const notProvided = deriveRowStatus(identity(), 'not-provided');
    const unreachable = deriveRowStatus(identity(), 'unreachable');
    const missing = deriveRowStatus(identity(), 'available');
    for (const status of [notProvided, unreachable, missing]) {
      expect(status.kind).toBe('unknown');
      expect(status.why).toBeTruthy();
    }
    expect(notProvided.why).not.toBe(unreachable.why);
    expect(unreachable.why).not.toBe(missing.why);
  });
});
