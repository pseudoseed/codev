/**
 * `afx pair issue / list / revoke` (Spec 236, phase 3).
 *
 * ## What makes this phase real rather than plausible
 *
 * `PairingStore.issue()` had two callers — a dev script and tests — so spec 146's
 * approval path was test-reachable only. The tests below are therefore written
 * against the two things that decide whether an operator can actually use it:
 *
 *  1. **A `client-session` token opens a real human session.** A command that can
 *     only mint `machine-credential` tokens leaves criterion 9b exactly as
 *     unreachable as it was, and would still satisfy a criterion phrased as
 *     "issue prints a token". So the link is driven, not asserted.
 *  2. **`revoke` works holding nothing.** That is the security decision this
 *     command exists to force: over the API, withdrawing access needs a live
 *     credential, so the operator who wants to revoke is the one who cannot.
 *
 * Every test drives a scratch store root. Nothing here touches the operator's
 * real `~/.agent-farm` — which matters more than usual, because the one thing
 * this command does that a test must never do is revoke a real credential.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PairCommandError,
  pairIssue,
  pairList,
  pairRevoke,
} from '../commands/pair.js';
import { MachineCredentialStore } from '../lib/machine-credentials.js';
import { PairingStore } from '../lib/pairing.js';
import { ApprovalCapabilityStore, issueApprovalCapability } from '../lib/approval-capability.js';
import { HumanPairedSessionRegistry } from '../servers/agent-routes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'codev-236-pair-'));
  roots.push(root);
  return root;
}

/** Capture everything the command printed, as one stream and as lines. */
function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

describe('afx pair issue', () => {
  it('prints a token exactly once, with what it is for and when it dies', () => {
    const root = scratch();
    const printed = capture();
    pairIssue({ purpose: 'client-session' }, { root, write: printed.write });

    const tokens = printed.lines.filter((line) => /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}$/.test(line));
    expect(tokens).toHaveLength(1);
    expect(printed.text()).toContain('purpose     client-session');
    expect(printed.text()).toContain('expires');
  });

  /*
   * `purpose` IS REQUIRED AND HAS NO DEFAULT, and this is the criterion that
   * makes the command reach criterion 9b at all. There are two ceremonies and a
   * token is bound to one; a default would fail in a different process, against a
   * different route, with a message about a token rather than about the choice
   * made silently on the operator's behalf.
   */
  it('refuses to guess a purpose', () => {
    const root = scratch();
    expect(() => pairIssue({}, { root, write: () => {} }))
      .toThrow(expect.objectContaining({ code: 'PAIR_PURPOSE_REQUIRED' }) as Error);
  });

  it('refuses a purpose it does not recognise, at issue time', () => {
    const root = scratch();
    // At ISSUE time, not at redemption: the second is a different process and a
    // different route, and the operator would be told about a token rather than
    // about the argument they typed.
    try {
      pairIssue({ purpose: 'session' }, { root, write: () => {} });
      expect.unreachable('an unknown purpose must be refused');
    } catch (error) {
      expect((error as PairCommandError).code).toBe('PAIR_PURPOSE_UNKNOWN');
      expect((error as Error).message).toContain('machine-credential');
      expect((error as Error).message).toContain('client-session');
    }
    // And nothing was minted, so a refused mint cannot leave a token behind.
    expect(new PairingStore({ root: join(root, 'pairing') }).records()).toHaveLength(0);
  });

  it.each(['machine-credential', 'client-session'] as const)('mints a %s token', (purpose) => {
    const root = scratch();
    pairIssue({ purpose }, { root, write: () => {} });
    expect(new PairingStore({ root: join(root, 'pairing') }).records()[0].purpose).toBe(purpose);
  });

  describe('authority', () => {
    /*
     * THE FLAG IS OPTIONAL; THE RECORDED VALUE IS NEVER EMPTY. An operator who
     * TRIED to say something and said nothing is not the same as one who did not
     * try, so an explicitly empty value is refused rather than quietly replaced.
     */
    it('records a default that names the command and the account, and claims nothing more', () => {
      const root = scratch();
      pairIssue({ purpose: 'client-session' }, { root, write: () => {} });
      const authority = new PairingStore({ root: join(root, 'pairing') }).records()[0].authority ?? '';
      expect(authority.length).toBeGreaterThan(0);
      expect(authority).toContain('afx pair issue');
      // It must NOT assert human presence: nothing in this process can verify it,
      // and a string implying it is the false guarantee the threat model was
      // twice falsified for.
      expect(authority).toContain('no human presence was verified');
    });

    it('records what the operator said, verbatim', () => {
      const root = scratch();
      pairIssue({ purpose: 'client-session', authority: 'Chris, at the laptop' }, { root, write: () => {} });
      expect(new PairingStore({ root: join(root, 'pairing') }).records()[0].authority)
        .toBe('Chris, at the laptop');
    });

    it('refuses an explicitly empty authority rather than substituting the default', () => {
      const root = scratch();
      expect(() => pairIssue({ purpose: 'client-session', authority: '   ' }, { root, write: () => {} }))
        .toThrow(expect.objectContaining({ code: 'PAIR_AUTHORITY_EMPTY' }) as Error);
    });
  });

  /*
   * THE LEAK THIS GUARDS AGAINST IS THE ONE NOBODY REMEMBERED TO REDACT, so the
   * assertion is over the WHOLE captured output and the whole store on disk,
   * never over a known variable.
   */
  it('writes the token to no file the command touches', () => {
    const root = scratch();
    const printed = capture();
    pairIssue({ purpose: 'client-session' }, { root, write: printed.write });
    const token = printed.lines.find((line) => line.includes('.'))!;
    const secret = token.split('.')[1];
    expect(secret.length).toBeGreaterThan(16);

    for (const file of walk(root)) {
      expect(readFileSync(file, 'utf8'), `${file} contains the token secret`).not.toContain(secret);
    }
  });
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

describe('afx pair list', () => {
  it('says plainly when there is nothing, rather than printing empty headings', () => {
    const printed = capture();
    pairList({ root: scratch(), write: printed.write });
    expect(printed.text()).toContain('no token has been minted on this host');
    expect(printed.text()).toContain('no machine holds a credential from this host');
  });

  it('separates outstanding, redeemed and expired tokens', () => {
    const root = scratch();
    let clock = 1_000_000;
    const pairings = new PairingStore({ root: join(root, 'pairing'), now: () => clock });
    const outstanding = pairings.issue({ purpose: 'client-session', authority: 'a' });
    const redeemed = pairings.issue({ purpose: 'machine-credential', authority: 'b' });
    pairings.redeem(redeemed.token, { machine: 'ipad', purpose: 'machine-credential' });
    const expired = pairings.issue({ purpose: 'client-session', authority: 'c', ttlMs: 60_000 });

    clock += 120_000;
    const printed = capture();
    pairList({ root, write: printed.write }, clock);
    const text = printed.text();
    expect(text).toContain(`${outstanding.pairingId}  outstanding`);
    expect(text).toContain(`${redeemed.pairingId}  redeemed`);
    expect(text).toContain(`${expired.pairingId}  expired`);
    // The tombstone's audit trail: who spent it.
    expect(text).toContain('ipad');
  });

  /*
   * NO SECRET AND NO VERIFIER. The verifier is a hash and is not presentable, but
   * printing it would put the one value an attacker wants to compare against on a
   * screen and into a scrollback for no operator benefit whatever.
   */
  it('prints no secret and no verifier', () => {
    const root = scratch();
    const pairings = new PairingStore({ root: join(root, 'pairing') });
    pairings.issue({ purpose: 'client-session', authority: 'a' });
    new MachineCredentialStore({ root: join(root, 'machines') }).issue({ machine: 'ipad' });

    const printed = capture();
    pairList({ root, write: printed.write });
    const text = printed.text();
    for (const record of pairings.records()) {
      expect(text).not.toContain(record.verifier);
    }
    for (const record of new MachineCredentialStore({ root: join(root, 'machines') }).records()) {
      expect(text).not.toContain(record.verifier);
    }
  });

  it('shows a revoked machine as revoked rather than hiding it', () => {
    const root = scratch();
    const machines = new MachineCredentialStore({ root: join(root, 'machines') });
    machines.issue({ machine: 'ipad' });
    machines.issue({ machine: 'laptop' });
    machines.revoke('ipad');

    const printed = capture();
    pairList({ root, write: printed.write });
    expect(printed.text()).toMatch(/ipad {2}REVOKED/);
    expect(printed.text()).toMatch(/laptop {2}live/);
  });
});

describe('afx pair revoke', () => {
  /*
   * THE DECISION THIS COMMAND EXISTS TO FORCE. Over the API, revoking needs a
   * live human session, which needs a live machine credential — so the operator
   * who wants to WITHDRAW access is the one who cannot. Here it is a store write,
   * so it costs exactly what minting costs, and it works with nothing in hand.
   */
  it('withdraws a machine while holding no credential and with no server running', () => {
    const root = scratch();
    const machines = new MachineCredentialStore({ root: join(root, 'machines') });
    const credential = machines.issue({ machine: 'dev-check' });
    expect(machines.verify(credential.presentation).authorized).toBe(true);

    const result = pairRevoke('dev-check', { root, write: () => {} });
    expect(result.credentialRevoked).toBe(true);

    const verdict = machines.verify(credential.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe('MACHINE_CREDENTIAL_REVOKED');
  });

  it('leaves every other machine working', () => {
    const root = scratch();
    const machines = new MachineCredentialStore({ root: join(root, 'machines') });
    const revoked = machines.issue({ machine: 'ipad' });
    const kept = machines.issue({ machine: 'laptop' });

    pairRevoke('ipad', { root, write: () => {} });
    expect(machines.verify(revoked.presentation).authorized).toBe(false);
    expect(machines.verify(kept.presentation).authorized).toBe(true);
  });

  /*
   * TWO STORES, ONE OPERATOR ACTION. They are keyed by the same machine name, and
   * revoking only the credential would leave a withdrawn device still able to
   * present a live approval capability to `porch approve`.
   */
  it('withdraws the approval capabilities as well as the credential', () => {
    const root = scratch();
    new MachineCredentialStore({ root: join(root, 'machines') }).issue({ machine: 'ipad' });
    const capabilities = new ApprovalCapabilityStore({ root: join(root, 'approval'), machine: 'ipad' });
    const issued = issueApprovalCapability(capabilities, {
      humanSession: { paired: true, sessionId: 'session-1' },
      declaredPrincipal: 'human-client',
      machine: 'ipad',
    });
    expect(issued.issued).toBe(true);

    const result = pairRevoke('ipad', { root, write: () => {} });
    expect(result.credentialRevoked).toBe(true);
    expect(result.approvalCapabilitiesRevoked).toBe(1);
    expect(capabilities.verify(issued.issued ? issued.capability.presentation : '').authorized).toBe(false);
  });

  /*
   * REPORTED AS THE TWO SHAPES THEY ARE. `revoke` answers a boolean — was there a
   * live credential — and `revokeMachine` answers a count. Collapsing them into
   * one number cannot say which store had nothing in it.
   */
  it('reports the credential as a yes/no and the capabilities as a count', () => {
    const root = scratch();
    new MachineCredentialStore({ root: join(root, 'machines') }).issue({ machine: 'ipad' });
    const printed = capture();
    const result = pairRevoke('ipad', { root, write: printed.write });
    expect(result).toEqual({ machine: 'ipad', credentialRevoked: true, approvalCapabilitiesRevoked: 0 });
    expect(printed.text()).toContain('credential revoked');
    expect(printed.text()).toContain('0 capability record(s) revoked');
  });

  it('answers "nothing live" as an answer, not as a failure', () => {
    const root = scratch();
    const printed = capture();
    const result = pairRevoke('never-paired', { root, write: printed.write });
    expect(result.credentialRevoked).toBe(false);
    expect(result.approvalCapabilitiesRevoked).toBe(0);
    expect(printed.text()).toContain('That is an answer, not a failure');
  });

  it('is idempotent in report as well as effect', () => {
    const root = scratch();
    new MachineCredentialStore({ root: join(root, 'machines') }).issue({ machine: 'ipad' });
    expect(pairRevoke('ipad', { root, write: () => {} }).credentialRevoked).toBe(true);
    // The second call finds nothing live. That is the same true statement, not a
    // failure, and an operator running it twice must not be told they broke it.
    expect(pairRevoke('ipad', { root, write: () => {} }).credentialRevoked).toBe(false);
  });

  it('requires a machine name rather than revoking something unnamed', () => {
    expect(() => pairRevoke('   ', { root: scratch(), write: () => {} }))
      .toThrow(expect.objectContaining({ code: 'PAIR_MACHINE_REQUIRED' }) as Error);
  });
});

describe('a store that will not parse is its own answer', () => {
  /*
   * "This store is corrupt" and "there is nothing here" are different facts with
   * different remedies, and reporting the first as the second is the failure this
   * whole spec is organised against.
   */
  it.each([
    ['pairing', () => pairList],
  ])('reports %s corruption rather than emptiness', (_name) => {
    const root = scratch();
    mkdirSync(join(root, 'pairing'), { recursive: true });
    writeFileSync(join(root, 'pairing', 'tokens.json'), '{ not json');
    try {
      pairList({ root, write: () => {} });
      expect.unreachable('an unparseable store must not read as empty');
    } catch (error) {
      expect((error as PairCommandError).code).toBe('PAIR_STORE_UNREADABLE');
      expect((error as Error).message).toContain('not "nothing is there"');
    }
  });

  it('reports a corrupt machine store from revoke rather than "no such machine"', () => {
    const root = scratch();
    // THE MACHINE'S OWN FILE has to be the corrupt one: the store keeps one file
    // per machine, keyed by a hash of the name, so junk under some other name is
    // not this machine's record and revoking would correctly find nothing. The
    // distinction under test is narrower than "the directory has a bad file in
    // it" — it is "the record for THIS machine cannot be read".
    const machines = new MachineCredentialStore({ root: join(root, 'machines') });
    machines.issue({ machine: 'ipad' });
    const file = readdirSync(join(root, 'machines')).find((entry) => entry.endsWith('.json'))!;
    writeFileSync(join(root, 'machines', file), '{ not json');
    try {
      pairRevoke('ipad', { root, write: () => {} });
      expect.unreachable('an unparseable record must not read as "never paired"');
    } catch (error) {
      expect((error as PairCommandError).code).toBe('PAIR_STORE_UNREADABLE');
    }
  });
});

/**
 * THE LINK THAT MAKES CRITERION 9b REACHABLE, driven rather than asserted.
 *
 * A command that mints only `machine-credential` tokens satisfies every wording
 * about "issues a token" and still leaves gate approval exactly as unreachable as
 * it was, because the approval routes need a HUMAN SESSION and a session is
 * opened by spending a `client-session` token. So this drives the whole way:
 * `afx pair issue --purpose client-session`, redeem it, hold the session.
 */
describe('a client-session token opens a real session', () => {
  it('carries the operator\'s authority from the token to the session', () => {
    const root = scratch();
    const printed = capture();
    pairIssue(
      { purpose: 'client-session', authority: 'Chris, at the laptop' },
      { root, write: printed.write },
    );
    const token = printed.lines[0];

    const pairings = new PairingStore({ root: join(root, 'pairing') });
    const redemption = pairings.redeem(token, { machine: 'laptop', purpose: 'client-session' });
    expect(redemption.redeemed).toBe(true);
    expect(redemption.authority).toBe('Chris, at the laptop');

    const sessions = new HumanPairedSessionRegistry();
    const session = sessions.completePairing({
      pairingId: redemption.pairingId!,
      principalKind: 'human-client',
      authority: redemption.authority,
    });
    const recognised = sessions.recognize(`${session.sessionId}.${session.credential}`);
    expect(recognised.paired).toBe(true);
    // The authority the operator typed reaches the session, which is what carries
    // it onward into `status.yaml` beside any approval that session makes.
    expect(recognised.authority).toBe('Chris, at the laptop');
  });

  it('refuses a machine-credential token at the session ceremony, without spending it', () => {
    const root = scratch();
    const printed = capture();
    pairIssue({ purpose: 'machine-credential' }, { root, write: printed.write });
    const token = printed.lines[0];

    const pairings = new PairingStore({ root: join(root, 'pairing') });
    const wrong = pairings.redeem(token, { machine: 'laptop', purpose: 'client-session' });
    expect(wrong.redeemed).toBe(false);

    // NOT CONSUMED: an operator who reached for the wrong ceremony still holds a
    // usable token, rather than having burned it on a refusal.
    const right = pairings.redeem(token, { machine: 'laptop', purpose: 'machine-credential' });
    expect(right.redeemed).toBe(true);
  });
});
