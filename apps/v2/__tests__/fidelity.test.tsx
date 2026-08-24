/*
 * Fidelity against codev/research/v2-mockups/01-site.png (issue #112).
 *
 * The component tests next door assert that a name renders. That is exactly
 * what let the shipped view lose every label prefix and still pass: "b1" is
 * present whether or not "builder/" is in front of it. These assertions are
 * written against the approved design instead — the fixture mirrors the
 * mockup's own data, and each check names the thing the mockup shows.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Page } from '../src/App.js';
import { IDLE_PX } from '../src/components/Sparkline.js';
import { initialAppState, type AppState } from '../src/lib/stream.js';
import type { ClientNode } from '../src/lib/validate.js';

const FLAT = Array.from({ length: 20 }, () => 0);
const BUSY = Array.from({ length: 20 }, (_, i) => (i % 4) * 3);

function node(over: Partial<ClientNode> & Pick<ClientNode, 'id' | 'kind'>): ClientNode {
  return {
    parentId: null,
    name: over.id,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    buckets: FLAT,
    ...over,
  };
}

/* The mockup's own tower-01 / checkout column, plus the offline lot beside it. */
function mockupState(): AppState {
  const s = initialAppState();
  s.connection = 'live';
  s.bootstrap = 'scoped';
  s.reducer.nodes = new Map(
    (
      [
        node({ id: 'workspace:/checkout', kind: 'workspace', name: 'checkout' }),
        node({
          id: 'architect:1',
          kind: 'architect',
          parentId: 'workspace:/checkout',
          name: 'checkout-v3',
        }),
        node({
          id: 'builder:2201',
          kind: 'builder',
          parentId: 'architect:1',
          name: 'pay-2201',
          status: 'gate-waiting',
        }),
        node({
          id: 'builder:2189',
          kind: 'builder',
          parentId: 'architect:1',
          name: 'pay-2189',
          buckets: BUSY,
        }),
        node({ id: 'workspace:/billing', kind: 'workspace', name: 'billing-svc', status: 'offline' }),
      ] as ClientNode[]
    ).map((n) => [n.id, n] as const),
  );
  s.reducer.counts = { workspaces: 5, builders: { total: 11, byStatus: { running: 1 } }, gateWaiting: 3 };
  return s;
}

describe('fidelity to the approved site design', () => {
  afterEach(() => cleanup());

  it('prefixes every node kind, so the kind is read and not inferred', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    const prefix = (sel: string) => container.querySelector(`${sel} .kind-prefix`)?.textContent;
    expect(prefix('[data-id="workspace:/checkout"]')).toBe('workspace /');
    expect(prefix('[data-kind="architect"]')).toBe('architect/');
    expect(prefix('[data-id="builder:2201"]')).toBe('builder/');
    const stake = container.querySelector('[data-id="builder:2201"] .stake-name');
    expect(stake?.textContent).toBe('builder/pay-2201');
  });

  it('keeps the bare name addressable beside its prefix', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    expect(container.querySelector('.ws-plot-label')?.textContent).toBe('checkout');
    expect(container.querySelector('.ws-plot-label')?.textContent).not.toMatch(/workspace/);
  });

  it('gives each node kind its glyph, from paths and not a CDN font', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    expect(container.querySelector('[data-kind="workspace"] .ws-plot-right svg.glyph')).toBeTruthy();
    expect(container.querySelector('[data-kind="architect"] svg.glyph')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/fa-solid|font-awesome/);
  });

  it('states the register counts in the header bar', () => {
    render(<Page state={mockupState()} hostname="tower-01" />);
    const reg = screen.getByTestId('site-register');
    expect(reg.textContent).toMatch(/Site register/);
    expect(reg.textContent).toMatch(/5 workspaces/);
    expect(reg.textContent).toMatch(/11 builders/);
  });

  it('names the machine and says its stream is live, and invents nothing else', () => {
    render(<Page state={mockupState()} hostname="tower-01" />);
    const row = screen.getByTestId('machine-row');
    expect(row.textContent).toMatch(/tower-01/);
    expect(row.textContent).toMatch(/online/i);
    expect(row.textContent).not.toMatch(/load|%|Mac Studio/i);
  });

  it('draws an idle trace as a visible flat baseline, not as nothing', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    const idle = container.querySelector('[data-id="builder:2201"] .spark');
    const heights = [...(idle?.querySelectorAll('i') ?? [])].map((el) => (el as HTMLElement).style.height);
    expect(heights).toHaveLength(20);
    expect(new Set(heights).size).toBe(1);
    expect(Number.parseFloat(heights[0])).toBeGreaterThanOrEqual(IDLE_PX);
    expect([...(idle?.querySelectorAll('i.idle') ?? [])]).toHaveLength(20);
  });

  it('still draws real output above that baseline', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    const busy = container.querySelector('[data-id="builder:2189"] .spark');
    const heights = [...(busy?.querySelectorAll('i') ?? [])].map((el) =>
      Number.parseFloat((el as HTMLElement).style.height),
    );
    expect(Math.max(...heights)).toBeGreaterThan(IDLE_PX * 2);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(IDLE_PX);
    expect(busy?.getAttribute('data-status')).toBe('running');
  });

  it('puts reconnect copy in an unreachable empty lot, and nowhere else', () => {
    const s = mockupState();
    render(<Page state={s} hostname="tower-01" />);
    const lots = screen.getAllByTestId('empty-lot');
    expect(lots).toHaveLength(1);
    expect(lots[0].textContent).toMatch(/reconnect to resume/i);
    expect(
      document.querySelector('[data-id="workspace:/checkout"] [data-testid="empty-lot"]'),
    ).toBeNull();
  });

  it('leaves a live workspace with nothing running silent, not "reconnect"', () => {
    const s = mockupState();
    s.reducer.nodes.set(
      'workspace:/billing',
      node({ id: 'workspace:/billing', kind: 'workspace', name: 'billing-svc', status: 'running' }),
    );
    render(<Page state={s} hostname="tower-01" />);
    expect(screen.queryByTestId('empty-lot')).toBeNull();
  });

  it('leaves the later units absent rather than stubbed', () => {
    const { container } = render(<Page state={mockupState()} hostname="tower-01" />);
    expect(container.innerHTML).not.toMatch(/gate queue|find node|add machine|live panes/i);
  });
});
