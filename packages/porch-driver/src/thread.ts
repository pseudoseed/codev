/**
 * Spec 146, Phase 3 — a porch thread on a t3code server.
 *
 * One thread is one builder: a worktree, a session, turns that settle, and phase
 * checks that run between them. Every operation here is a library call. There is
 * no PTY, no terminal, and nothing that types into a prompt.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT
 *
 * It owns the thread's identity, its worktree path, its event log, and the rule
 * that a check runs only between turns. It does NOT own the subscription: events
 * are fed in with `observe`, so one `ResumingSubscription` can drive several
 * threads and a test can drive one with an array. Ownership of the socket stays
 * where the reconnection logic is, which is `@cluesmith/t3-client`.
 *
 * THE EVENT LOG IS CAPPED, AND SAYS SO
 *
 * A gate can be held open for a day, so an unbounded log is a leak. It is capped
 * and the count of what fell off is kept, because a truncated log that reports
 * empty text reads exactly like a turn that said nothing.
 */

import { dispatchCommand, newCommandId, type CommandDispatcher, type DispatchJournal } from './commands.js';
import { runPhaseCheck, TurnActiveError, type PhaseCheckOptions, type PhaseCheckResult } from './checks.js';
import { mapHarness, type HarnessMapping, type T3DriverKind } from './harness-map.js';
import {
  applyWorktreeSetup,
  planWorktreeSetup,
  type WorktreeFile,
  type WorktreeSetupPlan,
} from './worktree-setup.js';
import {
  asThreadEvent,
  assistantText,
  interruptTurn,
  startTurn,
  TurnTracker,
  type ThreadEvent,
} from './turn.js';

export const CREATE_WORKTREE_METHOD = 'vcs.createWorktree';

export interface CreateWorktreeOptions {
  /** Repository the worktree is cut from. */
  readonly cwd: string;
  /** Ref to base it on. Default `HEAD`. */
  readonly refName?: string;
  /** Branch to create. */
  readonly newRefName: string;
  /** Explicit path, or null to let the server choose. */
  readonly path?: string | null;
}

export interface CreatedWorktree {
  readonly path: string;
  readonly refName: string;
}

/** Create a worktree through t3code and return where it landed. */
export async function createWorktree(
  dispatcher: CommandDispatcher,
  options: CreateWorktreeOptions,
): Promise<CreatedWorktree> {
  const result = (await dispatcher.call(CREATE_WORKTREE_METHOD, {
    cwd: options.cwd,
    refName: options.refName ?? 'HEAD',
    newRefName: options.newRefName,
    path: options.path ?? null,
  })) as { worktree?: { path?: unknown; refName?: unknown } };

  const worktree = result?.worktree;
  if (!worktree || typeof worktree.path !== 'string' || typeof worktree.refName !== 'string') {
    throw new Error(
      `${CREATE_WORKTREE_METHOD} returned no usable worktree: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }
  return { path: worktree.path, refName: worktree.refName };
}

export interface CreateProjectOptions {
  readonly projectId?: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection?: unknown;
}

/** Create the project a thread hangs off. Returns its id. */
export async function createProject(
  dispatcher: CommandDispatcher,
  journal: DispatchJournal,
  options: CreateProjectOptions,
): Promise<string> {
  const projectId = options.projectId ?? newCommandId();
  await dispatchCommand(dispatcher, journal, {
    type: 'project.create',
    projectId,
    title: options.title,
    workspaceRoot: options.workspaceRoot,
    ...(options.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: options.defaultModelSelection }),
    createdAt: new Date().toISOString(),
  });
  return projectId;
}

export interface CreateThreadOptions {
  readonly projectId: string;
  readonly title: string;
  /** Codev harness name — mapped to a driver kind here, not passed through. */
  readonly harnessName: string;
  /**
   * `--model`. Rejected at spawn for a harness with no model selector.
   *
   * Required in practice: `thread.create` lists `modelSelection` among its
   * REQUIRED fields in the vendored contract, so a thread cannot be created
   * without one. `defaultModel` covers the caller that has no `--model` to pass.
   */
  readonly model?: string;
  /** Used when `model` is absent. `thread.create` cannot omit `modelSelection`. */
  readonly defaultModel?: string;
  readonly instanceId?: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly threadId?: string;
  /**
   * The role prompt.
   *
   * Delivered as the FIRST turn's content — that is what replaces
   * `buildRoleInjection` / `buildScriptRoleInjection` — and also written into the
   * worktree for a human to read. Both, not either: the file is documentation,
   * the turn is what the agent actually receives.
   */
  readonly roleContent?: string;
  readonly roleFilePath?: string;
  /**
   * Called for each worktree file that could not be merged.
   *
   * `applyWorktreeSetup` leaves an unparseable JSON file alone rather than
   * destroying a user's config, and that decision is only defensible if someone
   * is told. Whether or not this is supplied, the messages are retained on
   * `setupWarnings`, so the skip is never silent in both places at once.
   */
  readonly onSetupWarning?: (message: string) => void;
  /** From `buildWorktreeGuardFiles(worktreePath)`. Absent means no guard, reported. */
  readonly guardFiles?: ReadonlyArray<WorktreeFile>;
  /** Cap on retained events. Default 5,000. */
  readonly retainEvents?: number;
}

/**
 * A thread was requested with no model.
 *
 * Separate from `ModelUnsupportedForDriverError`, which is "this harness cannot
 * take a model": this one is "the contract requires one and none was given".
 */
export class ModelSelectionRequiredError extends Error {
  constructor(readonly harnessName: string) {
    super(
      `A model is required to create a thread for the "${harnessName}" harness.\n` +
        `  t3code's thread.create lists modelSelection among its required fields, so ` +
        `there is no "let the server choose" here. Pass --model, or a defaultModel.`,
    );
    this.name = 'ModelSelectionRequiredError';
  }
}

export interface DriverThreadDeps {
  readonly dispatcher: CommandDispatcher;
  readonly journal: DispatchJournal;
  readonly tracker: TurnTracker;
}

export interface TurnOutcome {
  readonly commandId: string;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly turnId: string;
  readonly text: string;
  /** True when events were dropped from the log, so `text` may be incomplete. */
  readonly textTruncated: boolean;
}

/**
 * A thread, its worktree, and the operations porch performs on it.
 *
 * Created through `DriverThread.create`, which maps the harness, creates the
 * thread and lays down the worktree files in that order — the mapping first,
 * because an unmappable harness or an unsupported model must fail before a thread
 * exists.
 */
/**
 * The identity of a delivered event.
 *
 * `eventId` when the server sent one, the sequence otherwise. Prefixed so a
 * sequence key can never collide with an id that happens to be a number.
 */
function eventKey(event: ThreadEvent): string {
  return event.eventId === undefined ? `seq:${event.sequence}` : `id:${event.eventId}`;
}

/**
 * The first turn's text: the role prompt, then what the caller asked for.
 *
 * A blank caller text yields the role alone rather than a trailing separator —
 * a turn that opens with the role and nothing else is the ordinary spawn.
 */
function joinRoleAndText(role: string, text: string): string {
  return text.length === 0 ? role : `${role}\n\n${text}`;
}

export class DriverThread {
  #events: ThreadEvent[] = [];
  #droppedEvents = 0;
  /** Keys of the retained events, so a redelivered event is recognised as one. */
  #seenEventKeys = new Set<string>();
  /** The role prompt, until the first turn carries it. Null once delivered. */
  #pendingRole: string | null = null;

  private constructor(
    readonly threadId: string,
    readonly worktreePath: string,
    readonly branch: string,
    readonly mapping: HarnessMapping,
    readonly setup: WorktreeSetupPlan,
    /** Worktree files that could not be merged, in the order they were skipped. */
    readonly setupWarnings: ReadonlyArray<string>,
    private readonly deps: DriverThreadDeps,
    private readonly retainEvents: number,
  ) {}

  static async create(deps: DriverThreadDeps, options: CreateThreadOptions): Promise<DriverThread> {
    // Mapping first. A harness with no driver, or a model the harness cannot
    // honour, must fail here — before a thread exists to be left half-configured.
    const model = options.model ?? options.defaultModel;
    const mapping = mapHarness(options.harnessName, {
      model,
      instanceId: options.instanceId,
    });

    // `modelSelection` is REQUIRED on `thread.create` in the vendored contract, so
    // omitting it does not "let the server default" — it produces a payload the
    // server rejects, at a point where the caller has no way to read the refusal
    // as "you forgot the model". `mapHarness` may legitimately omit it (a
    // `thread.turn.start` does not require one), so the requirement is enforced
    // here, where it applies, and it fails before any command is dispatched.
    if (!mapping.modelSelection) {
      throw new ModelSelectionRequiredError(options.harnessName);
    }

    const threadId = options.threadId ?? newCommandId();
    const setup = planWorktreeSetup(mapping.driverKind, {
      worktreePath: options.worktreePath,
      guardFiles: options.guardFiles,
      roleContent: options.roleContent,
      roleFilePath: options.roleFilePath,
    });
    const setupWarnings: string[] = [];
    applyWorktreeSetup(setup, options.worktreePath, (message) => {
      setupWarnings.push(message);
      options.onSetupWarning?.(message);
    });

    await dispatchCommand(deps.dispatcher, deps.journal, {
      type: 'thread.create',
      threadId,
      projectId: options.projectId,
      title: options.title,
      modelSelection: mapping.modelSelection,
      runtimeMode: options.runtimeMode ?? 'full-access',
      interactionMode: options.interactionMode ?? 'default',
      branch: options.branch,
      worktreePath: options.worktreePath,
      createdAt: new Date().toISOString(),
    });

    const thread = new DriverThread(
      threadId,
      options.worktreePath,
      options.branch,
      mapping,
      setup,
      setupWarnings,
      deps,
      options.retainEvents ?? 5_000,
    );
    thread.#pendingRole = options.roleContent ?? null;
    return thread;
  }

  /** The driver kind this thread runs under. */
  get driverKind(): T3DriverKind {
    return this.mapping.driverKind;
  }

  /** Events retained for this thread, oldest first. */
  get events(): ReadonlyArray<ThreadEvent> {
    return this.#events;
  }

  /** How many events fell off the cap. Non-zero means `text` may be incomplete. */
  get droppedEvents(): number {
    return this.#droppedEvents;
  }

  /** True while a turn is running. */
  get isTurnActive(): boolean {
    return this.deps.tracker.activeThreads.has(this.threadId);
  }

  /** The highest sequence seen for this thread. */
  get lastSequence(): number {
    return this.deps.tracker.lastSequence(this.threadId);
  }

  /**
   * Feed one subscription value.
   *
   * Idempotent, by DISCARDING a redelivered event rather than by tolerating it.
   *
   * The earlier version appended the duplicate and claimed `assistantText` would
   * cope because it filters by sequence range — which it does not: a range filter
   * admits both copies of the same sequence, so a replay during a turn returned
   * the assistant's text twice and burned two slots of the retention cap for one
   * event. Redelivery is not an edge case here; the cursor advances after the
   * handler by design, so at-least-once delivery is the contract this class is
   * built on, and every replay crosses this line.
   *
   * The key is `eventId` when the server sent one and the sequence otherwise.
   * Both are unique per event; the sequence is the fallback because it is the
   * field `asThreadEvent` already requires.
   */
  observe(value: unknown): void {
    this.deps.tracker.observe(value);
    const event = asThreadEvent(value);
    if (!event || event.aggregateId !== this.threadId) return;
    const key = eventKey(event);
    if (this.#seenEventKeys.has(key)) return;
    this.#seenEventKeys.add(key);
    this.#events.push(event);
    if (this.#events.length > this.retainEvents) {
      const dropped = this.#events.length - this.retainEvents;
      for (const evicted of this.#events.slice(0, dropped)) this.#seenEventKeys.delete(eventKey(evicted));
      this.#events.splice(0, dropped);
      // Evicting the keys with the events keeps the set bounded by the same cap
      // rather than by the session's lifetime. The cost is that a redelivery of an
      // event already evicted would be appended again — harmless, because every
      // read is bounded by a turn's sequence range and an evicted event is by
      // definition older than the running turn's start.
      //
      // Counted as EVENTS dropped, not as times the cap was hit. Today those
      // agree, because `observe` takes one value at a time and the overflow is
      // therefore always one — there is no test that can tell the two apart, and
      // adding one that cannot fail would be worse than none. It is written this
      // way so it stays correct if a batching path ever arrives.
      this.#droppedEvents += dropped;
    }
  }

  /**
   * Run one turn and resolve when it settles.
   *
   * Settling is `activeTurnId` going null after it was non-null — never session
   * status, which reads `ready` for an interrupted turn as well as a finished one.
   */
  async runTurn(text: string, options: { readonly timeoutMs?: number } = {}): Promise<TurnOutcome> {
    // ONE budget for the whole call, and it starts HERE — before the dispatch.
    //
    // Two corrections, one round apart, both of the same kind. First: two
    // `#withTimeout` calls each holding the full budget meant `timeoutMs: 60_000`
    // could take 120 seconds. Then: the deadline was taken after the dispatch
    // returned, so a hung `thread.turn.start` sat outside the budget entirely and
    // `runTurn` could never return at all. A timeout the caller passes has to
    // bound the call the caller made, not the part of it after the network.
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const remaining = () => (deadline === undefined ? undefined : Math.max(deadline - Date.now(), 0));

    const started = await this.#withTimeout(this.#startTurnWithRole(text), remaining(), 'the turn to be dispatched');
    const turnId = await this.#withTimeout(started.running, remaining(), 'the turn to start');
    await this.#withTimeout(started.settled, remaining(), 'the turn to settle');

    const endSequence = this.lastSequence;
    return {
      commandId: started.commandId,
      startSequence: started.startSequence,
      endSequence,
      turnId,
      text: assistantText(this.#events, this.threadId, started.startSequence, endSequence),
      textTruncated: this.#droppedEvents > 0,
    };
  }

  /** Start a turn without waiting for it. The caller owns the returned promises. */
  async beginTurn(text: string) {
    return await this.#startTurnWithRole(text);
  }

  /** True until the role prompt has actually been carried by a turn. */
  get roleDelivered(): boolean {
    return this.#pendingRole === null;
  }

  /**
   * Start a turn, carrying the role prompt if this is the first one.
   *
   * The role is consumed only AFTER the start command is accepted. A turn that
   * failed to start may or may not have landed, and of the two ways to be wrong
   * — an agent that receives its role twice, or an agent that never receives it
   * — only the second leaves it working without instructions. So the role stays
   * pending until something confirms it went.
   */
  async #startTurnWithRole(text: string) {
    const role = this.#pendingRole;
    const started = await startTurn(this.deps.dispatcher, this.deps.journal, this.deps.tracker, {
      threadId: this.threadId,
      text: role === null ? text : joinRoleAndText(role, text),
      ...(this.mapping.modelSelection === undefined ? {} : { modelSelection: this.mapping.modelSelection }),
    });
    this.#pendingRole = null;
    return started;
  }

  /** Interrupt the running turn. Journalled like any other command. */
  async interrupt(turnId?: string | null): Promise<string> {
    return await interruptTurn(this.deps.dispatcher, this.deps.journal, this.threadId, turnId);
  }

  /**
   * Run a phase check in this thread's worktree, as a process porch owns.
   *
   * Refuses while a turn is active: a check against a tree an agent is still
   * writing measures something mid-edit and then reports it as the phase's
   * verdict.
   */
  async runCheck(
    command: string,
    options: Omit<PhaseCheckOptions, 'command' | 'cwd'> = {},
  ): Promise<PhaseCheckResult> {
    if (this.isTurnActive) throw new TurnActiveError(this.threadId);
    return await runPhaseCheck({ ...options, command, cwd: this.worktreePath });
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, what: string): Promise<T> {
    if (timeoutMs === undefined) return await promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for ${what} on thread ${this.threadId}. ` +
                    `This is "I stopped waiting", not "the turn finished" — the turn may still be running.`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
