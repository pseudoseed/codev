import fs from 'node:fs';
import type * as http from 'node:http';
import type { V2Counts, V2Frame, V2Node } from '@cluesmith/codev-types';
import { getGlobalDb } from '../db/index.js';
import { heldSummaryForWorkspace } from '../db/mailbox.js';
import { getArchitects, getBuilders } from '../state.js';
import { workspaceId, workspacePathFromId } from './v2-ids.js';
import { ScopeBus, scopeKey } from './v2-events.js';
import { discoverBuilders } from './overview.js';
import { getKnownWorkspacePaths } from './tower-instances.js';
import {
  getRehydratedTerminalsEntry,
  getTerminalManager,
  getWorkspaceTerminals,
} from './tower-terminals.js';
import { projectHierarchy, type V2Deps, type V2Projection } from './v2-projection.js';
import { V2Sampler, V2_BUCKET_SLOTS } from './v2-sampler.js';

export const V2_EVENTS_PATH = '/v2/events';
export const V2_MAX_CLIENTS = 50;
export const BUCKET_SLOTS = V2_BUCKET_SLOTS;

export interface V2RouteDeps {
  listWorkspaces: () => string[];
  project: (now: number) => V2Projection;
  now: () => number;
  isReadable: (workspacePath: string) => boolean;
  rehydrate?: (workspacePath: string) => Promise<void>;
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
let nextClient = 0;
let sampler: V2Sampler | null = null;

export function setV2RouteDeps(next: V2RouteDeps | null): void {
  deps = next ?? defaultDeps;
}

export function getV2Bus(): ScopeBus {
  return bus;
}

export function getV2Sampler(): V2Sampler | null {
  return sampler;
}

export function setV2SamplerForTests(next: V2Sampler | null): void {
  sampler = next;
}

export function resetV2RoutesForTests(): void {
  sampler?.stop();
  sampler = null;
  deps = defaultDeps;
  bus = new ScopeBus();
  clients.clear();
  nextClient = 0;
}

function writeSse(res: http.ServerResponse, frame: V2Frame): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function parseScope(raw: string | null): string[] | null {
  if (raw === null || raw === '') return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    if (part === '' || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.length === 0 ? null : out;
}

function parseSince(raw: string | null): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (!/^\d+$/.test(raw)) return { ok: false };
  return { ok: true, value: Number(raw) };
}

function withBuckets(nodes: V2Node[]): V2Node[] {
  return nodes.map((n) => {
    if (n.kind !== 'builder') return n;
    const ring = n.buckets ?? sampler?.bucketsFor(n.id);
    return { ...n, buckets: ring ?? Array.from({ length: BUCKET_SLOTS }, () => 0) };
  });
}

export function lookupBuilderTerminal(
  builders: Map<string, string>,
  roleId: string,
): string | undefined {
  const direct = builders.get(roleId);
  if (direct) return direct;
  const lower = roleId.toLowerCase();
  for (const [key, id] of builders) {
    if (key.toLowerCase() === lower) return id;
  }
  return undefined;
}

function builderTerminalId(ws: string, roleId: string): string | undefined {
  const entry = getWorkspaceTerminals().get(ws);
  if (!entry) return undefined;
  return lookupBuilderTerminal(entry.builders, roleId);
}

function createProductionV2Deps(): V2Deps {
  const heldCache = new Map<string, { now: number; agents: Set<string> }>();
  return {
    listWorkspaces: () => getKnownWorkspacePaths().filter((p) => !p.includes('/.builders/')),
    discoverBuilders: (ws) =>
      discoverBuilders(ws).map((b) => ({
        worktreePath: b.worktreePath,
        roleId: b.roleId,
        blockedGate: b.blockedGate,
      })),
    getBuilders: (ws) =>
      getBuilders(ws).map((b) => ({
        worktree: b.worktree,
        spawnedByArchitect: b.spawnedByArchitect ?? null,
      })),
    getArchitects: (ws) =>
      getArchitects(ws).map((a) => ({ name: a.name, terminalId: a.terminalId ?? null })),
    heldByAgent: (ws, toAgent, now) => {
      try {
        let cached = heldCache.get(ws);
        if (!cached || cached.now !== now) {
          const summary = heldSummaryForWorkspace(getGlobalDb(), ws, now);
          cached = {
            now,
            agents: new Set(summary.byAgent.map((a) => a.toAgent.toLowerCase())),
          };
          heldCache.set(ws, cached);
        }
        return cached.agents.has(toAgent.toLowerCase());
      } catch {
        return false;
      }
    },
    sessionForRole: (ws, roleId) => {
      const id = builderTerminalId(ws, roleId);
      return Boolean(id && getTerminalManager().getSession(id));
    },
    sessionForTerminal: (id) => Boolean(getTerminalManager().getSession(id)),
    terminalsForWorkspace: (ws) => {
      const entry = getWorkspaceTerminals().get(ws);
      if (!entry) return 0;
      return entry.architects.size + entry.builders.size + entry.shells.size;
    },
    lastDataAt: (ws, roleId) => {
      const id = builderTerminalId(ws, roleId);
      const session = id ? getTerminalManager().getSession(id) : undefined;
      return session ? session.lastDataAt : null;
    },
    bytesWritten: (ws, roleId) => {
      const id = builderTerminalId(ws, roleId);
      const session = id ? getTerminalManager().getSession(id) : undefined;
      return session ? session.bytesWritten : 0;
    },
  };
}

function nextMailboxNotBefore(now: number): number | null {
  try {
    const row = getGlobalDb()
      .prepare(
        "SELECT MIN(not_before) AS next FROM mailbox WHERE status = 'held' AND not_before IS NOT NULL AND not_before > ?",
      )
      .get(now) as { next: number | null } | undefined;
    return row?.next ?? null;
  } catch {
    return null;
  }
}

function watchBuildersDir(dir: string, wake: () => void): () => void {
  try {
    const watcher = fs.watch(dir, { persistent: false }, () => wake());
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

function productionReadable(workspacePath: string): boolean {
  try {
    fs.accessSync(workspacePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function bindProduction(): void {
  const v2 = createProductionV2Deps();
  sampler = new V2Sampler({
    bus,
    deps: v2,
    hooks: { watch: watchBuildersDir, nextNotBefore: nextMailboxNotBefore },
  });
  sampler.start();
  deps = {
    listWorkspaces: v2.listWorkspaces,
    project: (now) => {
      const projection = projectHierarchy(now, v2);
      return { nodes: withBuckets(projection.nodes), counts: projection.counts };
    },
    now: () => Date.now(),
    isReadable: productionReadable,
    rehydrate: async (workspacePath) => {
      await getRehydratedTerminalsEntry(workspacePath);
    },
  };
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

  if (deps === defaultDeps) bindProduction();

  const clientId = String(++nextClient);
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
  let cleaned = false;
  const unsub = bus.subscribe(key, (frame) => {
    if (live) writeSse(res, frame);
    else pending.push(frame);
  });
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsub();
    clients.delete(clientId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  const snapSeq = bus.cursor(key);
  const since = sinceParsed.value;
  const stream = streamRaw ?? '';
  let lastWrittenSeq = -1;
  const writeTracked = (frame: V2Frame): void => {
    writeSse(res, frame);
    lastWrittenSeq = Math.max(lastWrittenSeq, frame.seq);
  };

  if (deps.rehydrate) {
    for (const p of inScope) {
      await deps.rehydrate(p);
    }
  }

  sampler?.watchScope(inScope);

  let snapNodes: V2Node[] | null = null;
  let snapCounts: V2Counts | null = null;

  if (hasSince) {
    const result = bus.resume(key, since!, stream, deps.now());
    if (result.kind === 'resumed') {
      for (const frame of result.frames) writeTracked(frame);
    } else {
      const projection = deps.project(deps.now());
      snapNodes = withBuckets(projection.nodes.filter((n) => {
        const ws = workspacePathFromId(n.id);
        return ws !== null && inScopeSet.has(ws);
      }));
      snapCounts = projection.counts;
      writeTracked(bus.snapshotFrame(key, {
        scope: scopePaths,
        nodes: snapNodes,
        counts: snapCounts,
        resumed: false,
        seq: snapSeq,
      }));
    }
  } else {
    const projection = deps.project(deps.now());
    snapNodes = withBuckets(projection.nodes.filter((n) => {
      const ws = workspacePathFromId(n.id);
      return ws !== null && inScopeSet.has(ws);
    }));
    snapCounts = projection.counts;
    writeTracked(bus.snapshotFrame(key, {
      scope: scopePaths,
      nodes: snapNodes,
      counts: snapCounts,
      resumed: false,
      seq: snapSeq,
    }));
  }

  if (snapNodes && snapCounts) {
    sampler?.seedScope(scopePaths, snapNodes, snapCounts);
  }

  for (const d of darkPaths) {
    writeTracked(bus.darkFrame(key, workspaceId(d.path), d.reason, snapSeq));
  }

  for (const frame of pending) {
    if (frame.seq > lastWrittenSeq) writeTracked(frame);
  }
  live = true;
}
