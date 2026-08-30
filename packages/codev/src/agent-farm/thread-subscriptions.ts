/**
 * The production thread subscriber (issue #241).
 *
 * ## What was missing
 *
 * `TurnTracker` is the only thing that resolves a turn's `running` and `settled`
 * promises, and it resolves them from `thread.session-set` events fed to
 * `TurnTracker.observe`. Nothing in production ever fed it: `DriverThread.observe`
 * and `ResumingSubscription` had no caller outside `__tests__/`. So
 * `porch-thread-engine`'s `track()` set `record.activeTurnId` at dispatch and then
 * awaited two promises that never resolved, `DriverThread.runTurn` never returned,
 * and `SessionStartFailedError` — the named refusal added in #238 — could not reach
 * a caller. The transport was correct and tested; the subscriber did not exist.
 *
 * This module is the subscriber. One `ResumingSubscription` per adopted thread,
 * owned by whichever process owns the engine — Tower, per #221's ruling that
 * delivery registers an engine in Tower's own process — keyed the same way, by
 * canonical workspace root.
 *
 * ## TWO STREAMS PER WATCHED THREAD, and it is deliberate
 *
 * `T3codeSessionCache` (`servers/t3code-session-cache.ts`) already opens an
 * `orchestration.subscribeThread` stream per thread. It is a DISPLAY subscriber: it
 * folds frames into `entry.session`, holds no cursor, and its `watching` / `stale`
 * vocabulary is built on a stream that ENDS — `settle()` fires from `opened.done`.
 * A `ResumingSubscription` never ends; it resubscribes. Folding the two together is
 * therefore a rewrite of that freshness vocabulary and of the tests that encode it,
 * not a wiring change, so it is issue #251 rather than part of this one. A watched
 * thread carries two read-only streams on Tower's one socket until then. Whether
 * that costs anything measurable on a real server is NOT measured here, and #251
 * says so rather than leaving it implied.
 *
 * ## THE SNAPSHOT DROPS EVENTS, WHICH IS WHY `ensure` RESOLVES ON ATTACHMENT
 *
 * `ResumingSubscription` hands the server's snapshot frame to `onValue`, and
 * `asThreadEvent` returns null for it — so anything the server compacted into that
 * snapshot is never observed. A turn dispatched BEFORE the subscription attaches can
 * have its `running` transition land inside the snapshot, and the waiter then waits
 * for a transition that already happened.
 *
 * It is not hypothetical and it is driver-dependent: `air-235-full-protocol.mjs`
 * records a probe written without this gate passing under claude and timing out
 * under opencode/grok-4.6, which finishes a trivial turn in ~14s and therefore beat
 * the subscribe. A race a slow driver hides is exactly the class this exists to
 * close. So `ensure` resolves only once the subscription has ATTACHED — the first
 * `onResume` — and the engine awaits it before dispatching any turn.
 *
 * ## `close()` CANCELS THE STREAM, NEVER THE SOCKET
 *
 * `ResumingSubscription` calls `transport.close()` in the `finally` of EVERY
 * attempt, not only on `stop()`. Tower has one socket for commands and streams, so a
 * `close` that closed the socket would take the dispatch path down with it mid-turn.
 * The `air-235` helper made `close` a no-op and documented the cost: a failing
 * handler does not end the stream promptly, so redelivery waits for the next natural
 * resubscription. This closes that gap instead of inheriting it — the transport
 * captures its own request id and `close` cancels exactly that stream, which is what
 * `connectDispatcher`'s `ThreadStream` already does for the display path.
 */
import { resolve } from 'node:path';
import { PersistentCursor } from '@cluesmith/porch-driver/cursor';
import {
  asThreadEvent,
  isSnapshot,
  isSynchronized,
  sequenceOf,
} from '@cluesmith/porch-driver/turn';
import { ResumingSubscription } from '@cluesmith/t3-client/subscription';
import type { ResumeOutcome } from '@cluesmith/t3-client/resume';

/** The streaming method, from the vendored contract. Same one the display path uses. */
export const SUBSCRIBE_THREAD = 'orchestration.subscribeThread';

/**
 * How long `ensure` waits for a subscription to attach before naming the failure.
 *
 * SET TO `T3Client`'s OWN `requestTimeoutMs` DEFAULT, and the match is the argument
 * for it rather than a coincidence.
 *
 * Tower's mailbox drain awaits agents sequentially, and its own comment records why
 * nothing on that path may await a CONNECT: one workspace's connect stalled delivery
 * for every agent in every workspace, including PTY-only ones. So a new await there
 * deserves the same scrutiny.
 *
 * This is not that. Delivery already awaits `dispatchCommand` — a network RPC on this
 * same socket, bounded by `requestTimeoutMs`, 30s. Attaching a subscription is one
 * more round trip on the same wire, immediately before it. Matching the budget means
 * a subscription that never comes up costs exactly what a command that is never
 * answered already costs on a path that tolerates the latter; it does not introduce a
 * longer worst case than the line below it.
 *
 * Raising `requestTimeoutMs` without raising this would make the subscription the
 * shorter of the two bounds, which is the direction that is safe. Lowering this below
 * a thread's catch-up replay is the unsafe direction: a long history takes real time
 * to replay, and failing it would refuse turns on the busiest threads first.
 */
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

/** Pause between resubscription attempts. Matches the air-235 reference. */
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * The read half of Tower's t3code socket, shaped the way `ResumingSubscription` needs it.
 *
 * `onRequestId` is the load-bearing parameter. Without it a long-lived subscription
 * has no way to be stopped, and the only interrupt that can fire is the client's idle
 * timeout — which is how a stream outlives its reason.
 */
export interface ThreadSubscriber {
  stream(
    method: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    timeoutMs?: number,
    onRequestId?: (id: number) => void,
  ): Promise<unknown>;
  /** Interrupt one in-flight stream by its request id. Idempotent. */
  cancel(requestId: number): void;
}

export interface ThreadSubscriptionPoolOptions {
  readonly subscriber: ThreadSubscriber;
  /** Workspace root. Cursors live under its `.codev/`, beside `commands.jsonl`. */
  readonly workspaceRoot: string;
  /** Fed every stream value, in order. MUST be idempotent — delivery is at-least-once. */
  observe(value: unknown): void;
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void;
  readonly attachTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

/**
 * A thread id that is safe to use as a filename.
 *
 * The id arrives from a t3code server and from `global.db`, so it is not this
 * process's own string. A cursor path built from an unchecked id writes anywhere
 * Tower can write. Checked before any file is opened, and refused rather than
 * sanitised: a silently rewritten id would give two threads one cursor.
 */
const SAFE_THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class UnsafeThreadIdError extends Error {
  constructor(readonly threadId: string) {
    super(
      `Thread id ${JSON.stringify(threadId.slice(0, 160))} cannot be used as a cursor filename.\n` +
        `  Ids are accepted only as [A-Za-z0-9_-]{1,128}. This one is refused rather than rewritten: ` +
        `a sanitised id would silently give two different threads the same cursor file, and the ` +
        `resulting resume would be wrong for both.`,
    );
    this.name = 'UnsafeThreadIdError';
  }
}

/** A subscription did not attach within its budget. */
export class SubscriptionNotAttachedError extends Error {
  constructor(
    readonly threadId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `The subscription for thread ${threadId} did not attach within ${timeoutMs}ms.\n` +
        `  No turn is dispatched onto an unattached thread, because the server's snapshot frame ` +
        `carries no observable events: a turn started first can have its "running" transition land ` +
        `inside that snapshot, and the waiter would then wait forever for a transition that already ` +
        `happened.\n` +
        `  This says the stream never came up. It does not say the thread is gone, and it does not ` +
        `say the server refused.`,
    );
    this.name = 'SubscriptionNotAttachedError';
  }
}

interface Entry {
  readonly subscription: ResumingSubscription;
  readonly cursor: PersistentCursor;
  readonly attached: Promise<void>;
  /** Set when `onResume` first fires. Read by `attached(threadId)`. */
  isAttached: boolean;
  /**
   * Set by `stop`/`stopAll` before the subscription is torn down.
   *
   * A cancelled stream ends UNSYNCHRONIZED, which is indistinguishable at the callback
   * from a server that dropped mid-catch-up — so a deliberate teardown reported itself
   * as an anomaly. Measured on the #227 live run: `afx interrupt` succeeded, hung up its
   * connection, and printed "ended before the server signalled catch-up was complete"
   * about a subscription it had just asked to stop. The refusal to mark it attached is
   * still right; the warning is the part that was false.
   */
  isStopping: boolean;
  /** The `run()` loop, kept so `stopAll` can await a clean teardown. */
  readonly running: Promise<void>;
}

export interface ThreadSubscriptionPool {
  /**
   * Open a subscription for `threadId` if none is held, and return at once.
   *
   * For ADOPTION, which is not dispatch. The sweeper reconciles every thread in
   * `global.db` on an interval, so a thread whose subscription cannot come up would
   * otherwise cost `ensure`'s whole budget on every pass, forever, and delay the
   * adoption of every thread behind it.
   *
   * Throws synchronously for an id that cannot be a cursor filename and for a cursor
   * file that cannot be read — both are refusals to subscribe from the wrong place,
   * and neither improves by being deferred.
   */
  start(threadId: string): void;
  /**
   * Open a subscription if none is held, and resolve once it has ATTACHED.
   *
   * For DISPATCH. A turn started before the first subscription attaches can have its
   * `running` transition land inside the server's snapshot frame, which carries no
   * observable events.
   *
   * Note what this does NOT need to guard: a subscription that has attached once and
   * later dropped. Every resubscription after the first sends `afterSequence`, so the
   * events emitted during the drop are REPLAYED rather than compacted away. Only the
   * cold first subscription can lose history into a snapshot, and that is the case
   * this waits for.
   */
  ensure(threadId: string): Promise<void>;
  /** Stop and forget one subscription. Idempotent. */
  stop(threadId: string): void;
  /** Stop everything. For the socket's close handler and Tower's shutdown. */
  stopAll(): void;
  /** Whether this thread's subscription has attached. */
  attached(threadId: string): boolean;
  /** Thread ids this pool holds a subscription for. */
  readonly threadIds: ReadonlySet<string>;
  /** Where a thread's cursor lives. Exposed so a test can read the file. */
  cursorPath(threadId: string): string;
}

export function createThreadSubscriptionPool(
  options: ThreadSubscriptionPoolOptions,
): ThreadSubscriptionPool {
  const entries = new Map<string, Entry>();
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let stopped = false;

  const cursorPath = (threadId: string): string => {
    if (!SAFE_THREAD_ID.test(threadId)) throw new UnsafeThreadIdError(threadId);
    return resolve(options.workspaceRoot, '.codev', 'thread-cursors', threadId);
  };

  /**
   * One attempt's transport over the shared socket.
   *
   * A fresh object per attempt, because `close()` must name THIS attempt's stream.
   * Sharing one across attempts would let a `finally` from a dead attempt cancel the
   * request id of the live one.
   */
  function makeTransport(threadId: string) {
    let requestId: number | undefined;
    let cancelled = false;
    return {
      client: {
        stream: (
          method: string,
          payload: unknown,
          onValue: (value: unknown) => void,
          timeoutMs?: number,
        ) =>
          options.subscriber.stream(
            method,
            payload,
            (value) => {
              if (!cancelled) onValue(value);
            },
            timeoutMs,
            (id) => {
              requestId = id;
            },
          ),
      },
      close: () => {
        // Idempotent, and safe before the id arrives. `onRequestId` fires
        // synchronously inside `stream`, so in practice it has always arrived — but
        // an ordering assumption written as a guarantee is how this repository has
        // been bitten before, so it is a guard rather than a comment.
        if (cancelled) return;
        cancelled = true;
        if (requestId === undefined) return;
        try {
          options.subscriber.cancel(requestId);
        } catch {
          /* the socket is already gone; there is nothing to interrupt through */
        }
      },
    };
  }

  function open(threadId: string): Entry {
    // Before any file is opened, and before a subscription exists to leak.
    const path = cursorPath(threadId);
    // NOT caught into a cold start. `PersistentCursor.load` throws
    // `CursorUnreadableError` on a damaged file precisely so that resubscribing from
    // sequence 0 — which replays the thread from the beginning and looks exactly like
    // a first subscription — cannot be what a caller gets when the truth is "I could
    // not read where I was". An ABSENT file really is a cold start and returns 0.
    const cursor = PersistentCursor.load(path);

    let markAttached!: () => void;
    let failAttached!: (reason: unknown) => void;
    const attached = new Promise<void>((res, rej) => {
      markAttached = res;
      failAttached = rej;
    });
    // Attached so a subscription that fails before anyone awaits it does not surface as
    // an unhandled rejection. The `ensure` caller still sees it.
    attached.catch(() => {});

    const entry: Partial<Entry> & { isAttached: boolean; isStopping: boolean } = {
      isAttached: false,
      isStopping: false,
    };

    const subscription = new ResumingSubscription(
      async () => makeTransport(threadId),
      {
        method: SUBSCRIBE_THREAD,
        payload: { threadId },
        sequenceOf,
        isSnapshot,
        isSynchronized,
        onValue: (value) => {
          options.observe(value);
        },
        onResume: (outcome: ResumeOutcome, info) => {
          /*
           * ONLY A SYNCHRONIZED ATTEMPT COUNTS AS ATTACHED.
           *
           * `ResumingSubscription` also calls `onResume` from the `finally` of an
           * attempt that ended BEFORE the server signalled catch-up was complete,
           * reporting a `gap`. That attempt never came up: `#everSubscribed` stays
           * false and the cursor stays where it was, so the next attempt is another
           * COLD subscribe whose snapshot carries no observable events. Marking it
           * attached let `ensure` resolve and a turn dispatch into exactly the
           * snapshot race this module exists to close — reachable through the
           * failure path rather than the happy one.
           *
           * Keyed on `info.synchronized` rather than on `outcome.kind !== 'gap'`,
           * which both review lanes proposed and which is wrong in the other
           * direction: `classifyResume` returns a legitimate `gap` when the server
           * synchronized and DECLINED to resume from the cursor. That subscription
           * is up and the caller must reconcile, not wait. Refusing to attach on it
           * would turn a recoverable condition into a permanent refusal to dispatch.
           */
          if (!info.synchronized) {
            // Silent when WE stopped it. The attempt still does not count as attached —
            // that rule is unchanged and the `return` below is the same one — but a
            // teardown we asked for is not an anomaly to report, and saying so on the
            // happy path of a command that just succeeded trains people to ignore the
            // line that matters.
            if (!entry.isStopping) {
              options.log(
                'WARN',
                `t3code subscription for thread ${threadId} ended before the server signalled ` +
                  `catch-up was complete (attempt ${info.attempt}). This attempt never came up, so it ` +
                  `does NOT count as attached and the next one is a fresh subscribe.`,
              );
            }
            return;
          }
          entry.isAttached = true;
          markAttached();
          if (outcome.kind === 'gap') {
            // A gap is the one outcome nothing may absorb: the events between the
            // cursor and wherever the server resumed are exactly what cannot be
            // accounted for, and a turn that settled inside that range settles for
            // nobody. Reported with the range so it is actionable rather than a
            // shrug.
            options.log(
              'WARN',
              `t3code subscription for thread ${threadId} resumed with a GAP on attempt ${info.attempt}: ` +
                `requested events after ${outcome.requestedAfter}, first received ` +
                `${outcome.firstReceived ?? 'none'}. ${outcome.reason} A turn that settled inside that ` +
                `range will not have been observed.`,
            );
          }
        },
        onHandlerError: (error, sequence) => {
          // Not optional in practice: without it a failing handler is invisible and
          // the subscription retries it forever in silence.
          options.log(
            'ERROR',
            `t3code subscription handler failed for thread ${threadId} at sequence ` +
              `${sequence ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}. ` +
              `The cursor did not advance, so the event is redelivered.`,
          );
        },
        startAfter: cursor.applied,
        // `reset`, not `apply`. `ResumingSubscription` owns the ordering rule — the
        // handler runs, THEN this fires — so the durable copy is written to whatever
        // position the in-memory cursor reached. Running a second ordering rule
        // underneath the first is how two cursors disagree.
        persist: (sequence) => {
          cursor.reset(sequence);
        },
        delayBetweenAttemptsMs: retryDelayMs,
      },
    );

    const running = subscription.run().catch((error: unknown) => {
      // `run()` rejects only on a non-retryable failure or a transport that cannot be
      // opened. Either way nothing is watching this thread any more, so the entry is
      // dropped rather than left claiming a subscription that has stopped.
      options.log(
        'ERROR',
        `t3code subscription for thread ${threadId} ended and will not retry: ` +
          `${error instanceof Error ? error.message : String(error)}. Turns on this thread will not ` +
          `settle until it is re-adopted.`,
      );
      if (entries.get(threadId) === (entry as Entry)) entries.delete(threadId);
      // SURFACED NOW, not at the end of the attach budget.
      //
      // A caller in `ensure` is racing this promise against a 30s timer. Leaving it
      // pending meant a subscription that had already failed for a NAMED, terminal
      // reason was reported 30s later as `SubscriptionNotAttachedError` — "the stream
      // never came up", which is true and says nothing about why, in place of the
      // server's own sentence that was available immediately.
      failAttached(error);
    });

    Object.assign(entry, { subscription, cursor, attached, running });
    return entry as Entry;
  }

  return {
    start(threadId: string): void {
      if (stopped) throw new Error(`The thread subscription pool for ${options.workspaceRoot} is stopped.`);
      if (entries.has(threadId)) return;
      entries.set(threadId, open(threadId));
    },

    async ensure(threadId: string): Promise<void> {
      if (stopped) throw new Error(`The thread subscription pool for ${options.workspaceRoot} is stopped.`);
      let entry = entries.get(threadId);
      if (!entry) {
        entry = open(threadId);
        entries.set(threadId, entry);
      }
      if (entry.isAttached) return;
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new SubscriptionNotAttachedError(threadId, attachTimeoutMs)), attachTimeoutMs);
        // Never hold the process open for a subscription's attach budget.
        timer.unref?.();
      });
      // Attached, because the race can be won by `entry.attached` in the same tick the
      // timer fires. `Promise.race` has settled by then and nothing is left listening,
      // so the rejection would surface as an unhandled one — in Tower, a process-level
      // warning about a subscription that in fact came up. The awaiting caller below
      // still sees the rejection; this only stops the losing branch from escaping.
      expiry.catch(() => {});
      try {
        await Promise.race([entry.attached, expiry]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    stop(threadId: string): void {
      const entry = entries.get(threadId);
      if (!entry) return;
      entries.delete(threadId);
      // Flagged BEFORE the teardown, because the callback that would warn about an
      // unsynchronized end runs as a result of it.
      entry.isStopping = true;
      entry.subscription.stop();
    },

    stopAll(): void {
      stopped = true;
      for (const [threadId, entry] of [...entries]) {
        entries.delete(threadId);
        entry.isStopping = true;
        entry.subscription.stop();
      }
    },

    attached(threadId: string): boolean {
      return entries.get(threadId)?.isAttached ?? false;
    },

    get threadIds(): ReadonlySet<string> {
      return new Set(entries.keys());
    },

    cursorPath,
  };
}

/** Re-exported so a caller can name the shape without importing porch-driver directly. */
export { asThreadEvent };

/* ────────────────────────────────────────────────────────────────────────────
 * Adoption after a Tower restart
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a sweeper exists at all.
 *
 * `ThreadEngine.attach` has exactly ONE production caller — `mailbox-wiring.ts`'s
 * delivery path — so a thread is adopted only when somebody sends it a message. A
 * thread whose turn was in flight when Tower died would therefore stay unsubscribed
 * indefinitely, and the cursor this module persists would never be read by anything.
 * "The cursor resumes rather than resubscribes cold" would be a property of the test
 * suite and of nowhere else.
 *
 * So the set of threads to watch is reconciled against `global.db` on an interval,
 * the same way `T3codeSessionCache` reconciles the set it displays. It is re-read
 * every pass rather than once at boot: a sweeper that reads it once goes permanently
 * blind to every agent spawned afterwards, which on a Tower that runs for days is
 * most of them.
 *
 * The thread set comes from `global.db` and not from the server because the vendored
 * contract has no thread listing — `orchestration.subscribeThread` takes one
 * `threadId` and `orchestration.searchThreads` is a text search over message content.
 */

/** One row worth of what `attach` needs. The engine cannot recover these from an id. */
export interface AdoptableThread {
  readonly threadId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly builderId: string;
  readonly harnessName?: string;
  readonly model?: string;
}

export interface ThreadAdoptionSweeperOptions {
  /** Workspace roots to consider, or `null` when the read failed. */
  workspaces(): string[] | null;
  /** Adoptable threads for one workspace, or `null` when the read failed. */
  threads(workspaceRoot: string): AdoptableThread[] | null;
  /** Whether this workspace's backend is up. A workspace that is not `ready` is skipped. */
  isReady(workspaceRoot: string): boolean;
  /** The engine for a workspace, or nothing. MUST NOT be the throwing accessor. */
  engineFor(workspaceRoot: string): { attach(input: AdoptableThread): Promise<unknown> } | undefined;
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void;
  readonly intervalMs?: number;
}

/** Matches `T3codeSessionCache`'s sweep, so the two reconcile on the same rhythm. */
const DEFAULT_SWEEP_MS = 5_000;

export interface ThreadAdoptionSweeper {
  /** Run one pass. Exposed so a test drives it directly instead of waiting on a timer. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createThreadAdoptionSweeper(
  options: ThreadAdoptionSweeperOptions,
): ThreadAdoptionSweeper {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function sweepWorkspace(workspaceRoot: string): Promise<void> {
    // `isReady` first, and it must not be the throwing engine accessor: a workspace
    // with no t3code server configured is the ordinary case, not an error, and
    // treating it as one would stop the pass for every workspace after it.
    if (!options.isReady(workspaceRoot)) return;
    const engine = options.engineFor(workspaceRoot);
    if (!engine) return;
    const threads = options.threads(workspaceRoot);
    // NULL IS NOT AN EMPTY LIST. A locked or unreadable `global.db` says nothing
    // about how many threads a workspace has, and adopting none of them because the
    // read failed would spell "I could not tell" exactly like "there is nothing
    // here". The previous set stands.
    if (threads === null) return;
    for (const thread of threads) {
      try {
        // Idempotent by contract: a second `attach` returns the existing record and
        // must not replace a `DriverThread` that is tracking a live turn.
        await engine.attach(thread);
      } catch (error) {
        // PER THREAD. A throw that escaped here would skip every thread after it in
        // this workspace, and they would then be silently unwatched — the exact
        // shape of failure this sweeper exists to remove.
        options.log(
          'WARN',
          `Could not adopt thread ${thread.threadId} for ${workspaceRoot}: ` +
            `${error instanceof Error ? error.message : String(error)}. This is not evidence that the ` +
            `thread is gone; its turns will not settle in this process until a later pass adopts it.`,
        );
      }
    }
  }

  async function sweep(): Promise<void> {
    // One pass at a time. `attach` does NOT await the subscription's attach budget —
    // it calls `start`, which returns at once — but it still dispatches commands over
    // the socket, so a slow server can make a pass outlast its interval and
    // overlapping passes would stack `attach` calls on the same threads.
    if (running) return;
    running = true;
    try {
      const workspaces = options.workspaces();
      if (workspaces === null) return;
      for (const workspaceRoot of workspaces) {
        try {
          await sweepWorkspace(workspaceRoot);
        } catch (error) {
          // PER WORKSPACE, for the same reason as per thread: one workspace's
          // connector throwing must not skip every workspace after it.
          options.log(
            'ERROR',
            `Thread adoption sweep failed for ${workspaceRoot}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (timer) return;
      const run = () => {
        void sweep().catch((error: unknown) => {
          options.log(
            'ERROR',
            `Thread adoption sweep could not begin: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      };
      timer = setInterval(run, options.intervalMs ?? DEFAULT_SWEEP_MS);
      // Never the reason a process stays alive.
      timer.unref?.();
      // IMMEDIATELY, the way `T3codeSessionCache.start` does. Setting only the interval
      // leaves every thread that nobody messages unsubscribed for a full sweep after
      // Tower boots — which is precisely the window a Tower restart lands in, and
      // resuming from a persisted cursor is the thing this sweeper exists to make
      // possible after exactly that event.
      run();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
