import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { V2Counts, V2Node } from '@cluesmith/codev-types';
import {
  handleV2Route,
  resetV2RoutesForTests,
  setV2RouteDeps,
  getV2Bus,
  V2_MAX_CLIENTS,
  BUCKET_SLOTS,
} from '../servers/v2-routes.js';
import { scopeKey } from '../servers/v2-events.js';
import { builderId, workspaceId } from '../servers/v2-ids.js';

const WS_A = '/tmp/ws-a';
const WS_B = '/tmp/ws-b';
const counts: V2Counts = { workspaces: 1, builders: { total: 1, byStatus: { running: 1 } }, gateWaiting: 0 };

function builderNode(ws: string, dir: string): V2Node {
  return {
    id: builderId(ws, dir),
    kind: 'builder',
    parentId: workspaceId(ws),
    name: dir,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
  };
}

function makeReq(method: string, url: string): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes(): {
  res: http.ServerResponse;
  body: () => string;
  statusCode: () => number;
  headers: () => Record<string, string>;
} {
  const chunks: string[] = [];
  let code = 200;
  const hdrs: Record<string, string> = {};
  const res = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
    }),
    setHeader: vi.fn((k: string, v: string) => { hdrs[k] = v; }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => { chunks.push(data); }),
    on: vi.fn(),
  } as any;
  return { res, body: () => chunks.join(''), statusCode: () => code, headers: () => hdrs };
}

function frames(body: string): Array<{ type: string; [k: string]: unknown }> {
  return body
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function urlFor(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'http://localhost:4100');
}

describe('handleV2Route', () => {
  beforeEach(() => {
    resetV2RoutesForTests();
    setV2RouteDeps({
      listWorkspaces: () => [WS_A, WS_B],
      project: () => ({
        nodes: [builderNode(WS_A, 'spir-52'), builderNode(WS_B, 'other')],
        counts,
      }),
      now: () => 1_000,
      isReadable: () => true,
    });
  });

  it('400 when scope is missing', async () => {
    const { res, statusCode } = makeRes();
    await handleV2Route(makeReq('GET', '/v2/events'), res, urlFor('/v2/events'));
    expect(statusCode()).toBe(400);
  });

  it('400 when since travels without stream', async () => {
    const { res, statusCode } = makeRes();
    await handleV2Route(
      makeReq('GET', `/v2/events?scope=${encodeURIComponent(WS_A)}&since=0`),
      res,
      urlFor(`/v2/events?scope=${encodeURIComponent(WS_A)}&since=0`),
    );
    expect(statusCode()).toBe(400);
  });

  it('400 when since is malformed', async () => {
    const { res, statusCode } = makeRes();
    const q = `/v2/events?scope=${encodeURIComponent(WS_A)}&since=nope&stream=abc`;
    await handleV2Route(makeReq('GET', q), res, urlFor(q));
    expect(statusCode()).toBe(400);
  });

  it('404 for unknown /v2/ path', async () => {
    const { res, statusCode } = makeRes();
    await handleV2Route(makeReq('GET', '/v2/nope'), res, urlFor('/v2/nope'));
    expect(statusCode()).toBe(404);
  });

  it('snapshot on first connect, builders have 20 buckets, does not call addSseClient', async () => {
    const { res, body, statusCode, headers } = makeRes();
    await handleV2Route(
      makeReq('GET', `/v2/events?scope=${encodeURIComponent(WS_A)}`),
      res,
      urlFor(`/v2/events?scope=${encodeURIComponent(WS_A)}`),
    );
    expect(statusCode()).toBe(200);
    expect(headers()['Content-Type']).toBe('text/event-stream');
    const parsed = frames(body());
    expect(parsed[0].type).toBe('snapshot');
    expect(parsed[0].resumed).toBe(false);
    const nodes = parsed[0].nodes as V2Node[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(builderId(WS_A, 'spir-52'));
    expect(nodes[0].buckets).toHaveLength(BUCKET_SLOTS);
    expect(nodes[0].buckets?.every((n) => n === 0)).toBe(true);
  });

  it('scenario 7: dark names the unknown path; the other path still snapshots', async () => {
    const unknown = '/tmp/missing';
    const q = `/v2/events?scope=${encodeURIComponent(WS_A)},${encodeURIComponent(unknown)}`;
    const { res, body } = makeRes();
    await handleV2Route(makeReq('GET', q), res, urlFor(q));
    const parsed = frames(body());
    expect(parsed.map((f) => f.type)).toEqual(['snapshot', 'dark']);
    expect(parsed[1].id).toBe(workspaceId(unknown));
    const nodes = parsed[0].nodes as V2Node[];
    expect(nodes.some((n) => n.id === builderId(WS_A, 'spir-52'))).toBe(true);
  });

  it('empty in-window resume emits resumed only (5b)', async () => {
    const q1 = `/v2/events?scope=${encodeURIComponent(WS_A)}`;
    const first = makeRes();
    await handleV2Route(makeReq('GET', q1), first.res, urlFor(q1));
    const snap = frames(first.body())[0];
    const q2 = `/v2/events?scope=${encodeURIComponent(WS_A)}&since=${snap.seq}&stream=${snap.streamId}`;
    const second = makeRes();
    await handleV2Route(makeReq('GET', q2), second.res, urlFor(q2));
    const parsed = frames(second.body());
    expect(parsed.map((f) => f.type)).toEqual(['resumed']);
    expect(parsed[0].from).toBe(snap.seq);
  });

  it('resume after an emit replays from since+1', async () => {
    const q1 = `/v2/events?scope=${encodeURIComponent(WS_A)}`;
    const first = makeRes();
    await handleV2Route(makeReq('GET', q1), first.res, urlFor(q1));
    const snap = frames(first.body())[0];
    getV2Bus().emit(scopeKey([WS_A]), { type: 'gone', id: 'x' });
    const q2 = `/v2/events?scope=${encodeURIComponent(WS_A)}&since=${snap.seq}&stream=${snap.streamId}`;
    const second = makeRes();
    await handleV2Route(makeReq('GET', q2), second.res, urlFor(q2));
    const parsed = frames(second.body());
    expect(parsed.map((f) => f.type)).toEqual(['resumed', 'gone']);
    expect(parsed[1].seq).toBe((snap.seq as number) + 1);
  });

  it('503 at the v2 cap without using the existing SSE list', async () => {
    const q = `/v2/events?scope=${encodeURIComponent(WS_A)}`;
    for (let i = 0; i < V2_MAX_CLIENTS; i++) {
      await handleV2Route(makeReq('GET', q), makeRes().res, urlFor(q));
    }
    const over = makeRes();
    await handleV2Route(makeReq('GET', q), over.res, urlFor(q));
    expect(over.statusCode()).toBe(503);
    expect(over.headers()['Retry-After']).toBe('5');
  });

  it('subscribe-then-flush delivers deltas after the snapshot', async () => {
    const q = `/v2/events?scope=${encodeURIComponent(WS_A)}`;
    setV2RouteDeps({
      listWorkspaces: () => [WS_A],
      project: () => {
        getV2Bus().emit(scopeKey([WS_A]), { type: 'gone', id: 'during-snap' });
        return { nodes: [builderNode(WS_A, 'spir-52')], counts };
      },
      now: () => 1_000,
      isReadable: () => true,
    });
    const { body } = makeRes();
    const out = makeRes();
    await handleV2Route(makeReq('GET', q), out.res, urlFor(q));
    const parsed = frames(out.body());
    expect(parsed[0].type).toBe('snapshot');
    expect(parsed.some((f) => f.type === 'gone' && f.id === 'during-snap')).toBe(true);
    expect(parsed.findIndex((f) => f.type === 'gone')).toBeGreaterThan(
      parsed.findIndex((f) => f.type === 'snapshot'),
    );
    void body;
  });
});
