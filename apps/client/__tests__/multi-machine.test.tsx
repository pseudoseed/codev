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
          session: { status: 'ready', settled: false },
        },
        {
          backing: 'terminal',
          role: 'builder',
          roleId: builderId,
          workspacePath,
          worktree: `${workspacePath}/.builders/${builderId}`,
          management: 'managed',
          spawnedByArchitect: 'main',
          session: { status: 'running', settled: false },
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

describe('three refusals, three appearances', () => {
  /*
   * Withdrawn, unverifiable and unreachable are three different instructions to
   * an operator. Rendering any two of them the same way is the defect this
   * client exists to avoid, so this asserts they are pairwise distinct rather
   * than asserting each one's wording in isolation.
   */
  function bandFor(over: Partial<MachineState>): { className: string; text: string } {
    cleanup();
    renderTree([machine('alpha', '/srv/alpha', 'air-220', {
      status: 'disconnected',
      lastLiveAt: '2026-08-30T00:59:00Z',
      ...over,
    })]);
    const strip = document.querySelector('.conn-strip')!;
    return { className: strip.className, text: strip.textContent ?? '' };
  }

  it('keeps revoked, cannot-verify and disconnected visually and verbally apart', () => {
    const revoked = bandFor({
      why: 'revoked', retrying: false, signal: 'MACHINE_CREDENTIAL_REVOKED',
      message: 'credential alpha was revoked',
    });
    const cannotVerify = bandFor({
      why: 'indeterminate', retrying: true, signal: 'MACHINE_STORE_UNREADABLE',
      message: 'credential could not be re-checked',
    });
    const down = bandFor({ why: 'transport', retrying: true, message: 'the server answered 502' });

    const classes = [revoked.className, cannotVerify.className, down.className];
    expect(new Set(classes).size).toBe(3);

    expect(revoked.text).toContain('ACCESS REVOKED');
    expect(revoked.text).toContain('not retrying');
    expect(cannotVerify.text).toContain('CANNOT VERIFY');
    expect(cannotVerify.text).toContain('retrying');
    expect(cannotVerify.text).toContain('not the same as');
    expect(down.text).toContain('DISCONNECTED');

    // And each still carries a last-updated timestamp.
    for (const band of [revoked, cannotVerify, down]) {
      expect(band.text).toContain('2026-08-30T00:59:00Z');
    }
  });

  it('does not tell an operator to re-pair a machine that was never refused', () => {
    const cannotVerify = bandFor({
      why: 'indeterminate', retrying: true, signal: 'MACHINE_STORE_UNREADABLE',
      message: 'credential could not be re-checked',
    });
    expect(cannotVerify.text).not.toContain('Reconnecting will not help');
    expect(cannotVerify.text).not.toContain('paired again');
  });
});

describe('connected but not current', () => {
  /*
   * The failure the disconnected band was built to prevent, arriving through the
   * one branch that kept the connection open. A LIVE badge over a tree the
   * server has just said it could not fully read is the same lie in a different
   * place.
   */
  it('never shows LIVE over a tree the server said it could not read', () => {
    renderTree([machine('alpha', '/srv/alpha', 'air-220', {
      status: 'degraded',
      message: 'status.yaml cannot be read: EACCES',
      signal: 'STATUS_UNREADABLE',
      lastLiveAt: '2026-08-30T00:59:00Z',
    })]);
    const strip = document.querySelector('.conn-strip')!;
    expect(strip.className).toContain('conn-degraded');
    expect(strip.textContent).toContain('STALE');
    expect(strip.textContent).not.toContain('LIVE');
    expect(strip.textContent).toContain('last complete 2m ago');
    expect(strip.textContent).toContain('EACCES');
    expect(strip.textContent).toContain('STATUS_UNREADABLE');
    // Still says the connection itself is fine, so nobody goes looking at the box.
    expect(strip.textContent).toContain('connected');
    // And the tree under it is marked stale, not blanked.
    expect(document.querySelector('.workspace.is-stale')).toBeTruthy();
    expect(document.querySelectorAll('.thread-row')).toHaveLength(2);
  });
});
