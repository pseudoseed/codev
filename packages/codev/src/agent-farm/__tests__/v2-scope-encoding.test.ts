import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { V2Counts, V2Node } from '@cluesmith/codev-types';
import { handleV2Route, resetV2RoutesForTests, setV2RouteDeps } from '../servers/v2-routes.js';
import { builderId } from '../servers/v2-ids.js';

const WS_A = '/tmp/ws-a';
const WS_B = '/tmp/ws-b';
const counts: V2Counts = { workspaces: 2, builders: { total: 2, byStatus: { running: 2 } }, gateWaiting: 0 };

function builderNode(ws: string, dir: string): V2Node {
  return {
    id: builderId(ws, dir),
    kind: 'builder',
    parentId: `workspace:${ws}`,
    name: dir,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
  };
}

function makeReq(method: string, url: string): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  (req as http.IncomingMessage & { method: string }).method = method;
  (req as http.IncomingMessage & { url: string }).url = url;
  req.headers = { host: 'localhost:4100' };
  (req as http.IncomingMessage & { socket: { remoteAddress: string } }).socket = {
    remoteAddress: '127.0.0.1',
  } as http.IncomingMessage['socket'];
  return req;
}

function makeRes(): {
  res: http.ServerResponse;
  body: () => string;
  statusCode: () => number;
} {
  const chunks: string[] = [];
  let code = 200;
  const res = {
    writeHead: vi.fn((status: number) => {
      code = status;
    }),
    setHeader: vi.fn(),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => {
      chunks.push(data);
    }),
    on: vi.fn(),
    writableEnded: false,
    destroyed: false,
  } as unknown as http.ServerResponse;
  return { res, body: () => chunks.join(''), statusCode: () => code };
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

function encodeScope(paths: string[]): string {
  return paths.map((p) => encodeURIComponent(p)).join(',');
}

describe('scope encoding (scenario 18)', () => {
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

  it('literal-comma encoding returns both known paths, not empty+dark', async () => {
    const encoded = encodeScope([WS_A, WS_B]);
    expect(encoded).toBe(`${encodeURIComponent(WS_A)},${encodeURIComponent(WS_B)}`);
    expect(encoded).not.toBe(encodeURIComponent([WS_A, WS_B].join(',')));
    const q = `/v2/events?scope=${encoded}`;
    const { res, body } = makeRes();
    await handleV2Route(makeReq('GET', q), res, urlFor(q));
    const parsed = frames(body());
    expect(parsed[0].type).toBe('snapshot');
    const nodes = parsed[0].nodes as V2Node[];
    expect(nodes.map((n) => n.id).sort()).toEqual(
      [builderId(WS_A, 'spir-52'), builderId(WS_B, 'other')].sort(),
    );
    expect(parsed.some((f) => f.type === 'dark')).toBe(false);
  });

  it('encodeURIComponent(join) collapses to one unknown path', async () => {
    const q = `/v2/events?scope=${encodeURIComponent([WS_A, WS_B].join(','))}`;
    const { res, body } = makeRes();
    await handleV2Route(makeReq('GET', q), res, urlFor(q));
    const parsed = frames(body());
    expect(parsed.map((f) => f.type)).toEqual(['snapshot', 'dark']);
    expect(parsed[0].nodes).toEqual([]);
  });
});
