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

  /**
   * The spawn payload — #179 item 2's real substance.
   *
   * Reaching the thread path is not the same as spawning a builder on it. Every
   * `launchSpawnedBuilder` call site passed the generated prompt only into its
   * `startPty` closure, so the engine received `prompt: undefined`, never began a turn,
   * and produced a thread that exists and has been told nothing. The parity test could
   * not see it: it asserted an in-memory `launched` boolean, not a dispatched turn.
   */
  function engineOn(dispatcher: ReturnType<typeof recordingDispatcher>, root: string) {
    return createPorchThreadEngine({
      dispatcher,
      journal: new DispatchJournal(join(root, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: root,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
    });
  }

  const turnStarts = (dispatcher: ReturnType<typeof recordingDispatcher>) =>
    dispatcher.calls.filter((c) => (c.payload as { type?: string }).type === 'thread.turn.start');

  it('create begins the builder-s first turn with the prompt it was given', async () => {
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-prompt-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    const threadId = await engineOn(dispatcher, dir).create({
      builderId: 'air-173',
      worktreePath,
      branch: 'b',
      prompt: 'IMPLEMENT ISSUE 179',
    });

    const started = turnStarts(dispatcher);
    expect(started).toHaveLength(1);
    const payload = started[0].payload as { threadId: string; message: { text: string } };
    expect(payload.threadId).toBe(threadId);
    expect(payload.message.text).toContain('IMPLEMENT ISSUE 179');
  });

  it('create carries the role into that first turn', async () => {
    // `DriverThread` joins a pending role onto the first turn; the engine previously
    // dropped `roleContent` on the floor, so a thread-backed builder came up with no
    // role at all while the PTY path gave it one.
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-role-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    await engineOn(dispatcher, dir).create({
      builderId: 'air-173',
      worktreePath,
      branch: 'b',
      prompt: 'IMPLEMENT ISSUE 179',
      roleContent: 'YOU ARE A BUILDER',
      roleFilePath: join(worktreePath, '.builder-role.md'),
    });

    const started = turnStarts(dispatcher);
    expect(started).toHaveLength(1);
    const { message } = started[0].payload as { message: { text: string } };
    const text = message.text;
    expect(text).toContain('YOU ARE A BUILDER');
    expect(text).toContain('IMPLEMENT ISSUE 179');
  });

  it('create with no prompt starts no turn — an idle thread, which is the bug', async () => {
    // The control for the two above. Without it they would still pass if `create`
    // began a turn unconditionally, and this is the state every call site produced.
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-idle-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    const threadId = await engineOn(dispatcher, dir).create({
      builderId: 'air-173', worktreePath, branch: 'b',
    });

    expect(turnStarts(dispatcher)).toHaveLength(0);
    expect(threadId).toBeTruthy();
  });

  it('activeTurnId is non-null while a turn runs and is not the invented turn-<threadId>', async () => {
    // It was written as `turn-${threadId}` and cleared only by `interrupt`, so a turn
    // that settled normally left the record claiming one was still running, and the id
    // was invented rather than the server's. It is now the dispatched command's id until
    // the server names the turn.
    dir = mkdtempSync(join(tmpdir(), 'porch-engine-active-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const dispatcher = recordingDispatcher();
    const engine = engineOn(dispatcher, dir);
    const threadId = await engine.create({ builderId: 'air-173', worktreePath, branch: 'b' });
    expect(engine.get(threadId)?.activeTurnId).toBeNull();

    await engine.startTurn(threadId, 'go');
    const active = engine.get(threadId)?.activeTurnId;
    expect(active).toBeTruthy();
    expect(active).not.toBe(`turn-${threadId}`);
    expect(active).toBe((turnStarts(dispatcher)[0].payload as { commandId: string }).commandId);
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
