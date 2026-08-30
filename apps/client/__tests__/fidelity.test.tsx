/*
 * What a human actually sees. Issue #112: a client passed 127 component tests
 * while having dropped every label prefix, the header bar, and any visible idle
 * mark. Tests that assert "the name renders" pass happily through exactly that,
 * so these assert the things whose absence made that build unusable.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineSubtree } from '../src/tree/MachineSubtree.js';
import { buildTree } from '../src/tree/build.js';
import type { MachineConfig, MachineState } from '../src/connection/machine.js';
import type { AgentProtocolSnapshot, ThreadIdentity } from '../src/connection/types.js';

afterEach(cleanup);

const config: MachineConfig = {
  id: 'alpha',
  label: 'alpha',
  origin: 'http://127.0.0.1:4100',
  workspacePath: '/Users/x/dev/codev',
  credential: 'id.secret',
};

const IDENTITIES: ThreadIdentity[] = [
  {
    threadId: 'th-arch',
    role: 'architect',
    roleId: 'main',
    workspacePath: '/Users/x/dev/codev',
    management: 'unmanaged',
    sessionState: 'ready',
  },
  {
    threadId: 'th-220',
    role: 'builder',
    roleId: 'air-220',
    workspacePath: '/Users/x/dev/codev',
    worktree: '/Users/x/dev/codev/.builders/air-220',
    management: 'managed',
    spawnedByArchitect: 'main',
    sessionState: 'running',
    porch: {
      projectId: '220',
      title: 'phase 11',
      protocol: 'air',
      phase: 'implement',
      currentPlanPhase: null,
      gates: {},
      artifactRoot: '/Users/x/dev/codev/.builders/air-220',
      statusPath: '/Users/x/dev/codev/.builders/air-220/codev/projects/220/status.yaml',
    },
  },
  {
    threadId: 'th-146',
    role: 'builder',
    roleId: 'spir-146',
    workspacePath: '/Users/x/dev/codev',
    worktree: '/Users/x/dev/codev/.builders/spir-146',
    management: 'managed',
    spawnedByArchitect: 'main',
    sessionState: 'settled',
    porch: {
      projectId: '146',
      title: 'codev client',
      protocol: 'spir',
      phase: 'plan',
      currentPlanPhase: 'phase_11',
      gates: {
        // Declared-but-unrequested, exactly as porch leaves it. Not a block.
        pr: { status: 'pending' },
        'plan-approval': { status: 'pending', requested_at: '2026-08-29T11:00:00Z' },
      },
      artifactRoot: '/Users/x/dev/codev/.builders/spir-146',
      statusPath: '/Users/x/dev/codev/.builders/spir-146/codev/projects/146/status.yaml',
    },
  },
];

function snapshot(): AgentProtocolSnapshot {
  return {
    schemaVersion: 1,
    workspacePath: '/Users/x/dev/codev',
    generatedAt: '2026-08-29T12:00:00Z',
    protocol: {
      t3code: 'available',
      architects: { main: 'th-arch' },
      builders: { 'air-220': 'th-220', 'spir-146': 'th-146' },
      identities: IDENTITIES,
      statuses: [],
      signals: [],
    },
  };
}

function state(over: Partial<MachineState> = {}): MachineState {
  return {
    config,
    status: 'live',
    why: null,
    message: null,
    snapshot: snapshot(),
    lastLiveAt: '2026-08-29T12:00:00Z',
    retrying: true,
    ...over,
  };
}

function renderMachine(over: Partial<MachineState> = {}) {
  const node = buildTree([state(over)])[0];
  return render(<MachineSubtree node={node} nowMs={Date.parse('2026-08-29T12:00:30Z')} />);
}

describe('the tree a human looks at', () => {
  it('shows the machine, the workspace path, the architect and its builders', () => {
    renderMachine();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('/Users/x/dev/codev')).toBeTruthy();
    expect(document.querySelector('[data-kind="architect"][data-id="main"]')).toBeTruthy();
    expect(document.querySelector('[data-kind="builder"][data-id="air-220"]')).toBeTruthy();
    expect(document.querySelector('[data-kind="builder"][data-id="spir-146"]')).toBeTruthy();
  });

  it('keeps the kind prefix in front of every name', () => {
    renderMachine();
    const prefixes = [...document.querySelectorAll('.kind-prefix')].map((el) => el.textContent);
    expect(prefixes).toContain('architect/');
    expect(prefixes.filter((text) => text === 'builder/')).toHaveLength(2);
  });

  it('nests builders inside their architect, not beside it', () => {
    renderMachine();
    const group = document.querySelector('.architect-group')!;
    expect(within(group as HTMLElement).getByText('air-220')).toBeTruthy();
    expect(group.querySelector('.builder-list [data-id="air-220"]')).toBeTruthy();
  });

  it('gives every row a status word, never a bare colour mark', () => {
    renderMachine();
    const rows = [...document.querySelectorAll('.thread-row')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const stamp = row.querySelector('.status-stamp');
      expect(stamp).toBeTruthy();
      expect((stamp!.textContent ?? '').trim().length).toBeGreaterThan(2);
    }
  });

  it('names the gate a blocked builder is waiting on', () => {
    renderMachine();
    const blocked = document.querySelector('[data-id="spir-146"]')!;
    expect(blocked.querySelector('.status-stamp')!.textContent).toBe('GATE PLAN-APPROVAL');
    expect(blocked.classList.contains('needs-attn')).toBe(true);
  });

  it('makes a blocked builder visually distinct from a settled one', () => {
    renderMachine();
    const blocked = document.querySelector('[data-id="spir-146"]')!;
    const running = document.querySelector('[data-id="air-220"]')!;
    expect(blocked.getAttribute('data-status')).toBe('blocked');
    expect(running.getAttribute('data-status')).toBe('turning');
    expect(blocked.className).not.toBe(running.className);
  });

  it('shows the porch phase on a managed builder', () => {
    renderMachine();
    const row = document.querySelector('[data-id="air-220"]')!;
    expect(row.querySelector('.porch-phase')!.textContent).toContain('AIR');
    expect(row.querySelector('.porch-phase')!.textContent).toContain('implement');
  });

  it('says LIVE and when it was last updated', () => {
    renderMachine();
    const strip = document.querySelector('.conn-strip')!;
    expect(strip.textContent).toContain('LIVE');
    expect(strip.textContent).toContain('30s ago');
  });
});

describe('honest degradation', () => {
  it('marks a stopped machine disconnected with a last-updated timestamp', () => {
    renderMachine({
      status: 'disconnected',
      why: 'transport',
      message: 'the server could not be reached',
      lastLiveAt: '2026-08-29T11:59:00Z',
    });
    const strip = document.querySelector('.conn-strip')!;
    expect(strip.textContent).toContain('DISCONNECTED');
    expect(strip.textContent).toContain('2m ago');
    expect(strip.textContent).toContain('2026-08-29T11:59:00Z');
    expect(strip.textContent).toContain('the server could not be reached');
  });

  it('says the retained subtree is not current', () => {
    renderMachine({ status: 'disconnected', why: 'transport', lastLiveAt: '2026-08-29T11:59:00Z' });
    expect(screen.getByText(/not current/i)).toBeTruthy();
    expect(document.querySelector('.workspace.is-stale')).toBeTruthy();
    // And it does NOT go blank: the rows are still there, labelled stale.
    expect(document.querySelectorAll('.thread-row')).toHaveLength(3);
  });

  it('does not render disconnected and connected the same way', () => {
    const { container: live } = renderMachine();
    const { container: down } = renderMachine({ status: 'disconnected', why: 'auth', lastLiveAt: null });
    expect(live.querySelector('.machine')!.className)
      .not.toBe(down.querySelector('.machine')!.className);
    expect(down.querySelector('.conn-down')).toBeTruthy();
    expect(live.querySelector('.conn-down')).toBeNull();
  });

  it('tells "connected and empty" from "disconnected"', () => {
    const empty = snapshot();
    renderMachine({
      snapshot: { ...empty, protocol: { ...empty.protocol, identities: [], architects: {}, builders: {} } },
    });
    expect(screen.getByText(/connected and reports no architects/i)).toBeTruthy();
    expect(document.querySelector('.conn-down')).toBeNull();
  });

  it('says why a revoked machine is closed, and that it is not retrying', () => {
    renderMachine({
      status: 'disconnected',
      why: 'auth',
      retrying: false,
      message: 'this machine is not authorized; its credential was refused or revoked',
      lastLiveAt: '2026-08-29T11:59:00Z',
    });
    const strip = document.querySelector('.conn-strip')!;
    expect(strip.textContent).toContain('not retrying');
    expect(strip.textContent).toContain('not authorized');
  });

  it('reports an unobservable session as unknown, with the reason on the row', () => {
    const base = snapshot();
    renderMachine({
      snapshot: {
        ...base,
        protocol: {
          ...base.protocol,
          t3code: 'not-provided',
          identities: base.protocol.identities.map(({ sessionState: _drop, ...rest }) => rest),
        },
      },
    });
    const row = document.querySelector('[data-id="air-220"]')!;
    expect(row.getAttribute('data-status')).toBe('unknown');
    expect(row.querySelector('.status-stamp')!.textContent).toBe('UNKNOWN');
    expect(row.querySelector('.row-why')!.textContent).toContain('not reporting session state');
  });
});

/*
 * "Where porch and t3code disagree, porch wins and the client shows porch's
 * value." Titles, pins and activity entries are display projections, never a
 * source of truth — so the row's identity comes from `status.yaml`, and a
 * disagreement between the two stores is surfaced rather than resolved.
 */
describe('porch wins', () => {
  it('shows porch\'s protocol and phase, not a session-derived label', () => {
    renderMachine();
    const row = document.querySelector('[data-id="air-220"]')!;
    expect(row.querySelector('.porch-phase')!.textContent).toBe('AIR · implement');
  });

  it('keeps the gate a blocked row is on even when the session says settled', () => {
    const base = snapshot();
    renderMachine({
      snapshot: {
        ...base,
        protocol: {
          ...base.protocol,
          identities: base.protocol.identities.map((identity) =>
            identity.roleId === 'spir-146' ? { ...identity, sessionState: 'settled' } : identity),
        },
      },
    });
    const blocked = document.querySelector('[data-id="spir-146"]')!;
    expect(blocked.getAttribute('data-status')).toBe('blocked');
    expect(blocked.querySelector('.status-stamp')!.textContent).toBe('GATE PLAN-APPROVAL');
  });

  it('surfaces a two-store disagreement instead of resolving it', () => {
    const base = snapshot();
    renderMachine({
      snapshot: {
        ...base,
        protocol: {
          ...base.protocol,
          signals: [{
            code: 'THREAD_ID_DISAGREEMENT',
            message: 'status.yaml names th-old, while global.db names th-220; porch remains authoritative',
            role: 'builder',
            roleId: 'air-220',
          }],
        },
      },
    });
    const signals = document.querySelector('.signals')!;
    expect(signals.textContent).toContain('THREAD_ID_DISAGREEMENT');
    expect(signals.textContent).toContain('porch remains authoritative');
  });
});
