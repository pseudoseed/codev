import type * as http from 'node:http';
import type { V2Counts, V2Frame, V2Node } from '@cluesmith/codev-types';
import { workspaceId } from './v2-ids.js';
import { ScopeBus, scopeKey } from './v2-events.js';
import type { V2Projection } from './v2-projection.js';

export const V2_EVENTS_PATH = '/v2/events';
export const V2_MAX_CLIENTS = 50;
export const BUCKET_SLOTS = 20;

export interface V2RouteDeps {
  listWorkspaces: () => string[];
  project: (now: number) => V2Projection;
  now: () => number;
  isReadable: (workspacePath: string) => boolean;
}

const emptyCounts: V2Counts = {
  workspaces: 0,
  builders: { total: 0, byStatus: {} },
  gateWaiting: 0,
};

const defaultDeps: V2RouteDeps = {
  listWorkspaces: () => [],
  project: () => ({ nodes: [], counts: emptyCounts }),
  now: () => Date.now(),
  isReadable: () => true,
};

let deps: V2RouteDeps = defaultDeps;
let bus = new ScopeBus();
const clients = new Set<string>();

export function setV2RouteDeps(next: V2RouteDeps | null): void {
  deps = next ?? defaultDeps;
}

export function getV2Bus(): ScopeBus {
  return bus;
}

export function resetV2RoutesForTests(): void {
  deps = defaultDeps;
  bus = new ScopeBus();
  clients.clear();
}

function writeSse(res: http.ServerResponse, frame: V2Frame): void {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function parseScope(raw: string | null): string[] | null {
  if (raw === null || raw === '') return null;
  return raw.split(',').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function parseSince(raw: string | null): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (!/^-?\d+$/.test(raw)) return { ok: false };
  return { ok: true, value: Number(raw) };
}

function withBuckets(nodes: V2Node[]): V2Node[] {
  return nodes.map((n) => {
    if (n.kind !== 'builder') return n;
    return { ...n, buckets: n.buckets ?? Array.from({ length: BUCKET_SLOTS }, () => 0) };
  });
}

function nodeWorkspace(id: string): string | null {
  if (id.startsWith('workspace:')) return id.slice('workspace:'.length);
  const rest = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const hash = rest.lastIndexOf('#');
  return hash >= 0 ? rest.slice(0, hash) : rest;
}

export async function handleV2Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  if (url.pathname !== V2_EVENTS_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const scopePaths = parseScope(url.searchParams.get('scope'));
  if (!scopePaths) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'scope is required' }));
    return;
  }

  const sinceRaw = url.searchParams.get('since');
  const streamRaw = url.searchParams.get('stream');
  const sinceParsed = parseSince(sinceRaw);
  if (!sinceParsed.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'since is malformed' }));
    return;
  }
  const hasSince = sinceParsed.value !== null;
  const hasStream = streamRaw !== null && streamRaw !== '';
  if (hasSince !== hasStream) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'since and stream must travel together' }));
    return;
  }

  if (clients.size >= V2_MAX_CLIENTS) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
    res.end('SSE capacity reached. Retry later.\n');
    return;
  }

  const clientId = `${Date.now()}-${clients.size}`;
  clients.add(clientId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const key = scopeKey(scopePaths);
  const known = new Set(deps.listWorkspaces());
  const inScope: string[] = [];
  const darkPaths: { path: string; reason: string }[] = [];
  for (const p of scopePaths) {
    if (!known.has(p)) {
      darkPaths.push({ path: p, reason: 'unknown' });
      continue;
    }
    if (!deps.isReadable(p)) {
      darkPaths.push({ path: p, reason: 'unreadable' });
      continue;
    }
    inScope.push(p);
  }
  const inScopeSet = new Set(inScope);

  const pending: V2Frame[] = [];
  let live = false;
  const unsub = bus.subscribe(key, (frame) => {
    if (live) writeSse(res, frame);
    else pending.push(frame);
  });

  const snapSeq = bus.cursor(key);
  const since = sinceParsed.value;
  const stream = streamRaw ?? '';

  if (hasSince) {
    const result = bus.resume(key, since!, stream, deps.now());
    if (result.kind === 'resumed') {
      for (const frame of result.frames) writeSse(res, frame);
    } else {
      const projection = deps.project(deps.now());
      const nodes = withBuckets(projection.nodes.filter((n) => {
        const ws = nodeWorkspace(n.id);
        return ws !== null && inScopeSet.has(ws);
      }));
      writeSse(res, bus.snapshotFrame(key, {
        scope: scopePaths,
        nodes,
        counts: projection.counts,
        resumed: false,
      }));
    }
  } else {
    const projection = deps.project(deps.now());
    const nodes = withBuckets(projection.nodes.filter((n) => {
      const ws = nodeWorkspace(n.id);
      return ws !== null && inScopeSet.has(ws);
    }));
    writeSse(res, bus.snapshotFrame(key, {
      scope: scopePaths,
      nodes,
      counts: projection.counts,
      resumed: false,
    }));
  }

  for (const d of darkPaths) {
    writeSse(res, bus.darkFrame(key, workspaceId(d.path), d.reason));
  }

  for (const frame of pending) {
    if (frame.seq > snapSeq) writeSse(res, frame);
  }
  live = true;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsub();
    clients.delete(clientId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}
