/**
 * Spec 146 Phase 6 — `porch approve` gates on the approval capability.
 *
 * The acceptance criterion this file exists for: an approval typed inside a
 * builder worktree, WITH the `--a-human-explicitly-approved-this` flag, is
 * refused. That call succeeded before this phase, which is the whole point.
 *
 * Layout is the real one — `<workspace>/.builders/<id>/codev/projects/...` — so
 * the attribution under test is the same containment production computes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectState } from '../types.js';

// writeStateAndCommit is wrapped, not replaced, so this file counts COMMIT
// ATTEMPTS. Under vitest the function returns before it runs git (state.ts skips
// git IO when VITEST is set), so "no commit" is asserted as "the commit path was
// never entered" plus a byte-comparison of the file. Those two together are what
// the acceptance criterion asks for; neither alone would be honest.
const commitAttempts: string[] = [];
vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    writeStateAndCommit: async (statusPath: string, state: ProjectState, message: string) => {
      commitAttempts.push(message);
      return actual.writeStateAndCommit(statusPath, state, message);
    },
  };
});

const { approve } = await import('../index.js');
const { getStatusPath, readState, writeState } = await import('../state.js');
const { ApprovalCapabilityStore, ApprovalNonceStore, CAPABILITY_ENV_VAR, NONCE_ENV_VAR } =
  await import('../../../agent-farm/lib/approval-capability.js');

const protocol = {
  name: 'approval-capability-test',
  version: '1.0.0',
  phases: [
    { id: 'plan', name: 'Plan', gate: 'plan-approval' },
    { id: 'implement', name: 'Implement' },
  ],
};

let workspaceRoot: string;
let worktreeRoot: string;
let approvalRoot: string;
let statusPath: string;

function makeState(): ProjectState {
  return {
    id: '146',
    title: 'capability-gate',
    protocol: protocol.name,
    phase: 'plan',
    plan_phases: [],
    current_plan_phase: null,
    gates: { 'plan-approval': { status: 'pending', requested_at: '2026-08-29T00:00:00.000Z' } },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z',
  };
}

function capabilities(): InstanceType<typeof ApprovalCapabilityStore> {
  return new ApprovalCapabilityStore({ root: approvalRoot, machine: 'test-machine' });
}

function nonces(): InstanceType<typeof ApprovalNonceStore> {
  return new ApprovalNonceStore({ root: approvalRoot });
}

beforeEach(() => {
  commitAttempts.length = 0;
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-approval-'));
  approvalRoot = path.join(workspaceRoot, 'approval-store');
  worktreeRoot = path.join(workspaceRoot, '.builders', 'spir-146');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  for (const root of [workspaceRoot, worktreeRoot]) {
    const protocolDir = path.join(root, 'codev', 'protocols', protocol.name);
    fs.mkdirSync(protocolDir, { recursive: true });
    fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocol));
  }
  statusPath = getStatusPath(worktreeRoot, '146', 'capability-gate');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, makeState());
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function expectExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit:1');
  }) as typeof process.exit);
}

describe('an approval typed inside a builder worktree', () => {
  // THE TEST THAT WOULD HAVE FAILED BEFORE THIS PHASE.
  it('is refused with the flag and no capability, and writes and commits nothing', async () => {
    const before = fs.readFileSync(statusPath);
    const exit = expectExit();

    await expect(approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env: { CODEV_BUILDER_ID: 'spir-146', CODEV_WORKTREE_ROOT: worktreeRoot },
      cwd: worktreeRoot,
      capabilities: capabilities(),
      nonces: nonces(),
    })).rejects.toThrow('process.exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    // Byte-identical, and the commit path was never entered.
    expect(fs.readFileSync(statusPath)).toEqual(before);
    expect(commitAttempts).toEqual([]);
    expect(readState(statusPath).gates['plan-approval'].status).toBe('pending');
  });

  // The gate auto-creation branch is the one that used to write before the flag
  // was ever tested. Approving a gate the state does not carry must still write
  // nothing when the caller is refused.
  it('writes nothing even on the gate auto-creation path', async () => {
    const state = makeState();
    state.gates = {};
    writeState(statusPath, state);
    const before = fs.readFileSync(statusPath);
    const exit = expectExit();

    await expect(approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env: { CODEV_WORKTREE_ROOT: worktreeRoot },
      cwd: worktreeRoot,
      capabilities: capabilities(),
      nonces: nonces(),
    })).rejects.toThrow('process.exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(statusPath)).toEqual(before);
    expect(commitAttempts).toEqual([]);
  });

  it('succeeds when it presents a valid capability and nonce', async () => {
    const store = capabilities();
    const issued = store.issue({ sessionId: 'human-session-9' });
    const nonceStore = nonces();
    const nonce = nonceStore.mint({
      projectId: '146',
      gateName: 'plan-approval',
      capabilityId: issued.capabilityId,
    });

    await approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env: {
        CODEV_BUILDER_ID: 'spir-146',
        CODEV_WORKTREE_ROOT: worktreeRoot,
        [CAPABILITY_ENV_VAR]: issued.presentation,
        [NONCE_ENV_VAR]: nonce,
      },
      cwd: worktreeRoot,
      capabilities: store,
      nonces: nonceStore,
    });

    const gate = readState(statusPath).gates['plan-approval'];
    expect(gate.status).toBe('approved');
    // Success criterion 9b, field by field.
    expect(gate.approval?.authorization).toBe('capability');
    expect(gate.approval?.session_id).toBe('human-session-9');
    expect(gate.approval?.capability_id).toBe(issued.capabilityId);
    expect(gate.approval?.machine).toBe('test-machine');
    expect(Number.isNaN(Date.parse(gate.approval?.approved_at ?? ''))).toBe(false);
    expect(gate.approved_at).toBe(gate.approval?.approved_at);
    expect(commitAttempts.length).toBeGreaterThan(0);
  });

  it('refuses a replayed nonce after the first approval consumed it', async () => {
    const store = capabilities();
    const issued = store.issue({ sessionId: 'human-session-9' });
    const nonceStore = nonces();
    const nonce = nonceStore.mint({
      projectId: '146',
      gateName: 'plan-approval',
      capabilityId: issued.capabilityId,
    });
    const env = {
      CODEV_WORKTREE_ROOT: worktreeRoot,
      [CAPABILITY_ENV_VAR]: issued.presentation,
      [NONCE_ENV_VAR]: nonce,
    };

    await approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env, cwd: worktreeRoot, capabilities: store, nonces: nonceStore,
    });

    // Reset the gate so the refusal below is the nonce being refused and not the
    // "already approved" short circuit.
    writeState(statusPath, makeState());
    commitAttempts.length = 0;
    const before = fs.readFileSync(statusPath);
    const exit = expectExit();

    await expect(approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env, cwd: worktreeRoot, capabilities: store, nonces: nonceStore,
    })).rejects.toThrow('process.exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(statusPath)).toEqual(before);
    expect(commitAttempts).toEqual([]);
  });

  // A SINGLE-USE NONCE MUST BE SPENT ON AN APPROVAL THAT HAPPENS. Authorization
  // used to consume it, so a run that stopped at the already-approved return (or
  // at a failed phase check) burned it and forced a re-mint through the
  // authenticated route.
  it('does not burn the nonce on a call that stops at the already-approved return', async () => {
    const store = capabilities();
    const issued = store.issue({ sessionId: 'human-session-9' });
    const nonceStore = nonces();
    const nonce = nonceStore.mint({
      projectId: '146',
      gateName: 'plan-approval',
      capabilityId: issued.capabilityId,
    });
    const env = {
      CODEV_WORKTREE_ROOT: worktreeRoot,
      [CAPABILITY_ENV_VAR]: issued.presentation,
      [NONCE_ENV_VAR]: nonce,
    };

    const approved = makeState();
    approved.gates['plan-approval'] = { status: 'approved', approved_at: '2026-08-29T00:00:00.000Z' };
    writeState(statusPath, approved);

    await approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env, cwd: worktreeRoot, capabilities: store, nonces: nonceStore,
    });

    // The call returned at "already approved" and wrote nothing — and the nonce
    // is still usable, which is the point.
    expect(commitAttempts).toEqual([]);
    expect(nonceStore.peek(nonce, {
      projectId: '146', gateName: 'plan-approval', capabilityId: issued.capabilityId,
    }).accepted).toBe(true);
  });

  it('refuses a revoked capability while another machine keeps approving', async () => {
    const store = capabilities();
    const local = store.issue({ sessionId: 'session-local', machine: 'test-machine' });
    const other = store.issue({ sessionId: 'session-other', machine: 'other-machine' });
    const nonceStore = nonces();

    expect(store.revokeMachine('test-machine')).toBe(1);

    const exit = expectExit();
    await expect(approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env: {
        CODEV_WORKTREE_ROOT: worktreeRoot,
        [CAPABILITY_ENV_VAR]: local.presentation,
        [NONCE_ENV_VAR]: nonceStore.mint({
          projectId: '146', gateName: 'plan-approval', capabilityId: local.capabilityId,
        }),
      },
      cwd: worktreeRoot,
      capabilities: store,
      nonces: nonceStore,
    })).rejects.toThrow('process.exit:1');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();

    const otherMachine = new ApprovalCapabilityStore({ root: approvalRoot, machine: 'other-machine' });
    await approve(worktreeRoot, '146', 'plan-approval', true, undefined, {
      env: {
        CODEV_WORKTREE_ROOT: worktreeRoot,
        [CAPABILITY_ENV_VAR]: other.presentation,
        [NONCE_ENV_VAR]: nonceStore.mint({
          projectId: '146', gateName: 'plan-approval', capabilityId: other.capabilityId,
        }),
      },
      cwd: worktreeRoot,
      capabilities: otherMachine,
      nonces: nonceStore,
    });
    expect(readState(statusPath).gates['plan-approval'].approval?.session_id).toBe('session-other');
  });
});

describe('an approval from outside any builder worktree', () => {
  // The architect at the workspace root is not attributable to an agent session,
  // so it is allowed — and the record says exactly that, rather than implying a
  // human was verified. The threat model states the residual.
  it('is allowed without a capability and is recorded as flag-only', async () => {
    await approve(workspaceRoot, '146', 'plan-approval', true, undefined, {
      env: {},
      cwd: workspaceRoot,
      capabilities: capabilities(),
      nonces: nonces(),
    });
    const gate = readState(statusPath).gates['plan-approval'];
    expect(gate.status).toBe('approved');
    expect(gate.approval?.authorization).toBe('flag-only');
    expect(gate.approval?.session_id).toBeUndefined();
    expect(gate.approval?.capability_id).toBeUndefined();
  });

  it('is still refused when it presents a capability that does not verify', async () => {
    const store = capabilities();
    const issued = store.issue({ sessionId: 'human-session-9' });
    const before = fs.readFileSync(statusPath);
    const exit = expectExit();

    await expect(approve(workspaceRoot, '146', 'plan-approval', true, undefined, {
      env: { [CAPABILITY_ENV_VAR]: `${issued.capabilityId}.not-the-secret` },
      cwd: workspaceRoot,
      capabilities: store,
      nonces: nonces(),
    })).rejects.toThrow('process.exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(statusPath)).toEqual(before);
    expect(commitAttempts).toEqual([]);
  });
});
