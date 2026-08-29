/**
 * Spec 146 Phase 9, issue #179 items 1 and 2 — the production path to a real engine.
 *
 * Item 1 was "the only engine reachable in production is none": `createPorchThreadEngine`
 * lived under `__tests__/helpers/` and imported porch-driver by a relative path into its
 * gitignored `dist/`, while `porch-driver` was `private: true` and absent from this
 * package's dependencies. Item 2 was that `installThreadSpawnFactory` had no caller
 * outside tests, so `chooseSpawnPath` returned `pty` unconditionally.
 *
 * The manifest assertions below are the durable half. Moving the engine into `src/` is
 * undone by one `private: true`, and nothing else in the suite would notice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseSpawnPath, setSpawnThreadFactory } from '../db/thread-identity.js';
import { setThreadEngine, createMemoryThreadEngine } from '../thread-runtime.js';
import { ensureThreadBackendReady, readThreadBackendConfig } from '../thread-backend.js';
import { launchSpawnedBuilder } from '../commands/spawn.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const pkg = (rel: string) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

describe('Spec 146 Phase 9 — the engine is reachable in production (#179 item 1)', () => {
  it('the engine lives in src, not under __tests__', () => {
    expect(existsSync(join(repoRoot, 'packages/codev/src/agent-farm/porch-thread-engine.ts'))).toBe(true);
  });

  it('porch-driver is a real dependency of @cluesmith/codev', () => {
    const deps = pkg('packages/codev/package.json').dependencies as Record<string, string>;
    expect(deps['@cluesmith/porch-driver']).toBe('workspace:*');
  });

  it('porch-driver and its own dependency t3-client are publishable, not private', () => {
    // A published package cannot depend on a private one: `workspace:*` resolves to a
    // version at publish time, and a private package is never published. Both must go.
    expect(pkg('packages/porch-driver/package.json').private).toBeUndefined();
    expect(pkg('packages/t3-client/package.json').private).toBeUndefined();
    expect(pkg('packages/porch-driver/package.json').dependencies['@cluesmith/t3-client'])
      .toBe('workspace:*');
  });

  /**
   * Every place that hand-enumerates @cluesmith/codev's runtime workspace dependencies.
   *
   * The dependency set grew by two in this phase, and the first fix taught only
   * `pnpm publish` about it — the release commit's `git add` and `local-install.sh`
   * still enumerated the old set, so `pnpm -w run local-install` would E404 on a
   * package the tarball now requires. Reading the set from the manifest rather than
   * repeating it here is what makes the NEXT dependency addition fail loudly instead
   * of repeating this. Extra entries in these lists are fine; missing ones are not.
   */
  const workspaceDeps = () => {
    const deps = pkg('packages/codev/package.json').dependencies as Record<string, string>;
    return Object.keys(deps)
      .filter((name) => name.startsWith('@cluesmith/'))
      .map((name) => {
        // Resolve name → directory from the manifests themselves; `@cluesmith/codev-types`
        // lives at `packages/types`, so the name is not the path.
        const dir = readdirSync(join(repoRoot, 'packages')).find((d) => {
          const manifest = join(repoRoot, 'packages', d, 'package.json');
          return existsSync(manifest) && pkg(`packages/${d}/package.json`).name === name;
        });
        if (!dir) throw new Error(`No packages/* directory declares ${name}`);
        return { name, path: `packages/${dir}` };
      });
  };

  it('every workspace dependency is version-aligned with @cluesmith/codev', () => {
    // Dropping `private: true` makes a package publishable; it does not make it published.
    // pnpm rewrites `workspace:*` to the dependency's own version at publish time, so a
    // porch-driver left at 0.0.0 ships as `"@cluesmith/porch-driver": "0.0.0"` — a version
    // that is not on the registry, and `npm install -g @cluesmith/codev` fails with E404.
    const released = pkg('packages/codev/package.json').version;
    const deps = workspaceDeps();
    expect(deps.length).toBeGreaterThan(0);
    for (const { name, path } of deps) {
      expect({ name, version: pkg(`${path}/package.json`).version }).toEqual({ name, version: released });
      expect({ name, private: pkg(`${path}/package.json`).private }).toEqual({ name, private: undefined });
    }
  });

  it('the release tooling bumps, stages and publishes every one of them', () => {
    // Version alignment above is a fact about today's tree; these assertions are what
    // keeps it true across the next release. Every file here is edited by hand.
    const bump = readFileSync(join(repoRoot, 'scripts/bump-all.sh'), 'utf8');
    const release = readFileSync(join(repoRoot, 'codev/protocols/release/protocol.md'), 'utf8');
    const publishLines = release.split('\n').filter((l) => l.startsWith('pnpm publish --filter'));
    const stagingLines = release.split('\n').filter((l) => l.startsWith('git add package.json'));
    // Without these the loops below pass vacuously if the protocol is ever restructured.
    expect(publishLines.length).toBeGreaterThan(0);
    expect(stagingLines.length).toBeGreaterThan(0);

    for (const { name, path } of workspaceDeps()) {
      expect({ name, inBump: bump.includes(path) }).toEqual({ name, inBump: true });
      for (const line of publishLines) {
        expect({ name, published: line.includes(`--filter '${name}'`) }).toEqual({ name, published: true });
      }
      for (const line of stagingLines) {
        expect({ name, staged: line.includes(`${path}/package.json`) }).toEqual({ name, staged: true });
      }
    }
  });

  it('local-install packs and installs every one of them', () => {
    // `pnpm -w run local-install` is the step that makes a merged change visible to
    // Tower, and it runs far more often than a release. `pnpm pack` rewrites
    // `workspace:*` the same way `pnpm publish` does, so a dependency missing here
    // makes npm resolve it from the registry and the install fails before Tower restarts.
    const script = readFileSync(join(repoRoot, 'scripts/local-install.sh'), 'utf8');
    const uninstallLine = script.split('\n').find((l) => l.startsWith('npm uninstall -g '));
    expect(uninstallLine).toBeDefined();

    for (const { name, path } of workspaceDeps()) {
      expect({ name, packed: script.includes(`pnpm --filter ${name} pack`) })
        .toEqual({ name, packed: true });
      expect({ name, uninstalled: uninstallLine!.includes(` ${name}`) })
        .toEqual({ name, uninstalled: true });
      expect({ name, installed: script.includes(`$REPO_ROOT/${path}/`) })
        .toEqual({ name, installed: true });
    }
  });

  it('the production engine does not import porch-driver by a relative path out of the package', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/porch-thread-engine.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from '\.\..*porch-driver/);
    expect(src).toContain("from '@cluesmith/porch-driver/thread'");
  });
});

describe('Spec 146 Phase 9 — production spawn wiring (#179 item 2)', () => {
  let dir: string | undefined;

  afterEach(() => {
    setThreadEngine(undefined);
    setSpawnThreadFactory(undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function workspace(config?: unknown): string {
    dir = mkdtempSync(join(tmpdir(), 'phase9-backend-'));
    if (config !== undefined) {
      mkdirSync(join(dir, '.codev'), { recursive: true });
      writeFileSync(join(dir, '.codev', 'config.json'), JSON.stringify(config));
    }
    return dir;
  }

  it('a workspace with no t3code server configured stays on the PTY path', async () => {
    const root = workspace();
    await expect(ensureThreadBackendReady(root)).resolves.toBe('not-configured');
    expect(chooseSpawnPath()).toBe('pty');
  });

  it('a config with no threads block is not configured', () => {
    expect(readThreadBackendConfig(workspace({ shell: {} }))).toBeNull();
  });

  it('an unparseable config throws rather than reading as not-configured', () => {
    // A config file that cannot be parsed is "I could not tell", and returning null would
    // spell it the same way as "this workspace has no server", which is a decision.
    dir = mkdtempSync(join(tmpdir(), 'phase9-backend-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(join(dir, '.codev', 'config.json'), '{ not json');
    expect(() => readThreadBackendConfig(dir!)).toThrow(/is not valid JSON/);
  });

  it('a half-configured threads block throws rather than silently staying on PTY', () => {
    expect(() => readThreadBackendConfig(workspace({ threads: { serverUrl: 'http://127.0.0.1:3799' } })))
      .toThrow(/bootstrapToken=missing/);
    expect(() => readThreadBackendConfig(workspace({ threads: { bootstrapToken: 'tok' } })))
      .toThrow(/serverUrl=missing/);
  });

  it('reads a complete threads block', () => {
    const config = readThreadBackendConfig(workspace({
      threads: { serverUrl: 'http://127.0.0.1:3799', bootstrapToken: 'tok', harness: 'codex', model: 'm' },
    }));
    expect(config).toMatchObject({
      serverUrl: 'http://127.0.0.1:3799',
      bootstrapToken: 'tok',
      defaultHarness: 'codex',
      defaultModel: 'm',
    });
  });

  it('a configured but unreachable server throws — it is not spelled the same way as unconfigured', async () => {
    // Port 1 is reserved and refuses; the point is that this does NOT resolve to
    // 'not-configured' and does NOT leave the caller quietly on the PTY path.
    const root = workspace({ threads: { serverUrl: 'http://127.0.0.1:1', bootstrapToken: 'tok' } });
    await expect(ensureThreadBackendReady(root)).rejects.toThrow(/could not be reached/);
  });

  it('an already-registered engine is left alone', async () => {
    setThreadEngine(createMemoryThreadEngine());
    await expect(ensureThreadBackendReady(workspace())).resolves.toBe('already-installed');
  });

  it('launchSpawnedBuilder forwards the mission to the factory, not only to the PTY closure', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setSpawnThreadFactory(async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return 'thr-1';
    });
    const identity = await launchSpawnedBuilder({
      existing: { threadId: undefined, terminalId: undefined },
      builderId: 'b1',
      worktreePath: '/tmp/wt',
      branch: 'builder/b1',
      prompt: 'IMPLEMENT ISSUE 179',
      roleContent: 'YOU ARE A BUILDER',
      roleFilePath: '/tmp/wt/.builder-role.md',
      startPty: async () => {
        throw new Error('the thread path must not fall through to the PTY');
      },
    });

    expect(identity).toEqual({ threadId: 'thr-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prompt: 'IMPLEMENT ISSUE 179',
      roleContent: 'YOU ARE A BUILDER',
      roleFilePath: '/tmp/wt/.builder-role.md',
    });
  });

  it('every spawn call site gives the thread path something to run', () => {
    // The behaviour test above proves the forwarding; this proves the call sites
    // actually use it. They passed the generated prompt only into their `startPty`
    // closure, so on the thread path the engine got `prompt: undefined`, never began a
    // turn, and produced a thread that had been told nothing. Nothing in the suite
    // noticed, because the parity test asserted an in-memory `launched` boolean.
    //
    // A worktree spawn is the one form with no prompt by definition — its payload is
    // the launch script — so either satisfies this.
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn.ts'),
      'utf8',
    );
    const calls: string[] = [];
    let from = src.indexOf('await launchSpawnedBuilder({');
    while (from !== -1) {
      const end = src.indexOf('\n  });', from);
      expect(end).toBeGreaterThan(from);
      calls.push(src.slice(from, end));
      from = src.indexOf('await launchSpawnedBuilder({', end);
    }
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const [index, call] of calls.entries()) {
      expect({ index, carriesPayload: /\n\s+(prompt[,:]|launchScript:)/.test(call) })
        .toEqual({ index, carriesPayload: true });
    }
  });

  it('launchSpawnedBuilder calls the wiring — the production caller exists', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn.ts'),
      'utf8',
    );
    expect(src).toContain('ensureThreadBackendReady');
    // ...and before the path decision, or it could never change the outcome.
    expect(src.indexOf('ensureThreadBackendReady(opts.workspaceRoot)'))
      .toBeLessThan(src.indexOf('const pathKind = chooseSpawnPath'));
  });
});
