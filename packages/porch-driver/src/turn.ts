/**
 * Spec 146, Phase 3 — starting a turn and knowing when it is over.
 *
 * SETTLE DETECTION KEYS ON `activeTurnId`, NOT ON SESSION STATUS
 *
 * An interrupted turn reports status `ready`, exactly as a finished one does, so
 * status cannot tell the two apart. `thread.session-set` carries
 * `session.activeTurnId`, and that transition — non-null, then null — is the
 * turn's actual lifetime.
 *
 * THE LATCH IS NOT OPTIONAL
 *
 * `activeTurnId` is ALREADY null in the `thread.session-set` emitted when the
 * thread is created. A detector that waits for "null" reports settled before the
 * turn has begun, and then everything downstream measures an empty range. So a
 * turn is settled only after it was first seen RUNNING — `#seenRunning` — which
 * the spike found the same way (`proof.mjs:219-236`).
 *
 * REGISTER BEFORE DISPATCH
 *
 * `startTurn` registers the waiter and captures the starting sequence BEFORE the
 * command goes out. Registering afterwards races the `running` signal: a fast
 * server can emit it while the dispatch promise is still resolving, and the
 * waiter then waits for a transition that already happened
 * (`proof.mjs:294-311`).
 */

import { dispatchCommand, newCommandId, type CommandDispatcher, type DispatchJournal } from './commands.js';

/** The event shape t3code streams inside `{ kind: 'event', event }`. */
export interface ThreadEvent {
  readonly sequence: number;
  readonly aggregateId: string;
  readonly type: string;
  readonly eventId?: string;
  readonly payload?: Record<string, unknown>;
}

/** Read the event out of a `subscribeThread` stream value, or null if it is not one. */
export function asThreadEvent(value: unknown): ThreadEvent | null {
  const item = value as { kind?: unknown; event?: unknown } | null;
  if (!item || item.kind !== 'event') return null;
  const event = item.event as ThreadEvent | undefined;
  if (!event || typeof event.sequence !== 'number' || typeof event.type !== 'string') return null;
  return event;
}

/** True for the marker ending catch-up. */
export function isSynchronized(value: unknown): boolean {
  return (value as { kind?: unknown } | null)?.kind === 'synchronized';
}

/** True for the server's snapshot frame. */
export function isSnapshot(value: unknown): boolean {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'snapshot' || kind === 'thread-snapshot';
}

/** The sequence on a stream value, or null when it carries none. */
export function sequenceOf(value: unknown): number | null {
  return asThreadEvent(value)?.sequence ?? null;
}

/**
 * The session's failure from a `thread.session-set`, or `undefined` when it is
 * not one or the session is not in error.
 *
 * Three values, because there are three facts. `undefined` is "this event says
 * nothing about failure". `null` is "the session failed and the server gave no
 * reason" — WHY is unknown, THAT it failed is not. A string is the server's own
 * sentence.
 *
 * Spec 146 Phase 10 found the reason this exists. t3code ships
 * `OpenCodeSettings.enabled` defaulting to false — "users opt in from Settings" —
 * so a thread on the opencode driver in a state directory nobody opted in for is
 * refused at `startSession`:
 *
 *   ProviderValidationError: Provider instance 'opencode' is disabled in T3 Code
 *   settings.
 *
 * The server emits that as `status: "error"`, `lastError: <the sentence>`, twelve
 * milliseconds after the dispatch. Nothing read it, so the caller waited out its
 * whole budget and reported `Timed out after 599950ms waiting for the turn to
 * start`. Ten minutes to not learn something that was already on the wire, and
 * the failure named the wrong thing: a refusal presented as "I stopped waiting".
 */
export function sessionFailureOf(event: ThreadEvent): string | null | undefined {
  if (event.type !== 'thread.session-set') return undefined;
  const session = event.payload?.session as { status?: unknown; lastError?: unknown } | undefined;
  if (!session || session.status !== 'error') return undefined;
  return typeof session.lastError === 'string' && session.lastError.length > 0 ? session.lastError : null;
}

/** `session.activeTurnId` from a `thread.session-set` event, or `undefined` for other events. */
export function activeTurnIdOf(event: ThreadEvent): string | null | undefined {
  if (event.type !== 'thread.session-set') return undefined;
  const session = event.payload?.session as { activeTurnId?: string | null } | undefined;
  if (!session) return undefined;
  return session.activeTurnId ?? null;
}

interface Waiter {
  seenRunning: boolean;
  /**
   * The thread's sequence when this waiter was registered.
   *
   * Delivery is at-least-once by design, so a `status: "error"` from a PREVIOUS
   * turn can be redelivered after a new `expectTurn` — and without this it would
   * abandon a healthy turn's waiter with a refusal that belongs to history. The
   * cursor advances after the handler, which is exactly what makes such a replay
   * ordinary rather than exotic.
   */
  startSequence: number;
  resolveRunning(turnId: string): void;
  resolveSettled(): void;
  abandon(reason: Error): void;
  readonly running: Promise<string>;
  readonly settled: Promise<void>;
}

function makeWaiter(startSequence: number): Waiter {
  let resolveRunning!: (turnId: string) => void;
  let resolveSettled!: () => void;
  let rejectRunning!: (reason: Error) => void;
  let rejectSettled!: (reason: Error) => void;
  const running = new Promise<string>((resolve, reject) => {
    resolveRunning = resolve;
    rejectRunning = reject;
  });
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  // Both are attached so a waiter that is displaced before anyone awaits it does
  // not surface as an unhandled rejection. The awaiting caller still sees it.
  running.catch(() => {});
  settled.catch(() => {});
  return {
    seenRunning: false,
    startSequence,
    resolveRunning,
    resolveSettled,
    abandon: (reason: Error) => {
      rejectRunning(reason);
      rejectSettled(reason);
    },
    running,
    settled,
  };
}

/**
 * The session failed before the turn ever started.
 *
 * Distinct from a timeout on purpose, and that distinction is the whole point:
 * a timeout says "I stopped waiting" and leaves open that the turn is still
 * running. This says the server refused, and carries what it said.
 */
export class SessionStartFailedError extends Error {
  constructor(
    readonly threadId: string,
    /** The server's own sentence, or null when it reported an error and no reason. */
    readonly serverMessage: string | null,
  ) {
    super(
      `The session for thread ${threadId} failed before the turn started.\n` +
        (serverMessage === null
          ? `  The server reported status "error" and gave no reason, so WHY is unknown — but THAT it ` +
            `failed is not, and those are different facts.\n`
          : `  The server said: ${serverMessage.split('\n')[0]}\n`) +
        `  This is a refusal, not a timeout. Waiting out the caller's budget here would spell an answer ` +
        `the server gave in milliseconds as "I could not tell".`,
    );
    this.name = 'SessionStartFailedError';
  }
}

/** A waiter was displaced by a second turn started on the same thread. */
export class TurnDisplacedError extends Error {
  constructor(readonly threadId: string) {
    super(
      `The turn being awaited on thread ${threadId} was displaced by a second ` +
        `turn started on the same thread.\n` +
        `  Only one turn is tracked per thread, so the first waiter can never be ` +
        `resolved once the second replaces it. This is "nobody will ever tell you", ` +
        `not "it is still running" — a caller left awaiting the old promises would ` +
        `hang forever with nothing to observe.`,
    );
    this.name = 'TurnDisplacedError';
  }
}

/**
 * Tracks turn lifetime across the threads it is fed events for.
 *
 * `observe` is idempotent by construction: it derives state from the event and
 * resolves promises, and resolving a promise twice is a no-op. That matters
 * because at-least-once delivery means the same `thread.session-set` can arrive
 * more than once.
 */
export class TurnTracker {
  #waiters = new Map<string, Waiter>();
  #lastSequence = new Map<string, number>();
  #active = new Map<string, string>();

  /** The highest sequence seen for a thread, or 0. */
  lastSequence(threadId: string): number {
    return this.#lastSequence.get(threadId) ?? 0;
  }

  /** Threads with a turn currently running, by their `activeTurnId`. */
  get activeThreads(): ReadonlyMap<string, string> {
    return this.#active;
  }

  /** Feed one stream value. Non-events are ignored. */
  observe(value: unknown): void {
    const event = asThreadEvent(value);
    if (!event) return;
    const previous = this.#lastSequence.get(event.aggregateId) ?? 0;
    if (event.sequence > previous) this.#lastSequence.set(event.aggregateId, event.sequence);

    // A refusal is read BEFORE the activeTurnId path, because the refusal event
    // carries `activeTurnId: null` and would otherwise fall through the
    // `seenRunning` latch and do nothing at all — which is exactly how a
    // definite "no" became a ten-minute silence.
    const failure = sessionFailureOf(event);
    if (failure !== undefined) {
      const failed = this.#waiters.get(event.aggregateId);
      // Only before the turn is running, and only for a refusal that happened
      // AFTER this waiter was registered. Two guards, for two different mistakes:
      //
      //  - After running, a session error is the turn ENDING, and the
      //    `activeTurnId: null` below settles it normally. A caller that already
      //    holds a turn id wants its result, not an exception.
      //  - At or below `startSequence`, the error predates this waiter. Delivery
      //    is at-least-once, so a refusal from a previous turn WILL be
      //    redelivered on any resubscription, and killing a healthy turn with a
      //    stale refusal would be a worse failure than the one this guard fixes.
      if (failed && !failed.seenRunning && event.sequence > failed.startSequence) {
        this.#waiters.delete(event.aggregateId);
        this.#active.delete(event.aggregateId);
        failed.abandon(new SessionStartFailedError(event.aggregateId, failure));
        return;
      }
    }

    const activeTurnId = activeTurnIdOf(event);
    if (activeTurnId === undefined) return;

    const waiter = this.#waiters.get(event.aggregateId);
    if (activeTurnId !== null) {
      this.#active.set(event.aggregateId, activeTurnId);
      if (waiter) {
        waiter.seenRunning = true;
        waiter.resolveRunning(activeTurnId);
      }
      return;
    }

    this.#active.delete(event.aggregateId);
    // Null WITHOUT having seen running is the thread-creation event, not a
    // finished turn. Treating it as settled is the bug this latch exists for.
    if (waiter?.seenRunning) {
      this.#waiters.delete(event.aggregateId);
      waiter.resolveSettled();
    }
  }

  /**
   * Register interest in the next turn on `threadId`.
   *
   * Call BEFORE dispatching the turn. Returns the sequence the thread stood at,
   * so a caller can scope "what this turn produced" without guessing.
   */
  expectTurn(threadId: string): { readonly startSequence: number; readonly running: Promise<string>; readonly settled: Promise<void> } {
    // A second turn on the same thread displaces the first waiter, and the
    // promises it handed out would then never settle either way. Rejecting them
    // is the difference between a caller that learns and a caller that hangs.
    this.#waiters.get(threadId)?.abandon(new TurnDisplacedError(threadId));
    const startSequence = this.lastSequence(threadId);
    const waiter = makeWaiter(startSequence);
    this.#waiters.set(threadId, waiter);
    return { startSequence, running: waiter.running, settled: waiter.settled };
  }
}

export interface StartTurnOptions {
  readonly threadId: string;
  readonly text: string;
  readonly modelSelection?: unknown;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** Attachments, passed through untouched. */
  readonly attachments?: ReadonlyArray<unknown>;
  /**
   * The caller's identity for this turn, journalled with the intent and never sent.
   *
   * A caller that may retry needs to recognise its own pending intent after a restart.
   * The message text is not that: two identical messages to one agent are ordinary, and
   * matching on text let a stale intent answer for the current one.
   */
  readonly ref?: string;
}

export interface StartedTurn {
  readonly commandId: string;
  readonly messageId: string;
  readonly startSequence: number;
  readonly running: Promise<string>;
  readonly settled: Promise<void>;
}

/**
 * Start a turn, with the waiter registered before the command leaves.
 *
 * The role prompt is delivered here, as the first turn's `text` — that is what
 * replaces `buildRoleInjection` / `buildScriptRoleInjection`. There is no file to
 * write and no CLI flag to build, because there is no CLI.
 *
 * This function does not know which turn is the first, and does not need to:
 * `DriverThread` holds the role from `create` and composes it into the text of
 * whichever turn starts first (`#startTurnWithRole`). A caller reaching this
 * function directly is starting a turn that carries exactly what it passes.
 */
export async function startTurn(
  dispatcher: CommandDispatcher,
  journal: DispatchJournal,
  tracker: TurnTracker,
  options: StartTurnOptions,
): Promise<StartedTurn> {
  // Registered first, and the sequence captured inside it, so nothing the server
  // emits between here and the dispatch can be missed.
  const expectation = tracker.expectTurn(options.threadId);
  const messageId = newCommandId();

  const { commandId } = await dispatchCommand(
    dispatcher,
    journal,
    {
      type: 'thread.turn.start',
      threadId: options.threadId,
      message: { messageId, role: 'user', text: options.text, attachments: options.attachments ?? [] },
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
      runtimeMode: options.runtimeMode ?? 'full-access',
      interactionMode: options.interactionMode ?? 'default',
      createdAt: new Date().toISOString(),
    },
    // Journalled beside the intent, not added to the command: the wire payload is
    // t3code's schema and this is the caller's bookkeeping.
    options.ref === undefined ? {} : { ref: options.ref },
  );

  return { commandId, messageId, ...expectation };
}

/**
 * Interrupt the turn running on `threadId`.
 *
 * Journalled like every other command: an interrupt that was dispatched and lost
 * to a crash must be recoverable, and re-sending it under the same `commandId` is
 * how that stays safe.
 */
export async function interruptTurn(
  dispatcher: CommandDispatcher,
  journal: DispatchJournal,
  threadId: string,
  turnId?: string | null,
): Promise<string> {
  const { commandId } = await dispatchCommand(dispatcher, journal, {
    type: 'thread.turn.interrupt',
    threadId,
    ...(turnId === undefined ? {} : { turnId }),
    createdAt: new Date().toISOString(),
  });
  return commandId;
}

/** Assistant text emitted on `threadId` within `(after, through]`. */
export function assistantText(
  events: ReadonlyArray<ThreadEvent>,
  threadId: string,
  after: number,
  through: number = Number.POSITIVE_INFINITY,
): string {
  return events
    .filter(
      (event) =>
        event.aggregateId === threadId &&
        event.sequence > after &&
        event.sequence <= through &&
        event.type === 'thread.message-sent' &&
        (event.payload as { role?: unknown } | undefined)?.role === 'assistant',
    )
    .map((event) => String((event.payload as { text?: unknown }).text ?? ''))
    .join('');
}
