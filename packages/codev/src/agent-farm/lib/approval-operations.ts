/**
 * Durable approval operations (Spec 236, phase 4 — spec 146 criterion 9b).
 *
 * ## Why an operation exists at all
 *
 * `handleGateApprove` sets `refuseIfChecksWouldRun: true`, so any ordinary
 * project whose phase declares checks is refused and the operator is sent back to
 * the CLI. The refusal is right: an HTTP request will not hold a connection open
 * for a repository's build and test suite.
 *
 * **A request timeout is not the fix, and this store is what replaces it.** A
 * client that gives up does not stop porch, so a timeout abandons a call that
 * goes on to approve the gate anyway — reporting one outcome while another
 * happened. Submit, poll, report. This is where the operation lives between the
 * submit and the report.
 *
 * ## Why a file rather than `global.db`
 *
 * The approval domain's other two stores — capabilities and nonces — are
 * file-backed, outside every workspace, under the agent-farm approval root, with
 * the same "exists but will not parse" discipline. An approval operation is
 * short-lived operational state in that same domain. Putting it in `global.db`
 * would mean a schema migration for a record whose natural retention is hours,
 * in the user-global store shared with every workspace's live agent state.
 *
 * ## Why an operation names its owner
 *
 * The store is keyed by `CODEV_AGENT_FARM_DIR`, **not by host**. A startup pass
 * that resolved every `running` record it found would let a second host starting
 * against a shared root mark a LIVE host's operations `interrupted` — reporting a
 * running approval as dead, which is the same class of wrong answer the whole
 * store exists to prevent. So each record names the host and pid that owns it,
 * and the pass touches only records this host owns whose process is gone.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readJsonOrThrow, withStoreLock, writeJsonAtomic } from './atomic-store.js';
import { defaultApprovalRoot } from './approval-capability.js';

/**
 * Outcome codes, declared where they are emitted so the failure-matrix collector
 * forces each to be classified.
 *
 * `APPROVAL_OPERATION_UNKNOWN` and `APPROVAL_OPERATION_STORE_UNREADABLE` are
 * separate for the reason every pair in this codebase is: "there is no such
 * operation" sends a caller to check the id it was given, and "the store cannot
 * be read" sends someone to look at the host. Spelling them the same way would
 * tell a client its approval never existed because a file was corrupt.
 */
export const APPROVAL_OPERATION_SIGNAL = {
  APPROVAL_OPERATION_SUBMITTED: 'APPROVAL_OPERATION_SUBMITTED',
  APPROVAL_OPERATION_UNKNOWN: 'APPROVAL_OPERATION_UNKNOWN',
  APPROVAL_OPERATION_STORE_UNREADABLE: 'APPROVAL_OPERATION_STORE_UNREADABLE',
  /**
   * A LOCK TIMEOUT, WHICH IS NOT A CORRUPT FILE.
   *
   * The first cut passed `APPROVAL_OPERATION_STORE_UNREADABLE` as the lock code,
   * so a 2s contention miss reported the store as unparseable. Two remedies —
   * "retry, it will work" and "go and look at that file" — spelled with one word,
   * in the store whose whole purpose is keeping such pairs apart. Every sibling
   * store has had its own `*_STORE_LOCKED` from the start; `atomic-store.ts` takes
   * the code as a parameter precisely so these stay different.
   */
  APPROVAL_OPERATION_STORE_LOCKED: 'APPROVAL_OPERATION_STORE_LOCKED',
  APPROVAL_OPERATION_INTERRUPTED: 'APPROVAL_OPERATION_INTERRUPTED',
  APPROVAL_ALREADY_IN_FLIGHT: 'APPROVAL_ALREADY_IN_FLIGHT',
  APPROVAL_CONCURRENCY_LIMIT: 'APPROVAL_CONCURRENCY_LIMIT',
} as const;

export type ApprovalOperationSignal =
  (typeof APPROVAL_OPERATION_SIGNAL)[keyof typeof APPROVAL_OPERATION_SIGNAL];

/**
 * Six states, and none of them may be merged.
 *
 * They send an operator to six different places, which is the whole test of
 * whether a distinction earns its keep:
 *
 * | State | What it means | Where it sends you |
 * |---|---|---|
 * | `submitted` | accepted, not started | wait |
 * | `running` | porch is executing, with the phase and checks named | wait, and know what for |
 * | `succeeded` | the gate is approved | nothing to do |
 * | `refused` | porch declined; a precondition is unmet | fix the precondition |
 * | `failed` | something threw | read the reason |
 * | `interrupted` | this host stopped while it ran | read what `status.yaml` says NOW |
 *
 * `refused` is deliberately not `failed`: a refusal is porch working correctly
 * and saying no. Collapsing them would send an operator to debug a host when the
 * answer is that their checks did not pass.
 */
export type ApprovalOperationState =
  | 'submitted'
  | 'running'
  | 'succeeded'
  | 'refused'
  | 'failed'
  | 'interrupted';

/**
 * Which process owns an operation, so a second host cannot resolve it.
 *
 * `runId` IS NOT REDUNDANT WITH `pid`, and the case it exists for is the one that
 * would otherwise never heal: a Tower crashes, and the restarted Tower is given
 * **the same pid** by the OS. A pass keyed on pid alone then asks "is 4242
 * alive?", gets `true` — because it is 4242 — and leaves the dead run's record
 * `running` forever, which is the exact state this pass exists to make
 * unreachable. `runId` is minted once per process, so "my pid, not my run" is
 * decidable and means the previous holder is definitively gone.
 */
export interface OperationOwner {
  readonly host: string;
  readonly pid: number;
  /** Absent on records written before run ids existed; treated as unknown, never as mine. */
  readonly runId?: string;
}

/**
 * This process's identity, minted once.
 *
 * Module-scoped rather than per-store so two stores in one process agree about
 * whose operations are whose — the alternative would have a Tower resolving its
 * own live work through a second store instance.
 */
const PROCESS_RUN_ID = randomUUID();

export interface ApprovalOperation {
  readonly operationId: string;
  readonly workspacePath: string;
  readonly projectId: string;
  readonly gateName: string;
  /** The human session that submitted it. Never the capability's secret. */
  readonly sessionId: string;
  readonly owner: OperationOwner;
  readonly submittedAt: string;
  state: ApprovalOperationState;
  startedAt?: string;
  settledAt?: string;
  /**
   * What is being run, present while `running`.
   *
   * An operator waiting on a build deserves to know WHICH build. "Running" with
   * nothing beside it is a spinner, and a spinner is what a status word becomes
   * when it carries no content.
   */
  phase?: string;
  checks?: readonly string[];
  /** On `refused`: porch's own code. On `failed`: nothing — see `message`. */
  code?: string;
  /** The reason, in the words of whatever produced it. */
  message?: string;
  /**
   * What porch PERSISTED, on `succeeded`. Never a value built by the reporter.
   *
   * The route this replaces used to answer with the requesting session id, this
   * host's machine name and `new Date()`, which falsified the record it was
   * reporting: `approve` returns normally when the gate was ALREADY approved, so
   * a stale request claimed that this session approved a gate somebody else had.
   */
  record?: {
    readonly machine?: string;
    readonly sessionId?: string | null;
    readonly approvedAt?: string | null;
    readonly authority?: string;
    readonly outcome?: 'approved' | 'already-approved';
  };
  /**
   * On `interrupted`: what `status.yaml` says about the gate NOW.
   *
   * An interruption is not evidence the gate is unapproved. The work may have
   * completed and the host died afterwards, so the file is read and the answer
   * says what it found — including "approved", which must never be reported as a
   * failure.
   */
  gateAfterInterruption?: 'approved' | 'pending' | 'unreadable';
}

/** How long a settled operation is kept before it is swept. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

export class ApprovalOperationStoreUnreadable extends Error {
  constructor(readonly storePath: string, cause: unknown) {
    super(`APPROVAL_OPERATION_STORE_UNREADABLE: ${storePath} exists but could not be parsed (${String(cause)})`);
    this.name = 'ApprovalOperationStoreUnreadable';
  }
}

const TERMINAL: ReadonlySet<ApprovalOperationState> = new Set([
  'succeeded', 'refused', 'failed', 'interrupted',
]);

export function isTerminal(state: ApprovalOperationState): boolean {
  return TERMINAL.has(state);
}

export interface ApprovalOperationStoreOptions {
  readonly root?: string;
  readonly now?: () => number;
  readonly retentionMs?: number;
  /** Injected for tests; production reads this process's identity. */
  readonly owner?: OperationOwner;
  /** Injected for tests; production asks the OS whether a pid is alive. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Is this pid still running?
 *
 * `kill(pid, 0)` signals nothing and throws only when the process is gone or
 * unreachable. `EPERM` means it EXISTS and belongs to someone else — which on a
 * shared root is a live owner, so it must read as alive. Treating EPERM as dead
 * would resolve another user's running operation.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * File-backed, beside the capability and nonce stores.
 *
 * Every mutation runs read → decide → write inside the store lock, because two
 * Tower processes against one root is the case the owner field exists for and a
 * read-modify-write without a lock loses one of their writes.
 */
export class ApprovalOperationStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #owner: OperationOwner;
  readonly #isAlive: (pid: number) => boolean;

  constructor(options: ApprovalOperationStoreOptions = {}) {
    this.#path = join(options.root ?? defaultApprovalRoot(), 'approval-operations.json');
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#owner = options.owner ?? { host: hostname(), pid: process.pid, runId: PROCESS_RUN_ID };
    this.#isAlive = options.isAlive ?? defaultIsAlive;
  }

  get path(): string {
    return this.#path;
  }

  get owner(): OperationOwner {
    return this.#owner;
  }

  #read(): ApprovalOperation[] {
    const file = readJsonOrThrow<{ version?: number; operations?: ApprovalOperation[] }>(
      this.#path,
      {},
      (storePath, cause) => new ApprovalOperationStoreUnreadable(storePath, cause),
    );
    return Array.isArray(file.operations) ? file.operations : [];
  }

  #write(operations: ApprovalOperation[]): void {
    writeJsonAtomic(this.#path, { version: 1, operations });
  }

  /** Drop settled operations past the retention window. */
  #sweep(operations: ApprovalOperation[]): ApprovalOperation[] {
    const cutoff = this.#now() - this.#retentionMs;
    return operations.filter((operation) => {
      if (!isTerminal(operation.state)) return true;
      const settled = Date.parse(operation.settledAt ?? operation.submittedAt);
      // A TIMESTAMP THAT WILL NOT PARSE IS KEPT, deliberately. It says nothing
      // about how old the record is, and dropping it would let an unreadable
      // field delete an operator's only account of an approval — "I could not
      // tell" acted on as "it is old enough to discard".
      return Number.isNaN(settled) || settled > cutoff;
    });
  }

  /**
   * Record a submitted approval, or refuse because one is already in flight.
   *
   * SINGLE-FLIGHT PER (WORKSPACE, PROJECT), refused at submit time with the
   * operation id already running so the caller polls that one instead of
   * starting a second identical build. Not a queue: a queue turns "I will not
   * start this" into "this is running", which is the conflation the whole spec is
   * organised against.
   *
   * The workspace-wide cap is small on purpose. Each running operation is a full
   * repository build and test suite inside the process that is also serving every
   * other workspace.
   */
  submit(input: {
    readonly workspacePath: string;
    readonly projectId: string;
    readonly gateName: string;
    readonly sessionId: string;
    readonly maxConcurrent?: number;
  }): { readonly accepted: true; readonly operation: ApprovalOperation }
    | { readonly accepted: false; readonly code: ApprovalOperationSignal; readonly message: string } {
    const maxConcurrent = input.maxConcurrent ?? 2;
    return withStoreLock(this.#path, APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_STORE_LOCKED, () => {
      const operations = this.#sweep(this.#read());
      const live = operations.filter((operation) => !isTerminal(operation.state));

      const inFlight = live.find((operation) =>
        operation.workspacePath === input.workspacePath && operation.projectId === input.projectId);
      if (inFlight) {
        return {
          accepted: false as const,
          code: APPROVAL_OPERATION_SIGNAL.APPROVAL_ALREADY_IN_FLIGHT,
          message:
            `an approval for project ${input.projectId} is already running as operation `
            + `${inFlight.operationId} (gate ${inFlight.gateName}). Poll that one rather than `
            + 'submitting a second run of the same checks.',
        };
      }

      const here = live.filter((operation) => operation.workspacePath === input.workspacePath);
      if (here.length >= maxConcurrent) {
        return {
          accepted: false as const,
          code: APPROVAL_OPERATION_SIGNAL.APPROVAL_CONCURRENCY_LIMIT,
          message:
            `${here.length} approval(s) are already running for this workspace, which is the `
            + `limit. Each one runs the repository's checks inside this host, so they are bounded `
            + 'rather than queued — wait for one to settle and submit again.',
        };
      }

      const operation: ApprovalOperation = {
        operationId: randomUUID(),
        workspacePath: input.workspacePath,
        projectId: input.projectId,
        gateName: input.gateName,
        sessionId: input.sessionId,
        owner: this.#owner,
        submittedAt: new Date(this.#now()).toISOString(),
        state: 'submitted',
      };
      this.#write([...operations, operation]);
      return { accepted: true as const, operation };
    });
  }

  /** Mark an operation running, naming the phase and the checks it will run. */
  markRunning(operationId: string, what: { phase?: string; checks?: readonly string[] } = {}): void {
    this.#update(operationId, (operation) => {
      operation.state = 'running';
      operation.startedAt = new Date(this.#now()).toISOString();
      if (what.phase !== undefined) operation.phase = what.phase;
      if (what.checks !== undefined) operation.checks = what.checks;
    });
  }

  /** Settle an operation. Every field here comes from what actually happened. */
  settle(
    operationId: string,
    outcome:
      | { readonly state: 'succeeded'; readonly record: ApprovalOperation['record'] }
      | { readonly state: 'refused'; readonly code: string; readonly message: string }
      | { readonly state: 'failed'; readonly message: string },
  ): void {
    this.#update(operationId, (operation) => {
      operation.state = outcome.state;
      operation.settledAt = new Date(this.#now()).toISOString();
      if (outcome.state === 'succeeded') operation.record = outcome.record;
      else operation.message = outcome.message;
      if (outcome.state === 'refused') operation.code = outcome.code;
    });
  }

  #update(operationId: string, mutate: (operation: ApprovalOperation) => void): void {
    withStoreLock(this.#path, APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_STORE_LOCKED, () => {
      const operations = this.#read();
      const operation = operations.find((candidate) => candidate.operationId === operationId);
      // A caller settling an operation that is not there is a bug in the caller,
      // not a state to record. Saying so beats writing a second record that looks
      // like an operation nobody submitted.
      if (!operation) {
        throw new Error(
          `${APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_UNKNOWN}: no operation ${operationId} in this store`,
        );
      }
      // A TERMINAL RECORD IS FINAL. Overwriting one would let a late callback
      // from an abandoned run rewrite the outcome an operator has already been
      // shown — reporting a second answer for a question already answered.
      if (isTerminal(operation.state)) {
        throw new Error(
          `${APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_UNKNOWN}: operation ${operationId} `
          + `already settled as ${operation.state}; it cannot be changed`,
        );
      }
      mutate(operation);
      this.#write(operations);
    });
  }

  /**
   * Is the process that owned this operation definitively gone?
   *
   * Four cases, and the third is the one a pid check alone gets wrong:
   *
   * 1. **Another host.** Not ours to judge — its pids mean nothing here.
   * 2. **Our own run.** Live by definition: it is executing in this process right
   *    now, and resolving it would interrupt work in flight. `isAlive` is
   *    deliberately not consulted, because asking whether we are alive is silly
   *    and answering "no" would be catastrophic.
   * 3. **Our pid, a different run.** The previous holder of this pid is gone —
   *    we have that pid now. Without `runId` this asked "is my pid alive?",
   *    answered `true`, and left a crashed Tower's record `running` forever on
   *    every restart that happened to reuse the pid.
   * 4. **Some other pid on this host.** Ask the OS.
   */
  #ownerIsGone(owner: OperationOwner): boolean {
    if (owner.host !== this.#owner.host) return false;
    if (owner.runId !== undefined && owner.runId === this.#owner.runId) return false;
    if (owner.pid === this.#owner.pid) {
      // Same pid, and not this run. A record with no `runId` predates the field,
      // so "is it mine?" is unanswerable — and treating an unknown as MINE would
      // strand it, while treating it as gone at worst re-reports a gate this host
      // is about to report anyway.
      return owner.runId !== this.#owner.runId;
    }
    return !this.#isAlive(owner.pid);
  }

  /** One operation, or null when this store has never held it. */
  describe(operationId: string): ApprovalOperation | null {
    return this.#read().find((operation) => operation.operationId === operationId) ?? null;
  }

  /** Every operation, newest first. For an operator and for tests. */
  records(): ApprovalOperation[] {
    return [...this.#read()].reverse();
  }

  /**
   * Resolve operations this host owns whose process is gone.
   *
   * RUN BEFORE THE SURFACE CAN ANSWER A POLL, so "running forever" is
   * unreachable rather than unlikely: a record left `running` by a killed Tower
   * would otherwise be reported as in progress for the rest of the store's life.
   *
   * SCOPED TO THIS HOST'S DEAD PROCESSES. The store is keyed by
   * `CODEV_AGENT_FARM_DIR`, not by host, so an unscoped pass would let a second
   * host mark a live host's work interrupted — a running approval reported as
   * dead, which is the failure this store exists to prevent, committed by its own
   * recovery.
   *
   * `readGate` is injected rather than imported so this module stays free of the
   * status reader: what it returns is what `status.yaml` says NOW, and an
   * `approved` answer must be reported as approved rather than as a failure.
   */
  resolveInterrupted(
    readGate: (operation: ApprovalOperation) => 'approved' | 'pending' | 'unreadable',
  ): ApprovalOperation[] {
    return withStoreLock(this.#path, APPROVAL_OPERATION_SIGNAL.APPROVAL_OPERATION_STORE_LOCKED, () => {
      const operations = this.#sweep(this.#read());
      const resolved: ApprovalOperation[] = [];
      for (const operation of operations) {
        if (isTerminal(operation.state)) continue;
        if (!this.#ownerIsGone(operation.owner)) continue;

        operation.state = 'interrupted';
        operation.settledAt = new Date(this.#now()).toISOString();
        operation.gateAfterInterruption = readGate(operation);
        operation.message = interruptionMessage(operation);
        resolved.push(operation);
      }
      if (resolved.length > 0) this.#write(operations);
      return resolved;
    });
  }
}

/**
 * What an interrupted operation tells the operator.
 *
 * THE APPROVED CASE IS THE ONE THAT MATTERS. A host that died after porch wrote
 * the gate leaves a `running` record and an approved gate, and reporting that as
 * a failure would send an operator to approve something already approved — the
 * "reported one outcome while another happened" defect, arriving through the
 * recovery path instead of the request path.
 */
function interruptionMessage(operation: ApprovalOperation): string {
  const prefix = `this host stopped while approval ${operation.operationId} was running`;
  switch (operation.gateAfterInterruption) {
    case 'approved':
      return `${prefix}, and status.yaml now shows ${operation.gateName} APPROVED. `
        + 'The work completed; nothing needs redoing.';
    case 'pending':
      return `${prefix}, and status.yaml still shows ${operation.gateName} pending. `
        + 'Nothing was approved — submit again when you are ready.';
    default:
      return `${prefix}, and status.yaml could not be read, so whether ${operation.gateName} `
        + 'was approved is unknown. Check the file before resubmitting; this is not evidence '
        + 'that the gate is unapproved.';
  }
}
