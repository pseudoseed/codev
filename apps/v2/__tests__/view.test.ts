/*
 * Issue #106: a thrown /v2/events fetch used to discard the drawn tree.
 *
 * These assert the rule directly on viewKind, where the discarding happened:
 * a transport failure over a tree is still the site view; the whole-page
 * unreachable statement is only for when there is nothing to keep.
 */
import { describe, expect, it } from 'vitest';
import { initialAppState, type AppState } from '../src/lib/stream.js';
import type { ClientNode } from '../src/lib/validate.js';
import { hasTree, viewKind } from '../src/lib/view.js';

function node(id: string, kind: ClientNode['kind']): ClientNode {
  return {
    id,
    kind,
    parentId: null,
    name: id,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    blockedGate: null,
    blockedGateRequest: null,
    buckets: Array.from({ length: 20 }, () => 0),
  };
}

function drawn(): AppState {
  const s = initialAppState();
  s.connection = 'live';
  s.bootstrap = 'scoped';
  s.reducer.nodes = new Map([['workspace:/a', node('workspace:/a', 'workspace')]]);
  return s;
}

describe('viewKind keeps a drawn tree through a lost connection (#106)', () => {
  it('is the site view when the transport fails over a tree', () => {
    const s = drawn();
    s.connection = 'unreachable';
    s.connectionWhy = 'transport';
    expect(viewKind(s)).toBe('site');
  });

  it('is the site view when auth fails over a tree', () => {
    const s = drawn();
    s.connection = 'unreachable';
    s.connectionWhy = 'auth';
    expect(viewKind(s)).toBe('site');
  });

  it('is the site view when the only thing drawn is a dark path', () => {
    const s = initialAppState();
    s.bootstrap = 'scoped';
    s.reducer.darkPaths.set('workspace:/gone', { reason: 'unreadable', at: 't0' });
    s.connection = 'unreachable';
    expect(viewKind(s)).toBe('site');
  });

  it('is the whole-page unreachable statement before the first snapshot', () => {
    const s = initialAppState();
    s.connection = 'unreachable';
    s.connectionWhy = 'transport';
    expect(viewKind(s)).toBe('unreachable');
  });

  it('is the whole-page unreachable statement after a bootstrap failure', () => {
    const s = initialAppState();
    s.connection = 'unreachable';
    s.connectionWhy = 'auth';
    s.bootstrap = 'pending';
    expect(viewKind(s)).toBe('unreachable');
  });

  it('keeps a clean EOF on the site view, as it already was', () => {
    const s = drawn();
    s.connection = 'reconnecting';
    expect(viewKind(s)).toBe('site');
  });
});

describe('the other view kinds are untouched (D5)', () => {
  it('live with nothing running is empty, not unreachable', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'empty';
    expect(viewKind(s)).toBe('empty');
  });

  it('a scoped stream that returned no nodes is empty once live', () => {
    const s = initialAppState();
    s.connection = 'live';
    s.bootstrap = 'scoped';
    expect(viewKind(s)).toBe('empty');
  });

  it('before the first frame it is loading, not empty', () => {
    const s = initialAppState();
    s.bootstrap = 'scoped';
    expect(viewKind(s)).toBe('loading');
  });

  it('a contract mismatch over a tree is still the mismatch page', () => {
    const s = drawn();
    s.httpMismatch = { status: 400 };
    expect(viewKind(s)).toBe('mismatch');
  });

  it('a mismatch outranks a stale unreachable flag', () => {
    const s = drawn();
    s.connection = 'unreachable';
    s.bootstrap = 'mismatch';
    s.bootstrapMismatch = { how: 'bad-body', preview: 'x' };
    expect(viewKind(s)).toBe('mismatch');
  });
});

describe('hasTree', () => {
  it('is false on a fresh state and true once a node or a dark path lands', () => {
    const s = initialAppState();
    expect(hasTree(s)).toBe(false);
    s.reducer.nodes.set('workspace:/a', node('workspace:/a', 'workspace'));
    expect(hasTree(s)).toBe(true);
    const d = initialAppState();
    d.reducer.darkPaths.set('workspace:/gone', { reason: 'unknown', at: 't0' });
    expect(hasTree(d)).toBe(true);
  });
});
