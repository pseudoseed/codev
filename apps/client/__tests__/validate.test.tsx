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
import { validateSnapshot } from '../src/connection/types.js';
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

  /* The client renders what porch says, so a null `currentPlanPhase` is normal. */
  it('accepts a null currentPlanPhase and an absent optional field', () => {
    const ok = snapshot();
    const identities = (ok.protocol as Record<string, unknown>).identities as Array<Record<string, unknown>>;
    delete identities[0].spawnedByArchitect;
    delete identities[0].sessionState;
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
