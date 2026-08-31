/**
 * Spec 250, Phase 6 — `porch-driver` publishes the hierarchy.
 *
 * Phase 2 put `role` and `parentThreadId` in the fork's contract, phase 3 made
 * the server refuse illegal edges, and phase 5 made this repository's vendored
 * contract able to describe them. None of that produced a single thread with a
 * parent: nothing was sending the fields. This is the phase where the producer
 * starts, so these tests are about the PAYLOAD that leaves and the refusals that
 * never become payloads at all.
 *
 * The refusal half matters more than it looks. Two of the fork's six hierarchy
 * reasons — `builder-without-parent` and `parent-on-non-builder` — need no
 * projection to decide, so a client that ships them to the server is asking a
 * round trip to tell it something it already knew, and burning a `thread.create`
 * plus a worktree to find out.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DriverThread,
  HIERARCHY_REFUSAL_REASONS,
  HierarchyRefusedError,
  localHierarchyRefusal,
} from '../../../porch-driver/src/thread.js';
import { DispatchJournal } from '../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../porch-driver/src/turn.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const pin = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'),
);

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `spec250-p6-${label}-`));
}

function recordingDispatcher(reply: (method: string, payload: unknown) => unknown = () => ({})) {
  const calls: Array<{ method: string; payload: any }> = [];
  return {
    calls,
    async call(method: string, payload: unknown) {
      calls.push({ method, payload });
      return reply(method, payload);
    },
  };
}

function deps(dir: string) {
  return {
    dispatcher: recordingDispatcher(),
    journal: new DispatchJournal(join(dir, 'commands.jsonl')),
    tracker: new TurnTracker(),
  };
}

const baseOptions = (dir: string) => ({
  projectId: 'prj-1',
  title: 'a builder',
  harnessName: 'claude',
  model: 'sonnet',
  worktreePath: dir,
  branch: 'builder/x',
});

// ------------------------------------------------------------ the payload

describe('spec 250: thread.create carries the hierarchy', () => {
  it('sends role and parentThreadId for a builder', async () => {
    const dir = scratch('builder');
    try {
      const d = deps(dir);
      await DriverThread.create(d, {
        ...baseOptions(dir),
        role: 'builder',
        parentThreadId: 'thr-architect',
      });
      const create = d.dispatcher.calls.find((c) => c.payload?.type === 'thread.create');
      expect(create, 'no thread.create was dispatched').toBeDefined();
      expect(create!.payload.role).toBe('builder');
      expect(create!.payload.parentThreadId).toBe('thr-architect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends role and no parent for an architect', async () => {
    const dir = scratch('architect');
    try {
      const d = deps(dir);
      // The shape `createArchitectThread` produces: the workspace root as the
      // worktree, and an empty branch that `create` turns into null.
      await DriverThread.create(d, { ...baseOptions(dir), branch: '', role: 'architect' });
      const create = d.dispatcher.calls.find((c) => c.payload?.type === 'thread.create')!;
      expect(create.payload.role).toBe('architect');
      expect('parentThreadId' in create.payload).toBe(false);
      expect(create.payload.branch).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The upstream-compatibility case, and the reason the keys are omitted rather
   * than nulled.
   *
   * A caller that names no role must produce the payload it produced before this
   * spec existed — byte for byte, so an upstream t3code server that has never
   * heard of these fields sees nothing new. `role: null` would be a new key on
   * every create.
   */
  it('sends neither key when the caller names no role', async () => {
    const dir = scratch('unowned');
    try {
      const d = deps(dir);
      await DriverThread.create(d, baseOptions(dir));
      const create = d.dispatcher.calls.find((c) => c.payload?.type === 'thread.create')!;
      expect('role' in create.payload).toBe(false);
      expect('parentThreadId' in create.payload).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ local refusals

describe('spec 250: the two refusals that need no server', () => {
  it('names the reason for each decidable case, and null otherwise', () => {
    expect(localHierarchyRefusal({ role: 'builder' })).toBe('builder-without-parent');
    expect(localHierarchyRefusal({ role: 'builder', parentThreadId: null })).toBe('builder-without-parent');
    expect(localHierarchyRefusal({ role: 'builder', parentThreadId: 'thr-a' })).toBeNull();

    expect(localHierarchyRefusal({ role: 'architect', parentThreadId: 'thr-a' })).toBe('parent-on-non-builder');
    // No role at all, with a parent. The fork's reason covers this case too, and
    // spelling it something else here would give a caller two vocabularies.
    expect(localHierarchyRefusal({ parentThreadId: 'thr-a' })).toBe('parent-on-non-builder');

    expect(localHierarchyRefusal({ role: 'architect' })).toBeNull();
    expect(localHierarchyRefusal({})).toBeNull();
  });

  /**
   * Refused BEFORE the worktree is written, not after.
   *
   * A refusal that has already laid down guard files, a role file and a settings
   * merge has changed a directory on the strength of a create that was never
   * going to happen. The assertion is on the directory, not on the error: an
   * error thrown one line later would satisfy a test that only checked it threw.
   */
  it('refuses a parentless builder before touching the worktree or the wire', async () => {
    const dir = scratch('refused');
    try {
      const d = deps(dir);
      await expect(
        DriverThread.create(d, { ...baseOptions(dir), role: 'builder' }),
      ).rejects.toThrow(HierarchyRefusedError);

      expect(d.dispatcher.calls, 'a refused create must dispatch nothing').toHaveLength(0);
      expect(
        existsSync(join(dir, '.claude')),
        'the worktree was set up for a thread that was never created',
      ).toBe(false);
      // The journal is written by `dispatchCommand`, which was never reached.
      expect(existsSync(join(dir, 'commands.jsonl'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the reason and the offending ids on the error', async () => {
    const dir = scratch('reason');
    try {
      const d = deps(dir);
      const error = await DriverThread.create(d, {
        ...baseOptions(dir),
        threadId: 'thr-new',
        role: 'architect',
        parentThreadId: 'thr-a',
      }).catch((e: unknown) => e as HierarchyRefusedError);

      expect(error).toBeInstanceOf(HierarchyRefusedError);
      expect(error.reason).toBe('parent-on-non-builder');
      expect(error.threadId).toBe('thr-new');
      expect(error.parentThreadId).toBe('thr-a');
      // The same sentence shape the server produces, so a log line does not
      // change meaning depending on which side refused.
      expect(error.message).toContain('Codev hierarchy invalid (thread.create, parent-on-non-builder)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ the copied list

/**
 * The reason vocabulary is COPIED into this package, and a copy that nothing
 * checks is a copy that drifts.
 *
 * It cannot be imported: `porch-driver` does not depend on the fork, and the
 * vendored contract carries RPC payload schemas rather than error schemas, so
 * `CodevHierarchyInvalidReason` is not in `generated/`. So it is checked against
 * the fork's source when the checkout is present, and SKIPS — loudly, naming the
 * checkout — when it is not. A missing checkout is "I could not compare", which
 * is not "they agree".
 */
describe('spec 250: the copied reason list agrees with the fork', () => {
  const forkRoot = process.env.T3CODE_FORK_ROOT ?? '/Users/chris/dev/t3code-codev';
  const errorsPath = join(forkRoot, 'apps', 'server', 'src', 'orchestration', 'Errors.ts');

  it.skipIf(!existsSync(errorsPath))('names the same six reasons, in the fork', () => {
    const source = execFileSync(
      'git',
      ['-C', forkRoot, 'show', `${pin.commit}:apps/server/src/orchestration/Errors.ts`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const start = source.indexOf('export const CodevHierarchyInvalidReason = Schema.Literals([');
    expect(start, 'could not find CodevHierarchyInvalidReason in the fork').toBeGreaterThan(-1);
    const end = source.indexOf(']);', start);
    // Whole lines that are only a quoted literal. A bare `/"([a-z-]+)"/` also
    // matches the doc comments above each entry — they quote `role: "builder"`
    // and `role: "architect"` — which is how the first draft of this test
    // "found" eight reasons and disagreed with a list that was correct.
    const forkReasons = [...source.slice(start, end).matchAll(/^\s*"([a-z-]+)",?\s*$/gm)].map((m) => m[1]);

    expect(forkReasons.length, 'extracted no reasons, so this would pass against anything')
      .toBeGreaterThan(3);
    expect([...forkReasons].sort()).toEqual([...HIERARCHY_REFUSAL_REASONS].sort());
  });
});
