/**
 * Spec 146 Phase 6 — success criterion 9c, plus the symlink trap the plan names.
 *
 * DERIVED FROM THE ARTEFACT, NOT FROM A DESCRIPTION OF IT. Both tests generate
 * the real launch script and create the real `.env` symlink, then search the
 * bytes for a secret that was actually issued a moment earlier. A test that
 * asserted "the script has no CODEV_APPROVAL_CAPABILITY line" would pass while
 * the same secret shipped under a different variable name.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildWorktreeLaunchScript, startBuilderSession, symlinkConfigFiles } from '../commands/spawn-worktree.js';
import { CLAUDE_HARNESS, CODEX_HARNESS, OPENCODE_HARNESS } from '../utils/harness.js';
import type { Config } from '../types.js';
import {
  ApprovalCapabilityStore,
  CAPABILITY_ENV_VAR,
  NONCE_ENV_VAR,
  defaultApprovalRoot,
} from '../lib/approval-capability.js';

// Only the Tower REST client is mocked. Everything else — the filesystem, the
// harness, the script assembly — is real, so the script this file inspects is
// the one a spawn actually writes to disk.
vi.mock('../lib/tower-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tower-client.js')>();
  return {
    ...actual,
    getTowerClient: () => ({ createTerminal: async () => ({ id: 'terminal-test' }) }),
  };
});

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(workspaceRoot: string): Config {
  return {
    workspaceRoot,
    codevDir: join(workspaceRoot, 'codev'),
    buildersDir: join(workspaceRoot, '.builders'),
    stateDir: join(workspaceRoot, 'codev', 'state'),
    templatesDir: join(workspaceRoot, 'codev', 'templates'),
    serversDir: join(workspaceRoot, 'servers'),
    bundledRolesDir: join(workspaceRoot, 'roles'),
    terminalBackend: 'node-pty',
  };
}

describe("a spawned builder's environment carries no approval capability", () => {
  // The script is generated for EVERY harness, because the env block is built
  // per harness (`buildScriptRoleInjection` returns its own env) and a leak
  // through one harness only is still a leak.
  it('no generated launch script exports the issued secret or the capability variables', () => {
    const store = new ApprovalCapabilityStore({ root: tmp('approval-store-'), machine: 'test-machine' });
    const issued = store.issue({ sessionId: 'human-session-1' });
    const secret = issued.presentation.slice(issued.presentation.indexOf('.') + 1);

    const worktree = tmp('builder-worktree-');
    const role = { content: 'You are a builder for {PORT}', source: 'test' };

    for (const harness of [CLAUDE_HARNESS, CODEX_HARNESS, OPENCODE_HARNESS]) {
      const selection = { provider: harness, modelScriptFragment: '' } as Parameters<
        typeof buildWorktreeLaunchScript
      >[4];
      const script = buildWorktreeLaunchScript(worktree, 'claude', role, worktree, selection);

      // The script is not empty and does export things — otherwise these
      // absence assertions would be vacuous.
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain(worktree);

      expect(script).not.toContain(secret);
      expect(script).not.toContain(issued.presentation);
      expect(script).not.toContain(issued.capabilityId);
      expect(script).not.toContain(CAPABILITY_ENV_VAR);
      expect(script).not.toContain(NONCE_ENV_VAR);
    }
  });

  // SUCCESS CRITERION 9c, OVER THE GENERATED START SCRIPT ITSELF.
  //
  // `startBuilderSession` writes `.builder-start.sh` into the worktree and Tower
  // launches the builder from it. This drives that function for real and reads
  // the file back off disk; only the Tower REST client is mocked.
  //
  // THE ASSERTION ASSERTS ITS OWN REACH. The script MUST be found to export the
  // builder identity pair — the env block this test is claiming to inspect. If a
  // refactor moves the exports elsewhere, this fails by name instead of quietly
  // proving the absence of an approval variable from a block it never read.
  it('the generated .builder-start.sh exports the identity pair and nothing approval-shaped', async () => {
    const workspaceRoot = tmp('approval-workspace-');
    const worktree = join(workspaceRoot, '.builders', 'spir-146');
    mkdirSync(worktree, { recursive: true });

    const store = new ApprovalCapabilityStore({ root: tmp('approval-store-'), machine: 'test-machine' });
    const issued = store.issue({ sessionId: 'human-session-1' });
    const secret = issued.presentation.slice(issued.presentation.indexOf('.') + 1);

    await startBuilderSession(
      makeConfig(workspaceRoot),
      'spir-146',
      worktree,
      'claude',
      'implement the thing',
      'You are a builder',
      'test',
    );

    const script = readFileSync(join(worktree, '.builder-start.sh'), 'utf8');
    const exported = [...script.matchAll(/^export ([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(exported).toContain('CODEV_BUILDER_ID');
    expect(exported).toContain('CODEV_WORKTREE_ROOT');

    for (const name of exported) {
      expect(name.includes('APPROVAL')).toBe(false);
      expect(name.includes('CAPABILITY')).toBe(false);
    }
    expect(script).not.toContain(secret);
    expect(script).not.toContain(issued.presentation);
    expect(script).not.toContain(CAPABILITY_ENV_VAR);
    expect(script).not.toContain(NONCE_ENV_VAR);
  });
});

describe('the capability is not reachable through the symlinked .env', () => {
  // THE TRAP THE PLAN NAMES: `symlinkConfigFiles` links the workspace `.env`
  // into every builder worktree, so anything in it is readable by every builder.
  // This drives the real symlink rather than asserting the code path exists.
  it('the workspace .env is symlinked into the worktree and contains no capability', () => {
    const workspaceRoot = tmp('approval-workspace-');
    const envPath = join(workspaceRoot, '.env');
    writeFileSync(envPath, 'GITHUB_TOKEN=not-a-capability\nOPENAI_API_KEY=also-not\n');

    const store = new ApprovalCapabilityStore({ root: tmp('approval-store-'), machine: 'test-machine' });
    const issued = store.issue({ sessionId: 'human-session-1' });
    const secret = issued.presentation.slice(issued.presentation.indexOf('.') + 1);

    const worktree = join(workspaceRoot, '.builders', 'spir-146');
    mkdirSync(worktree, { recursive: true });
    symlinkConfigFiles(makeConfig(workspaceRoot), worktree);

    const linked = join(worktree, '.env');
    // The link really was created — otherwise the absence check below proves
    // nothing except that a file is missing.
    expect(existsSync(linked)).toBe(true);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);

    const contents = readFileSync(linked, 'utf8');
    expect(contents).toContain('GITHUB_TOKEN');
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(CAPABILITY_ENV_VAR);
  });

  it('the capability store lives outside every workspace, under the user home', () => {
    const root = defaultApprovalRoot();
    expect(root.startsWith(resolve(homedir()))).toBe(true);
    expect(root).toContain('.agent-farm');
    // Not `.env`, and not anywhere `symlinkConfigFiles` links from.
    expect(root.endsWith('.env')).toBe(false);
  });
});
