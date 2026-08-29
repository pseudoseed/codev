/**
 * Per-machine credentials for the codev-agent surface (Spec 146 Phase 7).
 *
 * WHAT BOUNDARY THIS IS, stated first, because phase 6 recorded a threat model
 * this phase must not quietly widen:
 *
 * A machine credential answers "WHICH client machine is talking to this host".
 * It does NOT answer "is the process at the other end of this socket a human".
 * Over loopback TCP the peer is not attributable — `remoteAddress` is 127.0.0.1
 * for a builder, an architect and a browser alike — and a same-uid process can
 * read anything on disk that this process can. So what this buys is:
 *
 * 1. **A remote peer must hold a credential this host issued.** That is a real
 *    boundary because a remote peer cannot read `~/.agent-farm`.
 * 2. **Per-machine revocation.** Tower's shared local key is ONE key for every
 *    client, so "revoke the iPad" under it means rotating the key for everyone.
 *    Success criterion 15 needs one machine's subtree to fail closed while the
 *    others keep working, and that is only expressible per machine.
 *
 * It buys nothing against a local process running as the same user. That is
 * recorded in `codev/resources/146-approval-threat-model.md` and is not fixed
 * here; the approval capability, not this credential, is what carries evidence
 * of a human for a gate.
 *
 * STORED SEPARATELY, LITERALLY. Each machine is its own file. The spec says
 * per-machine credentials are "stored separately and individually revocable" —
 * one JSON array would make that a property of the write code, where a bad write
 * loses every machine at once. One file per machine makes it a property of the
 * filesystem: revoking A cannot touch B's bytes.
 *
 * Node builtins only: `porch` and the server both reach this module.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readJsonOrThrow, withStoreLock, writeJsonAtomic } from './atomic-store.js';

/**
 * Outcome codes. Declared in the module that emits them, so the failure-matrix
 * collector that scans this file forces every one to be classified.
 *
 * MACHINE_CREDENTIAL_REVOKED is a failure-matrix row and is deliberately NOT
 * `CAPABILITY_REVOKED` or `HUMAN_SESSION_REVOKED`. Those three answer different
 * questions — "this machine's access was withdrawn", "this approval credential
 * was withdrawn", "this browser session was withdrawn" — and send an operator to
 * three different places. Collapsing them would be the "I could not tell spelled
 * as no" defect one level up.
 */
export const MACHINE_SIGNAL = {
  MACHINE_CREDENTIAL_AUTHORIZED: 'MACHINE_CREDENTIAL_AUTHORIZED',
  MACHINE_CREDENTIAL_REQUIRED: 'MACHINE_CREDENTIAL_REQUIRED',
  MACHINE_CREDENTIAL_MALFORMED: 'MACHINE_CREDENTIAL_MALFORMED',
  MACHINE_CREDENTIAL_UNKNOWN: 'MACHINE_CREDENTIAL_UNKNOWN',
  MACHINE_CREDENTIAL_INVALID: 'MACHINE_CREDENTIAL_INVALID',
  MACHINE_CREDENTIAL_EXPIRED: 'MACHINE_CREDENTIAL_EXPIRED',
  MACHINE_CREDENTIAL_REVOKED: 'MACHINE_CREDENTIAL_REVOKED',
  MACHINE_STORE_LOCKED: 'MACHINE_STORE_LOCKED',
  MACHINE_STORE_UNREADABLE: 'MACHINE_STORE_UNREADABLE',
} as const;

export type MachineSignal = (typeof MACHINE_SIGNAL)[keyof typeof MACHINE_SIGNAL];

/** Presentations are `<credentialId>.<secret>`; the separator is in neither half. */
const PRESENTATION_SEPARATOR = '.';
const DEFAULT_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export interface StoredMachineCredential {
  readonly id: string;
  /** The machine's own name, as the client declared it at pairing. */
  readonly machine: string;
  /** Hex SHA-256 of the secret. The secret itself is never persisted. */
  readonly verifier: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  revokedAt?: string;
}

export interface IssuedMachineCredential {
  readonly credentialId: string;
  readonly machine: string;
  /** Returned exactly once. Never persisted by this module in any form. */
  readonly presentation: string;
  readonly expiresAt: string;
}

export interface MachineVerification {
  readonly authorized: boolean;
  readonly code: MachineSignal;
  readonly message: string;
  readonly machine?: string;
  readonly credentialId?: string;
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

/**
 * Root of the user-global Agent Farm state directory.
 *
 * `CODEV_AGENT_FARM_DIR` is the same override the rest of agent-farm honours
 * (#1515): nothing in production sets it, and it exists so a spawned test Tower
 * writes to a throwaway directory instead of the developer's real
 * `~/.agent-farm`. Read per call rather than at import, because a test sets it
 * around a spawn and an import-time constant would have been captured already.
 */
function agentFarmRoot(): string {
  const override = process.env.CODEV_AGENT_FARM_DIR;
  return override ? resolve(override) : join(homedir(), '.agent-farm');
}

export function defaultMachineRoot(): string {
  return join(agentFarmRoot(), 'machines');
}

/**
 * Thrown when a machine's file exists but cannot be parsed.
 *
 * A missing file is "this machine was never paired" and answers UNKNOWN. A file
 * that will not parse is "I could not tell", and must not be spelled the same
 * way — the operator's next step differs (pair it, versus repair the store).
 */
export class MachineStoreUnreadable extends Error {
  constructor(readonly storePath: string, cause: unknown) {
    super(`MACHINE_STORE_UNREADABLE: ${storePath} exists but could not be parsed (${String(cause)})`);
    this.name = 'MachineStoreUnreadable';
  }
}

/**
 * Per-machine credential store.
 *
 * The file name is the SHA-256 of the machine name, not the machine name. Names
 * arrive from a client, and a name is a path component the moment it is used as
 * one — `../../local-key` is a valid string. Hashing removes the traversal
 * question rather than answering it with a validator that has to stay correct.
 */
export class MachineCredentialStore {
  readonly #root: string;
  readonly #now: () => number;

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.#root = options.root ?? defaultMachineRoot();
    this.#now = options.now ?? Date.now;
  }

  get root(): string {
    return this.#root;
  }

  /** The file holding this machine's record. One machine, one file. */
  pathFor(machine: string): string {
    return join(this.#root, `${sha256Hex(machine)}.json`);
  }

  #read(machine: string): StoredMachineCredential | null {
    const record = readJsonOrThrow<StoredMachineCredential | null>(
      this.pathFor(machine),
      null,
      (storePath, cause) => new MachineStoreUnreadable(storePath, cause),
    );
    return record && typeof record === 'object' && typeof record.id === 'string' ? record : null;
  }

  /**
   * Issue this machine's credential, replacing any previous one.
   *
   * Re-pairing a machine replaces its record, which revokes the old secret by
   * construction: the old verifier is gone, so the old presentation now reports
   * INVALID against the new record rather than continuing to work.
   */
  issue(options: { machine: string; lifetimeMs?: number }): IssuedMachineCredential {
    const machine = options.machine.trim();
    if (machine.length === 0) throw new Error('MACHINE_NAME_REQUIRED');
    const requested = options.lifetimeMs ?? DEFAULT_CREDENTIAL_LIFETIME_MS;
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('MACHINE_LIFETIME_INVALID');
    const lifetime = Math.min(requested, MAX_CREDENTIAL_LIFETIME_MS);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const issuedAt = this.#now();
    const record: StoredMachineCredential = {
      id,
      machine,
      verifier: sha256Hex(secret),
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + lifetime).toISOString(),
    };
    const path = this.pathFor(machine);
    withStoreLock(path, MACHINE_SIGNAL.MACHINE_STORE_LOCKED, () => writeJsonAtomic(path, record));
    return {
      credentialId: id,
      machine,
      presentation: `${id}${PRESENTATION_SEPARATOR}${secret}`,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Verify a presentation.
   *
   * The presentation carries the credential id, not the machine name, so this
   * cannot look up one file directly — it scans the store. That is a handful of
   * small files and it removes an attacker-chosen name from the lookup path
   * entirely: a caller cannot ask this store to read a file of its choosing.
   */
  verify(presentation: string | undefined): MachineVerification {
    if (presentation === undefined || presentation.length === 0) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_REQUIRED,
        message: 'no machine credential presented',
      };
    }
    const separator = presentation.indexOf(PRESENTATION_SEPARATOR);
    if (separator <= 0 || separator === presentation.length - 1) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_MALFORMED,
        message: 'machine credential is not <credentialId>.<secret>',
      };
    }
    const credentialId = presentation.slice(0, separator);
    const secret = presentation.slice(separator + 1);

    let record: StoredMachineCredential | null = null;
    for (const candidate of this.records()) {
      if (candidate.id === credentialId) {
        record = candidate;
        break;
      }
    }
    if (!record) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_UNKNOWN,
        message: 'no machine credential with that id on this host',
      };
    }
    // Revocation is decided before expiry and before the secret: a revoked
    // credential must say REVOKED even when the secret is right, otherwise the
    // operator who revoked it cannot tell their revocation took effect.
    if (record.revokedAt) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED,
        message: `credential for ${record.machine} was revoked at ${record.revokedAt}`,
        machine: record.machine,
        credentialId: record.id,
      };
    }
    if (Date.parse(record.expiresAt) <= this.#now()) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_EXPIRED,
        message: `credential for ${record.machine} expired at ${record.expiresAt}`,
        machine: record.machine,
        credentialId: record.id,
      };
    }
    if (!digestsMatch(sha256Hex(secret), record.verifier)) {
      return {
        authorized: false,
        code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_INVALID,
        message: 'machine credential secret does not match',
        credentialId: record.id,
      };
    }
    return {
      authorized: true,
      code: MACHINE_SIGNAL.MACHINE_CREDENTIAL_AUTHORIZED,
      message: `machine ${record.machine} authenticated`,
      machine: record.machine,
      credentialId: record.id,
    };
  }

  /**
   * Revoke one machine. Writes only that machine's file.
   *
   * A TOMBSTONE, not a delete: deleting the file would make a revoked machine
   * indistinguishable from one that was never paired, and those are different
   * answers. The tombstone is dropped by `sweep()` once the original expiry has
   * passed, at which point EXPIRED and UNKNOWN are the same answer anyway.
   */
  revoke(machine: string): boolean {
    const path = this.pathFor(machine);
    return withStoreLock(path, MACHINE_SIGNAL.MACHINE_STORE_LOCKED, () => {
      const record = this.#read(machine);
      if (!record || record.revokedAt) return false;
      writeJsonAtomic(path, { ...record, revokedAt: new Date(this.#now()).toISOString() });
      return true;
    });
  }

  /** The record for one machine, or null. Never includes the secret; there is none stored. */
  describe(machine: string): StoredMachineCredential | null {
    return this.#read(machine);
  }

  /**
   * Every stored record.
   *
   * A file that will not parse propagates `MachineStoreUnreadable` rather than
   * being skipped. Skipping it would make one corrupt file read as "that machine
   * is not paired", which is the failure this store exists to keep distinct.
   */
  records(): StoredMachineCredential[] {
    if (!existsSync(this.#root)) return [];
    const out: StoredMachineCredential[] = [];
    for (const entry of readdirSync(this.#root).sort()) {
      if (!entry.endsWith('.json')) continue;
      const path = join(this.#root, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        throw new MachineStoreUnreadable(path, error);
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as StoredMachineCredential).id === 'string') {
        out.push(parsed as StoredMachineCredential);
      }
    }
    return out;
  }

  /** Drop tombstones whose original expiry has passed. Returns how many were removed. */
  sweep(): number {
    let removed = 0;
    for (const record of this.records()) {
      if (!record.revokedAt) continue;
      if (Date.parse(record.expiresAt) > this.#now()) continue;
      rmSync(this.pathFor(record.machine), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Create the store directory with owner-only permissions. */
  ensureRoot(): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }
}
