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
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseSpawnPath, setSpawnThreadFactory } from '../db/thread-identity.js';
import { setThreadEngine, createMemoryThreadEngine } from '../thread-runtime.js';
import { ensureThreadBackendReady, readThreadBackendConfig } from '../thread-backend.js';

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
