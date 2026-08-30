/**
 * The production `t3codeSnapshot` provider (Spec 236, phase 2 — spec 146 criterion 3).
 *
 * ## The obstacle this exists to get around
 *
 * `AgentRouteContext.t3codeSnapshot` is **synchronous** and a t3code connection
 * is not. That is why phase 11 shipped without one, and why every snapshot from a
 * real Tower reported `not-provided` and every non-blocked row rendered UNKNOWN.
 *
 * The resolution is not to make the provider async — it is called inside request
 * handling, and a request that opens a socket is a request that can hang. It is
 * to split the two halves:
 *
 *  - a **background maintainer** owns every side effect: the connect, the
 *    subscriptions, the config read, the `global.db` rescan; and
 *  - a **synchronous reader** returns what the maintainer last wrote, plus how
 *    old it is.
 *
 * The reader performs no I/O of any kind. Not "fast I/O" — none.
 *
 * ## `observedAt` means SUBSCRIPTION LIVENESS, not last change
 *
 * The first draft of the plan said to derive the freshness window from "the
 * subscription's own update cadence". `orchestration.subscribeThread` has no
 * cadence: it is an event stream, and a session that is genuinely idle emits
 * nothing at all. A window keyed on event arrival would therefore mark a live,
 * watched, perfectly healthy idle session `stale` — inventing a doubt about the
 * one kind of session there is least reason to doubt.
 *
 * So `observedAt` is stamped while the subscription is UP. It advances on the
 * synchronized marker and on every event, and an entry begins ageing only when
 * its subscription **drops**. `stale` then means "I am no longer watching this",
 * which is a fact this process holds, rather than "nothing has happened lately",
 * which is evidence of nothing.
 *
 * ## Where the thread set comes from, and why it is re-read
 *
 * The vendored t3code contract has **no thread listing**:
 * `orchestration.subscribeThread` takes one `threadId`, and
 * `orchestration.searchThreads` is a text search over message content. So the set
 * of threads to watch comes from `global.db`'s `thread_id` columns — the same
 * join the registry publishes rows on, which is what keeps the cache from
 * describing a thread the snapshot will not mention.
 *
 * It is re-read on every maintenance pass. A maintainer that reads it once at
 * boot goes permanently blind to every agent spawned afterwards, which on a Tower
 * that runs for days is most of them.
 */

import type Database from 'better-sqlite3';
import {
  canonicalWorkspaceKey,
  tryGetThreadStreamer,
  type ThreadStream,
} from '../thread-runtime.js';
import { requestThreadBackend, type ThreadBackendAvailability } from '../thread-backend.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import type {
  LiveThread,
  LiveThreadSession,
  T3codeThreadSnapshot,
} from './thread-registry.js';

/** The streaming method this provider subscribes to, from the vendored contract. */
const SUBSCRIBE_THREAD = 'orchestration.subscribeThread';

/**
 * How long after a subscription drops the content stops being called `available`.
 *
 * Keyed off the reconnect path rather than picked: `requestThreadBackend` will
 * not retry a failed connect for 60s (`FAILED_CONNECT_COOLDOWN_MS`), so a drop
 * can take about that long to heal. A window shorter than the healing time would
 * flap every entry through `stale` on every ordinary reconnect; one much longer
 * would keep calling content current while nothing was watching it. One cooldown
 * is the smallest window that does not flap.
 */
const DEFAULT_FRESH_FOR_MS = 60_000;

/*
 * WHAT BOUNDS `available` WHILE A SUBSCRIPTION IS NOMINALLY OPEN, and it is not
 * this file.
 *
 * `observedAt` records subscription LIVENESS, not event cadence — that is
 * deliberate, because a quiet thread is not a stale one. The consequence is that
 * an entry cannot age into `stale` for as long as the subscription is believed
 * open, and what decides that belief is `packages/t3-client`'s stream idle
 * timeout: 300s of silence before a stream is abandoned (`streamIdleTimeoutMs`,
 * `client.ts`). So a socket that has silently died is called `available` here for
 * up to five minutes, and the freshness guarantee this module appears to make is
 * BORROWED from another package's timer.
 *
 * Recorded rather than fixed. Shortening it here would mean a second timer racing
 * the first, and lengthening it changes nothing. The thing worth knowing is that
 * raising `streamIdleTimeoutMs` in the t3-client package silently lengthens how
 * long this module will call dead content current, with nothing in this file
 * failing.
 */

/**
 * How long last-known content is kept at all.
 *
 * Past this it is dropped and the status falls back to reachability on its own
 * merits. Holding an hours-old session status is holding a wrong answer with a
 * disclaimer on it — the disclaimer stops being read long before the content
 * stops being wrong.
 */
const DEFAULT_DISCARD_AFTER_MS = 10 * 60_000;

/** How often the maintainer reconciles subscriptions against `global.db`. */
const DEFAULT_SWEEP_MS = 5_000;

/**
 * The key one open subscription is tracked under.
 *
 * ONE FUNCTION, because two call sites building this string by hand is how it
 * went wrong: the reader's template carried a literal NUL byte and the writer's
 * carried a space, so the two keys never matched and a `delete` silently missed.
 * Nothing showed it — the separator is invisible in an editor and in a diff — and
 * it only surfaced when a second call site had to agree with the first.
 *
 * A visible separator, once, for both. Workspace keys are absolute paths and
 * thread ids are opaque server strings, so a space cannot collide.
 */
function subscriptionKeyFor(workspaceKey: string, threadId: string): string {
  return `${workspaceKey} ${threadId}`;
}

interface CachedThread {
  readonly threadId: string;
  session?: LiveThreadSession;
  /**
   * When a frame last arrived, or `undefined` while none ever has.
   *
   * UNDEFINED IS LOAD-BEARING. A sweep creates the entry the moment it opens a
   * subscription, which is BEFORE the first frame. Seeding this with the creation
   * time made that placeholder look like an observation moments old, so the
   * snapshot answered `available` — a claim to have observed something nothing
   * had observed yet. An entry is published only once a frame has landed.
   */
  observedAt?: number;
  /** False before the first frame, and again once the stream ends or rejects. */
  watching: boolean;
}

interface WorkspaceCache {
  readonly threads: Map<string, CachedThread>;
  /** The connector's last answer, stamped by the maintainer, read by the snapshot. */
  availability: ThreadBackendAvailability;
  /** When each failure was first seen, so `cooling-down` can report a `since`. */
  coolingSince?: number;
  /**
   * When the thread set was last read out of `global.db`.
   *
   * This is a real observation even when the set is EMPTY — "connected, and this
   * workspace has no thread-backed agents" is something this process checked, and
   * it is the state every real workspace is in today.
   */
  threadsReadAt?: number;
  /**
   * How many thread ids that read found.
   *
   * KEPT SEPARATELY FROM `threads.size`, which is not the same number: the map
   * loses an entry when its content is discarded for age, and keying "nothing to
   * watch" on the map would then report a workspace that HAS a thread as having
   * none — turning a discarded observation into an assertion that there is
   * nothing to observe.
   */
  threadIdCount?: number;
}

export interface T3codeSessionCacheOptions {
  readonly db: () => Database.Database;
  readonly log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  readonly now?: () => number;
  readonly freshForMs?: number;
  readonly discardAfterMs?: number;
  readonly sweepMs?: number;
  /** Injected for tests; production reads the real registry. */
  readonly streamerFor?: (workspaceRoot: string) => { stream: StreamFn } | undefined;
  /** Injected for tests; production asks the real connector. */
  readonly availabilityFor?: (workspaceRoot: string) => ThreadBackendAvailability;
}

type StreamFn = (
  method: string,
  payload: unknown,
  onValue: (value: unknown) => void,
) => ThreadStream;

/**
 * Is this thread settled, from the two fields t3code uses to say so?
 *
 * `settledOverride` is `'settled' | 'active' | null` — NOT a boolean, which is
 * what a first reading of it assumed. An explicit `'active'` override means the
 * thread is not settled *even though* `settledAt` carries a timestamp, so
 * treating the presence of `settledAt` as decisive would report a thread its
 * owner has explicitly un-settled as finished. The override wins in both
 * directions; `settledAt` is the fallback.
 */
function settledFrom(thread: Record<string, unknown>): boolean {
  const override = thread.settledOverride;
  if (override === 'settled') return true;
  if (override === 'active') return false;
  return typeof thread.settledAt === 'string';
}

/** The `status` / `lastError` half of a session object, or nothing. */
function statusFrom(session: unknown): { status: string; lastError?: string } | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const record = session as Record<string, unknown>;
  if (typeof record.status !== 'string' || record.status.length === 0) return undefined;
  const lastError = record.lastError;
  return {
    status: record.status,
    ...(typeof lastError === 'string' && lastError.length > 0 ? { lastError } : {}),
  };
}

/**
 * Fold one `subscribeThread` frame into what is known about a thread's session.
 *
 * ## Why this is a fold and not a read
 *
 * A subscription sends the full snapshot ONCE and then sends events. Reading only
 * the snapshot would freeze each thread's session at the moment it was subscribed
 * and then report that frozen value as current for as long as the subscription
 * stayed up — which is precisely the "it had finished when I last looked"
 * failure this whole phase exists to prevent, produced from inside the mechanism
 * built to prevent it.
 *
 * Three event types move it, and they move different halves:
 *
 * | Frame | What it changes |
 * |---|---|
 * | `kind: 'snapshot'` | both halves, from the thread and its session |
 * | `thread.session-set` | the session status and `lastError` |
 * | `thread.settled` | settledness to true |
 * | `thread.unsettled` | settledness to false |
 *
 * ## Why an unreadable frame returns `current` rather than `undefined`
 *
 * Most frames are neither of the four — a message, a checkpoint, a turn event —
 * and they say nothing about the session. Returning `undefined` for those would
 * ERASE a session that is perfectly well known every time an unrelated event
 * arrived, and the row would flip to UNKNOWN on activity. Silence about a fact is
 * not evidence against it.
 *
 * The same rule covers a frame shape this build cannot parse at all: an operator
 * on a newer t3code gets the last thing this build understood, ageing normally,
 * rather than a fabricated status.
 */
export function applyFrame(
  current: LiveThreadSession | undefined,
  value: unknown,
): LiveThreadSession | undefined {
  if (typeof value !== 'object' || value === null) return current;
  const frame = value as Record<string, unknown>;

  if (frame.kind === 'snapshot') {
    const snapshot = frame.snapshot;
    if (typeof snapshot !== 'object' || snapshot === null) return current;
    const thread = (snapshot as Record<string, unknown>).thread;
    if (typeof thread !== 'object' || thread === null) return current;
    const record = thread as Record<string, unknown>;
    const status = statusFrom(record.session);
    // A thread with no session at all is a real state — nothing has started it.
    // Reporting the PREVIOUS session would claim a process that is gone.
    if (!status) return undefined;
    return { ...status, settled: settledFrom(record) };
  }

  if (frame.kind !== 'event') return current;
  const event = frame.event;
  if (typeof event !== 'object' || event === null) return current;
  const record = event as Record<string, unknown>;
  const payload = record.payload as Record<string, unknown> | undefined;

  switch (record.type) {
    case 'thread.session-set': {
      const status = statusFrom(payload?.session);
      if (!status) return current;
      // Settledness is NOT in this payload, so it is carried forward rather than
      // defaulted. Defaulting it to false would un-settle a settled thread every
      // time its session was replaced.
      return { ...status, settled: current?.settled ?? false };
    }
    case 'thread.settled':
      // Without a known status there is nothing to attach settledness TO, and
      // inventing one would put a word on the row that no server sent.
      return current === undefined ? undefined : { ...current, settled: true };
    case 'thread.unsettled':
      return current === undefined ? undefined : { ...current, settled: false };
    default:
      return current;
  }
}

/**
 * The per-workspace session cache, and the maintainer that fills it.
 *
 * One instance per Tower. Keyed by canonical workspace path for the same reason
 * the thread engines are: Tower serves every workspace from one process, and a
 * process-global anything here would report workspace A's sessions for
 * workspace B.
 */
export class T3codeSessionCache {
  readonly #caches = new Map<string, WorkspaceCache>();
  /**
   * The OPEN STREAMS, not merely the fact that one was opened.
   *
   * This was a `Set<string>` of keys, so forgetting a subscription forgot the
   * bookkeeping and left the stream running: the server kept producing values
   * for nobody, an orphaned stream and its replacement could both write a
   * recreated entry, and each cycle leaked a pending request. A set of names
   * cannot cancel anything.
   */
  readonly #subscribed = new Map<string, ThreadStream>();
  readonly #now: () => number;
  readonly #freshForMs: number;
  readonly #discardAfterMs: number;
  readonly #sweepMs: number;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(private readonly options: T3codeSessionCacheOptions) {
    this.#now = options.now ?? Date.now;
    this.#freshForMs = options.freshForMs ?? DEFAULT_FRESH_FOR_MS;
    this.#discardAfterMs = options.discardAfterMs ?? DEFAULT_DISCARD_AFTER_MS;
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
  }

  /**
   * THE SYNCHRONOUS READER. No network, no filesystem, no database.
   *
   * Everything it needs was written by the maintainer. In particular it does NOT
   * call `requestThreadBackend`: that function starts a connect and performs a
   * five-layer config read, and on a request path that is per-request file I/O
   * plus a side effect on a code path whose whole contract is that it returns
   * immediately.
   *
   * NOT PURE, AND SAYING SO. Reading discards entries past the retention window
   * and cancels their subscriptions — an in-memory eviction, no I/O. It happens
   * here rather than only in the sweep because the alternative is publishing
   * content this read has just determined is too old to publish, and a caller
   * that reads twice in the same millisecond gets the same answer both times.
   */
  snapshot(workspacePath: string): T3codeThreadSnapshot {
    const cache = this.#caches.get(canonicalWorkspaceKey(workspacePath));
    // Never swept, never asked: the maintainer has not reached this workspace.
    // `connecting` is the honest word — something is on the way — and it is not
    // `not-configured`, which would assert a config read that has not happened.
    if (!cache) return { status: 'connecting' };

    const availability = cache.availability;
    if (availability.kind === 'not-configured') return { status: 'not-configured' };
    if (availability.kind === 'misconfigured') {
      return { status: 'misconfigured', message: availability.message };
    }

    if (availability.kind === 'cooling-down') {
      return {
        status: 'cooling-down',
        message: availability.message,
        since: new Date(cache.coolingSince ?? availability.since).toISOString(),
      };
    }
    if (availability.kind !== 'ready') return { status: 'connecting' };

    const threads = this.#observed(canonicalWorkspaceKey(workspacePath), cache);
    if (threads.length === 0) {
      /*
       * READY WITH NOTHING TO WATCH IS NOT "CONNECTING".
       *
       * This returned `connecting` for any empty result, and that is the state
       * EVERY REAL WORKSPACE IS IN: no row in `global.db` carries a `thread_id`,
       * so a connected, healthy, correctly configured Tower reported "still
       * connecting to t3code" for as long as it ran. Saying the connector's word
       * for a connect in flight when the connector has already said `ready` is
       * exactly the collapse the eight-status set exists to prevent.
       *
       * Connected with no threads is an observation — of the thread set, read
       * from `global.db` on the sweep — so it is `available` with nothing in it.
       * Each row then says why it has no session, which is the honest place for
       * that answer: a row with no thread says so, and a row with one says t3code
       * returned nothing for it.
       */
      if (cache.threadIdCount === 0 && cache.threadsReadAt !== undefined) {
        return { status: 'available', observedAt: new Date(cache.threadsReadAt).toISOString(), threads: [] };
      }
      // Threads exist and none has content: either their subscriptions have not
      // answered yet, or their content aged out and the next sweep will
      // resubscribe. Both are a connect in flight one layer down, and unlike the
      // case above both resolve on their own.
      return { status: 'connecting' };
    }

    const oldest = threads.reduce((worst, entry) => Math.max(worst, entry.ageMs), 0);
    const observedAt = new Date(this.#now() - oldest).toISOString();
    const live = threads.map((entry) => entry.thread);
    if (oldest < this.#freshForMs) return { status: 'available', observedAt, threads: live };
    return { status: 'stale', observedAt, ageMs: oldest, threads: live };
  }

  /**
   * The threads that have actually been OBSERVED, with their ages.
   *
   * An entry with no `observedAt` has an open subscription that has not delivered
   * a frame, and it is skipped rather than published: publishing it would report
   * a thread whose state nothing has seen, under a status that claims observation.
   *
   * Entries past the discard window are dropped here rather than published with a
   * large age: content that old is a wrong answer wearing a disclaimer.
   */
  #observed(key: string, cache: WorkspaceCache): Array<{ thread: LiveThread; ageMs: number }> {
    const now = this.#now();
    const observed: Array<{ thread: LiveThread; ageMs: number }> = [];
    for (const [threadId, entry] of cache.threads) {
      if (entry.observedAt === undefined) continue;
      const ageMs = entry.watching ? 0 : now - entry.observedAt;
      if (ageMs >= this.#discardAfterMs) {
        /*
         * `#forget`, NOT a bare delete — it cancels the subscription too.
         *
         * This dropped the entry and left the stream open, which is the same
         * defect a reviewer found in the sweep's removal path, in a second
         * place: a subscription whose only reference has just been discarded is
         * one nothing will ever read or close.
         */
        this.#forget(key, cache, threadId);
        continue;
      }
      observed.push({
        thread: { threadId, ...(entry.session ? { session: entry.session } : {}) },
        ageMs,
      });
    }
    return observed;
  }

  /** Start the maintenance loop. Idempotent. */
  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.sweep(), this.#sweepMs);
    // Never hold the process open for a cache: Tower's lifetime decides this
    // module's, not the other way round.
    this.#timer.unref?.();
    this.sweep();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One maintenance pass: ask the connector where each workspace stands, then
   * reconcile subscriptions against the thread ids `global.db` currently holds.
   *
   * Exposed so a test can drive it deterministically instead of waiting on a
   * timer. Every failure is caught and logged: a maintenance pass that throws
   * would stop the interval and freeze every workspace's answer at whatever it
   * last was — which would then age into `stale` and look like a t3code problem.
   */
  sweep(): void {
    let workspaces: string[];
    try {
      workspaces = this.#workspaces();
    } catch (error) {
      this.options.log('ERROR', `t3code session sweep could not begin: ${(error as Error).message}`);
      return;
    }
    for (const workspacePath of workspaces) {
      // PER WORKSPACE, not per pass. The catch used to wrap the whole loop, so a
      // throw from one workspace's connector skipped every workspace after it —
      // and their entries then aged into `stale`, which reads as a t3code problem
      // in workspaces that never had one.
      try {
        this.#sweepWorkspace(workspacePath);
      } catch (error) {
        this.options.log(
          'ERROR',
          `t3code session sweep failed for ${workspacePath}: ${(error as Error).message}`,
        );
      }
    }
  }

  #sweepWorkspace(workspacePath: string): void {
    const key = canonicalWorkspaceKey(workspacePath);
    let cache = this.#caches.get(key);
    if (!cache) {
      cache = { threads: new Map(), availability: { kind: 'connecting' } };
      this.#caches.set(key, cache);
    }

    const availability = this.options.availabilityFor
      ? this.options.availabilityFor(workspacePath)
      : requestThreadBackend(workspacePath);
    cache.availability = availability;
    if (availability.kind === 'cooling-down') {
      cache.coolingSince ??= availability.since;
    } else {
      cache.coolingSince = undefined;
    }

    // A workspace with no server named must not keep last-known content: there is
    // nothing to become current again, so publishing it would be a permanent
    // stale answer for a workspace that simply opted out.
    if (availability.kind === 'not-configured' || availability.kind === 'misconfigured') {
      for (const threadId of [...cache.threads.keys()]) this.#forget(key, cache, threadId);
      cache.threadIdCount = undefined;
      cache.threadsReadAt = undefined;
      return;
    }
    if (availability.kind !== 'ready') return;

    const streamer = this.options.streamerFor
      ? this.options.streamerFor(workspacePath)
      : tryGetThreadStreamer(workspacePath);
    if (!streamer) return;

    const threadIds = this.#threadIds(workspacePath);
    // A read that FAILED leaves the previous answer standing. Stamping a fresh
    // time and a zero count here would turn a locked database into an assertion
    // that this workspace has no threads.
    if (threadIds === null) return;
    // Stamped even when the set is EMPTY: "connected, and this workspace has no
    // thread-backed agents" is a fact this pass established, and it is what
    // distinguishes it from a workspace the maintainer has never reached.
    cache.threadsReadAt = this.#now();
    cache.threadIdCount = threadIds.length;
    for (const threadId of threadIds) {
      if (!cache.threads.has(threadId)) {
        // No `observedAt`: nothing has been observed yet, and seeding one here is
        // what made an unobserved thread publish as `available`.
        cache.threads.set(threadId, { threadId, watching: false });
      }
      this.#ensureSubscribed(key, threadId, streamer.stream);
    }

    // A thread that has left `global.db` is not stale content, it is gone. Its
    // row will not be published either, so keeping the entry would grow the cache
    // for the life of the process.
    for (const threadId of [...cache.threads.keys()]) {
      if (!threadIds.includes(threadId)) this.#forget(key, cache, threadId);
    }
  }

  /**
   * Drop a thread's entry AND its subscription bookkeeping.
   *
   * Deleting only the entry left the `#subscribed` key behind, so the stream went
   * on running against a server for a thread nothing was reading — a live socket
   * outliving its reason. It also meant that if the thread came back, this
   * maintainer would consider it already subscribed and never re-open a stream
   * for it, so a returning thread would be silently unwatched forever.
   */
  #forget(key: string, cache: WorkspaceCache, threadId: string): void {
    cache.threads.delete(threadId);
    const subscriptionKey = subscriptionKeyFor(key, threadId);
    // CANCEL, then forget. The other order would drop the only reference to the
    // handle and leave the stream running with nothing able to stop it.
    this.#subscribed.get(subscriptionKey)?.cancel();
    this.#subscribed.delete(subscriptionKey);
  }

  /** Every workspace `global.db` knows about. Same query shape the routes use. */
  #workspaces(): string[] {
    try {
      const rows = this.options.db().prepare(`
        SELECT workspace_path FROM known_workspaces
        UNION SELECT workspace_path FROM architect
        UNION SELECT workspace_path FROM builders
        ORDER BY workspace_path
      `).all() as Array<{ workspace_path: string }>;
      return rows.map((row) => normalizeWorkspacePath(row.workspace_path));
    } catch (error) {
      // A locked or unreadable database is not "no workspaces": returning none
      // would let every cache entry age out and report `stale` about t3code,
      // blaming the wrong component entirely.
      this.options.log('WARN', `t3code session cache could not list workspaces: ${(error as Error).message}`);
      return [...this.#caches.keys()];
    }
  }

  /**
   * The thread ids this workspace currently holds, or `null` when the read failed.
   *
   * NULL IS NOT AN EMPTY LIST, and the distinction is the whole point. This
   * returned `[]` on a failed read, and the caller then stamped
   * `threadIdCount = 0`, deleted every entry, and published `available` with
   * nothing to watch — spelling "I could not tell" exactly like "there is nothing
   * here". A locked or unreadable `global.db` says nothing about how many threads
   * a workspace has.
   *
   * The caller skips the thread-set update entirely on null, keeping the last
   * answer, which is the same rule `#workspaces` already follows.
   */
  #threadIds(workspacePath: string): string[] | null {
    try {
      const rows = this.options.db().prepare(`
        SELECT thread_id FROM architect WHERE workspace_path = ? AND thread_id IS NOT NULL
        UNION
        SELECT thread_id FROM builders WHERE workspace_path = ? AND thread_id IS NOT NULL
      `).all(workspacePath, workspacePath) as Array<{ thread_id: string }>;
      return rows.map((row) => row.thread_id);
    } catch (error) {
      this.options.log('WARN', `t3code session cache could not read thread ids: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Open one subscription per thread, at most once.
   *
   * `#subscribed` is keyed by workspace AND thread so two workspaces holding the
   * same thread id — possible, since ids come from different servers — do not
   * share a subscription.
   *
   * The stream is not awaited: this runs on a maintenance tick that must not
   * block. When it ends, for any reason, the entry stops being watched and starts
   * ageing, and the next pass re-subscribes if the backend is ready again.
   */
  #ensureSubscribed(key: string, threadId: string, stream: StreamFn): void {
    const subscriptionKey = subscriptionKeyFor(key, threadId);
    if (this.#subscribed.has(subscriptionKey)) return;

    const settle = (reason: string): void => {
      this.#subscribed.delete(subscriptionKey);
      const entry = this.#caches.get(key)?.threads.get(threadId);
      if (!entry) return;
      /*
       * STAMPED ON THE TRUE-TO-FALSE TRANSITION ONLY, and that word is the fix.
       *
       * This stamped on EVERY subscription end. The maintainer retries a failed
       * subscription every five seconds, and each failed attempt ends — so an
       * entry that was observed once and whose subscription then failed
       * permanently had its drop time reset twelve times a minute, forever. The
       * content never aged past the freshness window, never became `stale`, and
       * was never discarded: THE FAILURE REFRESHED THE FRESHNESS.
       *
       * It also removed the only remaining bound on that content. A reviewer had
       * noted that `available` was ultimately limited by the t3-client stream
       * idle timeout; a retry loop that re-stamps makes even that unreachable.
       *
       * So: the age is measured from when watching STOPPED, and it stops once.
       */
      const wasWatching = entry.watching;
      entry.watching = false;
      // Only on the transition, and only if something WAS observed. A
      // subscription that ended without ever delivering a frame leaves nothing to
      // age, and stamping here would turn "never seen" into "seen just now, then
      // lost".
      if (wasWatching && (entry.session !== undefined || entry.observedAt !== undefined)) {
        entry.observedAt = this.#now();
      }
      this.options.log('INFO', `t3code subscription for ${threadId} ended: ${reason}`);
    };

    // Called DIRECTLY rather than deferred to a microtask, so a sweep leaves the
    // subscription open rather than merely scheduled. The try/catch is what a
    // `Promise.resolve().then(...)` wrapper was buying — a synchronous throw from
    // `stream` must not escape the maintenance pass and stop the interval — and
    // it buys it without making "subscribed" true one turn of the event loop
    // after the pass that decided it.
    let opened: ThreadStream;
    try {
      opened = stream(SUBSCRIBE_THREAD, { threadId }, (value) => {
        const entry = this.#caches.get(key)?.threads.get(threadId);
        if (!entry) return;
        // LIVENESS, NOT CHANGE. Every frame — including one that carries no
        // session this build can read — proves the subscription is up, which is
        // what freshness means here.
        entry.watching = true;
        entry.observedAt = this.#now();
        // A FOLD, not a read: the snapshot arrives once and everything after it
        // is an event. Assigning only when a frame parses would freeze the
        // session at subscription time and then report it as current.
        entry.session = applyFrame(entry.session, value);
      });
    } catch (error) {
      settle(error instanceof Error ? error.message : String(error));
      return;
    }
    // Registered only once the stream is actually open, so a `stream` that threw
    // never leaves a handle behind that `cancel` would call into.
    this.#subscribed.set(subscriptionKey, opened);
    void opened.done.then(
      () => settle('the server ended the stream'),
      (error: unknown) => settle(error instanceof Error ? error.message : String(error)),
    );
  }
}
