/*
 * Criteria 7, 8 and 15 at the level a human reads them: two machines in one
 * tree, and one of them failing does nothing to the other.
 */
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tree } from '../src/tree/Tree.js';
import { buildTree } from '../src/tree/build.js';
import type { MachineConfig, MachineState } from '../src/connection/machine.js';
import type { AgentProtocolSnapshot } from '../src/connection/types.js';

afterEach(cleanup);

function config(id: string, workspacePath: string): MachineConfig {
  return { id, label: id, origin: `/m/${id}`, workspacePath, credential: `${id}.secret` };
}

function snapshot(workspacePath: string, builderId: string): AgentProtocolSnapshot {
  return {
    schemaVersion: 1,
    workspacePath,
    generatedAt: '2026-08-30T01:00:00Z',
    protocol: {
      t3code: 'available',
      architects: {},
      builders: {},
      identities: [
        {
          backing: 'terminal',
          role: 'architect',
          roleId: 'main',
          workspacePath,
          management: 'unmanaged',
          sessionState: 'ready',
        },
        {
          backing: 'terminal',
          role: 'builder',
          roleId: builderId,
          workspacePath,
          worktree: `${workspacePath}/.builders/${builderId}`,
          management: 'managed',
          spawnedByArchitect: 'main',
          sessionState: 'running',
        },
      ],
      statuses: [],
      signals: [],
    },
  };
}

function machine(id: string, workspacePath: string, builderId: string, over: Partial<MachineState> = {}): MachineState {
  return {
    config: config(id, workspacePath),
    status: 'live',
    why: null,
    message: null,
    signal: null,
    snapshot: snapshot(workspacePath, builderId),
    lastLiveAt: '2026-08-30T01:00:00Z',
    retrying: true,
    ...over,
  };
}

function renderTree(states: MachineState[]) {
  return render(<Tree machines={buildTree(states)} nowMs={Date.parse('2026-08-30T01:00:30Z')} />);
}

describe('two machines in one tree', () => {
  it('renders each machine\'s own workspace and rows', () => {
    renderTree([
      machine('alpha', '/srv/alpha', 'air-220'),
      machine('beta', '/srv/beta', 'spir-146'),
    ]);
    const alpha = document.querySelector('[data-machine="alpha"]') as HTMLElement;
    const beta = document.querySelector('[data-machine="beta"]') as HTMLElement;
    expect(within(alpha).getByText('/srv/alpha')).toBeTruthy();
    expect(within(beta).getByText('/srv/beta')).toBeTruthy();
    expect(alpha.querySelector('[data-id="air-220"]')).toBeTruthy();
    expect(alpha.querySelector('[data-id="spir-146"]')).toBeNull();
    expect(beta.querySelector('[data-id="spir-146"]')).toBeTruthy();
  });

  it('marks one subtree disconnected with a timestamp and leaves the other live', () => {
    renderTree([
      machine('alpha', '/srv/alpha', 'air-220'),
      machine('beta', '/srv/beta', 'spir-146', {
        status: 'disconnected',
        why: 'transport',
        message: 'the server could not be reached',
        lastLiveAt: '2026-08-30T00:59:00Z',
      }),
    ]);
    const alpha = document.querySelector('[data-machine="alpha"]')!;
    const beta = document.querySelector('[data-machine="beta"]')!;
    expect(alpha.getAttribute('data-connection')).toBe('live');
    expect(alpha.querySelector('.conn-live')).toBeTruthy();
    expect(beta.getAttribute('data-connection')).toBe('disconnected');
    expect(beta.querySelector('.conn-down')!.textContent).toContain('2m ago');
    expect(beta.querySelector('.conn-down')!.textContent).toContain('2026-08-30T00:59:00Z');
    // Beta's rows are still there, marked stale rather than blanked.
    expect(beta.querySelectorAll('.thread-row')).toHaveLength(2);
    expect(beta.querySelector('.workspace.is-stale')).toBeTruthy();
    expect(alpha.querySelector('.workspace.is-stale')).toBeNull();
  });

  it('fails a revoked machine closed and does not touch the other', () => {
    renderTree([
      machine('alpha', '/srv/alpha', 'air-220'),
      machine('beta', '/srv/beta', 'spir-146', {
        status: 'disconnected',
        why: 'revoked',
        retrying: false,
        signal: 'MACHINE_CREDENTIAL_REVOKED',
        message: 'credential beta was revoked at 2026-08-30T01:00:00Z',
        lastLiveAt: '2026-08-30T00:59:00Z',
      }),
    ]);
    const alpha = document.querySelector('[data-machine="alpha"]')!;
    const beta = document.querySelector('[data-machine="beta"]')!;
    expect(alpha.querySelector('.conn-live')).toBeTruthy();
    expect(alpha.querySelector('.conn-revoked')).toBeNull();

    const band = beta.querySelector('.conn-revoked')!;
    expect(band).toBeTruthy();
    // Not a generic disconnect, in words as well as in class.
    expect(beta.querySelector('.conn-down')).toBeNull();
    expect(band.textContent).toContain('ACCESS REVOKED');
    expect(band.textContent).toContain('not retrying');
    expect(band.textContent).toContain('Reconnecting will not help');
    expect(band.textContent).toContain('MACHINE_CREDENTIAL_REVOKED');
  });

  it('counts a machine that never connected as a machine, not as absent', () => {
    renderTree([
      machine('alpha', '/srv/alpha', 'air-220'),
      machine('beta', '/srv/beta', 'spir-146', {
        status: 'disconnected',
        why: 'transport',
        snapshot: null,
        lastLiveAt: null,
        message: 'the server could not be reached',
      }),
    ]);
    expect(document.querySelectorAll('.machine')).toHaveLength(2);
    const beta = document.querySelector('[data-machine="beta"]')!;
    expect(beta.querySelector('.conn-down')!.textContent).toContain('never connected');
    expect(beta.textContent).toContain('No state has arrived from this machine');
  });
});
