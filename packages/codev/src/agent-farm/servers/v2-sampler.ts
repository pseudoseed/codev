import type { V2Counts, V2Node, V2NodeKind, V2Status } from '@cluesmith/codev-types';
import { isDeepStrictEqual } from 'node:util';
import { builderId, workspaceId, workspacePathFromId, worktreeDirName } from './v2-ids.js';
import { ScopeBus, scopeKey } from './v2-events.js';
import { projectHierarchy, type V2Deps } from './v2-projection.js';

export const V2_BUCKET_SLOTS = 20;
export const V2_COMPARE_MS = 100;
export const V2_TICK_MS = 30_000;
export const V2_WATCH_DEBOUNCE_MS = 50;
export const V2_WATCH_MAX_WAIT_MS = 200;

export interface SamplerTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface SamplerHooks {
  watch?: (dir: string, wake: () => void) => () => void;
  nextNotBefore?: (now: number) => number | null;
  isReadable?: (workspacePath: string) => boolean;
}

const realTimers: SamplerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as NodeJS.Timeout),
};

function zeros(): number[] {
  return Array.from({ length: V2_BUCKET_SLOTS }, () => 0);
}

function tableChanged(prev: V2Node, next: V2Node): boolean {
  return (
    prev.status !== next.status
    || prev.flags.heldMail !== next.flags.heldMail
    || prev.parentId !== next.parentId
    || prev.name !== next.name
    || prev.blockedGate !== next.blockedGate
    || !isDeepStrictEqual(prev.blockedGateRequest, next.blockedGateRequest)
  );
}

function countsEqual(a: V2Counts, b: V2Counts): boolean {
  if (a.workspaces !== b.workspaces) return false;
  if (a.gateWaiting !== b.gateWaiting) return false;
  if (a.builders.total !== b.builders.total) return false;
  const keys = new Set([
    ...Object.keys(a.builders.byStatus),
    ...Object.keys(b.builders.byStatus),
  ]);
  for (const key of keys) {
    const k = key as V2Status;
    if ((a.builders.byStatus[k] ?? 0) !== (b.builders.byStatus[k] ?? 0)) return false;
  }
  return true;
}

function goneRank(kind: V2NodeKind): number {
  if (kind === 'builder') return 0;
  if (kind === 'architect') return 1;
  return 2;
}

function stripBuckets(node: V2Node): V2Node {
  if (node.buckets === undefined) return node;
  const { buckets: _ignored, ...rest } = node;
  return rest;
}

export function scopeFilter(nodes: V2Node[], scopePaths: Iterable<string>): V2Node[] {
  const allowed = new Set(scopePaths);
  const scoped = nodes.filter((n) => {
    const ws = workspacePathFromId(n.id);
    return ws !== null && allowed.has(ws);
  });
  const ids = new Set(scoped.map((n) => n.id));
  return scoped.map((n) => {
    if (n.kind !== 'builder' || !n.parentId || ids.has(n.parentId)) return n;
    const ws = workspacePathFromId(n.id);
    return ws ? { ...n, parentId: workspaceId(ws) } : n;
  });
}

export class V2Sampler {
  private readonly bus: ScopeBus;
  private readonly deps: V2Deps;
  private readonly timers: SamplerTimers;
  private readonly watch: (dir: string, wake: () => void) => () => void;
  private readonly nextNotBefore: ((now: number) => number | null) | undefined;
  private readonly isReadable: (workspacePath: string) => boolean;
  private readonly scopes = new Map<string, string[]>();
  private readonly filterByScope = new Map<string, string[]>();
  private readonly darkByScope = new Map<string, Map<string, string>>();
  private readonly lastByScope = new Map<string, Map<string, V2Node>>();
  private lastCounts: V2Counts | null = null;
  private readonly rings = new Map<string, number[]>();
  private readonly lastBytes = new Map<string, number>();
  private readonly watchers = new Map<string, () => void>();
  private interval: unknown = null;
  private notBeforeTimer: unknown = null;
  private watchDebounceTimer: unknown = null;
  private lastWatchWalkAt: number | null = null;
  private watchPending = false;
  private lastTickAt = 0;
  private running = false;

  constructor(opts: {
    bus: ScopeBus;
    deps: V2Deps;
    timers?: SamplerTimers;
    hooks?: SamplerHooks;
  }) {
    this.bus = opts.bus;
    this.deps = opts.deps;
    this.timers = opts.timers ?? realTimers;
    this.watch = opts.hooks?.watch ?? (() => () => {});
    this.nextNotBefore = opts.hooks?.nextNotBefore;
    this.isReadable = opts.hooks?.isReadable ?? (() => true);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = this.timers.now();
    this.compare();
    this.interval = this.timers.setInterval(() => {
      const now = this.timers.now();
      if (now - this.lastTickAt >= V2_TICK_MS) {
        this.lastTickAt = now;
        this.tick();
      } else {
        this.compare();
      }
    }, V2_COMPARE_MS);
  }

  stop(): void {
    this.running = false;
    if (this.interval !== null) {
      this.timers.clearInterval(this.interval);
      this.interval = null;
    }
    if (this.notBeforeTimer !== null) {
      this.timers.clearTimeout(this.notBeforeTimer);
      this.notBeforeTimer = null;
    }
    if (this.watchDebounceTimer !== null) {
      this.timers.clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    this.watchPending = false;
    for (const unwatch of this.watchers.values()) unwatch();
    this.watchers.clear();
  }

  watchScope(paths: string[], filterPaths: string[] = paths): void {
    const key = scopeKey(paths);
    if (!this.scopes.has(key)) {
      this.scopes.set(key, [...paths]);
      this.filterByScope.set(key, [...filterPaths]);
      this.rememberDark(key, paths);
    }
  }

  seedScope(paths: string[], nodes: V2Node[], counts: V2Counts, filterPaths: string[] = paths): void {
    const key = scopeKey(paths);
    this.scopes.set(key, [...paths]);
    const prev = this.filterByScope.get(key) ?? [];
    this.filterByScope.set(key, [...new Set([...prev, ...filterPaths])]);
    this.rememberDark(key, paths);
    if (!this.lastByScope.has(key)) {
      this.lastByScope.set(key, new Map(nodes.map((n) => [n.id, n])));
    }
    if (this.lastCounts === null) this.lastCounts = counts;
  }

  bucketsFor(builderNodeId: string): number[] {
    const ring = this.rings.get(builderNodeId);
    return ring ? [...ring] : zeros();
  }

  compare(): void {
    const now = this.timers.now();
    const projection = projectHierarchy(now, this.deps);
    const known = new Set(this.deps.listWorkspaces());
    const readable = new Map<string, boolean>();
    const probe = (p: string): boolean => {
      const cached = readable.get(p);
      if (cached !== undefined) return cached;
      const next = this.isReadable(p);
      readable.set(p, next);
      return next;
    };

    for (const [key, paths] of this.scopes) {
      this.syncReadability(key, paths, now, known, probe);
      const scoped = scopeFilter(projection.nodes, this.filterByScope.get(key) ?? paths);
      const scopedMap = new Map(scoped.map((n) => [n.id, n]));
      const last = this.lastByScope.get(key);
      if (!last) {
        this.lastByScope.set(key, scopedMap);
        continue;
      }

      for (const node of scoped) {
        const prev = last.get(node.id);
        if (!prev || tableChanged(prev, node)) {
          this.bus.emit(key, { type: 'node', node: stripBuckets(node) }, now);
        }
      }

      const gone: V2Node[] = [];
      for (const [id, prev] of last) {
        if (!scopedMap.has(id)) gone.push(prev);
      }
      gone.sort((a, b) => goneRank(a.kind) - goneRank(b.kind));
      for (const node of gone) {
        this.bus.emit(key, { type: 'gone', id: node.id }, now);
      }

      this.lastByScope.set(key, scopedMap);
    }

    if (this.lastCounts === null) {
      this.lastCounts = projection.counts;
    } else if (!countsEqual(this.lastCounts, projection.counts)) {
      this.lastCounts = projection.counts;
      for (const key of this.scopes.keys()) {
        this.bus.emit(key, { type: 'counts', counts: projection.counts }, now);
      }
    }

    this.syncWatchers(known);
    this.scheduleNotBefore();
  }

  tick(): void {
    const now = this.timers.now();
    const deltas: { [builderId: string]: number } = {};
    const seen = new Set<string>();

    for (const ws of this.deps.listWorkspaces()) {
      for (const discovered of this.deps.discoverBuilders(ws)) {
        const id = builderId(ws, worktreeDirName(discovered.worktreePath));
        seen.add(id);
        const current = discovered.roleId ? this.deps.bytesWritten(ws, discovered.roleId) : 0;
        const prev = this.lastBytes.has(id) ? this.lastBytes.get(id)! : current;
        const delta = current - prev;
        this.lastBytes.set(id, current);
        const ring = this.rings.get(id) ?? zeros();
        ring.shift();
        ring.push(Math.max(0, delta));
        this.rings.set(id, ring);
        if (delta > 0) deltas[id] = delta;
      }
    }

    for (const id of [...this.rings.keys()]) {
      if (!seen.has(id)) {
        this.rings.delete(id);
        this.lastBytes.delete(id);
      }
    }

    const at = new Date(now).toISOString();
    for (const [key, paths] of this.scopes) {
      if (this.bus.subscriberCount(key) === 0) continue;
      const allowed = new Set(this.filterByScope.get(key) ?? paths);
      const scoped: { [builderId: string]: number } = {};
      for (const [id, delta] of Object.entries(deltas)) {
        const ws = workspacePathFromId(id);
        if (ws && allowed.has(ws)) scoped[id] = delta;
      }
      this.bus.emit(key, { type: 'tick', at, buckets: scoped }, now);
    }

    this.compare();
  }

  private rememberDark(key: string, paths: string[]): void {
    if (this.darkByScope.has(key)) return;
    const known = new Set(this.deps.listWorkspaces());
    this.darkByScope.set(key, this.classify(paths, known, (p) => this.isReadable(p)).dark);
  }

  private classify(
    paths: string[],
    known: Set<string>,
    probe: (p: string) => boolean,
  ): { live: string[]; dark: Map<string, string> } {
    const live: string[] = [];
    const dark = new Map<string, string>();
    for (const p of paths) {
      if (!known.has(p)) continue;
      if (!probe(p)) dark.set(p, 'unreadable');
      else live.push(p);
    }
    return { live, dark };
  }

  private syncReadability(
    key: string,
    paths: string[],
    now: number,
    known: Set<string>,
    probe: (p: string) => boolean,
  ): void {
    const { live, dark } = this.classify(paths, known, probe);
    const prev = this.darkByScope.get(key) ?? new Map();
    for (const [path, reason] of dark) {
      if (prev.get(path) !== reason) {
        this.bus.emit(key, { type: 'dark', id: workspaceId(path), reason }, now);
      }
    }
    this.darkByScope.set(key, dark);
    this.filterByScope.set(key, live);
  }

  private syncWatchers(knownWorkspaces: Iterable<string> = this.deps.listWorkspaces()): void {
    const wanted = new Set([...knownWorkspaces].map((ws) => `${ws}/.builders`));
    for (const [dir, unwatch] of this.watchers) {
      if (wanted.has(dir)) continue;
      unwatch();
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      this.watchers.set(dir, this.watch(dir, () => this.wakeFromWatch()));
    }
  }

  private wakeFromWatch(): void {
    const now = this.timers.now();
    const elapsed = this.lastWatchWalkAt === null ? Number.POSITIVE_INFINITY : now - this.lastWatchWalkAt;
    const quiet = !this.watchPending && elapsed >= V2_WATCH_DEBOUNCE_MS;
    const capped = this.watchPending && elapsed >= V2_WATCH_MAX_WAIT_MS;
    if (quiet || capped) {
      this.flushWatchWake();
      return;
    }
    this.watchPending = true;
    if (this.watchDebounceTimer !== null) {
      this.timers.clearTimeout(this.watchDebounceTimer);
    }
    this.watchDebounceTimer = this.timers.setTimeout(() => {
      this.watchDebounceTimer = null;
      this.flushWatchWake();
    }, V2_WATCH_DEBOUNCE_MS);
  }

  private flushWatchWake(): void {
    if (this.watchDebounceTimer !== null) {
      this.timers.clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    this.watchPending = false;
    this.lastWatchWalkAt = this.timers.now();
    this.compare();
  }

  private scheduleNotBefore(): void {
    if (this.notBeforeTimer !== null) {
      this.timers.clearTimeout(this.notBeforeTimer);
      this.notBeforeTimer = null;
    }
    if (!this.nextNotBefore) return;
    const now = this.timers.now();
    const next = this.nextNotBefore(now);
    if (next === null) return;
    const delay = Math.max(0, next - now);
    this.notBeforeTimer = this.timers.setTimeout(() => {
      this.notBeforeTimer = null;
      this.compare();
      this.scheduleNotBefore();
    }, delay);
  }
}
