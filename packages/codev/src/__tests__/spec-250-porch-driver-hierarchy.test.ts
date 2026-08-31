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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
 * The reason vocabulary is COPIED into `porch-driver`, and the copy is checked.
 *
 * It cannot be imported there: `porch-driver` has no dependency on
 * `@cluesmith/codev-types` and acquiring one to read six string literals would be
 * the wrong trade. So the check lives here, where the generated contract already
 * is.
 *
 * Phase 6 made this checkable IN THIS REPOSITORY. The reasons used to be declared
 * only in the fork's `apps/server/src/orchestration/Errors.ts`, so the check
 * needed a fork checkout and skipped without one — a copy verified only on the
 * machine that wrote it. They now travel on
 * `OrchestrationDispatchCommandError.refusal`, so they are in the contract and in
 * `generated/schema.json`, and this runs everywhere.
 */
describe('spec 250: the copied reason list agrees with the vendored contract', () => {
  const document = JSON.parse(
    readFileSync(join(repoRoot, 'packages/types/src/t3/generated/schema.json'), 'utf8'),
  );

  it('names the same six hierarchy reasons the contract declares', () => {
    const vendored: string[] = document.schemas.OrchestrationDispatchRefusal.properties.reason.enum;
    expect(vendored.length, 'the refusal schema was not vendored').toBeGreaterThan(6);

    // The gate reasons share the union and are SCREAMING_CASE; the hierarchy ones
    // are kebab-case. Partitioning on shape rather than on a second hand-written
    // list is what keeps this from being the copy it is checking.
    const hierarchy = vendored.filter((reason) => reason === reason.toLowerCase());
    expect([...hierarchy].sort()).toEqual([...HIERARCHY_REFUSAL_REASONS].sort());
  });

  /**
   * The gate half is checked too, because they share one union on the wire.
   *
   * A gate reason arriving where a hierarchy reason was expected is a real
   * possibility now — `refusal.reason` is one field — and a client that switches
   * only on the six would fall through on four it never heard of.
   */
  it('carries the gate reasons in the same union, so a client must handle both', () => {
    const vendored: string[] = document.schemas.OrchestrationDispatchRefusal.properties.reason.enum;
    const gate = vendored.filter((reason) => reason === reason.toUpperCase());
    expect(gate.length).toBeGreaterThan(0);
    expect(gate.every((reason) => reason.startsWith('CODEV_GATE_'))).toBe(true);
  });

  /**
   * And still against the fork's own source when the checkout is present — the
   * vendored artifacts are generated from it, so agreeing with them is agreeing
   * with a derivative. Skips loudly rather than passing when there is nothing to
   * compare against.
   */
  const forkRoot = process.env.T3CODE_FORK_ROOT ?? '/Users/chris/dev/t3code-codev';
  const contractPath = join(forkRoot, 'packages', 'contracts', 'src', 'orchestration.ts');

  it.skipIf(!existsSync(contractPath))('agrees with the fork contract at pin.commit', () => {
    const source = execFileSync(
      'git',
      ['-C', forkRoot, 'show', `${pin.commit}:packages/contracts/src/orchestration.ts`],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const start = source.indexOf('export const CodevHierarchyInvalidReason = Schema.Literals([');
    expect(start, 'could not find CodevHierarchyInvalidReason in the fork contract').toBeGreaterThan(-1);
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

// ------------------------------------------------------------ the wire

/**
 * The last hop, recorded.
 *
 * Phase 6's acceptance criterion is a LIVE round trip: dispatch an illegal edge
 * over a socket and assert the client can still tell "no such parent" from "wrong
 * parent role". A unit suite cannot do that — it needs a server built from the
 * fork's source, two auth exchanges and a WebSocket. So the run happens in
 * `packages/t3-client/live/spec-250-hierarchy.mjs` and this asserts what it
 * recorded.
 *
 * The first run of that script FAILED, and that failure is the reason the fork
 * carries a `refusal` field at all: every discriminant arrived inside `message`,
 * as English. Phase 3 fixed the engine deleting them; the ws layer was flattening
 * them one hop further out, with every test beneath it green.
 *
 * Reproduce:
 *   export T3_NODE=/absolute/path/to/node T3CODE_FORK_ROOT=/path/to/fork
 *   export T3_HARNESS_PORT=<free port> T3_HARNESS_DIR=<scratch dir>
 *   node packages/t3-client/live/spec-250-hierarchy.mjs \
 *     --out codev/research/250-hierarchy-wire-evidence.json
 */
describe('spec 250: the refusal discriminant survives the ws boundary', () => {
  const evidencePath = join(repoRoot, 'codev', 'research', '250-hierarchy-wire-evidence.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

  it('was recorded against the fork commit this repo pins', () => {
    expect(
      evidence.forkCommit,
      'the wire evidence describes a different fork commit than the contract was generated from',
    ).toBe(pin.commit);
  });

  it('every claim held', () => {
    const failed = evidence.claims.filter((claim: { passed: boolean }) => !claim.passed);
    expect(failed.map((c: { name: string }) => c.name)).toEqual([]);
    expect(evidence.passed).toBe(true);
  });

  /**
   * FOUR DISTINCT reasons, asserted here and not only in the script.
   *
   * "It refused" is satisfied by a single opaque failure. The criterion is that a
   * client can distinguish them, which needs the reasons to arrive intact AND to
   * differ — so the evidence is read for the reasons themselves rather than for
   * the script's own verdict on them.
   */
  it('carries four different reasons, each a member of the contract union', () => {
    const document = JSON.parse(
      readFileSync(join(repoRoot, 'packages/types/src/t3/generated/schema.json'), 'utf8'),
    );
    const declared: string[] = document.schemas.OrchestrationDispatchRefusal.properties.reason.enum;

    const observed = Object.entries<{ kind: string; reason?: string; tag?: string }>(evidence.observed);
    expect(observed.length).toBe(4);
    for (const [name, outcome] of observed) {
      expect(outcome.kind, `${name} did not come back as a refusal`).toBe('refused');
      expect(outcome.reason, `${name} came back under a different reason`).toBe(name);
      expect(declared, `${outcome.reason} is not in the vendored reason union`).toContain(outcome.reason);
      expect(outcome.tag).toBe('CodevHierarchyInvalidError');
    }
    expect(new Set(observed.map(([, o]) => o.reason)).size).toBe(4);
  });

  /**
   * Recorded evidence can outlive the code it describes.
   *
   * The same guard `spec-146-t3-contract.test.ts` puts on the cold-start run, for
   * the same reason: nothing else stops the ws layer changing while a green JSON
   * file says the discriminant still travels.
   */
  it('is not older than the code it is evidence for', () => {
    const evidenceAge = statSync(evidencePath).mtimeMs;
    const sources = [
      join(repoRoot, 'packages', 't3-client', 'live', 'spec-250-hierarchy.mjs'),
      join(repoRoot, 'tools', 't3-server', 't3-server.mjs'),
      // The CLIENT's read path, which review pointed out was missing. The whole
      // claim is that a client can read the discriminant, and `envelope.ts` is
      // where `RpcFailureError` decides what `error` and `tag` mean. A change
      // there could stop the reading working while this evidence stayed green.
      join(repoRoot, 'packages', 't3-client', 'src', 'envelope.ts'),
      join(repoRoot, 'packages', 't3-client', 'src', 'client.ts'),
    ];
    for (const source of sources) {
      expect(
        evidenceAge,
        `${source} changed after the wire evidence was recorded — re-run it with\n`
          + `  export T3_NODE=/absolute/path/to/node T3CODE_FORK_ROOT=/path/to/fork\n`
          + `  export T3_HARNESS_PORT=<free port> T3_HARNESS_DIR=<scratch dir>\n`
          + `  node packages/t3-client/live/spec-250-hierarchy.mjs --out `
          + `codev/research/250-hierarchy-wire-evidence.json\n`
          + `rather than trusting a stale result.`,
      ).toBeGreaterThanOrEqual(statSync(source).mtimeMs - 1000);
    }
  });
});
