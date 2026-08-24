/*
 * Issue #106, rendered. The tree must survive a dropped connection, and the
 * page must still say — visibly — that what it is showing is last-known.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Page } from '../src/App.js';
import { lastSeenLabel } from '../src/components/ConnectionStrip.js';
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

function drawnState(): AppState {
  const s = initialAppState();
  s.connection = 'live';
  s.bootstrap = 'scoped';
  s.lastLiveAt = '2026-08-24T10:20:30.000Z';
  s.reducer.nodes = new Map([
    ['workspace:/a', node({ id: 'workspace:/a', kind: 'workspace', name: 'alpha' })],
    ['architect:1', node({ id: 'architect:1', kind: 'architect', parentId: 'workspace:/a', name: 'arch' })],
    ['builder:1', node({ id: 'builder:1', kind: 'builder', parentId: 'architect:1', name: 'b1' })],
  ]);
  s.reducer.counts = { workspaces: 3, builders: { total: 4, byStatus: { running: 1 } }, gateWaiting: 0 };
  return s;
}

afterEach(() => cleanup());

describe('a thrown fetch keeps the drawn tree (#106)', () => {
  it('keeps every node on the page and adds a strip instead of a banner', () => {
    const s = drawnState();
    s.connection = 'unreachable';
    s.connectionWhy = 'transport';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(document.querySelector('[data-id="builder:1"]')).toBeTruthy();
    expect(screen.queryByTestId('unreachable')).toBeNull();
    expect(screen.getByTestId('connection-lost').textContent).toMatch(/Cannot reach Tower/);
  });

  it('says the tree is last-known and when it was last live', () => {
    const s = drawnState();
    s.lastLiveAt = new Date().toISOString(); // today, so the stamp is the bare clock
    s.connection = 'unreachable';
    render(<Page state={s} hostname="box" />);
    const strip = screen.getByTestId('connection-lost');
    expect(strip.textContent).toMatch(/last known tree/i);
    expect(strip.textContent).toMatch(/last seen \d\d:\d\d:\d\d/);
  });

  it('names an auth rejection rather than calling it a transport failure', () => {
    const s = drawnState();
    s.connection = 'unreachable';
    s.connectionWhy = 'auth';
    render(<Page state={s} hostname="box" />);
    const strip = screen.getByTestId('connection-lost');
    expect(strip.textContent).toMatch(/Auth failed/);
    // The stream loop has stopped, so the copy must name the way out.
    expect(strip.textContent).toMatch(/Reload to retry/);
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('marks the machine row off, so live and lost are not spelled the same', () => {
    const s = drawnState();
    s.connection = 'unreachable';
    render(<Page state={s} hostname="box" />);
    const row = screen.getByTestId('machine-row');
    expect(row.textContent).toMatch(/unreachable/);
    expect(row.textContent).not.toMatch(/online/);
  });

  it('is a strip and not the whole page: the header and footer survive', () => {
    const s = drawnState();
    s.connection = 'unreachable';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('site-register')).toBeTruthy();
    expect(document.querySelector('.machine-footer')).toBeTruthy();
  });
});

describe('the states stay distinct (D5)', () => {
  it('a clean EOF is the routine reconnect strip, not the lost one', () => {
    const s = drawnState();
    s.connection = 'reconnecting';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('reconnecting').textContent).toMatch(/Reconnecting/);
    expect(screen.queryByTestId('connection-lost')).toBeNull();
  });

  it('a lost connection and a clean EOF do not share a class', () => {
    const lost = drawnState();
    lost.connection = 'unreachable';
    const { container } = render(<Page state={lost} hostname="box" />);
    expect(container.querySelector('.conn-strip-lost')).toBeTruthy();
    cleanup();
    const eof = drawnState();
    eof.connection = 'reconnecting';
    const second = render(<Page state={eof} hostname="box" />);
    expect(second.container.querySelector('.conn-strip')).toBeTruthy();
    expect(second.container.querySelector('.conn-strip-lost')).toBeNull();
  });

  it('an unreachable Tower with no tree is still the whole-page statement', () => {
    const s = initialAppState();
    s.connection = 'unreachable';
    s.connectionWhy = 'transport';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('unreachable').textContent).toMatch(/Cannot reach Tower/);
    expect(screen.queryByTestId('connection-lost')).toBeNull();
    expect(screen.queryByTestId('empty-site')).toBeNull();
  });

  it('an empty machine is not dressed up as a lost connection', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'empty';
    render(<Page state={s} hostname="box" />);
    expect(screen.getByTestId('empty-site').textContent).toMatch(/No workspaces/);
    expect(screen.queryByTestId('connection-lost')).toBeNull();
    expect(screen.queryByTestId('unreachable')).toBeNull();
  });

  it('a live tree carries no strip at all', () => {
    render(<Page state={drawnState()} hostname="box" />);
    expect(screen.queryByTestId('connection-lost')).toBeNull();
    expect(screen.queryByTestId('reconnecting')).toBeNull();
  });

  /*
   * Read the stylesheet, not the markup. The colour lives in a CSS rule, so an
   * assertion over rendered innerHTML would pass unchanged if `.conn-strip-lost`
   * started using var(--rust) — it would be a test that names one thing and
   * checks another.
   */
  it('keeps rust off every strip rule — rust belongs to gates', () => {
    const css = readFileSync(path.resolve(__dirname, '../src/site.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector.trim(), body }))
      .filter((r) => r.selector.includes('.conn-strip'));
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const r of rules) {
      expect(`${r.selector} { ${r.body} }`).not.toMatch(/var\(--rust/);
    }
  });
});

describe('lastSeenLabel', () => {
  it('says nothing when nothing was ever live, rather than inventing a time', () => {
    expect(lastSeenLabel(null)).toBeNull();
    expect(lastSeenLabel('not-a-date')).toBeNull();
  });

  it('stamps a clock time for the same day', () => {
    const at = new Date(2026, 7, 24, 10, 20, 30);
    expect(lastSeenLabel(at.toISOString(), new Date(2026, 7, 24, 18, 0, 0))).toBe('last seen 10:20:30');
  });

  it('carries the date once the outage crosses a day, so it cannot read as today', () => {
    const at = new Date(2026, 7, 22, 9, 5, 1);
    expect(lastSeenLabel(at.toISOString(), new Date(2026, 7, 24, 18, 0, 0))).toBe(
      'last seen 2026-08-22 09:05:01',
    );
  });
});
