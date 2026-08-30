/**
 * ONE MALFORMED SERVER MUST NOT REACH ANOTHER MACHINE'S SUBTREE.
 *
 * The first version of `validateSnapshot` checked the top-level containers and
 * cast the rest, so a malformed nested identity, gate or choice passed and threw
 * later — in `buildTree` or mid-render. A throw there takes down the whole tree
 * rather than the subtree it came from, which is the opposite of criterion 8's
 * requirement that one server's failure leave the others live.
 *
 * So these assert the shape is rejected AT THE BOUNDARY, and then that a machine
 * sending nonsense leaves its neighbour rendering.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotRejection, validateSnapshot } from '../src/connection/types.js';
import { buildTree } from '../src/tree/build.js';
import { Tree } from '../src/tree/Tree.js';
import type { MachineConfig, MachineState } from '../src/connection/machine.js';

afterEach(cleanup);

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspacePath: '/w',
    generatedAt: '2026-08-30T01:00:00Z',
    protocol: {
      t3code: 'available',
      architects: { main: 'th-a' },
      builders: { 'builder-x': 'th-b' },
      identities: [{
        backing: 'terminal',
        role: 'builder',
        roleId: 'builder-x',
        workspacePath: '/w',
        management: 'managed',
        porch: {
          projectId: '1',
          title: 't',
          protocol: 'air',
          phase: 'implement',
          currentPlanPhase: null,
          gates: { pr: { status: 'pending', requested_at: 'now', request: { question: 'q?', choices: [{ label: 'a', consequence: 'b' }] } } },
          artifactRoot: '/w',
          statusPath: '/w/s.yaml',
        },
      }],
      statuses: [],
      signals: [{ code: 'X', message: 'y' }],
      ...over,
    },
  };
}

describe('validateSnapshot refuses a shape it cannot render', () => {
  it('accepts a well-formed payload', () => {
    expect(validateSnapshot(snapshot())).not.toBeNull();
  });

  it.each([
    ['an identity with no role', { identities: [{ backing: 'terminal', workspacePath: '/w', management: 'managed' }] }],
    ['an identity with an unknown backing', { identities: [{ backing: 'psychic', role: 'builder', workspacePath: '/w', management: 'managed' }] }],
    ['an identity whose workspacePath is a number', { identities: [{ backing: 'terminal', role: 'builder', workspacePath: 7, management: 'managed' }] }],
    ['identities that are not an array', { identities: { nope: true } }],
    ['a signal with no message', { signals: [{ code: 'X' }] }],
    ['an architect map holding a non-string', { architects: { main: 42 } }],
    ['a status that is not an object', { statuses: ['nope'] }],
  ])('rejects %s', (_name, over) => {
    expect(validateSnapshot(snapshot(over))).toBeNull();
  });

  it.each([
    ['a gate with an unknown status', { status: 'maybe' }],
    ['a gate whose request has no question', { status: 'pending', request: { choices: [] } }],
    ['a gate whose choices are not an array', { status: 'pending', request: { question: 'q', choices: 'a' } }],
    ['a choice with no consequence', { status: 'pending', request: { question: 'q', choices: [{ label: 'a' }] } }],
    ['a choice whose recommended is a string', { status: 'pending', request: { question: 'q', choices: [{ label: 'a', consequence: 'b', recommended: 'yes' }] } }],
  ])('rejects %s, which would otherwise throw mid-render', (_name, gate) => {
    const bad = snapshot();
    const protocol = bad.protocol as Record<string, unknown>;
    const identities = protocol.identities as Array<Record<string, unknown>>;
    (identities[0].porch as Record<string, unknown>).gates = { pr: gate };
    expect(validateSnapshot(bad)).toBeNull();
  });

  /*
   * THE EIGHT-STATUS VOCABULARY, AND THE CROSS-VERSION RULE AROUND IT.
   *
   * The set is an allow-list on purpose: a value this build does not know is a
   * payload it cannot read, and rendering half of one is what this validator
   * exists to prevent. The allow-list is NOT loosened to make a test pass — if a
   * new status is added to the server, it is added here too, deliberately.
   */
  it.each([
    'not-provided', 'not-configured', 'misconfigured', 'connecting',
    'cooling-down', 'unreachable', 'available', 'stale',
  ])('accepts the %s snapshot status', (t3code) => {
    expect(validateSnapshot(snapshot({ t3code }))).not.toBeNull();
  });

  it('still refuses a status outside the set rather than rendering half a payload', () => {
    expect(validateSnapshot(snapshot({ t3code: 'sideways' }))).toBeNull();
  });

  /*
   * WHY `t3codeObservation` IS A SIBLING RATHER THAN `t3code` BECOMING AN OBJECT.
   *
   * `snapshotRejection` tells an older server from a corrupt payload by whether
   * `t3code` is ABSENT. Promote `t3code` to an object and an older server's bare
   * string becomes "corrupt", blanking a whole machine over a version
   * difference. As a sibling, the older server validates and simply carries no
   * age — and an unknown age is handled as unknown, never as fresh.
   */
  it('accepts an older server: a valid status and no observation', () => {
    const older = snapshot({ t3code: 'available' });
    delete (older.protocol as Record<string, unknown>).t3codeObservation;
    expect(validateSnapshot(older)).not.toBeNull();
    expect(snapshotRejection(older)).toBeNull();
  });

  it('accepts a well-formed observation', () => {
    const ok = snapshot({ t3code: 'stale' });
    (ok.protocol as Record<string, unknown>).t3codeObservation =
      { observedAt: '2026-08-29T10:00:00Z', ageMs: 5000 };
    expect(validateSnapshot(ok)).not.toBeNull();
  });

  it.each([
    ['a non-numeric age', { observedAt: '2026-08-29T10:00:00Z', ageMs: 'old' }],
    ['an infinite age', { observedAt: '2026-08-29T10:00:00Z', ageMs: Infinity }],
    ['no observedAt', { ageMs: 5000 }],
    ['a non-object', 'recent'],
  ])('refuses %s, because a present-but-malformed observation is unreadable', (_name, observation) => {
    const bad = snapshot({ t3code: 'stale' });
    (bad.protocol as Record<string, unknown>).t3codeObservation = observation;
    expect(validateSnapshot(bad)).toBeNull();
  });

  it.each([
    ['a session with no status', { settled: false }],
    ['a session whose settled is a string', { status: 'idle', settled: 'yes' }],
    ['a session whose lastError is a number', { status: 'error', settled: false, lastError: 5 }],
    ['a session that is not an object', 'idle'],
  ])('refuses %s on an identity', (_name, session) => {
    const bad = snapshot();
    const identities = (bad.protocol as Record<string, unknown>).identities as Array<Record<string, unknown>>;
    identities[0].session = session;
    expect(validateSnapshot(bad)).toBeNull();
  });

  it('accepts a well-formed identity session', () => {
    const ok = snapshot();
    const identities = (ok.protocol as Record<string, unknown>).identities as Array<Record<string, unknown>>;
    identities[0].session = { status: 'running', settled: false };
    expect(validateSnapshot(ok)).not.toBeNull();
  });

  /* The client renders what porch says, so a null `currentPlanPhase` is normal. */
  it('accepts a null currentPlanPhase and an absent optional field', () => {
    const ok = snapshot();
    const identities = (ok.protocol as Record<string, unknown>).identities as Array<Record<string, unknown>>;
    delete identities[0].spawnedByArchitect;
    delete identities[0].session;
    expect(validateSnapshot(ok)).not.toBeNull();
  });
});

describe('a malformed machine cannot take down a good one', () => {
  function config(id: string): MachineConfig {
    return { id, label: id, origin: `/m/${id}`, workspacePath: `/srv/${id}`, credential: `${id}.s` };
  }

  function good(id: string): MachineState {
    return {
      config: config(id),
      status: 'live',
      why: null,
      message: null,
      signal: null,
      snapshot: validateSnapshot(snapshot())!,
      lastLiveAt: '2026-08-30T01:00:00Z',
      retrying: true,
    };
  }

  /*
   * The malformed payload never becomes a snapshot: `connectMachine` refuses it
   * and drops that machine to `protocol`. This asserts the CONSEQUENCE — the
   * other machine still renders — because that is the property criterion 8 is
   * about, and a boundary test alone would not show it.
   */
  it('renders the healthy machine while the malformed one reports a protocol failure', () => {
    const broken: MachineState = {
      config: config('beta'),
      status: 'disconnected',
      why: 'protocol',
      message: 'the server sent a snapshot this client does not understand',
      signal: null,
      snapshot: null,
      lastLiveAt: null,
      retrying: true,
    };

    render(<Tree machines={buildTree([good('alpha'), broken])} nowMs={Date.parse('2026-08-30T01:00:30Z')} />);

    const alpha = document.querySelector('[data-machine="alpha"]')!;
    expect(alpha.getAttribute('data-connection')).toBe('live');
    expect(alpha.querySelectorAll('.thread-row').length).toBeGreaterThan(0);

    const beta = document.querySelector('[data-machine="beta"]')!;
    expect(beta.getAttribute('data-connection')).toBe('disconnected');
    expect(beta.textContent).toContain('does not understand');
    // Named as a protocol problem, not as an empty workspace.
    expect(beta.textContent).toContain('No state has arrived from this machine');
  });
});

/**
 * AN OLDER SERVER IS NOT A CORRUPT ONE.
 *
 * The doc comment on `validateSnapshot` claimed this distinction while the code
 * rejected both identically — a comment asserting a difference the code does not
 * make, in the function whose whole job is making differences. Same defect class
 * as everything else in this PR, one level up. These assert the branch exists.
 */
describe('why a payload was refused', () => {
  it('names a missing t3code field as an older server, not as unreadable', () => {
    const old = snapshot();
    delete (old.protocol as Record<string, unknown>).t3code;
    expect(validateSnapshot(old)).toBeNull();
    expect(snapshotRejection(old)).toBe('older-server');
  });

  it('does not soften a present-but-wrong value into a version difference', () => {
    expect(snapshotRejection(snapshot({ t3code: 'sideways' }))).toBe('unreadable');
  });

  it.each([
    ['a corrupt identity', snapshot({ identities: [{ nope: true }] })],
    ['a wrong schemaVersion', { ...snapshot(), schemaVersion: 2 }],
    ['not an object at all', 'nope'],
    ['null', null],
  ])('names %s as unreadable', (_name, payload) => {
    expect(snapshotRejection(payload)).toBe('unreadable');
  });

  it('says nothing was wrong with a payload it accepted', () => {
    expect(snapshotRejection(snapshot())).toBeNull();
  });
});
