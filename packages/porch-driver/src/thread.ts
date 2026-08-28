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
  /** `--model`. Rejected at spawn for a harness with no model selector. */
  readonly model?: string;
  readonly instanceId?: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly threadId?: string;
  /** Written into the worktree for a human to read; the turn carries the prompt. */
  readonly roleContent?: string;
  readonly roleFilePath?: string;
  /** From `buildWorktreeGuardFiles(worktreePath)`. Absent means no guard, reported. */
  readonly guardFiles?: ReadonlyArray<WorktreeFile>;
  /** Cap on retained events. Default 5,000. */
  readonly retainEvents?: number;
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
export class DriverThread {
  #events: ThreadEvent[] = [];
  #droppedEvents = 0;

  private constructor(
    readonly threadId: string,
    readonly worktreePath: string,
    readonly branch: string,
    readonly mapping: HarnessMapping,
    readonly setup: WorktreeSetupPlan,
    private readonly deps: DriverThreadDeps,
    private readonly retainEvents: number,
  ) {}

  static async create(deps: DriverThreadDeps, options: CreateThreadOptions): Promise<DriverThread> {
    // Mapping first. A harness with no driver, or a model the harness cannot
    // honour, must fail here — before a thread exists to be left half-configured.
    const mapping = mapHarness(options.harnessName, {
      model: options.model,
      instanceId: options.instanceId,
    });

    const threadId = options.threadId ?? newCommandId();
    const setup = planWorktreeSetup(mapping.driverKind, {
      worktreePath: options.worktreePath,
      guardFiles: options.guardFiles,
      roleContent: options.roleContent,
      roleFilePath: options.roleFilePath,
    });
    applyWorktreeSetup(setup, options.worktreePath);

    await dispatchCommand(deps.dispatcher, deps.journal, {
      type: 'thread.create',
      threadId,
      projectId: options.projectId,
      title: options.title,
      ...(mapping.modelSelection === undefined ? {} : { modelSelection: mapping.modelSelection }),
      runtimeMode: options.runtimeMode ?? 'full-access',
      interactionMode: options.interactionMode ?? 'default',
      branch: options.branch,
      worktreePath: options.worktreePath,
      createdAt: new Date().toISOString(),
    });

    return new DriverThread(
      threadId,
      options.worktreePath,
      options.branch,
      mapping,
      setup,
      deps,
      options.retainEvents ?? 5_000,
    );
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
   * Idempotent: a redelivered event updates the same derived state and appends a
   * duplicate to the log, which `assistantText` tolerates because it filters by
   * sequence range. At-least-once delivery makes redelivery ordinary.
   */
  observe(value: unknown): void {
    this.deps.tracker.observe(value);
    const event = asThreadEvent(value);
    if (!event || event.aggregateId !== this.threadId) return;
    this.#events.push(event);
    if (this.#events.length > this.retainEvents) {
      this.#events.splice(0, this.#events.length - this.retainEvents);
      this.#droppedEvents += 1;
    }
  }

  /**
   * Run one turn and resolve when it settles.
   *
   * Settling is `activeTurnId` going null after it was non-null — never session
   * status, which reads `ready` for an interrupted turn as well as a finished one.
   */
  async runTurn(text: string, options: { readonly timeoutMs?: number } = {}): Promise<TurnOutcome> {
    const started = await startTurn(this.deps.dispatcher, this.deps.journal, this.deps.tracker, {
      threadId: this.threadId,
      text,
      ...(this.mapping.modelSelection === undefined ? {} : { modelSelection: this.mapping.modelSelection }),
    });

    const turnId = await this.#withTimeout(started.running, options.timeoutMs, 'the turn to start');
    await this.#withTimeout(started.settled, options.timeoutMs, 'the turn to settle');

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
    return await startTurn(this.deps.dispatcher, this.deps.journal, this.deps.tracker, {
      threadId: this.threadId,
      text,
      ...(this.mapping.modelSelection === undefined ? {} : { modelSelection: this.mapping.modelSelection }),
    });
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
