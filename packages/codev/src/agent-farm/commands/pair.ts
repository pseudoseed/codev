/**
 * `afx pair` — the operator entry point for pairing (Spec 236, phase 3).
 *
 * ## Why this exists
 *
 * `PairingStore.issue()` had two callers: a dev script and tests. There was no
 * command a person could run, so the whole approval path was test-reachable only
 * and spec 146's criterion 9b was unreachable in production no matter what else
 * was built.
 *
 * ## The security decision this command forces, stated where it is implemented
 *
 * Minting a pairing token needs write access to a file. Revoking a machine
 * needed a live human session, which needs a live machine credential — **so the
 * operator who wants to withdraw access was the one who could not**. A real
 * credential (`dev-check`) sat unrevokable on the development machine for
 * exactly that reason.
 *
 * That is backwards, and this command inverts it: **every subcommand here is a
 * direct store operation**, so revoking costs precisely what minting costs, and
 * works with no credential and with Tower not running — which is when an
 * operator most wants to revoke.
 *
 * **The objection this has to answer is availability, not confidentiality.** The
 * route table privileges revocation because "an agent that could revoke could
 * deny a human their gate". That is a denial-of-service argument, and "a same-uid
 * agent could already forge a capability" does not reach it. What reaches it: a
 * same-uid agent can already write these stores directly — it can revoke, forge,
 * delete or corrupt them — so it can already perform that denial. This command
 * makes the denial *convenient*, not *possible*, and the alternative on offer is
 * the status quo, where the human cannot revoke and the agent still can.
 *
 * The HTTP routes are unchanged, for clients that do hold a session.
 *
 * ## What this command does NOT establish
 *
 * Nothing about human presence. Every agent on this host runs as the same user
 * as the operator, so a builder can run this too. `authority` is therefore
 * RECORDED and never interpreted: it is the minter's own account of what
 * authorized the mint, and it travels verbatim to the session, the capability and
 * `status.yaml`. A reader of `status.yaml` sees the claim an approval was made
 * under, not a verification anybody performed.
 */

import { userInfo } from 'node:os';
import { MachineCredentialStore, type StoredMachineCredential } from '../lib/machine-credentials.js';
import {
  PairingStore,
  type PairingPurpose,
  type PairingStoreUnreadable,
} from '../lib/pairing.js';
import { ApprovalCapabilityStore } from '../lib/approval-capability.js';

const PURPOSES: readonly PairingPurpose[] = ['machine-credential', 'client-session'];

/**
 * Where each store lives, overridable together for a test.
 *
 * One option rather than three, because they are three directories under one
 * root and a test that pointed two at a scratch directory and one at the real
 * `~/.agent-farm` would write to the operator's actual store.
 */
export interface PairCommandOptions {
  /** Overrides `CODEV_AGENT_FARM_DIR`/`~/.agent-farm` for all three stores. */
  readonly root?: string;
  /** Where output goes. Injected so a test can assert what was printed. */
  readonly write?: (line: string) => void;
}

function stores(options: PairCommandOptions) {
  const root = options.root;
  return {
    pairings: new PairingStore(root ? { root: `${root}/pairing` } : {}),
    machines: new MachineCredentialStore(root ? { root: `${root}/machines` } : {}),
    capabilities: new ApprovalCapabilityStore(root ? { root: `${root}/approval` } : {}),
  };
}

function out(options: PairCommandOptions): (line: string) => void {
  return options.write ?? ((line) => process.stdout.write(`${line}\n`));
}

/**
 * The authority recorded when the operator names none.
 *
 * DELIBERATELY MODEST. It says which command ran and which account ran it, both
 * of which are true, and it claims nothing about a human being present — because
 * this process cannot know that and a string that implied it would be the kind of
 * false guarantee the threat model was twice falsified for.
 */
function defaultAuthority(): string {
  let account = 'an unknown account';
  try {
    account = userInfo().username;
  } catch {
    // A container with no passwd entry. The fallback above is still true.
  }
  return `afx pair issue, run by the OS account ${account}; no human presence was verified`;
}

export class PairCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PairCommandError';
  }
}

/** Is this the "store exists but will not parse" error, from any of the stores? */
function unreadable(error: unknown): error is PairingStoreUnreadable {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'PairingStoreUnreadable' || name === 'MachineStoreUnreadable'
    || name === 'ApprovalStoreUnreadable';
}

/**
 * Run one store operation, turning an unreadable store into its own answer.
 *
 * A store that exists and will not parse must never be reported as "no such
 * machine" or "no tokens": one wants investigating and the other is a normal
 * empty state. Every subcommand goes through this so the distinction cannot be
 * made in one place and forgotten in another.
 */
function readStore<T>(what: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (unreadable(error)) {
      throw new PairCommandError(
        'PAIR_STORE_UNREADABLE',
        `the ${what} store exists but could not be read (${(error as Error).message}). `
        + 'This is not "nothing is there" — it is a store that needs looking at.',
      );
    }
    throw error;
  }
}

export interface PairIssueInput {
  readonly purpose?: string;
  readonly authority?: string;
  readonly ttlMinutes?: number;
}

/**
 * Mint one pairing token and print it exactly once.
 *
 * `purpose` IS REQUIRED AND HAS NO DEFAULT. There are two ceremonies —
 * `pairing/redeem` spends a `machine-credential` token, `human-sessions` spends a
 * `client-session` one — and a token is refused at the wrong one. A default would
 * therefore fail in a different process, against a different route, with a
 * message about a token rather than about the choice that was made silently on
 * the operator's behalf. Refusing here costs one argument and reports the problem
 * where the decision is.
 *
 * The token goes to stdout and nowhere else: never a log line, never a file, and
 * never an argument — argv is world-readable through `ps` and lands in shell
 * history, which is why there is no `--token` anywhere in this command.
 */
export function pairIssue(input: PairIssueInput, options: PairCommandOptions = {}): void {
  const purpose = input.purpose;
  if (purpose === undefined) {
    throw new PairCommandError(
      'PAIR_PURPOSE_REQUIRED',
      `--purpose is required and has no default. Use "machine-credential" to pair a device, or `
      + `"client-session" to open the session that authorizes gate approvals. A token minted for `
      + `one is refused at the other, so guessing here would fail later and elsewhere.`,
    );
  }
  if (!PURPOSES.includes(purpose as PairingPurpose)) {
    throw new PairCommandError(
      'PAIR_PURPOSE_UNKNOWN',
      `unknown --purpose "${purpose}". Valid values: ${PURPOSES.join(', ')}.`,
    );
  }

  // An operator who TRIED to say something and said nothing is not the same as
  // one who did not try, so an explicitly empty value is refused rather than
  // silently replaced with the default.
  if (input.authority !== undefined && input.authority.trim().length === 0) {
    throw new PairCommandError(
      'PAIR_AUTHORITY_EMPTY',
      '--authority was given but is empty. Omit it to record this command and the invoking '
      + 'account, or give it something a later reader of status.yaml can act on.',
    );
  }
  const authority = input.authority?.trim() ?? defaultAuthority();

  const { pairings } = stores(options);
  const issued = readStore('pairing', () => pairings.issue({
    purpose: purpose as PairingPurpose,
    authority,
    ...(input.ttlMinutes !== undefined ? { ttlMs: input.ttlMinutes * 60_000 } : {}),
  }));

  const write = out(options);
  write(issued.token);
  write('');
  write(`pairing id  ${issued.pairingId}`);
  write(`purpose     ${purpose}`);
  write(`expires     ${issued.expiresAt}`);
  write(`authority   ${authority}`);
  write('');
  write('The token above is shown ONCE and is not stored anywhere in presentable form.');
  write('Type it into the device being paired; do not paste it into a command line, a');
  write('log, or a file. It is single-use and expires at the time above.');
}

/** What `list` reports for one pairing token. Never its secret or its verifier. */
interface TokenLine {
  readonly pairingId: string;
  readonly purpose: string;
  readonly state: 'outstanding' | 'redeemed' | 'expired';
  readonly detail: string;
  readonly authority: string;
}

function tokenState(
  token: { expiresAt: number; redeemedAt?: number; redeemedBy?: string },
  now: number,
): { state: TokenLine['state']; detail: string } {
  if (token.redeemedAt !== undefined) {
    return {
      state: 'redeemed',
      detail: `at ${new Date(token.redeemedAt).toISOString()} by ${token.redeemedBy ?? 'an undeclared machine'}`,
    };
  }
  if (now >= token.expiresAt) {
    return { state: 'expired', detail: `at ${new Date(token.expiresAt).toISOString()}` };
  }
  return { state: 'outstanding', detail: `until ${new Date(token.expiresAt).toISOString()}` };
}

/**
 * Report outstanding tokens and paired machines.
 *
 * NO SECRET AND NO VERIFIER IS PRINTED. The verifier is not presentable — it is a
 * hash — but printing it would put the one value an attacker wants to compare
 * against onto a screen and into a scrollback, for no operator benefit at all.
 *
 * Redeemed and expired tokens are shown rather than filtered: their tombstones
 * are what let the host tell "already redeemed" from "never existed", and an
 * operator debugging a refused token needs to see the same distinction.
 */
export function pairList(options: PairCommandOptions = {}, now: number = Date.now()): void {
  const { pairings, machines } = stores(options);
  const tokens = readStore('pairing', () => pairings.records());
  const credentials = readStore('machine credential', () => machines.records());
  const write = out(options);

  write('PAIRING TOKENS');
  if (tokens.length === 0) {
    write('  none — no token has been minted on this host, or every tombstone has aged out');
  }
  for (const token of tokens) {
    const { state, detail } = tokenState(token, now);
    write(`  ${token.id}  ${state}`);
    write(`    purpose    ${token.purpose ?? 'machine-credential (minted before purposes existed)'}`);
    write(`    ${state === 'outstanding' ? 'valid     ' : 'settled   '} ${detail}`);
    write(`    authority  ${token.authority ?? 'not recorded (minted before authority existed)'}`);
  }

  write('');
  write('PAIRED MACHINES');
  if (credentials.length === 0) {
    write('  none — no machine holds a credential from this host');
  }
  for (const credential of credentials) {
    write(`  ${credential.machine}  ${credential.revokedAt ? 'REVOKED' : liveness(credential, now)}`);
    write(`    credential ${credential.id}`);
    write(`    issued     ${credential.issuedAt}`);
    write(`    expires    ${credential.expiresAt}`);
    if (credential.revokedAt) write(`    revoked    ${credential.revokedAt}`);
  }
}

function liveness(credential: StoredMachineCredential, now: number): string {
  return Date.parse(credential.expiresAt) <= now ? 'expired' : 'live';
}

export interface PairRevokeResult {
  readonly machine: string;
  /** Whether there was a LIVE credential to revoke. `false` is an answer, not an error. */
  readonly credentialRevoked: boolean;
  /** How many live approval capabilities were revoked. */
  readonly approvalCapabilitiesRevoked: number;
}

/**
 * Withdraw one machine's access — its credential AND its approval capabilities.
 *
 * TWO STORES, ONE OPERATOR ACTION. They are separate stores keyed by the same
 * machine name, and revoking only the first would leave a withdrawn device still
 * able to present a live approval capability to `porch approve`. An operator
 * asked to remember two commands will eventually run one.
 *
 * The two results are reported AS THE TWO SHAPES THEY ARE — a boolean and a count
 * — rather than collapsed into one number. "There was no live credential" and
 * "no capabilities were live" are different facts about different stores, and a
 * single number cannot say which of them is which.
 *
 * Neither `false` nor `0` is a failure. They mean there was nothing live to
 * withdraw, which is its own answer and the normal result of revoking twice.
 */
export function pairRevoke(machine: string, options: PairCommandOptions = {}): PairRevokeResult {
  const name = machine.trim();
  if (name.length === 0) {
    throw new PairCommandError('PAIR_MACHINE_REQUIRED', 'name the machine to revoke.');
  }
  const { machines, capabilities } = stores(options);
  const credentialRevoked = readStore('machine credential', () => machines.revoke(name));
  const approvalCapabilitiesRevoked = readStore('approval capability', () => capabilities.revokeMachine(name));

  const write = out(options);
  write(`machine    ${name}`);
  write(`credential ${credentialRevoked ? 'revoked' : 'nothing live to revoke'}`);
  write(`approvals  ${approvalCapabilitiesRevoked} capability record(s) revoked`);
  if (!credentialRevoked && approvalCapabilitiesRevoked === 0) {
    write('');
    write('Nothing was live under that name. That is an answer, not a failure: either the');
    write('machine was never paired here, its access was already withdrawn, or the name');
    write('differs from the one it paired under (see `afx pair list`).');
  } else {
    write('');
    write('Every request from that machine now fails closed with MACHINE_CREDENTIAL_REVOKED.');
    write('No other machine was touched. Re-pair it with `afx pair issue` if that was a');
    write('mistake — revocation is a tombstone, so the old secret can never be revived.');
  }
  return { machine: name, credentialRevoked, approvalCapabilitiesRevoked };
}
