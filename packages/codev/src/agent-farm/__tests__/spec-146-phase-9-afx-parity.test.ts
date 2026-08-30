import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchSpawnedBuilder } from '../commands/spawn.js';
import { isBuilderRunning } from '../commands/status.js';
import { cleanupThreadBackedBuilder } from '../commands/cleanup.js';
import {
  chooseSpawnPath,
  setSpawnThreadFactory,
  setThreadBackedSpawnsEnabled,
} from '../db/thread-identity.js';
import {
  createArchitectThread,
  createMemoryThreadEngine,
  deliverThreadTurn,
  installThreadSpawnFactory,
  interruptThread,
  refuseUnsupportedThreadCommand,
  setThreadEngine,
  THREAD_BACKED_UNSUPPORTED,
  worktreeForThreadBuilder,
} from '../thread-runtime.js';
import type { Builder } from '../types.js';

vi.mock('../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/index.js')>();
  return {
    ...actual,
    getConfig: () => ({
      workspaceRoot: '/ws',
      codevDir: '/ws/codev',
      buildersDir: '/ws/.builders',
    }),
  };
});

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return { ...actual, removeBuilder: vi.fn() };
});

function threadBuilder(threadId: string, worktree: string): Builder {
  return {
    id: 'air-173',
    name: 'phase-9',
    status: 'implementing',
    phase: 'init',
    worktree,
    branch: 'builder/air-173',
    type: 'spec',
    threadId,
  };
}

describe('Spec 146 Phase 9 — afx command parity against a thread-backed builder', () => {
  afterEach(() => {
    setThreadEngine(undefined);
    setSpawnThreadFactory(undefined, undefined);
    setThreadBackedSpawnsEnabled(true);
  });

  it('installThreadSpawnFactory registers the factory and chooseSpawnPath returns thread', () => {
    setThreadEngine(createMemoryThreadEngine());
    expect(chooseSpawnPath(undefined, undefined)).toBe('pty');
    installThreadSpawnFactory(undefined);
    expect(chooseSpawnPath(undefined, undefined)).toBe('thread');
  });

  it('launchSpawnedBuilder takes the thread path and launches the worktree session', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine);
    installThreadSpawnFactory(undefined);
    const pty = async () => ({ terminalId: 'term-should-not-run' });
    const identity = await launchSpawnedBuilder({
      builderId: 'worktree-9',
      worktreePath: '/ws/.builders/worktree-9',
      branch: 'builder/worktree-9',
      launchScript: '/ws/.builders/worktree-9/.builder-start.sh',
      startPty: pty,
    });
    expect(identity.threadId).toBe('thr-worktree-9');
    expect(engine.get('thr-worktree-9')?.launched).toBe(true);
  });

  it('deliverThreadTurn starts a turn on the thread', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine);
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath: '/ws/.builders/air-173', branch: 'builder/air-173',
    });
    await deliverThreadTurn(threadId, 'hello');
    expect(engine.get(threadId)?.activeTurnId).toBe(`turn-${threadId}`);
  });

  it('isBuilderRunning is true for a thread-backed builder with no terminalId', () => {
    expect(isBuilderRunning(threadBuilder('thr-air-173', '/ws/.builders/air-173'))).toBe(true);
  });

  it('interruptThread settles activeTurnId to null', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine);
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath: '/ws/.builders/air-173', branch: 'builder/air-173',
    });
    await deliverThreadTurn(threadId, 'sleep 30');
    expect(engine.get(threadId)?.activeTurnId).not.toBeNull();
    const settled = await interruptThread(threadId);
    expect(settled.activeTurnId).toBeNull();
    expect(engine.get(threadId)?.activeTurnId).toBeNull();
  });

  it('cleanupThreadBackedBuilder refuses when isWorktreeMerged is false', async () => {
    const engine = createMemoryThreadEngine();
    // Registered FOR '/ws', which is what `getConfig().workspaceRoot` returns here.
    // Since #219 the engine map is keyed by workspace and a keyed read never falls
    // back — an engine registered for another workspace holds another server.
    setThreadEngine(engine, '/ws');
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath: '/tmp/missing-air-173', branch: 'builder/air-173',
    });
    const result = await cleanupThreadBackedBuilder(threadBuilder(threadId, '/tmp/missing-air-173'));
    expect(result).toBe('refused-unmerged');
    expect(engine.get(threadId)).toBeDefined();
  });

  it('cleanupThreadBackedBuilder removes a thread-backed builder when force is set', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine, '/ws');
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath: '/tmp/missing-air-173', branch: 'builder/air-173',
    });
    const result = await cleanupThreadBackedBuilder(threadBuilder(threadId, '/tmp/missing-air-173'), true);
    expect(result).toBe('removed');
    expect(engine.get(threadId)).toBeUndefined();
  });

  it('worktreeForThreadBuilder resolves the worktree from the thread', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine, '/ws');
    const threadId = await engine.create({
      builderId: 'air-173', worktreePath: '/ws/.builders/air-173', branch: 'builder/air-173',
    });
    expect(worktreeForThreadBuilder({ threadId, worktree: '/stale' }, '/ws')).toBe('/ws/.builders/air-173');
  });

  it('createArchitectThread roots the thread at the workspace', async () => {
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine, '/ws');
    const threadId = await createArchitectThread({ name: 'uiv2', workspaceRoot: '/ws' });
    expect(engine.get(threadId)?.worktreePath).toBe('/ws');
    expect(engine.get(threadId)?.launched).toBe(true);
  });
});

describe('Spec 146 Phase 9 — thread-backed unsupported commands', () => {
  it('refuseUnsupportedThreadCommand throws thread-backed, unsupported here', () => {
    expect(() => refuseUnsupportedThreadCommand({ threadId: 'thr-1' }))
      .toThrow(THREAD_BACKED_UNSUPPORTED);
  });

  it('refuseUnsupportedThreadCommand does not throw for a row with no threadId', () => {
    expect(() => refuseUnsupportedThreadCommand({ threadId: undefined })).not.toThrow();
  });

  it('attach.ts lists a thread-backed builder without throwing', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../commands/attach.ts'), 'utf8');
    expect(src).toMatch(/if \(isThreadBacked\(builder\)\)/);
    expect(src).not.toMatch(/for \(const builder of builders\) \{\s*refuseUnsupportedThreadCommand/);
  });

  it('stop.ts continues past a thread-backed row instead of throwing', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../commands/stop.ts'), 'utf8');
    expect(src).toMatch(/if \(isThreadBacked\(builder\)\) \{\s*logger\.info/);
    expect(src).not.toMatch(/for \(const builder of state\.builders\) \{\s*refuseUnsupportedThreadCommand/);
  });

  it('reset.ts source calls refuseUnsupportedThreadCommand before buildTerminalPort', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../commands/reset.ts'), 'utf8');
    expect(src).toMatch(/refuseUnsupportedThreadCommand\(builder\)[\s\S]*buildTerminalPort/);
  });
});
