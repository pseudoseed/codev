import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { connect, type Session } from '../src/lib/stream.js';

const KEY = 'ab'.repeat(32);
const COUNTS = { workspaces: 22, builders: { total: 58, byStatus: { running: 10 } }, gateWaiting: 3 };

function snap(over: Record<string, unknown> = {}) {
  return {
    seq: 0,
    type: 'snapshot',
    streamId: 's1',
    resumed: false,
    nodes: [],
    counts: COUNTS,
    ...over,
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusRes(status: number): Response {
  return new Response('', { status });
}

function sseRes(frames: unknown[]): Response {
  const text = frames
    .map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function hangingSse(frames: unknown[]): { response: Response; close: () => void } {
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      for (const f of frames) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    close: () => ctrl.close(),
  };
}

type FetchFn = typeof globalThis.fetch;

function recordFetch(impl: (url: URL, init?: RequestInit) => Response | Promise<Response>): {
  fetch: FetchFn;
  urls: string[];
  inits: Array<RequestInit | undefined>;
} {
  const urls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    urls.push(url.pathname + url.search);
    inits.push(init);
    return impl(url, init);
  };
  return { fetch: fetchFn, urls, inits };
}

const sessions: Session[] = [];

function start(fetch: FetchFn): Session {
  const s = connect({ fetch, getKey: () => KEY });
  sessions.push(s);
  return s;
}

async function settle(session: Session): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  void session;
}

afterEach(() => {
  while (sessions.length) sessions.pop()?.stop();
});

describe('bootstrap then stream (scenarios 13, 14, 17)', () => {
  it('requests /api/workspaces once; reconnect does not re-request (scenario 13)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        return sseRes([snap()]);
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().bootstrap).toBe('scoped');
      expect(s.getState().reducer.cursor.streamId).toBe('s1');
      expect(s.getState().connection).toBe('reconnecting');
      expect(urls.filter((u) => u.startsWith('/api/workspaces'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/api/workspaces'))).toHaveLength(1);
      expect(urls.filter((u) => u.startsWith('/v2/events')).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('200 + [] is empty and never opens the stream (scenario 14)', async () => {
    const { fetch, urls } = recordFetch((url) => {
      if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [] });
      throw new Error('stream opened');
    });
    const s = start(fetch);
    await settle(s);
    expect(s.getState().bootstrap).toBe('empty');
    expect(s.getState().connection).toBe('live');
    expect(s.getState().connection).not.toBe('unreachable');
    expect(urls.some((u) => u.startsWith('/v2/events'))).toBe(false);
  });

  it('401 bootstrap is unreachable, not empty (scenario 17)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, urls } = recordFetch(() => statusRes(401));
      const s = start(fetch);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().connectionWhy).toBe('auth');
      expect(s.getState().bootstrap).not.toBe('empty');
      expect(urls.some((u) => u.startsWith('/v2/events'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('thrown bootstrap fetch is unreachable (scenario 17)', async () => {
    vi.useFakeTimers();
    try {
      const s = start(async () => {
        throw new TypeError('offline');
      });
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().connectionWhy).toBe('transport');
      expect(s.getState().bootstrap).not.toBe('empty');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EOF and HTTP classification (scenarios 20, 40)', () => {
  it('clean EOF resumes with since+stream, not empty, not mismatch (scenario 20)', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap()]);
        return hangingSse([
          { seq: 0, type: 'snapshot', streamId: 's1', resumed: true, nodes: [], counts: COUNTS },
        ]).response;
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().connection).toBe('reconnecting');
      expect(s.getState().bootstrap).toBe('scoped');
      expect(s.getState().httpMismatch).toBeNull();
      expect(s.getState().reducer.mismatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      const second = urls.filter((u) => u.startsWith('/v2/events'))[1];
      expect(second).toContain('since=0');
      expect(second).toContain('stream=s1');
      expect(second).toContain(`scope=${encodeURIComponent('/a')}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('400 is mismatch with no retry (scenario 40)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        return statusRes(400);
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().httpMismatch).toEqual({ status: 400 });
      expect(s.getState().connection).not.toBe('unreachable');
      await vi.advanceTimersByTimeAsync(15_000);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('401 stream is auth-unreachable with no retry (scenario 40)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, urls, inits } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        return statusRes(401);
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().connectionWhy).toBe('auth');
      expect(s.getState().bootstrap).not.toBe('empty');
      await vi.advanceTimersByTimeAsync(15_000);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(1);
      const hdrs = new Headers(inits[1]?.headers);
      expect(hdrs.get(TOWER_KEY_HEADER)).toBe(KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('404 is mismatch with no retry (scenario 40)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        return statusRes(404);
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().httpMismatch).toEqual({ status: 404 });
      await vi.advanceTimersByTimeAsync(15_000);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('503 retries on backoff (scenario 40)', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const hang = hangingSse([snap()]);
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return statusRes(503);
        return hang.response;
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().connectionWhy).toBe('transport');
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(2);
      expect(s.getState().connection).toBe('live');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the tree outlives the socket (#106)', () => {
  it('a thrown mid-stream fetch keeps the nodes and stamps when they were last live', async () => {
    vi.useFakeTimers();
    try {
      const nodes = [
        {
          id: 'workspace:/a',
          kind: 'workspace',
          parentId: null,
          name: 'alpha',
          status: 'running',
          flags: { heldMail: false },
          lastDataAt: null,
          blockedGate: null,
          blockedGateRequest: null,
        },
      ];
      let events = 0;
      const { fetch } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap({ nodes })]);
        throw new TypeError('Failed to fetch');
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().reducer.nodes.size).toBe(1);
      const liveAt = s.getState().lastLiveAt;
      expect(liveAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().connectionWhy).toBe('transport');
      // The point of the issue: the tree is still there to draw.
      expect(s.getState().reducer.nodes.size).toBe(1);
      expect(s.getState().reducer.nodes.get('workspace:/a')?.name).toBe('alpha');
      // And the stamp still names the last moment it was true, not now.
      expect(s.getState().lastLiveAt).toBe(liveAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 5xx mid-stream keeps the nodes too', async () => {
    vi.useFakeTimers();
    try {
      const nodes = [
        {
          id: 'workspace:/a',
          kind: 'workspace',
          parentId: null,
          name: 'alpha',
          status: 'running',
          flags: { heldMail: false },
          lastDataAt: null,
          blockedGate: null,
          blockedGateRequest: null,
        },
      ];
      let events = 0;
      const { fetch } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap({ nodes })]);
        return statusRes(503);
      });
      const s = start(fetch);
      await settle(s);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      expect(s.getState().reducer.nodes.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lastLiveAt stays null while nothing has ever been live', async () => {
    const { fetch } = recordFetch((url) => {
      if (url.pathname === '/api/workspaces') throw new TypeError('Failed to fetch');
      return statusRes(503);
    });
    const s = start(fetch);
    await settle(s);
    expect(s.getState().connection).toBe('unreachable');
    expect(s.getState().lastLiveAt).toBeNull();
  });
});

describe('bad frame recovery (scenario 28)', () => {
  it('one recover-fresh without since/stream; second bad frame opens no third', async () => {
    const { fetch, urls } = recordFetch((url) => {
      if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
      return sseRes(['{nope']);
    });
    const s = start(fetch);
    await settle(s);
    const eventUrls = urls.filter((u) => u.startsWith('/v2/events'));
    expect(eventUrls).toHaveLength(2);
    expect(eventUrls[0]).not.toContain('since=');
    expect(eventUrls[0]).not.toContain('stream=');
    expect(eventUrls[1]).not.toContain('since=');
    expect(eventUrls[1]).not.toContain('stream=');
    expect(s.getState().reducer.mismatch).not.toBeNull();
    expect(s.getState().connection).not.toBe('unreachable');
    expect(s.getState().bootstrap).not.toBe('empty');
  });
});

describe('stale unreachable does not hide mismatch', () => {
  it('500 then malformed 200 is mismatch, not unreachable', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const s = start(async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname !== '/api/workspaces') throw new Error('stream opened');
        n += 1;
        if (n === 1) return statusRes(500);
        return jsonRes(200, {});
      });
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(s.getState().bootstrap).toBe('mismatch');
      expect(s.getState().connection).not.toBe('unreachable');
      await vi.advanceTimersByTimeAsync(2000);
      await settle(s);
      expect(s.getState().bootstrap).toBe('mismatch');
      expect(s.getState().connection).not.toBe('unreachable');
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('503 then 400 is http mismatch, not unreachable', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const { fetch } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return statusRes(503);
        return statusRes(400);
      });
      const s = start(fetch);
      await settle(s);
      expect(s.getState().connection).toBe('unreachable');
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(s.getState().httpMismatch).toEqual({ status: 400 });
      expect(s.getState().connection).not.toBe('unreachable');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recover-fresh survives transient failure', () => {
  it('keeps requesting a fresh snapshot after recover-fresh then 503', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const hang = hangingSse([snap({ streamId: 's2' })]);
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap(), '{nope']);
        if (events === 2) return statusRes(503);
        return hang.response;
      });
      const s = start(fetch);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(2);
      expect(urls[2]).not.toContain('since=');
      expect(urls[2]).not.toContain('stream=');
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      const third = urls.filter((u) => u.startsWith('/v2/events'))[2];
      expect(third).toBeDefined();
      expect(third).not.toContain('since=');
      expect(third).not.toContain('stream=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes after a recover-fresh snapshot then a body error', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const hang = hangingSse([snap({ streamId: 's2', seq: 0 })]);
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap(), '{nope']);
        if (events === 2) {
          const enc = new TextEncoder();
          let pulls = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(c) {
              pulls += 1;
              if (pulls === 1) {
                c.enqueue(enc.encode(`data: ${JSON.stringify(snap({ streamId: 's2' }))}\n\n`));
                return;
              }
              c.error(new Error('reset'));
            },
          });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return hang.response;
      });
      const s = start(fetch);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      const third = urls.filter((u) => u.startsWith('/v2/events'))[2];
      expect(third).toBeDefined();
      expect(third).toContain('since=0');
      expect(third).toContain('stream=s2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps requesting a fresh snapshot after recover-fresh then EOF', async () => {
    vi.useFakeTimers();
    try {
      let events = 0;
      const hang = hangingSse([snap({ streamId: 's2' })]);
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
        events += 1;
        if (events === 1) return sseRes([snap(), '{nope']);
        if (events === 2) return new Response(null, { status: 200 });
        return hang.response;
      });
      const s = start(fetch);
      await settle(s);
      expect(urls.filter((u) => u.startsWith('/v2/events'))).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      const third = urls.filter((u) => u.startsWith('/v2/events'))[2];
      expect(third).toBeDefined();
      expect(third).not.toContain('since=');
      expect(third).not.toContain('stream=');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('emit snapshots state', () => {
  it('onState receives a new object each time', async () => {
    const seen: Array<ReturnType<Session['getState']>> = [];
    const { fetch } = recordFetch((url) => {
      if (url.pathname === '/api/workspaces') return jsonRes(200, { workspaces: [{ path: '/a' }] });
      return hangingSse([snap()]).response;
    });
    const s = connect({
      fetch,
      getKey: () => KEY,
      onState: (st) => seen.push(st),
    });
    sessions.push(s);
    await settle(s);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('bootstrap then later reconnect (scenario 25)', () => {
  it('500 then 200 is two bootstrap requests; later stream reconnect makes none', async () => {
    vi.useFakeTimers();
    try {
      let boots = 0;
      const { fetch, urls } = recordFetch((url) => {
        if (url.pathname === '/api/workspaces') {
          boots += 1;
          if (boots === 1) return statusRes(500);
          return jsonRes(200, { workspaces: [{ path: '/a' }] });
        }
        return sseRes([snap()]);
      });
      const s = start(fetch);
      await settle(s);
      expect(boots).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(boots).toBe(2);
      expect(s.getState().bootstrap).toBe('scoped');
      await vi.advanceTimersByTimeAsync(1000);
      await settle(s);
      expect(boots).toBe(2);
      expect(urls.filter((u) => u.startsWith('/api/workspaces'))).toHaveLength(2);
      expect(urls.filter((u) => u.startsWith('/v2/events')).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
