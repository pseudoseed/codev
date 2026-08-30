/*
 * The grid's placement rules, at the widths the criteria name.
 *
 * jsdom reports whatever `window.innerWidth` is set to and lays nothing out, so
 * these assert WHICH elements exist at which width — the placement half of
 * criteria 4b and 5. The measured half (pane geometry, computed font size,
 * scrollWidth) is Playwright's, in `e2e/tiling.spec.ts` and `e2e/mobile.spec.ts`,
 * because a jsdom "pass" on a number it never computed is worse than no test.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Grid } from '../src/grid/Grid.js';
import { buildTree } from '../src/tree/build.js';
import type { MachineConfig, MachineState } from '../src/connection/machine.js';
import type { AgentProtocolSnapshot, ThreadIdentity } from '../src/connection/types.js';

afterEach(cleanup);

const WORKSPACE = '/w';

function identities(builderCount: number): ThreadIdentity[] {
  const architect: ThreadIdentity = {
    threadId: 'th-arch',
    role: 'architect',
    roleId: 'main',
    workspacePath: WORKSPACE,
    management: 'unmanaged',
    sessionState: 'ready',
    messages: [{ id: 'a1', from: 'human', at: '2026-08-30T11:00:00Z', body: 'the last thing said' }],
  };
  const builders = Array.from({ length: builderCount }, (_, index): ThreadIdentity => ({
    threadId: `th-${index}`,
    role: 'builder',
    roleId: `builder-b${index}`,
    workspacePath: WORKSPACE,
    worktree: `${WORKSPACE}/.builders/b${index}`,
    management: 'managed',
    spawnedByArchitect: 'main',
    sessionState: 'running',
  }));
  return [architect, ...builders];
}

function machineNodes(builderCount: number) {
  const config: MachineConfig = {
    id: 'alpha',
    label: 'alpha',
    origin: 'http://127.0.0.1:4100',
    workspacePath: WORKSPACE,
    credential: 'id.secret',
  };
  const snapshot: AgentProtocolSnapshot = {
    schemaVersion: 1,
    workspacePath: WORKSPACE,
    generatedAt: '2026-08-30T12:00:00Z',
    protocol: {
      t3code: 'available',
      messageLog: 'available',
      architects: { main: 'th-arch' },
      builders: {},
      identities: identities(builderCount),
      statuses: [],
      signals: [],
    },
  };
  const state: MachineState = {
    config,
    status: 'live',
    why: null,
    message: null,
    snapshot,
    lastLiveAt: '2026-08-30T12:00:00Z',
    retrying: true,
  };
  return buildTree([state]);
}

function at(width: number, builderCount = 6) {
  window.innerWidth = width;
  window.innerHeight = width >= 1920 ? 1080 : 900;
  const view = render(<Grid machines={machineNodes(builderCount)} nowMs={Date.parse('2026-08-30T12:00:00Z')} />);
  act(() => { window.dispatchEvent(new Event('resize')); });
  return view;
}

describe('criterion 4b: the architect is not a seventh tile', () => {
  it('tiles six builders and puts the architect in a strip at 1440', () => {
    at(1440);
    expect(document.querySelectorAll('.tile-grid .pane')).toHaveLength(6);
    expect(document.querySelector('.tile-grid')!.getAttribute('data-columns')).toBe('3');
    expect(document.querySelector('.architect-strip')).toBeTruthy();
    expect(document.querySelector('.tile-grid [data-kind="architect"]')).toBeNull();
  });

  it('gives the architect a seventh tile, and no strip, at 1920', () => {
    at(1920);
    expect(document.querySelectorAll('.tile-grid .pane')).toHaveLength(7);
    expect(document.querySelector('.tile-grid [data-kind="architect"]')).toBeTruthy();
    expect(document.querySelector('.architect-strip')).toBeNull();
  });

  it('expands to a full pane that REPLACES the grid, and comes back', () => {
    at(1440);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(document.querySelector('[data-layout="expanded"]')).toBeTruthy();
    expect(document.querySelector('.tile-grid')).toBeNull();
    expect(document.querySelector('[data-kind="architect"]')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Back to grid' })[0]);
    expect(document.querySelector('.tile-grid')).toBeTruthy();
  });

  it('carries the architect last message into the strip', () => {
    at(1440);
    expect(document.querySelector('.strip-detail')!.textContent).toContain('the last thing said');
  });
});

describe('criterion 5: the narrow layout pages rather than shrinks', () => {
  it('renders exactly one pane and a pager at 390', () => {
    at(390);
    expect(document.querySelector('.tile-grid')).toBeNull();
    expect(document.querySelectorAll('.pane')).toHaveLength(1);
    expect(document.querySelector('.pager-position')!.getAttribute('data-position')).toBe('1/7');
  });

  it('moves one pane at a time and stops at both ends', () => {
    at(390);
    const previous = () => screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;

    expect(previous().disabled).toBe(true);
    fireEvent.click(next());
    expect(document.querySelector('.pager-position')!.getAttribute('data-position')).toBe('2/7');
    expect(previous().disabled).toBe(false);

    for (let step = 0; step < 10; step += 1) fireEvent.click(next());
    expect(document.querySelector('.pager-position')!.getAttribute('data-position')).toBe('7/7');
    expect(next().disabled).toBe(true);
  });

  /* The architect is reachable on a phone: it is a page, not a strip nobody can open. */
  it('includes the architect in the paged sequence', () => {
    at(390);
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(document.querySelector('[data-kind="architect"]')).toBeTruthy();
  });
});
