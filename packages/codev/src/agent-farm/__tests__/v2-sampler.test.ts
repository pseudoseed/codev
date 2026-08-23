import { describe, it, expect, afterEach } from 'vitest';
import { IDLE_WAITING_THRESHOLD_MS } from '@cluesmith/codev-sdk/builder-helpers';
import type { V2Counts, V2Frame, V2Node } from '@cluesmith/codev-types';
import { architectId, builderId, workspaceId } from '../servers/v2-ids.js';
import { ScopeBus, scopeKey } from '../servers/v2-events.js';
import {
  projectHierarchy,
  type V2ArchitectRow,
  type V2BuilderRow,
  type V2Deps,
  type V2DiscoveredBuilder,
} from '../servers/v2-projection.js';
import {
  V2Sampler,
  V2_BUCKET_SLOTS,
  V2_TICK_MS,
  scopeFilter,
  type SamplerTimers,
} from '../servers/v2-sampler.js';

const NOW = 1_700_000_000_000;
const STALE = NOW - IDLE_WAITING_THRESHOLD_MS - 1;
const FRESH = NOW - 1_000;
const WS_A = '/tmp/ws-a';
const WS_B = '/tmp/ws-b';

function discovered(
  dir: string,
  extra: Partial<V2DiscoveredBuilder> = {},
  ws = WS_A,
): V2DiscoveredBuilder {
  return {
    worktreePath: `${ws}/.builders/${dir}`,
    roleId: `builder-${dir.toLowerCase()}`,
    blockedGate: null,
    ...extra,
  };
}

class World {
  now = NOW;
  workspaces: string[] = [WS_A];
  builders: Record<string, V2DiscoveredBuilder[]> = { [WS_A]: [] };
  rows: Record<string, V2BuilderRow[]> = { [WS_A]: [] };
  architects: Record<string, V2ArchitectRow[]> = { [WS_A]: [] };
  held = new Set<string>();
  liveRoles = new Set<string>();
  liveTerminals = new Set<string>();
  terminalCounts: Record<string, number> = {};
  lastData: Record<string, number> = {};
  bytes: Record<string, number> = {};

  deps(): V2Deps {
    return {
      listWorkspaces: () => this.workspaces,
      discoverBuilders: (ws) => this.builders[ws] ?? [],
      getBuilders: (ws) => this.rows[ws] ?? [],
      getArchitects: (ws) => this.architects[ws] ?? [],
      heldByAgent: (ws, toAgent) => this.held.has(`${ws}|${toAgent.toLowerCase()}`),
      sessionForRole: (ws, roleId) => this.liveRoles.has(`${ws}|${roleId}`),
      sessionForTerminal: (id) => this.liveTerminals.has(id),
      terminalsForWorkspace: (ws) => this.terminalCounts[ws] ?? 0,
      lastDataAt: (ws, roleId) => this.lastData[`${ws}|${roleId}`] ?? null,
      bytesWritten: (ws, roleId) => this.bytes[`${ws}|${roleId}`] ?? 0,
    };
  }

  projection(): { nodes: V2Node[]; counts: V2Counts } {
    return projectHierarchy(this.now, this.deps());
  }

  addLiveBuilder(dir: string, ws = WS_A): V2DiscoveredBuilder {
    const b = discovered(dir, {}, ws);
    this.builders[ws] = [...(this.builders[ws] ?? []), b];
    if (b.roleId) {
      this.liveRoles.add(`${ws}|${b.roleId}`);
      this.lastData[`${ws}|${b.roleId}`] = FRESH;
    }
    return b;
  }
}

function collect(bus: ScopeBus, paths: string[]): { frames: V2Frame[]; unsub: () => void } {
  const frames: V2Frame[] = [];
  const unsub = bus.subscribe(scopeKey(paths), (f) => { frames.push(f); });
  return { frames, unsub };
}

function types(frames: V2Frame[]): string[] {
  return frames.map((f) => f.type);
}

function nodeFrames(frames: V2Frame[]): Array<V2Frame & { type: 'node' }> {
  return frames.filter((f) => f.type === 'node') as Array<V2Frame & { type: 'node' }>;
}

const samplers: V2Sampler[] = [];

function makeSampler(world: World, bus: ScopeBus, extra?: {
  watch?: (dir: string, wake: () => void) => () => void;
  nextNotBefore?: (now: number) => number | null;
  timers?: SamplerTimers;
}): V2Sampler {
  const sampler = new V2Sampler({
    bus,
    deps: world.deps(),
    timers: extra?.timers ?? { now: () => world.now, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    hooks: { watch: extra?.watch, nextNotBefore: extra?.nextNotBefore },
  });
  samplers.push(sampler);
  return sampler;
}

afterEach(() => {
  for (const s of samplers) s.stop();
  samplers.length = 0;
});

describe('V2Sampler', () => {
  it('scenario 1: two subscribers see a spawn on the same compare', () => {
    const world = new World();
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const first = world.projection();
    sampler.seedScope([WS_A], first.nodes, first.counts);
    const a = collect(bus, [WS_A]);
    const b = collect(bus, [WS_A]);
    world.addLiveBuilder('spir-52');
    const t0 = Date.now();
    sampler.compare();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
    expect(nodeFrames(a.frames).map((f) => f.node.id)).toEqual([builderId(WS_A, 'spir-52')]);
    expect(nodeFrames(b.frames).map((f) => f.node.id)).toEqual([builderId(WS_A, 'spir-52')]);
    expect(a.frames.some((f) => f.type === 'counts')).toBe(true);
    expect(b.frames.some((f) => f.type === 'counts')).toBe(true);
    a.unsub();
    b.unsub();
  });

  it('scenario 2: silence past threshold is stalled; gate-blocked is not', () => {
    const world = new World();
    const live = world.addLiveBuilder('runner');
    const gated = discovered('gated', { blockedGate: 'plan-approval' });
    world.builders[WS_A].push(gated);
    if (gated.roleId) {
      world.liveRoles.add(`${WS_A}|${gated.roleId}`);
      world.lastData[`${WS_A}|${gated.roleId}`] = STALE;
    }
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    if (live.roleId) world.lastData[`${WS_A}|${live.roleId}`] = STALE;
    sampler.compare();
    const nodes = nodeFrames(frames);
    expect(nodes.find((f) => f.node.id === builderId(WS_A, 'runner'))?.node.status).toBe('stalled');
    expect(nodes.find((f) => f.node.id === builderId(WS_A, 'gated'))).toBeUndefined();
    expect(snap.nodes.find((n) => n.id === builderId(WS_A, 'gated'))?.status).toBe('gate-waiting');
    unsub();
  });

  it('scenario 3 unit: 20 silent builders produce only ticks', () => {
    const world = new World();
    for (let i = 0; i < 20; i++) world.addLiveBuilder(`b${i}`);
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    sampler.tick();
    expect(types(frames)).toEqual(['tick']);
    expect(nodeFrames(frames)).toHaveLength(0);
    unsub();
  });

  it('scenario 4: in-window resume replays from since+1', () => {
    const world = new World();
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const key = scopeKey([WS_A]);
    const since = bus.cursor(key);
    const stream = bus.streamId(key);
    world.addLiveBuilder('spir-52');
    sampler.compare();
    const result = bus.resume(key, since, stream, world.now);
    expect(result.kind).toBe('resumed');
    if (result.kind !== 'resumed') return;
    expect(result.frames[0]).toMatchObject({ type: 'resumed', from: since });
    expect(result.frames.some((f) => f.type === 'node')).toBe(true);
    expect(result.frames.some((f) => f.type === 'snapshot')).toBe(false);
  });

  it('scenario 4b: two snapshots share seq; next delta is seq+1', () => {
    const world = new World();
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const key = scopeKey([WS_A]);
    const a = bus.snapshotFrame(key, { scope: [WS_A], nodes: snap.nodes, counts: snap.counts, resumed: false });
    const b = bus.snapshotFrame(key, { scope: [WS_A], nodes: snap.nodes, counts: snap.counts, resumed: false });
    expect(a.seq).toBe(b.seq);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.addLiveBuilder('spir-52');
    sampler.compare();
    expect(frames[0].seq).toBe(a.seq + 1);
    unsub();
  });

  it('scenario 5c: due held sets the flag; future not_before waits for the timer', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    const timeouts: Array<{ id: number; fn: () => void; at: number }> = [];
    let nextId = 0;
    let nextDue: number | null = null;
    const timers: SamplerTimers = {
      now: () => world.now,
      setTimeout: (fn, ms) => {
        const id = ++nextId;
        timeouts.push({ id, fn, at: world.now + ms });
        return id;
      },
      clearTimeout: (id) => {
        const i = timeouts.findIndex((t) => t.id === id);
        if (i >= 0) timeouts.splice(i, 1);
      },
      setInterval: () => 0,
      clearInterval: () => {},
    };
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus, {
      timers,
      nextNotBefore: () => nextDue,
    });
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    if (builder.roleId) world.held.add(`${WS_A}|${builder.roleId}`);
    sampler.compare();
    expect(nodeFrames(frames).at(-1)?.node.flags.heldMail).toBe(true);

    if (builder.roleId) world.held.delete(`${WS_A}|${builder.roleId}`);
    nextDue = world.now + 5_000;
    sampler.compare();
    expect(nodeFrames(frames).at(-1)?.node.flags.heldMail).toBe(false);
    expect(timeouts).toHaveLength(1);

    world.now = nextDue;
    if (builder.roleId) world.held.add(`${WS_A}|${builder.roleId}`);
    nextDue = null;
    const due = timeouts.splice(0);
    for (const t of due) t.fn();
    expect(nodeFrames(frames).at(-1)?.node.flags.heldMail).toBe(true);
    unsub();
  });

  it('scenario 9: out-of-scope change emits counts only', () => {
    const world = new World();
    world.workspaces = [WS_A, WS_B];
    world.builders[WS_B] = [];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], scopeFilter(snap.nodes, [WS_A]), snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.addLiveBuilder('other', WS_B);
    sampler.compare();
    expect(types(frames)).toEqual(['counts']);
    expect(nodeFrames(frames)).toHaveLength(0);
    unsub();
  });

  it('scenario 9b: in-scope spawn emits node and counts; scopes share gateWaiting', () => {
    const world = new World();
    world.workspaces = [WS_A, WS_B];
    world.builders[WS_B] = [];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], scopeFilter(snap.nodes, [WS_A]), snap.counts);
    sampler.seedScope([WS_B], scopeFilter(snap.nodes, [WS_B]), snap.counts);
    const a = collect(bus, [WS_A]);
    const b = collect(bus, [WS_B]);
    world.addLiveBuilder('spir-52');
    world.builders[WS_A][0].blockedGate = 'plan-approval';
    sampler.compare();
    expect(a.frames.some((f) => f.type === 'node')).toBe(true);
    const aCounts = a.frames.find((f) => f.type === 'counts');
    const bCounts = b.frames.find((f) => f.type === 'counts');
    expect(aCounts && aCounts.type === 'counts' ? aCounts.counts.gateWaiting : null).toBe(1);
    expect(bCounts && bCounts.type === 'counts' ? bCounts.counts.gateWaiting : null).toBe(1);
    expect(b.frames.some((f) => f.type === 'node' && f.node.id === builderId(WS_A, 'spir-52'))).toBe(false);
    a.unsub();
    b.unsub();
  });

  it('scenario 9c: cleanup emits gone with the qualified id', () => {
    const world = new World();
    world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.builders[WS_A] = [];
    sampler.compare();
    expect(frames.some((f) => f.type === 'gone' && f.id === builderId(WS_A, 'spir-52'))).toBe(true);
    unsub();
  });

  it('scenario 9d: both clients share the same tick after an upsert', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const a = collect(bus, [WS_A]);
    const b = collect(bus, [WS_A]);
    if (builder.roleId) world.held.add(`${WS_A}|${builder.roleId}`);
    sampler.compare();
    if (builder.roleId) world.bytes[`${WS_A}|${builder.roleId}`] = 40;
    sampler.tick();
    const tickA = a.frames.find((f) => f.type === 'tick');
    const tickB = b.frames.find((f) => f.type === 'tick');
    expect(tickA && tickA.type === 'tick' ? tickA.buckets : null).toEqual(
      tickB && tickB.type === 'tick' ? tickB.buckets : undefined,
    );
    a.unsub();
    b.unsub();
  });

  it('scenario 9e: worktree with no session is offline, not absent', () => {
    const world = new World();
    world.builders[WS_A] = [discovered('spir-52')];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const node = snap.nodes.find((n) => n.id === builderId(WS_A, 'spir-52'));
    expect(node?.status).toBe('offline');
    const { frames, unsub } = collect(bus, [WS_A]);
    sampler.compare();
    expect(frames.some((f) => f.type === 'gone')).toBe(false);
    unsub();
  });

  it('scenario 9g: architect exit is offline; delete is gone', () => {
    const world = new World();
    world.architects[WS_A] = [{ name: 'uiv2', terminalId: 'term-1' }];
    world.liveTerminals.add('term-1');
    world.terminalCounts[WS_A] = 1;
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.liveTerminals.delete('term-1');
    sampler.compare();
    expect(nodeFrames(frames).find((f) => f.node.id === architectId(WS_A, 'uiv2'))?.node.status).toBe('offline');
    expect(frames.some((f) => f.type === 'gone' && f.id === architectId(WS_A, 'uiv2'))).toBe(false);
    world.architects[WS_A] = [];
    sampler.compare();
    expect(frames.some((f) => f.type === 'gone' && f.id === architectId(WS_A, 'uiv2'))).toBe(true);
    world.terminalCounts[WS_A] = 0;
    sampler.compare();
    expect(nodeFrames(frames).find((f) => f.node.id === workspaceId(WS_A))?.node.status).toBe('offline');
    unsub();
  });

  it('scenario 9h: architect delete reparents then gone; applying in order never orphans', () => {
    const world = new World();
    world.architects[WS_A] = [{ name: 'uiv2', terminalId: 'term-1' }];
    world.liveTerminals.add('term-1');
    const one = world.addLiveBuilder('one');
    const two = world.addLiveBuilder('two');
    world.rows[WS_A] = [
      { worktree: one.worktreePath, spawnedByArchitect: 'uiv2' },
      { worktree: two.worktreePath, spawnedByArchitect: 'uiv2' },
    ];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.architects[WS_A] = [];
    sampler.compare();
    const relevant = frames.filter((f) =>
      f.type === 'node' && (f.node.id === builderId(WS_A, 'one') || f.node.id === builderId(WS_A, 'two'))
      || f.type === 'gone' && f.id === architectId(WS_A, 'uiv2'),
    );
    expect(relevant.map((f) => f.type)).toEqual(['node', 'node', 'gone']);
    const tree = new Map(snap.nodes.map((n) => [n.id, n]));
    for (const frame of frames) {
      if (frame.type === 'node') tree.set(frame.node.id, frame.node);
      if (frame.type === 'gone') tree.delete(frame.id);
      for (const node of tree.values()) {
        if (node.parentId) expect(tree.has(node.parentId)).toBe(true);
      }
    }
    unsub();
  });

  it('scenario 9i: workspace drop is children-first gone', () => {
    const world = new World();
    world.architects[WS_A] = [{ name: 'uiv2' }];
    world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.workspaces = [];
    sampler.compare();
    const gones = frames.filter((f) => f.type === 'gone');
    expect(gones.map((f) => f.type === 'gone' ? f.id : '')).toEqual([
      builderId(WS_A, 'spir-52'),
      architectId(WS_A, 'uiv2'),
      workspaceId(WS_A),
    ]);
    unsub();
  });

  it('scenario 9j: bytesWritten alone never emits node', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    for (let i = 1; i <= 20; i++) {
      if (builder.roleId) world.bytes[`${WS_A}|${builder.roleId}`] = i * 10;
      sampler.compare();
    }
    expect(nodeFrames(frames)).toHaveLength(0);
    unsub();
  });

  it('scenario 9k: builders row arriving later keeps the same id', () => {
    const world = new World();
    const b = discovered('spir-52');
    world.builders[WS_A] = [b];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    expect(snap.nodes.some((n) => n.id === builderId(WS_A, 'spir-52'))).toBe(true);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.architects[WS_A] = [{ name: 'uiv2' }];
    world.rows[WS_A] = [{ worktree: b.worktreePath, spawnedByArchitect: 'uiv2' }];
    sampler.compare();
    expect(frames.some((f) => f.type === 'gone' && f.id === builderId(WS_A, 'spir-52'))).toBe(false);
    const upsert = nodeFrames(frames).find((f) => f.node.id === builderId(WS_A, 'spir-52'));
    expect(upsert?.node.parentId).toBe(architectId(WS_A, 'uiv2'));
    unsub();
  });

  it('last-client gap: reconnect honours buffered deltas', () => {
    const world = new World();
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const key = scopeKey([WS_A]);
    const first = collect(bus, [WS_A]);
    const since = bus.cursor(key);
    const stream = bus.streamId(key);
    first.unsub();
    world.addLiveBuilder('spir-52');
    sampler.compare();
    const result = bus.resume(key, since, stream, world.now);
    expect(result.kind).toBe('resumed');
    if (result.kind !== 'resumed') return;
    expect(result.frames[0].type).toBe('resumed');
    expect(result.frames.some((f) => f.type === 'node')).toBe(true);
    expect(result.frames).not.toEqual([{ type: 'resumed', seq: since, from: since }]);
  });

  it('snapshot buckets are length 20 and tick fills the newest slot', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    if (builder.roleId) world.bytes[`${WS_A}|${builder.roleId}`] = 0;
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    expect(sampler.bucketsFor(builderId(WS_A, 'spir-52'))).toHaveLength(V2_BUCKET_SLOTS);
    const { unsub } = collect(bus, [WS_A]);
    sampler.tick();
    if (builder.roleId) world.bytes[`${WS_A}|${builder.roleId}`] = 12;
    sampler.tick();
    const ring = sampler.bucketsFor(builderId(WS_A, 'spir-52'));
    expect(ring).toHaveLength(V2_BUCKET_SLOTS);
    expect(ring[V2_BUCKET_SLOTS - 1]).toBe(12);
    expect(ring.slice(0, V2_BUCKET_SLOTS - 1).every((n) => n === 0)).toBe(true);
    unsub();
  });

  it('tick with zero subscribers updates rings but does not fan', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    sampler.tick();
    if (builder.roleId) world.bytes[`${WS_A}|${builder.roleId}`] = 8;
    const cursor = bus.cursor(scopeKey([WS_A]));
    sampler.tick();
    expect(bus.cursor(scopeKey([WS_A]))).toBe(cursor);
    expect(sampler.bucketsFor(builderId(WS_A, 'spir-52')).at(-1)).toBe(8);
  });

  it('fs.watch wake runs compare immediately', () => {
    const world = new World();
    const wakes: Array<() => void> = [];
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus, {
      watch: (_dir, wake) => {
        wakes.push(wake);
        return () => {};
      },
    });
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    sampler.compare();
    expect(wakes.length).toBeGreaterThan(0);
    const { frames, unsub } = collect(bus, [WS_A]);
    world.addLiveBuilder('spir-52');
    wakes[0]();
    expect(nodeFrames(frames).some((f) => f.node.id === builderId(WS_A, 'spir-52'))).toBe(true);
    unsub();
  });

  it('tick buckets stay in-scope', () => {
    const world = new World();
    world.workspaces = [WS_A, WS_B];
    world.builders[WS_B] = [];
    const a = world.addLiveBuilder('local');
    const b = world.addLiveBuilder('other', WS_B);
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], scopeFilter(snap.nodes, [WS_A]), snap.counts);
    sampler.tick();
    if (a.roleId) world.bytes[`${WS_A}|${a.roleId}`] = 5;
    if (b.roleId) world.bytes[`${WS_B}|${b.roleId}`] = 9;
    const { frames, unsub } = collect(bus, [WS_A]);
    sampler.tick();
    const tick = frames.find((f) => f.type === 'tick');
    expect(tick && tick.type === 'tick' ? tick.buckets : {}).toEqual({
      [builderId(WS_A, 'local')]: 5,
    });
    unsub();
  });

  it('lastDataAt alone does not emit node', () => {
    const world = new World();
    const builder = world.addLiveBuilder('spir-52');
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus);
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    if (builder.roleId) world.lastData[`${WS_A}|${builder.roleId}`] = FRESH - 10;
    sampler.compare();
    expect(nodeFrames(frames)).toHaveLength(0);
    unsub();
  });

  it('start() ticks after V2_TICK_MS on the fake clock', () => {
    const world = new World();
    world.addLiveBuilder('spir-52');
    const intervals: Array<{ fn: () => void }> = [];
    const timers: SamplerTimers = {
      now: () => world.now,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: (fn) => {
        intervals.push({ fn });
        return intervals.length;
      },
      clearInterval: () => {},
    };
    const bus = new ScopeBus();
    const sampler = makeSampler(world, bus, { timers });
    const snap = world.projection();
    sampler.seedScope([WS_A], snap.nodes, snap.counts);
    const { frames, unsub } = collect(bus, [WS_A]);
    sampler.start();
    expect(intervals).toHaveLength(1);
    world.now += V2_TICK_MS;
    intervals[0].fn();
    expect(frames.some((f) => f.type === 'tick')).toBe(true);
    unsub();
  });
});
