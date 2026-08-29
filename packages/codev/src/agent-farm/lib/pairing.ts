/**
 * Pairing tokens: how a machine that holds nothing obtains a credential
 * (Spec 146 Phase 7).
 *
 * WHAT BOUNDARY THIS IS. A pairing token is a short-lived bearer secret carried
 * out of band by the operator — read off the host's terminal and typed into the
 * new device. It authenticates NOTHING about the redeemer's identity; it proves
 * only that whoever redeems it had the token. The bound that makes that
 * acceptable is time and count: single-use, minutes not days. Anything longer or
 * reusable would be a second permanent credential with no revocation story.
 *
 * The token is the one secret in this system that a human handles directly, so
 * the leak surface is different in kind from the others: a log line, a shell
 * history file, a commit. This module therefore never accepts a sink to write to,
 * and exports {@link redactPairingToken} for the paths that log around it. The
 * host stores a verifier, so even the store cannot re-present a token.
 *
 * Node builtins only.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readJsonOrThrow, withStoreLock, writeJsonAtomic } from './atomic-store.js';

/**
 * Outcome codes, declared where they are emitted so the failure-matrix collector
 * forces each to be classified.
 *
 * REDEEMED and UNKNOWN are separate on purpose. A token presented twice is an
 * operator who did not notice the first redemption succeeded, or a replay; a
 * token that was never minted here is a typo or the wrong host. The tombstone is
 * what makes the distinction possible, and dropping it would spell "I could not
 * tell" as "no such token".
 */
export const PAIRING_SIGNAL = {
  PAIRING_TOKEN_ACCEPTED: 'PAIRING_TOKEN_ACCEPTED',
  PAIRING_TOKEN_REQUIRED: 'PAIRING_TOKEN_REQUIRED',
  PAIRING_TOKEN_MALFORMED: 'PAIRING_TOKEN_MALFORMED',
  PAIRING_TOKEN_UNKNOWN: 'PAIRING_TOKEN_UNKNOWN',
  PAIRING_TOKEN_REDEEMED: 'PAIRING_TOKEN_REDEEMED',
  PAIRING_TOKEN_EXPIRED: 'PAIRING_TOKEN_EXPIRED',
  PAIRING_STORE_LOCKED: 'PAIRING_STORE_LOCKED',
  /** Issuance failed after the token was spent; see `release`. */
  PAIRING_CREDENTIAL_ISSUE_FAILED: 'PAIRING_CREDENTIAL_ISSUE_FAILED',
  PAIRING_STORE_UNREADABLE: 'PAIRING_STORE_UNREADABLE',
} as const;

export type PairingSignal = (typeof PAIRING_SIGNAL)[keyof typeof PAIRING_SIGNAL];

const PRESENTATION_SEPARATOR = '.';
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
/** How long a spent or expired token is kept so REDEEMED/EXPIRED stay distinct from UNKNOWN. */
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

interface StoredPairingToken {
  readonly id: string;
  /** Hex SHA-256 of the secret. */
  readonly verifier: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Set when redeemed; the record stays as a tombstone until retention passes. */
  redeemedAt?: number;
  /** The machine name the redeemer declared. Recorded for the audit trail. */
  redeemedBy?: string;
}

export interface IssuedPairingToken {
  readonly pairingId: string;
  /**
   * Returned exactly once, in memory. Show it to the operator; do not log it,
   * do not write it to a file, do not pass it as a command-line argument (argv is
   * world-readable through `ps` and lands in shell history).
   */
  readonly token: string;
  readonly expiresAt: string;
}

export interface PairingRedemption {
  readonly redeemed: boolean;
  readonly code: PairingSignal;
  readonly message: string;
  readonly pairingId?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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

export function defaultPairingRoot(): string {
  return join(agentFarmRoot(), 'pairing');
}

/**
 * Replace the secret half of any `<uuid>.<secret>` pairing token in `text`.
 *
 * Written to be used on a whole log line rather than on a known variable: the
 * leak this guards against is the one nobody remembered to redact. It keeps the
 * pairing id, which is what makes a log line useful, and drops the only part
 * that can be presented.
 */
export function redactPairingToken(text: string): string {
  return text.replace(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{16,}/g,
    '$1.<redacted>',
  );
}

export class PairingStoreUnreadable extends Error {
  constructor(readonly storePath: string, cause: unknown) {
    super(`PAIRING_STORE_UNREADABLE: ${storePath} exists but could not be parsed (${String(cause)})`);
    this.name = 'PairingStoreUnreadable';
  }
}

/**
 * Pairing token store. File-backed because issuance and redemption can be
 * different processes (an operator issues from a CLI; the server redeems).
 */
export class PairingStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.#path = join(options.root ?? defaultPairingRoot(), 'tokens.json');
    this.#now = options.now ?? Date.now;
  }

  get path(): string {
    return this.#path;
  }

  #read(): StoredPairingToken[] {
    const file = readJsonOrThrow<{ version?: number; tokens?: StoredPairingToken[] }>(
      this.#path,
      {},
      (storePath, cause) => new PairingStoreUnreadable(storePath, cause),
    );
    return Array.isArray(file.tokens) ? file.tokens : [];
  }

  #write(tokens: StoredPairingToken[]): void {
    writeJsonAtomic(this.#path, { version: 1, tokens });
  }

  /** Drop records whose tombstone retention has passed. */
  #sweep(tokens: StoredPairingToken[]): StoredPairingToken[] {
    const now = this.#now();
    return tokens.filter((token) => {
      const settledAt = token.redeemedAt ?? token.expiresAt;
      return now - settledAt < TOMBSTONE_RETENTION_MS;
    });
  }

  issue(options: { ttlMs?: number } = {}): IssuedPairingToken {
    const requested = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('PAIRING_TTL_INVALID');
    const ttl = Math.min(requested, MAX_TOKEN_TTL_MS);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const issuedAt = this.#now();
    const record: StoredPairingToken = {
      id,
      verifier: sha256Hex(secret),
      issuedAt,
      expiresAt: issuedAt + ttl,
    };
    withStoreLock(this.#path, PAIRING_SIGNAL.PAIRING_STORE_LOCKED, () => {
      this.#write([...this.#sweep(this.#read()), record]);
    });
    return {
      pairingId: id,
      token: `${id}${PRESENTATION_SEPARATOR}${secret}`,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  /**
   * Redeem a token exactly once.
   *
   * The whole read-modify-write runs under the lock. Two concurrent redemptions
   * of the same token would otherwise both read it unredeemed and both succeed,
   * which is precisely the property this is supposed to have.
   */
  redeem(token: string | undefined, options: { machine: string }): PairingRedemption {
    if (token === undefined || token.length === 0) {
      return {
        redeemed: false,
        code: PAIRING_SIGNAL.PAIRING_TOKEN_REQUIRED,
        message: 'no pairing token presented',
      };
    }
    const separator = token.indexOf(PRESENTATION_SEPARATOR);
    if (separator <= 0 || separator === token.length - 1) {
      return {
        redeemed: false,
        code: PAIRING_SIGNAL.PAIRING_TOKEN_MALFORMED,
        message: 'pairing token is not <pairingId>.<secret>',
      };
    }
    const pairingId = token.slice(0, separator);
    const secret = token.slice(separator + 1);

    return withStoreLock(this.#path, PAIRING_SIGNAL.PAIRING_STORE_LOCKED, () => {
      const tokens = this.#sweep(this.#read());
      const index = tokens.findIndex((candidate) => candidate.id === pairingId);
      if (index < 0) {
        return {
          redeemed: false,
          code: PAIRING_SIGNAL.PAIRING_TOKEN_UNKNOWN,
          message: 'no pairing token with that id on this host',
        };
      }
      const record = tokens[index];
      // The secret is checked BEFORE the state is reported, so a caller holding a
      // wrong secret cannot use this to learn whether a real token was redeemed
      // or has expired. A wrong secret answers UNKNOWN, the same as a wrong id.
      if (!digestsMatch(sha256Hex(secret), record.verifier)) {
        return {
          redeemed: false,
          code: PAIRING_SIGNAL.PAIRING_TOKEN_UNKNOWN,
          message: 'no pairing token with that id on this host',
        };
      }
      if (record.redeemedAt !== undefined) {
        return {
          redeemed: false,
          code: PAIRING_SIGNAL.PAIRING_TOKEN_REDEEMED,
          message: `pairing token was already redeemed at ${new Date(record.redeemedAt).toISOString()}`,
          pairingId,
        };
      }
      const now = this.#now();
      if (now >= record.expiresAt) {
        return {
          redeemed: false,
          code: PAIRING_SIGNAL.PAIRING_TOKEN_EXPIRED,
          message: `pairing token expired at ${new Date(record.expiresAt).toISOString()}`,
          pairingId,
        };
      }
      tokens[index] = { ...record, redeemedAt: now, redeemedBy: options.machine };
      this.#write(tokens);
      return {
        redeemed: true,
        code: PAIRING_SIGNAL.PAIRING_TOKEN_ACCEPTED,
        message: 'pairing token redeemed',
        pairingId,
      };
    });
  }

  /**
   * Undo a redemption, making the token usable again until its TTL passes.
   *
   * EXISTS FOR ONE CALLER: redemption spends the token BEFORE the machine
   * credential is issued, and it has to — issuing first would leave a credential
   * standing against a token that was never spent. So if issuance then fails, the
   * operator is holding a token that is gone and a device that is not paired, and
   * their only recourse is to notice and mint another.
   *
   * This does not weaken single-use. The token was consumed and is being put back
   * because the transaction it was consumed FOR did not happen; a redemption that
   * returned a credential is never released. The TTL still bounds it.
   *
   * Returns false when there was nothing to release — an unknown id, or a token
   * that was not redeemed — so the caller can tell "your token still works" from
   * "I could not put it back", which are different instructions to an operator.
   */
  release(pairingId: string): boolean {
    return withStoreLock(this.#path, PAIRING_SIGNAL.PAIRING_STORE_LOCKED, () => {
      const tokens = this.#read();
      const index = tokens.findIndex((candidate) => candidate.id === pairingId);
      if (index < 0) return false;
      const record = tokens[index];
      if (record.redeemedAt === undefined) return false;
      const { redeemedAt: _redeemedAt, redeemedBy: _redeemedBy, ...unspent } = record;
      tokens[index] = unspent;
      this.#write(tokens);
      return true;
    });
  }

  /** Raw stored records, for tests and for an operator listing outstanding tokens. */
  records(): StoredPairingToken[] {
    return this.#read();
  }
}
