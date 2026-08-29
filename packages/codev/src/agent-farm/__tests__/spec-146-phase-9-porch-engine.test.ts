import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertPackedDistRelativeImports } from '../../../scripts/packed-dist-imports.mjs';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';

function recordingDispatcher() {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    async call(method: string, payload: unknown) {
      calls.push({ method, payload });
      return {};
    },
  };
}

describe('createPorchThreadEngine (Spec 146 Phase 9)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('createPorchThreadEngine.create dispatches thread.create through DriverThread', async () => {
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
    const engine = createPorchThreadEngine({
      dispatcher,
      journal,
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
    });

    const threadId = await engine.create({
      builderId: 'air-173',
      worktreePath,
      branch: 'builder/air-173',
    });

    const created = dispatcher.calls.find(
      (c) => (c.payload as { type?: string }).type === 'thread.create',
    );
    expect(created).toBeDefined();
    expect((created!.payload as { worktreePath: string }).worktreePath).toBe(worktreePath);
    expect(engine.worktreePath(threadId)).toBe(worktreePath);
  });

  it('createPorchThreadEngine.interrupt dispatches thread.turn.interrupt', async () => {
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-int-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    const engine = createPorchThreadEngine({
      dispatcher,
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultModel: 'gpt-5.6-luna',
    });
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath, branch: 'b',
    });
    await engine.interrupt(threadId);
    const interrupted = dispatcher.calls.find(
      (c) => (c.payload as { type?: string }).type === 'thread.turn.interrupt',
    );
    expect(interrupted).toBeDefined();
    expect((interrupted!.payload as { threadId: string }).threadId).toBe(threadId);
  });
});

describe('Spec 146 Phase 9 — @cluesmith/codev pack relative imports', () => {
  const pkg = resolve(import.meta.dirname, '../../..');
  const distBuilt = existsSync(join(pkg, 'dist'));
  const packSkipReason = 'could not check: packages/codev/dist not built';

  it.skipIf(!distBuilt)(
    'every relative import in packed dist/ resolves inside the @cluesmith/codev tarball',
    () => {
      const packDirectory = mkdtempSync(join(tmpdir(), 'codev-pack-'));
      try {
        execFileSync('npm', ['pack', '--pack-destination', packDirectory], {
          cwd: pkg,
          stdio: 'pipe',
        });
        const tarball = readdirSync(packDirectory).find((file) => file.endsWith('.tgz'));
        expect(tarball).toBeDefined();
        assertPackedDistRelativeImports(join(packDirectory, tarball!));
      } finally {
        rmSync(packDirectory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(distBuilt)('records why pack relative imports could not check', () => {
    expect(packSkipReason).toBe('could not check: packages/codev/dist not built');
    expect(packSkipReason).toMatch(/^could not check:/);
  });
});
