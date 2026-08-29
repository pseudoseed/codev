/**
 * Spec 146 Phase 6 — approval capabilities.
 *
 * Every assertion here drives the real store through a real issue/verify cycle.
 * Nothing constructs a stored record by hand: a fixture that agrees with the
 * assumption it should be challenging is how phase 5 hid an impossible state
 * behind a green suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_SIGNAL,
  ApprovalCapabilityStore,
  ApprovalNonceStore,
  attributeApprovalCaller,
  issueApprovalCapability,
} from '../lib/approval-capability.js';
import {
  clearPendingRegistrations,
  consumePendingRegistration,
  createPendingRegistration,
} from '../lib/nonce-store.js';

let root: string;
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'approval-capability-'));
  roots.push(root);
});

afterEach(() => {
  clearPendingRegistrations();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(options: { machine?: string; now?: () => number } = {}): ApprovalCapabilityStore {
  return new ApprovalCapabilityStore({ root, machine: options.machine ?? 'test-machine', now: options.now });
}

describe('the host stores a verifier, never a replayable credential', () => {
  // DERIVED FROM THE ARTEFACT: the secret is pulled out of the presentation the
  // store just returned and searched for in the bytes the store just wrote. A
  // test that asserted "the record has no `secret` field" would pass while the
  // secret shipped under any other key.
  it('the persisted file does not contain the issued secret in any field', () => {
    const capabilities = store();
    const issued = capabilities.issue({ sessionId: 'human-session-1' });
    const secret = issued.presentation.slice(issued.presentation.indexOf('.') + 1);
    expect(secret.length).toBeGreaterThan(20);

    const raw = capabilities.rawContents();
    expect(raw).not.toContain(secret);
    // The id IS stored — this test must fail if the file simply went missing.
    expect(raw).toContain(issued.capabilityId);
  });

  it('a capability read back out of storage cannot be re-presented', () => {
    const capabilities = store();
    const issued = capabilities.issue({ sessionId: 'human-session-1' });
    const persisted = JSON.parse(readFileSync(capabilities.path, 'utf8')) as {
      capabilities: Array<{ id: string; verifier: string }>;
    };
    const record = persisted.capabilities[0];
    // This is everything a builder that reads the host's storage has.
    const forged = `${record.id}.${record.verifier}`;
    const verdict = capabilities.verify(forged);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_INVALID);
  });

  it('a valid presentation verifies and names the issuing session', () => {
    const capabilities = store();
    const issued = capabilities.issue({ sessionId: 'human-session-7' });
    const verdict = capabilities.verify(issued.presentation);
    expect(verdict.authorized).toBe(true);
    expect(verdict.sessionId).toBe('human-session-7');
    expect(verdict.capabilityId).toBe(issued.capabilityId);
  });
});

describe('expiry and revocation', () => {
  it('a capability past its expiry is refused as expired, not as invalid', () => {
    let clock = 1_000_000;
    const capabilities = store({ now: () => clock });
    const issued = capabilities.issue({ sessionId: 'human-session-1', lifetimeMs: 60_000 });
    clock += 59_000;
    expect(capabilities.verify(issued.presentation).authorized).toBe(true);
    clock += 2_000;
    const verdict = capabilities.verify(issued.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_EXPIRED);
  });

  // AN EXPIRY THAT CANNOT BE READ IS NOT AN EXPIRY THAT HAS NOT PASSED.
  // `now >= NaN` is false, so a corrupted timestamp used to skip the expiry
  // branch entirely and fall through to the secret comparison.
  it('a record with an unreadable expiry is refused as expired, not accepted', () => {
    const capabilities = store();
    const issued = capabilities.issue({ sessionId: 'human-session-1' });
    const file = JSON.parse(readFileSync(capabilities.path, 'utf8')) as {
      capabilities: Array<{ expiresAt: string }>;
    };
    file.capabilities[0].expiresAt = 'not-a-timestamp';
    writeFileSync(capabilities.path, JSON.stringify(file));

    const verdict = capabilities.verify(issued.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_EXPIRED);
    expect(verdict.message).toContain('unreadable expiry');
  });

  // THE ISOLATION PROPERTY, driven through one shared store because that is where
  // it could actually break. Two separate stores would pass whatever the code did.
  it('revoking one machine leaves another machine approving', () => {
    const shared = new ApprovalCapabilityStore({ root, machine: 'laptop' });
    const laptop = shared.issue({ sessionId: 'session-laptop', machine: 'laptop' });
    const studio = shared.issue({ sessionId: 'session-studio', machine: 'mac-studio' });

    expect(shared.revokeMachine('laptop')).toBe(1);

    const asLaptop = new ApprovalCapabilityStore({ root, machine: 'laptop' });
    expect(asLaptop.verify(laptop.presentation).code).toBe(APPROVAL_SIGNAL.CAPABILITY_REVOKED);

    const asStudio = new ApprovalCapabilityStore({ root, machine: 'mac-studio' });
    const stillGood = asStudio.verify(studio.presentation);
    expect(stillGood.authorized).toBe(true);
    expect(stillGood.machine).toBe('mac-studio');
  });

  it('a capability issued for another machine is refused on this one, distinctly', () => {
    const shared = new ApprovalCapabilityStore({ root, machine: 'laptop' });
    const studio = shared.issue({ sessionId: 'session-studio', machine: 'mac-studio' });
    const verdict = shared.verify(studio.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_FOREIGN_MACHINE);
    expect(verdict.code).not.toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN);
  });

  it('an unknown capability id and a wrong secret are different answers', () => {
    const capabilities = store();
    const issued = capabilities.issue({ sessionId: 'human-session-1' });
    expect(capabilities.verify('11111111-2222-3333-4444-555555555555.whatever').code)
      .toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN);
    expect(capabilities.verify(`${issued.capabilityId}.wrong-secret`).code)
      .toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_INVALID);
    expect(capabilities.verify(undefined).code).toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_REQUIRED);
    expect(capabilities.verify('no-separator-here').code)
      .toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_MALFORMED);
  });
});

describe('approval nonces', () => {
  it('a nonce is single use, and a replay is named as a replay', () => {
    const nonces = new ApprovalNonceStore({ root });
    const nonce = nonces.mint({ projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' });

    expect(nonces.consume(nonce, { projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' }).accepted).toBe(true);

    const replay = nonces.consume(nonce, { projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' });
    expect(replay.accepted).toBe(false);
    // The whole point of the tombstone: a replay is not spelled the same way as
    // a nonce this host never minted.
    expect(replay.code).toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_REPLAYED);
    expect(nonces.consume('never-minted', { projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' }).code)
      .toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_UNKNOWN);
  });

  it('a nonce is bound to its project and gate', () => {
    const nonces = new ApprovalNonceStore({ root });
    const nonce = nonces.mint({ projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' });
    const wrongGate = nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    expect(wrongGate.accepted).toBe(false);
    expect(wrongGate.code).toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_SCOPE_MISMATCH);
    // The mismatch must not have consumed it — the bound gate still works.
    expect(nonces.consume(nonce, { projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' }).accepted).toBe(true);
  });

  // A STORED FIELD NOTHING ENFORCES IS A CLAIM, NOT A CONSTRAINT. `capabilityId`
  // was persisted on every nonce and never compared, so a nonce minted for one
  // capability authorized an approval presented with another.
  it('a nonce minted for one capability does not authorize another', () => {
    const nonces = new ApprovalNonceStore({ root });
    const nonce = nonces.mint({ projectId: '146', gateName: 'pr', capabilityId: 'cap-A' });
    const wrong = nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-B' });
    expect(wrong.accepted).toBe(false);
    expect(wrong.code).toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_CAPABILITY_MISMATCH);
    // The refusal did not consume it: the capability it WAS minted for still works.
    expect(nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-A' }).accepted)
      .toBe(true);
  });

  it('a nonce older than its lifetime is refused', () => {
    let clock = 5_000_000;
    const nonces = new ApprovalNonceStore({ root, now: () => clock });
    const nonce = nonces.mint({ projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    clock += 6 * 60 * 1000;
    const verdict = nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    expect(verdict.accepted).toBe(false);
    // Past the TTL the entry is swept, so the honest answer is that this host does
    // not know the nonce — not that it expired, which would claim a record we no
    // longer hold.
    expect(verdict.code).toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_UNKNOWN);
  });

  // THE PLAN REQUIRES THESE TWO STORES TO BE SEPARATE. Asserted, not commented:
  // a tunnel registration nonce must not authorize a gate, and vice versa.
  it('approval nonces and OAuth tunnel registration nonces are not interchangeable', () => {
    const nonces = new ApprovalNonceStore({ root });
    const approvalNonce = nonces.mint({ projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    const tunnelNonce = createPendingRegistration('laptop', 'https://example.invalid');

    expect(consumePendingRegistration(approvalNonce)).toBeNull();
    expect(nonces.consume(tunnelNonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' }).code)
      .toBe(APPROVAL_SIGNAL.APPROVAL_NONCE_UNKNOWN);
    // Both stores still hold their own entry, so the two lookups above failed
    // because the stores are separate rather than because either was empty.
    expect(consumePendingRegistration(tunnelNonce)).not.toBeNull();
    expect(nonces.consume(approvalNonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' }).accepted).toBe(true);
  });
});

describe('the store serializes its read-modify-write', () => {
  // NAMED FOR WHAT IT ACTUALLY EXERCISES. This does not run two processes, so it
  // is not a concurrency test and must not be read as one. It asserts the lock is
  // genuinely taken: with the lock file held, a consume cannot proceed.
  it('a held lock blocks a consume rather than letting it through', () => {
    const nonces = new ApprovalNonceStore({ root });
    const nonce = nonces.mint({ projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    const lockPath = join(root, 'approval-nonces.json.lock');
    writeFileSync(lockPath, '');
    try {
      expect(() => nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' }))
        .toThrow(/APPROVAL_STORE_LOCKED/);
    } finally {
      rmSync(lockPath, { force: true });
    }
    // Released, and the nonce was never consumed by the blocked attempt.
    expect(nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' }).accepted)
      .toBe(true);
  });

  // A lock left by a killed process must not wedge approvals forever.
  it('reclaims a lock older than the stale window', () => {
    const nonces = new ApprovalNonceStore({ root });
    const nonce = nonces.mint({ projectId: '146', gateName: 'pr', capabilityId: 'cap-1' });
    const lockPath = join(root, 'approval-nonces.json.lock');
    writeFileSync(lockPath, '');
    const ancient = new Date(Date.now() - 60_000);
    utimesSync(lockPath, ancient, ancient);
    expect(nonces.consume(nonce, { projectId: '146', gateName: 'pr', capabilityId: 'cap-1' }).accepted)
      .toBe(true);
  });
});

describe('issuance', () => {
  it('refuses a caller that declares itself a builder or an architect', () => {
    const capabilities = store();
    for (const principal of ['builder', 'architect']) {
      const outcome = issueApprovalCapability(capabilities, {
        humanSession: { paired: true, sessionId: 'session-1' },
        declaredPrincipal: principal,
      });
      expect(outcome.issued).toBe(false);
      if (!outcome.issued) expect(outcome.code).toBe(APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REFUSED_AGENT);
    }
  });

  it('refuses issuance without a human-paired session', () => {
    const outcome = issueApprovalCapability(store(), { humanSession: { paired: false } });
    expect(outcome.issued).toBe(false);
    if (!outcome.issued) {
      expect(outcome.code).toBe(APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION);
    }
  });

  it('issues to a human-paired session and binds the capability to that session id', () => {
    const capabilities = store();
    const outcome = issueApprovalCapability(capabilities, {
      humanSession: { paired: true, sessionId: 'session-42' },
      declaredPrincipal: 'human-client',
    });
    expect(outcome.issued).toBe(true);
    if (outcome.issued) {
      expect(capabilities.verify(outcome.capability.presentation).sessionId).toBe('session-42');
    }
  });
});

describe('caller attribution reads the environment the launch script writes', () => {
  // These env names are not invented here. `buildWorktreeLaunchScript` in
  // commands/spawn-worktree.ts exports CODEV_BUILDER_ID and CODEV_WORKTREE_ROOT
  // into every builder's shell, which is what makes this attribution reachable.
  it('attributes a caller whose declared worktree contains the artifact root', () => {
    const attribution = attributeApprovalCaller({
      env: { CODEV_BUILDER_ID: 'spir-146', CODEV_WORKTREE_ROOT: '/repo/.builders/spir-146' },
      cwd: '/somewhere/else',
      artifactRoot: '/repo/.builders/spir-146',
    });
    expect(attribution.kind).toBe('builder-session');
    expect(attribution.evidence).toContain('spir-146');
  });

  it('attributes a caller sitting inside a builder worktree with no env at all', () => {
    const attribution = attributeApprovalCaller({
      env: {},
      cwd: '/repo/.builders/spir-146/packages',
      artifactRoot: '/repo/.builders/spir-146',
    });
    expect(attribution.kind).toBe('builder-session');
  });

  // A builder approving ANOTHER builder's gate is still an agent approving a
  // gate. Keying the cwd rule on the target's worktree rather than the caller's
  // would let this through.
  it('attributes a builder approving a different project from its own worktree', () => {
    const attribution = attributeApprovalCaller({
      env: {},
      cwd: '/repo/.builders/spir-146',
      artifactRoot: '/repo/.builders/air-173',
    });
    expect(attribution.kind).toBe('builder-session');
  });

  // THE LIMIT, ASSERTED RATHER THAN ONLY DOCUMENTED. A process that clears both
  // variables and leaves the worktree is not attributed, and the threat model
  // says so. This test exists so that limit cannot be quietly forgotten.
  it('does not attribute a caller that cleared its environment and left the worktree', () => {
    const attribution = attributeApprovalCaller({
      env: {},
      cwd: '/repo',
      artifactRoot: '/repo/.builders/spir-146',
    });
    expect(attribution.kind).toBe('unattributed');
  });

  // THE EVIDENCE STRING MUST NOT CLAIM A CHECK THAT DOES NOT RUN. The earlier
  // version returned "no builder or architect session evidence" while reading
  // nothing about architects, and CODEV_ARCHITECT_NAME is set in every architect
  // terminal. It is now read, attributed as its own kind, and still allowed.
  it('attributes an architect at the workspace root, and still allows it', () => {
    const attribution = attributeApprovalCaller({
      env: { CODEV_ARCHITECT_NAME: 'main' },
      cwd: '/repo',
      artifactRoot: '/repo/.builders/spir-146',
    });
    expect(attribution.kind).toBe('architect-session');
    expect(attribution.evidence).toContain('CODEV_ARCHITECT_NAME=main');
  });

  // Builder evidence wins. CODEV_ARCHITECT_NAME is INHERITED by processes an
  // architect spawns — this builder's own shell carries it — so checking it
  // first would label a builder an architect.
  it('prefers builder evidence over an inherited CODEV_ARCHITECT_NAME', () => {
    const attribution = attributeApprovalCaller({
      env: { CODEV_ARCHITECT_NAME: 'main', CODEV_BUILDER_ID: 'spir-146' },
      cwd: '/repo/.builders/spir-146',
      artifactRoot: '/repo/.builders/spir-146',
    });
    expect(attribution.kind).toBe('builder-session');
  });

  it('reports unattributed only when it read every signal and found none', () => {
    const attribution = attributeApprovalCaller({
      env: {},
      cwd: '/repo',
      artifactRoot: '/repo/codev/projects/146-x',
    });
    expect(attribution.kind).toBe('unattributed');
    // The message names what was checked. A message naming a check the function
    // does not run is the defect this assertion exists to catch.
    expect(attribution.evidence).toContain('CODEV_ARCHITECT_NAME');
    expect(attribution.evidence).toContain('cwd');
  });
});
