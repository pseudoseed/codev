/**
 * Approval capabilities for gate approval (Spec 146 Phase 6).
 *
 * WHAT THIS IS FOR, stated before the mechanism, because two earlier revisions of
 * this design were falsified by claiming more than the code did:
 *
 * `porch approve` used to enforce exactly one thing — that the string
 * `--a-human-explicitly-approved-this` appeared in argv. A builder has a shell in
 * its own worktree, so it could type that string. The flag was never a control.
 *
 * What a capability adds is not a wall. It is that an approval now carries
 * evidence of WHICH credential and WHICH human session performed it, and that a
 * caller this process can attribute to an agent session cannot produce that
 * evidence. `codev/resources/146-approval-threat-model.md` states the residual
 * paths this does not close.
 *
 * Two properties are load-bearing and are the reason for the shapes below:
 *
 * 1. **The host stores a verifier, never a replayable credential.** Builders run
 *    as the same user as the host process, so anything presentable that sits on
 *    disk is presentable BY THEM. Only a SHA-256 of the secret is persisted.
 * 2. **The nonce distinguishes "replayed" from "never seen".** A consumed nonce
 *    leaves a tombstone until its TTL passes, so a replay reports
 *    APPROVAL_NONCE_REPLAYED and an unknown nonce reports APPROVAL_NONCE_UNKNOWN.
 *    Spelling those the same way would be spelling "I could not tell" as "no".
 *
 * Dependencies are node builtins only: this module is imported by `porch`, whose
 * command path must not pull in the database or server layers.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Outcome codes. These live here rather than in `servers/agent-failure.ts` so the
 * module that emits them also declares them, and the failure-matrix collector in
 * `servers/__tests__/agent-failure-matrix.test.ts` scans this file for exactly
 * that reason — a code added here has to be classified there.
 *
 * CAPABILITY_REVOKED is a failure-matrix row (it is operator-facing: an approval
 * that used to work has stopped, and the operator needs to know it was revoked
 * rather than expired). The rest are request-level outcomes.
 */
export const APPROVAL_SIGNAL = {
  APPROVAL_AUTHORIZED: 'APPROVAL_AUTHORIZED',
  APPROVAL_CAPABILITY_REQUIRED: 'APPROVAL_CAPABILITY_REQUIRED',
  APPROVAL_CAPABILITY_MALFORMED: 'APPROVAL_CAPABILITY_MALFORMED',
  APPROVAL_CAPABILITY_UNKNOWN: 'APPROVAL_CAPABILITY_UNKNOWN',
  APPROVAL_CAPABILITY_INVALID: 'APPROVAL_CAPABILITY_INVALID',
  APPROVAL_CAPABILITY_EXPIRED: 'APPROVAL_CAPABILITY_EXPIRED',
  APPROVAL_CAPABILITY_FOREIGN_MACHINE: 'APPROVAL_CAPABILITY_FOREIGN_MACHINE',
  CAPABILITY_REVOKED: 'CAPABILITY_REVOKED',
  APPROVAL_NONCE_MISSING: 'APPROVAL_NONCE_MISSING',
  APPROVAL_NONCE_UNKNOWN: 'APPROVAL_NONCE_UNKNOWN',
  APPROVAL_NONCE_REPLAYED: 'APPROVAL_NONCE_REPLAYED',
  APPROVAL_NONCE_EXPIRED: 'APPROVAL_NONCE_EXPIRED',
  APPROVAL_NONCE_SCOPE_MISMATCH: 'APPROVAL_NONCE_SCOPE_MISMATCH',
  APPROVAL_NONCE_CAPABILITY_MISMATCH: 'APPROVAL_NONCE_CAPABILITY_MISMATCH',
  APPROVAL_ISSUANCE_REFUSED_AGENT: 'APPROVAL_ISSUANCE_REFUSED_AGENT',
  APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION: 'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION',
} as const;

export type ApprovalSignal = (typeof APPROVAL_SIGNAL)[keyof typeof APPROVAL_SIGNAL];

/** Presentations are `<capabilityId>.<secret>`; the separator is never in either half. */
const PRESENTATION_SEPARATOR = '.';
const DEFAULT_CAPABILITY_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_CAPABILITY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

/** Env var a human's own shell carries; deliberately absent from builder launch scripts. */
export const CAPABILITY_ENV_VAR = 'CODEV_APPROVAL_CAPABILITY';
export const NONCE_ENV_VAR = 'CODEV_APPROVAL_NONCE';

/**
 * On-disk record. Note what is NOT here: the secret. A builder that reads this
 * file learns a capability id, a machine and an expiry, none of which it can
 * present. That is the whole point of the split.
 */
export interface StoredCapability {
  readonly id: string;
  readonly machine: string;
  /** The human-paired session that requested issuance. */
  readonly sessionId: string;
  /** Hex SHA-256 of the secret. */
  readonly verifier: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  revokedAt?: string;
}

export interface IssuedCapability {
  readonly capabilityId: string;
  readonly sessionId: string;
  readonly machine: string;
  /** Returned exactly once. Never persisted by this module in any form. */
  readonly presentation: string;
  readonly expiresAt: string;
}

export interface CapabilityVerification {
  readonly authorized: boolean;
  readonly code: ApprovalSignal;
  readonly message: string;
  readonly capabilityId?: string;
  readonly sessionId?: string;
  readonly machine?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time over equal-length digests; length differences are decided first. */
function digestsMatch(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function defaultApprovalRoot(): string {
  return join(homedir(), '.agent-farm', 'approval');
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The temp name carries the pid and a random suffix. A FIXED `${path}.tmp`
  // is a collision between two concurrent writers, and the rename would then
  // publish whichever half-written file won.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** How long to keep trying for the lock before giving up. */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

/**
 * Run a read-modify-write under an exclusive lock.
 *
 * Single-use MEANS single-use, and read-modify-write without a lock does not
 * deliver it: two concurrent `porch approve` processes could each read the same
 * unconsumed nonce and both succeed, and a concurrent issue could drop a
 * revocation tombstone. `wx` is the atomic primitive — the create fails if the
 * lock exists — so this does not depend on a check-then-act.
 */
function withLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock left behind by a killed process must not wedge approvals
      // forever. Anything older than the stale window is reclaimed.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* the holder released it between the two calls; retry */ }
      if (Date.now() >= deadline) {
        throw new Error(`APPROVAL_STORE_LOCKED: could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
      }
      // Busy-wait: these critical sections are two file operations long.
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Capability store. File-backed rather than in-memory because the two callers are
 * separate processes: `codev-agent` issues, and the `porch` CLI verifies.
 *
 * Per-machine records are the unit of revocation: `revokeMachine` marks one
 * machine's capabilities revoked and leaves every other machine's untouched.
 */
export class ApprovalCapabilityStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #machine: string;

  constructor(options: { root?: string; now?: () => number; machine?: string } = {}) {
    this.#path = join(options.root ?? defaultApprovalRoot(), 'capabilities.json');
    this.#now = options.now ?? Date.now;
    this.#machine = options.machine ?? hostname();
  }

  get machine(): string {
    return this.#machine;
  }

  get path(): string {
    return this.#path;
  }

  #read(): StoredCapability[] {
    const file = readJsonFile<{ version?: number; capabilities?: StoredCapability[] }>(this.#path, {});
    return Array.isArray(file.capabilities) ? file.capabilities : [];
  }

  #write(capabilities: StoredCapability[]): void {
    writeJsonFile(this.#path, { version: 1, capabilities });
  }

  issue(options: { sessionId: string; lifetimeMs?: number; machine?: string }): IssuedCapability {
    const requested = options.lifetimeMs ?? DEFAULT_CAPABILITY_LIFETIME_MS;
    const lifetime = Math.min(Math.max(requested, 1), MAX_CAPABILITY_LIFETIME_MS);
    const now = this.#now();
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const record: StoredCapability = {
      id,
      machine: options.machine ?? this.#machine,
      sessionId: options.sessionId,
      verifier: sha256Hex(secret),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lifetime).toISOString(),
    };
    withLock(this.#path, () => this.#write([...this.#read(), record]));
    return {
      capabilityId: id,
      sessionId: record.sessionId,
      machine: record.machine,
      presentation: `${id}${PRESENTATION_SEPARATOR}${secret}`,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Verify a presentation. The order of the checks is deliberate: an expired or
   * revoked capability reports that, rather than being flattened into "invalid",
   * because those three send an operator to three different places.
   */
  verify(presentation: string | undefined, options: { machine?: string } = {}): CapabilityVerification {
    if (presentation === undefined || presentation.length === 0) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_REQUIRED,
        message: 'no approval capability was presented',
      };
    }
    const separator = presentation.indexOf(PRESENTATION_SEPARATOR);
    if (separator <= 0 || separator === presentation.length - 1) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_MALFORMED,
        message: 'approval capability is not in <capability-id>.<secret> form',
      };
    }
    const capabilityId = presentation.slice(0, separator);
    const secret = presentation.slice(separator + 1);
    const record = this.#read().find((entry) => entry.id === capabilityId);
    if (!record) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN,
        message: `no capability ${capabilityId} is stored on this host`,
      };
    }
    if (record.revokedAt) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.CAPABILITY_REVOKED,
        message: `capability ${capabilityId} was revoked at ${record.revokedAt}`,
        capabilityId,
        machine: record.machine,
      };
    }
    const machine = options.machine ?? this.#machine;
    if (record.machine !== machine) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_FOREIGN_MACHINE,
        message: `capability ${capabilityId} was issued for ${record.machine}, not ${machine}`,
        capabilityId,
        machine: record.machine,
      };
    }
    // `Date.parse` returns NaN on a corrupted record, and `now >= NaN` is false —
    // which would skip the expiry branch and fall through to the secret
    // comparison, treating an unreadable expiry as "not expired". An expiry that
    // cannot be read is not an expiry that has not passed.
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt) || this.#now() >= expiresAt) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_EXPIRED,
        message: Number.isFinite(expiresAt)
          ? `capability ${capabilityId} expired at ${record.expiresAt}`
          : `capability ${capabilityId} carries an unreadable expiry (${record.expiresAt})`,
        capabilityId,
        machine: record.machine,
      };
    }
    if (!digestsMatch(sha256Hex(secret), record.verifier)) {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_INVALID,
        message: `capability ${capabilityId} was presented with the wrong secret`,
        capabilityId,
      };
    }
    return {
      authorized: true,
      code: APPROVAL_SIGNAL.APPROVAL_AUTHORIZED,
      message: 'capability verified',
      capabilityId,
      sessionId: record.sessionId,
      machine: record.machine,
    };
  }

  /** Revoke one capability. Returns false when there was nothing to revoke. */
  revoke(capabilityId: string): boolean {
    return withLock(this.#path, () => {
      const capabilities = this.#read();
      const target = capabilities.find((entry) => entry.id === capabilityId && !entry.revokedAt);
      if (!target) return false;
      target.revokedAt = new Date(this.#now()).toISOString();
      this.#write(capabilities);
      return true;
    });
  }

  /**
   * Revoke every live capability issued for one machine. Other machines are not
   * read out of the returned count and not touched on disk — that isolation is
   * the property `revoking one machine leaves another working` depends on.
   */
  revokeMachine(machine: string): number {
    return withLock(this.#path, () => {
      const capabilities = this.#read();
      const revokedAt = new Date(this.#now()).toISOString();
      let revoked = 0;
      for (const entry of capabilities) {
        if (entry.machine === machine && !entry.revokedAt) {
          entry.revokedAt = revokedAt;
          revoked += 1;
        }
      }
      if (revoked > 0) this.#write(capabilities);
      return revoked;
    });
  }

  /** Raw file bytes, for tests that assert no secret was persisted. */
  rawContents(): string {
    return existsSync(this.#path) ? readFileSync(this.#path, 'utf8') : '';
  }
}

interface StoredNonce {
  readonly nonce: string;
  readonly projectId: string;
  readonly gateName: string;
  readonly capabilityId: string;
  readonly createdAt: number;
  consumedAt?: number;
}

export interface NonceConsumption {
  readonly accepted: boolean;
  readonly code: ApprovalSignal;
  readonly message: string;
}

/**
 * Approval nonces, bound to (project id, gate name) and single-use.
 *
 * DELIBERATELY NOT `lib/nonce-store.ts`. That store is the OAuth tunnel
 * registration store; sharing it would let a tunnel nonce authorize a gate and a
 * gate nonce complete a registration. The separation is asserted by a test rather
 * than left as a comment.
 */
export class ApprovalNonceStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.#path = join(options.root ?? defaultApprovalRoot(), 'approval-nonces.json');
    this.#now = options.now ?? Date.now;
  }

  #read(): StoredNonce[] {
    const file = readJsonFile<{ version?: number; nonces?: StoredNonce[] }>(this.#path, {});
    const nonces = Array.isArray(file.nonces) ? file.nonces : [];
    // Sweep entries whose TTL has passed, tombstones included: past the TTL a
    // replay is indistinguishable from a fresh unknown nonce, and claiming
    // otherwise would be inventing a distinction the data no longer supports.
    const cutoff = this.#now() - NONCE_TTL_MS;
    return nonces.filter((entry) => entry.createdAt > cutoff);
  }

  #write(nonces: StoredNonce[]): void {
    writeJsonFile(this.#path, { version: 1, nonces });
  }

  mint(options: { projectId: string; gateName: string; capabilityId: string }): string {
    const nonce = randomUUID();
    withLock(this.#path, () => this.#write([
      ...this.#read(),
      {
        nonce,
        projectId: options.projectId,
        gateName: options.gateName,
        capabilityId: options.capabilityId,
        createdAt: this.#now(),
      },
    ]));
    return nonce;
  }

  consume(
    nonce: string | undefined,
    scope: { projectId: string; gateName: string; capabilityId: string },
  ): NonceConsumption {
    if (nonce === undefined || nonce.length === 0) {
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_MISSING,
        message: 'no approval nonce was presented',
      };
    }
    // The whole read → decide → write sequence is inside the lock. Deciding
    // outside it and writing inside would let two processes both observe the
    // same unconsumed nonce, which is precisely the single-use guarantee.
    return withLock(this.#path, () => this.#consumeLocked(nonce, scope));
  }

  #consumeLocked(
    nonce: string,
    scope: { projectId: string; gateName: string; capabilityId: string },
  ): NonceConsumption {
    const nonces = this.#read();
    const entry = nonces.find((candidate) => candidate.nonce === nonce);
    if (!entry) {
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_UNKNOWN,
        message: 'approval nonce is unknown to this host, or older than its lifetime',
      };
    }
    if (entry.consumedAt !== undefined) {
      // The tombstone is why this is not APPROVAL_NONCE_UNKNOWN. A replay and a
      // nonce that never existed are different events and get different names.
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_REPLAYED,
        message: `approval nonce was already used at ${new Date(entry.consumedAt).toISOString()}`,
      };
    }
    if (this.#now() - entry.createdAt >= NONCE_TTL_MS) {
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_EXPIRED,
        message: 'approval nonce has expired',
      };
    }
    if (entry.projectId !== scope.projectId || entry.gateName !== scope.gateName) {
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_SCOPE_MISMATCH,
        message: `approval nonce is bound to ${entry.projectId}/${entry.gateName}, not ${scope.projectId}/${scope.gateName}`,
      };
    }
    // The capability binding was STORED and never checked, which made it a claim
    // rather than a constraint: a nonce minted for capability A would authorize
    // an approval presented with capability B. A stored field nothing enforces
    // is the defect this phase is meant to be watching for.
    if (entry.capabilityId !== scope.capabilityId) {
      return {
        accepted: false,
        code: APPROVAL_SIGNAL.APPROVAL_NONCE_CAPABILITY_MISMATCH,
        message: `approval nonce was minted for capability ${entry.capabilityId}, not ${scope.capabilityId}`,
      };
    }
    entry.consumedAt = this.#now();
    this.#write(nonces);
    return {
      accepted: true,
      code: APPROVAL_SIGNAL.APPROVAL_AUTHORIZED,
      message: 'approval nonce consumed',
    };
  }
}

/**
 * WHO IS ASKING — and what this actually reads.
 *
 * Every signal below is something the calling process could remove from itself,
 * and none of them is more reliable than the process that carries it.
 *
 * - `CODEV_WORKTREE_ROOT` / `CODEV_BUILDER_ID` are written into the env block by
 *   `startBuilderSession` (`commands/spawn-worktree.ts`). **They are not present
 *   in every live builder**: this was checked against a real `.builder-start.sh`
 *   on 2026-08-29 and that one, spawned by the globally installed package rather
 *   than this tree, carried no `export` lines at all. So the env rule is a bonus,
 *   not the mechanism.
 * - The cwd rule is the one that fires in practice, and `cd` defeats it.
 * - `CODEV_ARCHITECT_NAME` is set in an architect terminal — **and inherited by
 *   everything an architect spawns**, this builder's own shell included. So it
 *   attributes "an architect session or a descendant of one", never "an
 *   architect". It is checked last for that reason: builder evidence wins.
 *
 * This is attribution, not authentication. The threat model records it in those
 * words, and an architect session is attributed but still ALLOWED — refusing it
 * would leave no working approval path until the client exists.
 */
export type ApprovalCallerKind = 'builder-session' | 'architect-session' | 'unattributed';

export interface ApprovalCallerAttribution {
  readonly kind: ApprovalCallerKind;
  /** What was read, not what was assumed. Recorded in status.yaml verbatim. */
  readonly evidence: string;
}

function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** A builder worktree is `<workspace>/.builders/<id>` — the layout `afx spawn` creates. */
export function isBuilderWorktreePath(candidate: string): boolean {
  return resolve(candidate).split(sep).includes('.builders');
}

export function attributeApprovalCaller(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  artifactRoot: string;
}): ApprovalCallerAttribution {
  const declaredWorktree = input.env.CODEV_WORKTREE_ROOT?.trim();
  if (declaredWorktree && isInside(declaredWorktree, input.artifactRoot)) {
    const builderId = input.env.CODEV_BUILDER_ID?.trim();
    return {
      kind: 'builder-session',
      evidence: `CODEV_WORKTREE_ROOT contains the artifact root${builderId ? ` (CODEV_BUILDER_ID=${builderId})` : ''}`,
    };
  }
  // Keyed on the CALLER's cwd, not on the target's. A builder sitting in its own
  // worktree approving some OTHER project's gate is still an agent approving a
  // gate, and an earlier version of this function let that through because it
  // required the target to be the caller's own worktree.
  if (isBuilderWorktreePath(input.cwd)) {
    return {
      kind: 'builder-session',
      evidence: `cwd ${resolve(input.cwd)} is inside a builder worktree`,
    };
  }
  // Checked last, and named for exactly what it proves. An earlier version of
  // this function returned "no builder or architect session evidence" while
  // reading nothing about architects at all — a message claiming a check that
  // did not exist, in the string an operator reads out of status.yaml.
  const architectName = input.env.CODEV_ARCHITECT_NAME?.trim();
  if (architectName) {
    return {
      kind: 'architect-session',
      evidence: `CODEV_ARCHITECT_NAME=${architectName} (an architect session or a process it spawned)`,
    };
  }
  return {
    kind: 'unattributed',
    evidence: 'no builder worktree in the cwd or environment, and no CODEV_ARCHITECT_NAME',
  };
}

export interface IssuanceRequest {
  /** Recognition from `HumanPairedSessionRegistry.recognize`, passed by value. */
  readonly humanSession: { readonly paired: boolean; readonly sessionId?: string };
  /** What the caller says it is. A lying caller is not caught here; see the threat model. */
  readonly declaredPrincipal?: string;
  readonly machine?: string;
  readonly lifetimeMs?: number;
}

export type IssuanceOutcome =
  | { readonly issued: true; readonly capability: IssuedCapability }
  | { readonly issued: false; readonly code: ApprovalSignal; readonly message: string };

/**
 * Issuance. Two refusals, in this order, and the order is the honest one: the
 * declared-principal refusal is defence in depth, and the human-paired session is
 * the check that carries weight.
 */
export function issueApprovalCapability(
  store: ApprovalCapabilityStore,
  request: IssuanceRequest,
): IssuanceOutcome {
  const declared = request.declaredPrincipal?.trim();
  if (declared === 'builder' || declared === 'architect') {
    return {
      issued: false,
      code: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REFUSED_AGENT,
      message: `issuance refused to a caller declaring itself ${declared}`,
    };
  }
  if (!request.humanSession.paired || !request.humanSession.sessionId) {
    return {
      issued: false,
      code: APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION,
      message: 'approval capability issuance requires a human-paired session',
    };
  }
  return {
    issued: true,
    capability: store.issue({
      sessionId: request.humanSession.sessionId,
      machine: request.machine,
      lifetimeMs: request.lifetimeMs,
    }),
  };
}
