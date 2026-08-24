import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Page } from '../src/App.js';
import { initialAppState, type AppState } from '../src/lib/stream.js';
import type { ClientNode } from '../src/lib/validate.js';

function node(over: Partial<ClientNode> & Pick<ClientNode, 'id' | 'kind'>): ClientNode {
  return {
    parentId: null,
    name: over.id,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    buckets: Array.from({ length: 20 }, () => 0),
    ...over,
  };
}

function liveState(): AppState {
  const s = initialAppState();
  s.connection = 'live';
  s.bootstrap = 'scoped';
  s.reducer.nodes = new Map([
    ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'alpha' })],
    ['architect:1', node({ id: 'architect:1', kind: 'architect', parentId: 'workspace:/a', name: 'arch' })],
    [
      'builder:1',
      node({ id: 'builder:1', kind: 'builder', parentId: 'workspace:/a', name: 'b1', status: 'running' }),
    ],
    [
      'builder:2',
      node({
        id: 'builder:2',
        kind: 'builder',
        parentId: 'workspace:/a',
        name: 'b2',
        status: 'gate-waiting',
      }),
    ],
  ]);
  s.reducer.counts = { workspaces: 22, builders: { total: 58, byStatus: { running: 10 } }, gateWaiting: 3 };
  return s;
}

describe('SiteView display (scenarios 6, 7, 21)', () => {
  afterEach(() => cleanup());
  it('renders unknown status as the raw string, not RUN', () => {
    const s = liveState();
    s.reducer.nodes.set(
      'builder:x',
      node({ id: 'builder:x', kind: 'builder', parentId: 'workspace:/a', name: 'bx', status: 'reticulating' }),
    );
    render(<Page state={s} hostname="box" />);
    expect(screen.getByText('reticulating')).toBeTruthy();
    expect(screen.queryByText('reticulating')?.className).toContain('stamp-unknown');
  });

  it('keeps a live sibling when one workspace is dark', () => {
    const s = liveState();
    s.reducer.darkPaths.set('workspace:/gone', { reason: 'unreadable', at: 't0' });
    render(<Page state={s} hostname="box" />);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('gone')).toBeTruthy();
    expect(screen.getByText(/unreadable/)).toBeTruthy();
    const dark = document.querySelector('[data-dark="true"]');
    expect(dark?.className).toContain('dim-sub');
    expect(document.querySelector('[data-id="workspace:/a"]')?.className).not.toContain('dim-sub');
  });

  it('nodes: [] is the empty-site copy, not the unreachable banner', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'empty';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('empty-site').textContent).toMatch(/No workspaces/);
    expect(screen.queryByTestId('unreachable')).toBeNull();
  });

  it('unreachable is a connection banner and not the empty-site copy', () => {
    const s = initialAppState();
    s.connection = 'unreachable';
    s.connectionWhy = 'transport';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('unreachable').textContent).toMatch(/Cannot reach Tower/);
    expect(screen.queryByTestId('empty-site')).toBeNull();
  });

  it('http mismatch is the mismatch page, not an empty tree', () => {
    const s = liveState();
    s.httpMismatch = { status: 400 };
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('mismatch').textContent).toMatch(/HTTP 400/);
    expect(screen.queryByTestId('empty-site')).toBeNull();
    expect(screen.queryByText('alpha')).toBeNull();
  });

  it('nodes: [] plus one dark is a dark plot from the id (scenario 21)', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'scoped';
    s.reducer.darkPaths.set('workspace:/tmp/gone', { reason: 'unknown', at: 't1' });
    render(<Page state={s} hostname="box" />);
    expect(screen.queryByTestId('empty-site')).toBeNull();
    expect(screen.getByText('gone')).toBeTruthy();
    expect(screen.getByText(/unknown/)).toBeTruthy();
  });

  it('puts counts in the footer as machine totals, not a tree rollup', () => {
    render(<Page state={liveState()} hostname="box" />);
    const foot = screen.getByTestId('machine-totals');
    expect(foot.textContent).toMatch(/Machine totals/);
    expect(foot.textContent).toMatch(/22 workspaces/);
    expect(foot.textContent).toMatch(/58 builders/);
    expect(foot.textContent).not.toMatch(/drawn|this tree|shown/i);
  });

  it('sits the builder under the workspace beside the architect', () => {
    const { container } = render(<Page state={liveState()} hostname="box" />);
    const ws = container.querySelector('[data-kind="workspace"]');
    const kinds = [...(ws?.querySelectorAll('[data-kind]') ?? [])].map((el) => el.getAttribute('data-kind'));
    expect(kinds).toContain('architect');
    expect(kinds).toContain('builder');
    const arch = ws?.querySelector('[data-kind="architect"]');
    expect(arch?.querySelector('[data-kind="builder"]')).toBeNull();
  });

  it('renders workspace name and status as separately readable text', () => {
    const { container } = render(<Page state={liveState()} hostname="box" />);
    const header = container.querySelector('[data-id="workspace:/a"] .ws-plot-name');
    expect(header?.querySelector('.ws-plot-label')?.textContent).toBe('alpha');
    expect(header?.querySelector('.stamp-run')?.textContent).toBe('RUN');
    expect(header?.querySelector('.ws-plot-label')?.textContent).not.toContain('RUN');
  });

  it('renders workspace held mail beside name and status, not concatenated', () => {
    const s = liveState();
    s.reducer.nodes.set(
      'workspace:/a',
      node({ id: 'workspace:/a', kind: 'workspace', name: 'alpha', flags: { heldMail: true } }),
    );
    const { container } = render(<Page state={s} hostname="box" />);
    const header = container.querySelector('[data-id="workspace:/a"] .ws-plot-name');
    expect(header?.querySelector('.ws-plot-label')?.textContent).toBe('alpha');
    expect(header?.querySelector('.held-mail')?.textContent).toBe('mail');
    expect(header?.querySelector('.stamp-run')?.textContent).toBe('RUN');
    expect(header?.querySelector('.ws-plot-label')?.textContent).not.toMatch(/mail|RUN/);
  });

  it('dims an offline workspace and shows architect heldMail plus status', () => {
    const s = liveState();
    s.reducer.nodes.set(
      'workspace:/a',
      node({ id: 'workspace:/a', kind: 'workspace', name: 'alpha', status: 'offline' }),
    );
    s.reducer.nodes.set(
      'architect:1',
      node({
        id: 'architect:1',
        kind: 'architect',
        parentId: 'workspace:/a',
        name: 'arch',
        status: 'offline',
        flags: { heldMail: true },
      }),
    );
    const { container } = render(<Page state={s} hostname="box" />);
    expect(container.querySelector('[data-id="workspace:/a"]')?.className).toContain('dim-sub');
    expect(container.querySelector('[data-kind="architect"]')?.className).toContain('dim-sub');
    expect(container.querySelector('[data-kind="architect"] .held-mail')).toBeTruthy();
    expect(container.querySelector('[data-kind="architect"] .stamp-offline')).toBeTruthy();
  });

  it('keeps machine totals on an empty snapshot that still has counts', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'scoped';
    s.reducer.counts = { workspaces: 22, builders: { total: 58, byStatus: {} }, gateWaiting: 3 };
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('empty-site')).toBeTruthy();
    expect(screen.getByTestId('machine-totals').textContent).toMatch(/Machine totals/);
    expect(screen.getByTestId('machine-totals').textContent).toMatch(/22 workspaces/);
  });

  it('uses rust only on gate-waiting treatment', () => {
    const { container } = render(<Page state={liveState()} hostname="box" />);
    const rust = [...container.querySelectorAll('.stamp-gate, .needs-attn')];
    expect(rust.length).toBeGreaterThan(0);
    expect(container.querySelector('.stamp-gate')?.textContent).toBe('GATE');
    expect(container.querySelectorAll('.needs-attn')).toHaveLength(1);
    expect(container.querySelector('.machine-footer')?.className).not.toContain('stamp-gate');
    expect(container.innerHTML).not.toMatch(/#gate-rail|Find node|Add machine|#terminal-bank/);
    expect(container.querySelector('#gate-rail')).toBeNull();
    expect(container.querySelector('#terminal-bank')).toBeNull();
  });
});
