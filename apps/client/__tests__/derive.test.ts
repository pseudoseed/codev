import { describe, expect, it } from 'vitest';
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
        sessionState: 'settled',
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
      identity({ sessionState: 'running', porch: porch({ pr: { status: 'pending' } }) }),
      'available',
    );
    expect(status.kind).toBe('turning');
    expect(status.gate).toBeUndefined();
  });

  it('blocks on the same gate once porch requests it', () => {
    const status = deriveRowStatus(
      identity({
        sessionState: 'running',
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
      identity({ sessionState: 'running', porch: porch({ 'spec-approval': { status: 'approved' } }) }),
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

  it.each([
    ['settled', 'settled'],
    ['running', 'turning'],
    ['turning', 'turning'],
    ['starting', 'working'],
    ['ready', 'working'],
  ])('maps session state %s to %s', (sessionState, kind) => {
    expect(deriveRowStatus(identity({ sessionState }), 'available').kind).toBe(kind);
  });

  it('refuses to bucket a session state it does not recognise', () => {
    const status = deriveRowStatus(identity({ sessionState: 'hibernating' }), 'available');
    expect(status.kind).toBe('unknown');
    expect(status.why).toContain('hibernating');
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
