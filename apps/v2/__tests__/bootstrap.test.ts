import { describe, it, expect } from 'vitest';
import {
  fetchWorkspacesOnce,
  parseWorkspacesBody,
  runBootstrap,
  type BootstrapEnd,
  type BootstrapOnce,
} from '../src/lib/bootstrap.js';

function jsonRes(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clock() {
  const queue: Array<{ ms: number; cb: () => void }> = [];
  return {
    backoff(ms: number, cb: () => void) {
      queue.push({ ms, cb });
      return queue.length;
    },
    flush() {
      const next = queue.shift();
      next?.cb();
    },
    get pending() {
      return queue.map((q) => q.ms);
    },
  };
}

async function pump(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error('pump exhausted');
}

describe('parseWorkspacesBody', () => {
  it('200 with workspaces yields scoped paths', () => {
    const r = parseWorkspacesBody(JSON.stringify({
      workspaces: [{ path: '/a', name: 'a', active: true, proxyUrl: null, terminals: 0 }],
    }));
    expect(r).toEqual({ kind: 'scoped', paths: ['/a'] });
  });

  it('200 with [] is empty (scenario 14 / 17)', () => {
    expect(parseWorkspacesBody(JSON.stringify({ workspaces: [] }))).toEqual({ kind: 'empty' });
  });

  it.each([
    ['not-json', 'invalid-json'],
    ['{}', 'bad-body'],
    [JSON.stringify({ workspaces: null }), 'bad-body'],
    [JSON.stringify({ workspaces: 'nope' }), 'bad-body'],
    [JSON.stringify({ workspaces: [{}] }), 'bad-body'],
    [JSON.stringify({ workspaces: [{ path: 42 }] }), 'bad-body'],
    [JSON.stringify({ workspaces: [{ path: '' }] }), 'bad-body'],
  ] as const)('unreadable body %s is mismatch (scenarios 26 / 32)', (body, how) => {
    const r = parseWorkspacesBody(body);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') expect(r.mismatch.how).toBe(how);
  });
});

describe('fetchWorkspacesOnce (scenario 17)', () => {
  it('401 is unreachable auth', async () => {
    const r = await fetchWorkspacesOnce(async () => jsonRes(401, {}), 'k');
    expect(r).toEqual({ kind: 'unreachable', why: 'auth' });
  });

  it('500 is unreachable transport', async () => {
    const r = await fetchWorkspacesOnce(async () => jsonRes(500, {}), 'k');
    expect(r).toEqual({ kind: 'unreachable', why: 'transport' });
  });

  it('thrown fetch is unreachable transport', async () => {
    const r = await fetchWorkspacesOnce(async () => {
      throw new TypeError('network');
    }, 'k');
    expect(r).toEqual({ kind: 'unreachable', why: 'transport' });
  });

  it('200 + [] is empty', async () => {
    const r = await fetchWorkspacesOnce(async () => jsonRes(200, { workspaces: [] }), 'k');
    expect(r).toEqual({ kind: 'empty' });
  });

  it('200 whose body cannot be read is mismatch, not unreachable', async () => {
    const r = await fetchWorkspacesOnce(async () => {
      return {
        status: 200,
        text: async () => {
          throw new TypeError('failed to read body');
        },
      } as Response;
    }, 'k');
    expect(r.kind).toBe('mismatch');
  });
});

describe('runBootstrap retry policy (scenarios 25, 26, 32, 38)', () => {
  it('500 then 200 is two requests and scoped (scenario 25 / 38)', async () => {
    const urls: string[] = [];
    let n = 0;
    const c = clock();
    const pending = runBootstrap({
      fetch: async (input) => {
        urls.push(String(input));
        n += 1;
        if (n === 1) return jsonRes(500, {});
        return jsonRes(200, { workspaces: [{ path: '/a' }] });
      },
      key: 'k',
      reconnectBackoff: c.backoff,
    });
    await pump(() => c.pending.length > 0);
    expect(n).toBe(1);
    expect(c.pending).toEqual([1000]);
    c.flush();
    const end = await pending;
    expect(end).toEqual({ kind: 'scoped', paths: ['/a'] });
    expect(n).toBe(2);
    expect(urls).toEqual(['/api/workspaces', '/api/workspaces']);
  });

  it('unreadable 200 retries once then stops in mismatch (scenario 26 / 38)', async () => {
    let n = 0;
    const c = clock();
    const seen: BootstrapOnce['kind'][] = [];
    const pending = runBootstrap({
      fetch: async () => {
        n += 1;
        return jsonRes(200, {});
      },
      key: 'k',
      reconnectBackoff: c.backoff,
      onMismatch: () => seen.push('mismatch'),
      onUnreachable: () => seen.push('unreachable'),
    });
    await pump(() => seen.length > 0);
    expect(n).toBe(1);
    expect(seen).toEqual(['mismatch']);
    c.flush();
    const end: BootstrapEnd = await pending;
    expect(end.kind).toBe('mismatch');
    expect(n).toBe(2);
    expect(seen).toEqual(['mismatch', 'mismatch']);
    expect(c.pending).toEqual([]);
  });

  it.each([
    'not-json',
    '{}',
    JSON.stringify({ workspaces: null }),
    JSON.stringify({ workspaces: 'nope' }),
    JSON.stringify({ workspaces: [{}] }),
    JSON.stringify({ workspaces: [{ path: 42 }] }),
    JSON.stringify({ workspaces: [{ path: '' }] }),
  ])('body %s is never empty and never unreachable', async (body) => {
    let n = 0;
    const c = clock();
    let unreachable = 0;
    const pending = runBootstrap({
      fetch: async () => {
        n += 1;
        return new Response(body, { status: 200 });
      },
      key: 'k',
      reconnectBackoff: c.backoff,
      onUnreachable: () => {
        unreachable += 1;
      },
    });
    await pump(() => c.pending.length > 0);
    c.flush();
    const end = await pending;
    expect(end.kind).toBe('mismatch');
    expect(n).toBe(2);
    expect(unreachable).toBe(0);
  });

  it('500 retries on backoff indefinitely until a 200 (scenario 38)', async () => {
    let n = 0;
    const c = clock();
    const pending = runBootstrap({
      fetch: async () => {
        n += 1;
        if (n < 3) return jsonRes(500, {});
        return jsonRes(200, { workspaces: [{ path: '/z' }] });
      },
      key: 'k',
      reconnectBackoff: c.backoff,
    });
    await pump(() => c.pending.length > 0);
    expect(c.pending).toEqual([1000]);
    c.flush();
    await pump(() => c.pending.length > 0);
    expect(c.pending).toEqual([2000]);
    c.flush();
    const end = await pending;
    expect(end).toEqual({ kind: 'scoped', paths: ['/z'] });
    expect(n).toBe(3);
  });
});
