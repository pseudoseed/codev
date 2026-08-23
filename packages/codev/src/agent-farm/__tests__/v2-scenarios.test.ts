import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { V2Frame, V2Node } from '@cluesmith/codev-types';
import {
  handleV2Route,
  resetV2RoutesForTests,
  setV2RouteDeps,
  setV2SamplerForTests,
  getV2Bus,
  BUCKET_SLOTS,
} from '../servers/v2-routes.js';
import { V2Sampler } from '../servers/v2-sampler.js';
import { builderId, workspaceId } from '../servers/v2-ids.js';
import {
  projectHierarchy,
  type V2ArchitectRow,
  type V2BuilderRow,
  type V2Deps,
  type V2DiscoveredBuilder,
} from '../servers/v2-projection.js';

const WS = '/tmp/ws-a';
const NOW = 1_700_000_000_000;

function discovered(dir: string): V2DiscoveredBuilder {
  return {
    worktreePath: `${WS}/.builders/${dir}`,
    roleId: `builder-${dir.toLowerCase()}`,
    blockedGate: null,
  };
}

class World {
  now = NOW;
  workspaces = [WS];
  builders: V2DiscoveredBuilder[] = [];
  rows: V2BuilderRow[] = [];
  architects: V2ArchitectRow[] = [];
  held = new Set<string>();
  liveRoles = new Set<string>();
  lastData: Record<string, number> = {};
  bytes: Record<string, number> = {};
  terminalCount = 1;

  deps(): V2Deps {
    return {
      listWorkspaces: () => this.workspaces,
      discoverBuilders: () => this.builders,
      getBuilders: () => this.rows,
      getArchitects: () => this.architects,
      heldByAgent: (_ws, toAgent) => this.held.has(toAgent.toLowerCase()),
      sessionForRole: (_ws, roleId) => this.liveRoles.has(roleId),
      sessionForTerminal: () => true,
      terminalsForWorkspace: () => this.terminalCount,
      lastDataAt: (_ws, roleId) => this.lastData[roleId] ?? NOW - 1_000,
      bytesWritten: (_ws, roleId) => this.bytes[roleId] ?? 0,
    };
  }

  addBuilder(dir: string): V2DiscoveredBuilder {
    const b = discovered(dir);
    this.builders.push(b);
    if (b.roleId) this.liveRoles.add(b.roleId);
    return b;
  }
}

function makeReq(url: string): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost:4100' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes(): { res: http.ServerResponse; body: () => string; frames: () => V2Frame[] } {
  const chunks: string[] = [];
  const res = {
    writeHead: () => {},
    setHeader: () => {},
    end: (data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    },
    write: (data: string) => { chunks.push(data); },
    on: () => {},
    writableEnded: false,
    destroyed: false,
  } as any;
  const body = () => chunks.join('');
  return {
    res,
    body,
    frames: () =>
      body()
        .split('\n\n')
        .map((block) => block.replace(/^data: /, '').trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as V2Frame),
  };
}

function urlFor(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'http://localhost:4100');
}

function apply(frames: V2Frame[]): { nodes: Map<string, V2Node>; counts: unknown } {
  const nodes = new Map<string, V2Node>();
  let counts: unknown = null;
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      nodes.clear();
      for (const n of frame.nodes) {
        const { buckets: _b, ...rest } = n;
        nodes.set(rest.id, rest);
      }
      counts = frame.counts;
    } else if (frame.type === 'node') {
      const { buckets: _b, ...rest } = frame.node;
      nodes.set(rest.id, rest);
    } else if (frame.type === 'gone') {
      nodes.delete(frame.id);
    } else if (frame.type === 'counts') {
      counts = frame.counts;
    }
  }
  return { nodes, counts };
}

const samplers: V2Sampler[] = [];

function attach(world: World): V2Sampler {
  const sampler = new V2Sampler({
    bus: getV2Bus(),
    deps: world.deps(),
    timers: {
      now: () => world.now,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
  });
  samplers.push(sampler);
  setV2SamplerForTests(sampler);
  setV2RouteDeps({
    listWorkspaces: () => world.workspaces,
    project: (now) => {
      const p = projectHierarchy(now, world.deps());
      return {
        nodes: p.nodes.map((n) =>
          n.kind === 'builder'
            ? { ...n, buckets: sampler.bucketsFor(n.id) }
            : n,
        ),
        counts: p.counts,
      };
    },
    now: () => world.now,
    isReadable: () => true,
  });
  return sampler;
}

async function connect(): Promise<ReturnType<typeof makeRes>> {
  const q = `/v2/events?scope=${encodeURIComponent(WS)}`;
  const out = makeRes();
  await handleV2Route(makeReq(q), out.res, urlFor(q));
  return out;
}

describe('v2 scenarios (phase 4)', () => {
  beforeEach(() => {
    resetV2RoutesForTests();
  });

  afterEach(() => {
    for (const s of samplers) s.stop();
    samplers.length = 0;
    resetV2RoutesForTests();
  });

  it('scenario 3: 20 silent builders stay under 1 KB/s over two ticks', async () => {
    const world = new World();
    for (let i = 0; i < 20; i++) world.addBuilder(`b${i}`);
    const sampler = attach(world);
    const client = await connect();
    sampler.tick();
    sampler.tick();
    const frames = client.frames();
    expect(frames.filter((f) => f.type === 'tick')).toHaveLength(2);
    expect(frames.filter((f) => f.type === 'node')).toHaveLength(0);
    expect(client.body().length / 60).toBeLessThan(1024);
  });

  it('scenario 8b: rising bytesWritten does not scale frame count', async () => {
    const world = new World();
    for (let i = 0; i < 20; i++) world.addBuilder(`b${i}`);
    const sampler = attach(world);
    const client = await connect();
    const afterSnap = client.frames().length;
    for (let step = 1; step <= 4; step++) {
      for (const b of world.builders) {
        if (b.roleId) world.bytes[b.roleId] = step * 100;
      }
      sampler.tick();
    }
    const later = client.frames().slice(afterSnap);
    expect(later.every((f) => f.type === 'tick')).toBe(true);
    expect(later).toHaveLength(4);
    expect(client.body().length / 60).toBeLessThan(1024);
  });

  it('scenario 8: two clients converge after 100 mutations', async () => {
    const world = new World();
    world.addBuilder('seed');
    const sampler = attach(world);
    const a = await connect();
    const rng = mulberry32(0x52);
    const kinds = ['spawn', 'cleanup', 'gate', 'hold', 'session', 'architect', 'drop'] as const;
    let b: Awaited<ReturnType<typeof connect>> | null = null;
    for (let i = 0; i < 100; i++) {
      const kind = kinds[Math.floor(rng() * kinds.length)];
      if (kind === 'spawn') {
        world.addBuilder(`m${i}`);
      } else if (kind === 'cleanup' && world.builders.length > 0) {
        world.builders.splice(Math.floor(rng() * world.builders.length), 1);
      } else if (kind === 'gate' && world.builders.length > 0) {
        const target = world.builders[Math.floor(rng() * world.builders.length)];
        target.blockedGate = target.blockedGate ? null : 'plan-approval';
      } else if (kind === 'hold' && world.builders.length > 0) {
        const role = world.builders[Math.floor(rng() * world.builders.length)].roleId;
        if (role) {
          if (world.held.has(role)) world.held.delete(role);
          else world.held.add(role);
        }
      } else if (kind === 'session' && world.builders.length > 0) {
        const role = world.builders[Math.floor(rng() * world.builders.length)].roleId;
        if (role) {
          if (world.liveRoles.has(role)) world.liveRoles.delete(role);
          else world.liveRoles.add(role);
        }
      } else if (kind === 'architect') {
        if (world.architects.length === 0) world.architects.push({ name: 'uiv2', terminalId: 't1' });
        else world.architects = [];
      } else if (kind === 'drop') {
        world.workspaces = world.workspaces.length === 0 ? [WS] : [];
      }
      sampler.compare();
      if (i === 49) b = await connect();
    }
    world.workspaces = [WS];
    if (world.builders.length === 0) world.addBuilder('final');
    sampler.compare();
    expect(b).not.toBeNull();
    const left = apply(a.frames());
    const right = apply(b!.frames());
    expect(left.nodes.size).toBeGreaterThan(0);
    expect([...left.nodes.entries()].sort()).toEqual([...right.nodes.entries()].sort());
    expect(left.counts).toEqual(right.counts);
  });

  it('scenario 6: a new bus treats an old streamId as a flagged snapshot', async () => {
    const world = new World();
    world.addBuilder('spir-52');
    attach(world);
    const first = await connect();
    const snap = first.frames()[0];
    expect(snap.type).toBe('snapshot');
    resetV2RoutesForTests();
    attach(world);
    const q = `/v2/events?scope=${encodeURIComponent(WS)}&since=${snap.seq}&stream=${snap.type === 'snapshot' ? snap.streamId : 'x'}`;
    const second = makeRes();
    await handleV2Route(makeReq(q), second.res, urlFor(q));
    const parsed = second.frames();
    expect(parsed[0].type).toBe('snapshot');
    expect(parsed[0].type === 'snapshot' && parsed[0].resumed).toBe(false);
    expect(parsed.every((f) => f.type !== 'resumed')).toBe(true);
  });

  it('scenario 12: C1 files stay untouched except the /v2/ mount', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd: root });
    let base: string;
    try {
      base = git(['merge-base', 'origin/main', 'HEAD']).trim();
    } catch (err) {
      throw new Error(`scenario 12 needs origin/main: ${err instanceof Error ? err.message : err}`);
    }
    const forbidden = git([
      'diff',
      base,
      '--',
      'packages/codev/src/agent-farm/servers/tower-server.ts',
      'packages/codev/src/terminal/pty-session.ts',
    ]);
    expect(forbidden).toBe('');
    const routes = git(['diff', base, '--', 'packages/codev/src/agent-farm/servers/tower-routes.ts']);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toMatch(/handleV2Route/);
    expect(routes).toMatch(/url\.pathname\.startsWith\('\/v2\/'\)/);
    const added = routes.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.length).toBeLessThanOrEqual(8);
    const source = readFileSync('src/agent-farm/servers/tower-routes.ts', 'utf8');
    expect(source.match(/pathname\.startsWith\('\/v2\/'\)/g)).toHaveLength(1);
  });

  it('a dark second connect does not emit gone to the live client', async () => {
    const world = new World();
    world.addBuilder('b1');
    const sampler = attach(world);
    const a = await connect();
    setV2RouteDeps({
      listWorkspaces: () => world.workspaces,
      project: (now) => projectHierarchy(now, world.deps()),
      now: () => world.now,
      isReadable: () => false,
    });
    const before = a.frames().filter((f) => f.type === 'gone').length;
    await connect();
    sampler.compare();
    const gones = a.frames().filter((f) => f.type === 'gone');
    expect(gones.length).toBe(before);
  });

  it('snapshot builders still carry 20 buckets', async () => {
    const world = new World();
    world.addBuilder('spir-52');
    attach(world);
    const client = await connect();
    const snap = client.frames()[0];
    expect(snap.type).toBe('snapshot');
    if (snap.type !== 'snapshot') return;
    const builder = snap.nodes.find((n) => n.id === builderId(WS, 'spir-52'));
    expect(builder?.buckets).toHaveLength(BUCKET_SLOTS);
    expect(snap.nodes.some((n) => n.id === workspaceId(WS))).toBe(true);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
