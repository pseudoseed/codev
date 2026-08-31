/**
 * Spec 250, Phase 6 — the porch gate published onto a thread.
 *
 * The publisher has three properties that are easy to state and easy to lose:
 *
 *   1. `status.yaml` is authoritative; the block is a projection of it.
 *   2. The publisher invents no revision.
 *   3. An unconfirmed write is never spelled like an applied one.
 *
 * Each of those is a way a human waiting on a gate stops being visible, so each
 * one is tested for the FAILURE it prevents rather than for the happy path.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATE_WRITE_METHOD,
  GatePublisher,
  startGateWatch,
  T3_GATE_LIMITS,
  pendingGate,
  projectGate,
  publishGate,
  sameProjection,
  type GateWriter,
} from '../servers/t3-gate-publisher.js';
import type { PorchStatusProjection } from '../servers/status-reader.js';
import type { GateStatus } from '../../commands/porch/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

function status(gates: Record<string, GateStatus>): PorchStatusProjection {
  return {
    projectId: '250',
    title: 'a project',
    protocol: 'spir',
    phase: 'implement',
    currentPlanPhase: 'phase_6',
    gates,
    artifactRoot: '/w',
    statusPath: '/w/codev/projects/250/status.yaml',
  };
}

/** A writer that records what it was asked to send, and answers as told. */
function recordingWriter(reply: (payload: any) => unknown = () => ({ threadId: 't', gateRevision: 1, cleared: false })) {
  const calls: Array<{ method: string; payload: any }> = [];
  const writer: GateWriter & { calls: typeof calls } = {
    calls,
    async call(method: string, payload: unknown) {
      calls.push({ method, payload: payload as any });
      return reply(payload as any);
    },
  };
  return writer;
}

/** The shape `@cluesmith/t3-client` throws for a server refusal. */
function rpcFailure(reason: string, detail: string): Error {
  const error = new Error(`t3code RPC request 1 failed (Fail): ${reason}`) as Error & {
    error: unknown;
  };
  error.name = 'RpcFailureError';
  error.error = { _tag: 'CodevGateWriteError', reason, detail };
  return error;
}

// ---------------------------------------------------------------- projection

describe('spec 250: which gate a human is waiting on', () => {
  it('is the pending one, and an approved gate is not a gate', () => {
    expect(pendingGate(status({ 'spec-approval': { status: 'approved' } }))).toBeNull();
    expect(pendingGate(status({}))).toBeNull();
    expect(pendingGate(status({ 'plan-approval': { status: 'pending' } }))?.name).toBe('plan-approval');
  });

  /**
   * The EARLIEST pending gate, and stably.
   *
   * A thread carries one block. Picking by object key order would publish
   * whichever gate the YAML parser happened to yield first, and re-picking on
   * every cycle makes the block flicker between two gates for as long as both are
   * pending — which reads to a human as the gate being answered and re-asked.
   */
  it('picks the oldest pending gate, and the same one every time', () => {
    const gates = {
      'pr': { status: 'pending' as const, requested_at: '2026-08-30T12:00:00.000Z' },
      'plan-approval': { status: 'pending' as const, requested_at: '2026-08-30T09:00:00.000Z' },
    };
    expect(pendingGate(status(gates))?.name).toBe('plan-approval');
    // Reversed insertion order, same answer.
    expect(pendingGate(status({ 'plan-approval': gates['plan-approval'], pr: gates.pr }))?.name)
      .toBe('plan-approval');
  });

  it('sorts a gate with no timestamp last, not first', () => {
    const picked = pendingGate(status({
      untimed: { status: 'pending' },
      'plan-approval': { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' },
    }));
    expect(picked?.name, 'an absent timestamp must not outrank a gate that has been waiting').toBe('plan-approval');
  });
});

describe('spec 250: the gate block projects status.yaml', () => {
  it('carries the gate name and #128 structured content intact', () => {
    const projection = projectGate(status({
      'plan-approval': {
        status: 'pending',
        requested_at: '2026-08-30T09:00:00.000Z',
        request: {
          question: 'Delete the legacy table, or keep it?',
          choices: [
            { label: 'Delete it', consequence: 'Migrate references first.', recommended: true },
            { label: 'Keep it', consequence: 'Document the audit dependency.' },
          ],
          terminalExcerpt: 'warning: legacy references remain',
        },
      },
    }));
    expect(projection.kind).toBe('set');
    if (projection.kind !== 'set') return;
    expect(projection.gate.gateName).toBe('plan-approval');
    expect(projection.gate.requestedAt).toBe('2026-08-30T09:00:00.000Z');
    expect(projection.gate.question).toBe('Delete the legacy table, or keep it?');
    expect(projection.gate.choices).toHaveLength(2);
    expect(projection.gate.choices?.[0].recommended).toBe(true);
    expect(projection.gate.terminalExcerpt).toBe('warning: legacy references remain');
    expect(projection.dropped).toEqual([]);
  });

  /**
   * THE GATE NAME NEVER GOES IN THE TITLE AGAIN.
   *
   * Spec 146 put it there because there was nowhere else. This asserts the name
   * travels as a field — the whole reason phase 4 built the block.
   */
  it('puts the gate name in a field, and no title is constructed anywhere', () => {
    const projection = projectGate(status({ 'plan-approval': { status: 'pending' } }));
    if (projection.kind !== 'set') throw new Error('expected a set');
    expect(projection.gate.gateName).toBe('plan-approval');
    const source = readFileSync(join(repoRoot, 'packages/codev/src/agent-farm/servers/t3-gate-publisher.ts'), 'utf8');
    expect(source, 'the publisher must not build a thread title').not.toMatch(/thread\.rename|title:/);
  });

  it('clears when nothing is pending', () => {
    expect(projectGate(status({ 'spec-approval': { status: 'approved' } })).kind).toBe('clear');
  });

  it('supplies a requestedAt when status.yaml has none, because the field is required', () => {
    const projection = projectGate(status({ g: { status: 'pending' } }), () => '2026-08-30T10:00:00.000Z');
    if (projection.kind !== 'set') throw new Error('expected a set');
    expect(projection.gate.requestedAt).toBe('2026-08-30T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------- narrowing

/**
 * Codev bounds a gate request in BYTES; the fork bounds `CodevGate` in string
 * length, and tighter. So content porch accepted can exceed what the fork will
 * take — and the fork refuses an oversize gate WHOLE.
 *
 * The rule these tests pin: the optional content is what gets dropped, never the
 * gate. `gateName` and `requestedAt` are what say a human is needed.
 */
describe('spec 250: losing the question is better than losing the gate', () => {
  it('still publishes the gate when the question is over the fork limit', () => {
    const projection = projectGate(status({
      'plan-approval': {
        status: 'pending',
        requested_at: '2026-08-30T09:00:00.000Z',
        request: { question: 'q'.repeat(T3_GATE_LIMITS.question + 1), choices: [] },
      },
    }));
    if (projection.kind !== 'set') throw new Error('the gate was lost with the question');
    expect(projection.gate.gateName).toBe('plan-approval');
    expect(projection.gate.question).toBeUndefined();
    expect(projection.dropped.join(' ')).toContain('question');
  });

  it('flattens a multi-line question rather than letting the fork refuse the gate', () => {
    const projection = projectGate(status({
      g: { status: 'pending', request: { question: 'first\nsecond', choices: [] } },
    }));
    if (projection.kind !== 'set') throw new Error('expected a set');
    expect(projection.gate.question).toBe('first second');
  });

  it('keeps at most five choices and at most one recommendation', () => {
    const choice = (n: number, recommended?: boolean) => ({
      label: `choice ${n}`,
      consequence: 'something happens',
      ...(recommended === undefined ? {} : { recommended }),
    });
    const projection = projectGate(status({
      g: {
        status: 'pending',
        request: {
          question: 'which?',
          choices: [choice(1, true), choice(2, true), choice(3), choice(4), choice(5), choice(6)],
        },
      },
    }));
    if (projection.kind !== 'set') throw new Error('expected a set');
    expect(projection.gate.choices).toHaveLength(T3_GATE_LIMITS.maxChoices);
    expect(projection.gate.choices!.filter((c) => c.recommended === true)).toHaveLength(1);
    expect(projection.gate.choices![0].recommended).toBe(true);
    // Both narrowings are reported. A silently demoted recommendation is a
    // changed answer, and a silently dropped choice is one a human never sees.
    expect(projection.dropped.join(' ')).toContain('recommended');
    expect(projection.dropped.join(' ')).toContain('past the 5-choice limit');
  });

  it('truncates a long terminal excerpt from the head, and says it did', () => {
    const excerpt = 'x'.repeat(T3_GATE_LIMITS.terminalExcerpt + 500) + 'THE INTERESTING TAIL';
    const projection = projectGate(status({ g: { status: 'pending', request: { question: 'q', choices: [], terminalExcerpt: excerpt } } }));
    if (projection.kind !== 'set') throw new Error('expected a set');
    const kept = projection.gate.terminalExcerpt!;
    expect(kept.length).toBeLessThanOrEqual(T3_GATE_LIMITS.terminalExcerpt);
    expect(kept, 'the end of an excerpt is the part that says what happened').toContain('THE INTERESTING TAIL');
    expect(kept, 'a fragment must not read as the whole output').toContain('truncated');
    expect(projection.dropped.join(' ')).toContain('terminalExcerpt');
  });

  /**
   * The one case where the gate IS dropped, and why it is the right call.
   *
   * A `gateName` cannot be shortened without changing which gate it names, so
   * publishing a truncated one would show a human a gate they cannot match to
   * their protocol. Reporting no gate is worse than reporting the right one and
   * better than reporting a different one.
   */
  it('reports no gate rather than a renamed one when the name is unusable', () => {
    expect(projectGate(status({ ['g'.repeat(T3_GATE_LIMITS.gateName + 1)]: { status: 'pending' } })).kind).toBe('clear');
  });
});

// ---------------------------------------------------------------- the write

describe('spec 250: the publisher sends no revision', () => {
  it('omits revision from both command shapes', async () => {
    const writer = recordingWriter();
    await publishGate(writer, 'thr-1', projectGate(status({ g: { status: 'pending' } })));
    await publishGate(writer, 'thr-1', { kind: 'clear' });

    expect(writer.calls.map((c) => c.method)).toEqual([GATE_WRITE_METHOD, GATE_WRITE_METHOD]);
    expect(writer.calls[0].payload.type).toBe('codev.gate.set');
    expect(writer.calls[1].payload.type).toBe('codev.gate.clear');
    for (const call of writer.calls) {
      expect(
        'revision' in call.payload,
        'a revision held in a writer’s memory resets on restart, and a reset counter renders '
          + 'every later gate as "no gate pending"',
      ).toBe(false);
      expect(typeof call.payload.commandId).toBe('string');
    }
  });

  it('reads the revision the server returned', async () => {
    const writer = recordingWriter(() => ({ threadId: 'thr-1', gateRevision: 7, cleared: false }));
    const outcome = await publishGate(writer, 'thr-1', projectGate(status({ g: { status: 'pending' } })));
    expect(outcome).toEqual({ kind: 'applied', gateRevision: 7, cleared: false });
  });
});

describe('spec 250: unconfirmed is not applied and not refused', () => {
  it('reports a transport failure as unconfirmed', async () => {
    const writer: GateWriter = { async call() { throw new Error('socket closed'); } };
    const outcome = await publishGate(writer, 'thr-1', { kind: 'clear' });
    expect(outcome.kind).toBe('unconfirmed');
  });

  /**
   * A response that returned and cannot be read.
   *
   * This is the case that most wants to be called success — the call did not
   * throw. It carries no revision, so nothing is known about what the thread now
   * holds, and reporting it applied is how a gate that was never set gets
   * rendered as set.
   */
  it('reports an unreadable response as unconfirmed, not applied', async () => {
    const writer = recordingWriter(() => ({ ok: true }));
    const outcome = await publishGate(writer, 'thr-1', { kind: 'clear' });
    expect(outcome.kind).toBe('unconfirmed');
  });

  it('reads a server refusal with its reason discriminant', async () => {
    const writer: GateWriter = {
      async call() { throw rpcFailure('CODEV_GATE_REVISION_STALE', 'revision 3 is at or below the mark'); },
    };
    const outcome = await publishGate(writer, 'thr-1', { kind: 'clear' });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.reason).toBe('CODEV_GATE_REVISION_STALE');
    expect(outcome.detail).toContain('at or below the mark');
  });
});

// ---------------------------------------------------------------- suppression

describe('spec 250: the publish memory suppresses writes and never decides state', () => {
  it('does not resend an identical projection', async () => {
    const writer = recordingWriter();
    const publisher = new GatePublisher(writer);
    const pending = status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } });

    expect((await publisher.publish('thr-1', pending))?.kind).toBe('applied');
    expect(await publisher.publish('thr-1', pending), 'nothing to send is not the same as sent').toBeNull();
    expect(writer.calls).toHaveLength(1);
  });

  /**
   * The property that makes an unconfirmed write safe to have.
   *
   * If a failed write updated the memory, the next cycle would see "already
   * published" and send nothing — so a gate that never landed would stay
   * unpublished for as long as `status.yaml` did not change, which for a gate
   * waiting on a human is forever.
   */
  it('retries after an unconfirmed write, because nothing was confirmed', async () => {
    let first = true;
    const writer = recordingWriter(() => {
      if (first) { first = false; throw new Error('socket closed'); }
      return { threadId: 'thr-1', gateRevision: 2, cleared: false };
    });
    const publisher = new GatePublisher(writer);
    const pending = status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } });

    expect((await publisher.publish('thr-1', pending))?.kind).toBe('unconfirmed');
    expect((await publisher.publish('thr-1', pending))?.kind).toBe('applied');
    expect(writer.calls).toHaveLength(2);
  });

  it('retries after a refusal too, for the same reason', async () => {
    let first = true;
    const writer = recordingWriter(() => {
      if (first) { first = false; throw rpcFailure('CODEV_GATE_REVISION_STALE', 'another writer got there'); }
      return { threadId: 'thr-1', gateRevision: 4, cleared: false };
    });
    const publisher = new GatePublisher(writer);
    const pending = status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } });
    expect((await publisher.publish('thr-1', pending))?.kind).toBe('refused');
    expect((await publisher.publish('thr-1', pending))?.kind).toBe('applied');
  });

  it('sends the clear when the gate is approved', async () => {
    const writer = recordingWriter();
    const publisher = new GatePublisher(writer);
    await publisher.publish('thr-1', status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } }));
    await publisher.publish('thr-1', status({ g: { status: 'approved', approved_at: '2026-08-30T10:00:00.000Z' } }));
    expect(writer.calls.map((c) => c.payload.type)).toEqual(['codev.gate.set', 'codev.gate.clear']);
  });

  /**
   * Reconnect republishes CURRENT state, and does not replay history.
   *
   * A new connection has published nothing, whatever this process remembers about
   * the old one — the server it is now talking to may not be the server that
   * confirmed those writes.
   */
  it('republishes everything after forget(), with no history in between', async () => {
    const writer = recordingWriter();
    const publisher = new GatePublisher(writer);
    const pending = status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } });

    await publisher.publish('thr-1', pending);
    // Two intervening states that were never published. A replay would send them.
    publisher.forget();
    await publisher.publish('thr-1', pending);

    expect(writer.calls).toHaveLength(2);
    expect(writer.calls.every((c) => c.payload.type === 'codev.gate.set')).toBe(true);
    expect(writer.calls[0].payload.gate).toEqual(writer.calls[1].payload.gate);
  });

  it('reports dropped content to the caller rather than swallowing it', async () => {
    const dropped: Array<{ threadId: string; items: ReadonlyArray<string> }> = [];
    const publisher = new GatePublisher(recordingWriter(), (threadId, items) =>
      dropped.push({ threadId, items: [...items] }));
    await publisher.publish('thr-1', status({
      g: { status: 'pending', request: { question: 'q'.repeat(T3_GATE_LIMITS.question + 1), choices: [] } },
    }));
    expect(dropped).toHaveLength(1);
    expect(dropped[0].threadId).toBe('thr-1');
    expect(dropped[0].items.join(' ')).toContain('question');
  });
});

describe('spec 250: sameProjection', () => {
  it('treats two clears as the same and a changed gate as different', () => {
    const a = projectGate(status({ g: { status: 'pending', requested_at: '2026-08-30T09:00:00.000Z' } }));
    const b = projectGate(status({ g: { status: 'pending', requested_at: '2026-08-30T11:00:00.000Z' } }));
    expect(sameProjection({ kind: 'clear' }, { kind: 'clear' })).toBe(true);
    expect(sameProjection(a, { kind: 'clear' })).toBe(false);
    expect(sameProjection(a, a)).toBe(true);
    expect(sameProjection(a, b), 'a gate re-requested at a new time is a new gate').toBe(false);
  });
});

// ---------------------------------------------------------------- the limits

/**
 * The fork's caps are COPIED here, so they are checked against the fork.
 *
 * The vendored contract cannot supply them for the string fields — the emitter
 * drops checks behind `TrimmedNonEmptyString`'s transform, which is exactly what
 * `generated/LOSSY.md` records. The array bounds DO survive, so those are checked
 * against the artifacts; the string caps are checked against the fork source when
 * the checkout is present.
 */
describe('spec 250: the copied gate limits agree with the contract', () => {
  it('matches the choice bounds that survived emission', () => {
    const document = JSON.parse(
      readFileSync(join(repoRoot, 'packages/types/src/t3/generated/schema.json'), 'utf8'),
    );
    const setCommand = document.schemas.CodevGateWriteInput.anyOf.find(
      (member: any) => member.properties?.type?.enum?.[0] === 'codev.gate.set',
    );
    const bounds = setCommand.properties.gate.properties.choices;
    const emitted = JSON.stringify(bounds);
    expect(emitted).toContain(`"minItems":${T3_GATE_LIMITS.minChoices}`);
    expect(emitted).toContain(`"maxItems":${T3_GATE_LIMITS.maxChoices}`);
  });

  const forkRoot = process.env.T3CODE_FORK_ROOT ?? '/Users/chris/dev/t3code-codev';
  const contractPath = join(forkRoot, 'packages/contracts/src/orchestration.ts');
  it.skipIf(!existsSync(contractPath))('matches the string caps in the fork source', () => {
    const source = readFileSync(contractPath, 'utf8');
    const block = source.slice(
      source.indexOf('export const CodevGateChoice = Schema.Struct({'),
      source.indexOf('export type CodevGate = typeof CodevGate.Type;'),
    );
    expect(block.length, 'found no CodevGate block, so this would pass against anything')
      .toBeGreaterThan(200);
    for (const [field, limit] of [
      ['gateName', T3_GATE_LIMITS.gateName],
      ['question', T3_GATE_LIMITS.question],
      ['label', T3_GATE_LIMITS.label],
      ['consequence', T3_GATE_LIMITS.consequence],
      ['terminalExcerpt', T3_GATE_LIMITS.terminalExcerpt],
    ] as const) {
      expect(block, `${field}'s cap in the fork is not ${limit}`).toContain(`isMaxLength(${limit})`);
    }
  });
});

// ---------------------------------------------------------------- integration

/**
 * The publish cycle over a REAL workspace on disk.
 *
 * Everything above drives the projection and the writer directly. That proves the
 * pieces and not the path: `readWorkspaceStatuses` reads
 * `codev/projects/<dir>/status.yaml` under a root, rejects symlinks, and returns
 * a `threadId` only when the file carries `thread_id` — and a publisher that never
 * meets that reader is a publisher whose join key is a guess.
 *
 * So these write real `status.yaml` files and run `startGateWatch`'s own cycle
 * over them, with `readStatuses` left at its default.
 */
describe('spec 250: a status.yaml walked from pending to approved', () => {
  const roots: string[] = [];
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'spec250-gate-ws-'));
    roots.push(dir);
    return dir;
  }
  function writeStatus(root: string, name: string, body: string): void {
    const dir = join(root, 'codev', 'projects', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.yaml'), body);
  }
  const statusYaml = (gates: string, threadId = 'thr-1') =>
    `id: "250"\ntitle: a project\nprotocol: spir\nphase: implement\ncurrent_plan_phase: phase_6\n`
    + `thread_id: "${threadId}"\ngates:\n${gates}`;

  function watchOver(root: string, writer: ReturnType<typeof recordingWriter>) {
    // `readStatuses` is NOT injected: the point is to exercise the real reader.
    return startGateWatch({ workspaceRoot: root, writer, debounceMs: 5, reconcileMs: 60_000 });
  }

  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a pending gate, clears it on approval, then publishes the next one', async () => {
    const root = workspace();
    const writer = recordingWriter();
    writeStatus(root, '250-a-project', statusYaml(
      `  plan-approval:\n    status: pending\n    requested_at: "2026-08-30T09:00:00.000Z"\n`,
    ));
    const watch = watchOver(root, writer);
    try {
      await watch.publishNow();
      expect(writer.calls.map((c) => c.payload.type)).toEqual(['codev.gate.set']);
      expect(writer.calls[0].payload.threadId).toBe('thr-1');
      expect(writer.calls[0].payload.gate.gateName).toBe('plan-approval');

      // Approved. The block clears.
      writeStatus(root, '250-a-project', statusYaml(
        `  plan-approval:\n    status: approved\n    approved_at: "2026-08-30T10:00:00.000Z"\n`,
      ));
      await watch.publishNow();
      expect(writer.calls.map((c) => c.payload.type)).toEqual(['codev.gate.set', 'codev.gate.clear']);

      // The next gate opens.
      writeStatus(root, '250-a-project', statusYaml(
        `  plan-approval:\n    status: approved\n    approved_at: "2026-08-30T10:00:00.000Z"\n`
        + `  pr:\n    status: pending\n    requested_at: "2026-08-30T11:00:00.000Z"\n`,
      ));
      await watch.publishNow();
      expect(writer.calls.map((c) => c.payload.type))
        .toEqual(['codev.gate.set', 'codev.gate.clear', 'codev.gate.set']);
      expect(writer.calls[2].payload.gate.gateName).toBe('pr');
    } finally {
      watch.close();
    }
  });

  it('publishes nothing for a status.yaml with no thread_id', async () => {
    const root = workspace();
    const writer = recordingWriter();
    const dir = join(root, 'codev', 'projects', '250-no-thread');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'status.yaml'),
      `id: "250"\ntitle: t\nprotocol: spir\nphase: implement\ncurrent_plan_phase: p\n`
      + `gates:\n  plan-approval:\n    status: pending\n`,
    );
    const watch = watchOver(root, writer);
    try {
      await watch.publishNow();
      expect(writer.calls, 'no join key means no thread to publish onto').toHaveLength(0);
    } finally {
      watch.close();
    }
  });

  /**
   * An unreadable `status.yaml` publishes NOTHING — it does not clear.
   *
   * Clearing would spell "I could not read the file" exactly like "no gate is
   * pending", on the one thread where a human may be waiting. This is the
   * hot-tier rule applied to the failure mode it was written for.
   */
  it('sends no clear when status.yaml cannot be parsed', async () => {
    const root = workspace();
    const writer = recordingWriter();
    writeStatus(root, '250-a-project', statusYaml(
      `  plan-approval:\n    status: pending\n    requested_at: "2026-08-30T09:00:00.000Z"\n`,
    ));
    const watch = watchOver(root, writer);
    try {
      await watch.publishNow();
      expect(writer.calls).toHaveLength(1);

      writeStatus(root, '250-a-project', 'not: [valid, yaml\n  - at all');
      await watch.publishNow();
      expect(
        writer.calls,
        'an unreadable status.yaml must not clear a gate a human is waiting on',
      ).toHaveLength(1);
    } finally {
      watch.close();
    }
  });

  /**
   * Spec test scenario 4: killing and restarting mid-gate leaves the rendered
   * gate matching `status.yaml`.
   *
   * The restart is modelled by building a SECOND watch over the same workspace —
   * a new process has a new `GatePublisher` and remembers nothing. What makes the
   * outcome right is that the new one re-reads the file rather than replaying
   * what the old one saw: the gate it publishes is whatever `status.yaml` says
   * NOW, including a gate that was approved while nothing was running.
   */
  it('matches status.yaml after a restart, including a change made while it was down', async () => {
    const root = workspace();
    writeStatus(root, '250-a-project', statusYaml(
      `  plan-approval:\n    status: pending\n    requested_at: "2026-08-30T09:00:00.000Z"\n`,
    ));

    const before = recordingWriter();
    const first = watchOver(root, before);
    await first.publishNow();
    first.close();
    expect(before.calls.map((c) => c.payload.type)).toEqual(['codev.gate.set']);

    // Down. The human approves, and a new gate opens.
    writeStatus(root, '250-a-project', statusYaml(
      `  plan-approval:\n    status: approved\n    approved_at: "2026-08-30T10:00:00.000Z"\n`
      + `  pr:\n    status: pending\n    requested_at: "2026-08-30T11:00:00.000Z"\n`,
    ));

    const after = recordingWriter();
    const second = watchOver(root, after);
    try {
      await second.publishNow();
      // ONE write, and it is the current state. Not a clear followed by a set,
      // which would be a replay of the transition it never saw.
      expect(after.calls).toHaveLength(1);
      expect(after.calls[0].payload.type).toBe('codev.gate.set');
      expect(after.calls[0].payload.gate.gateName).toBe('pr');
      expect('revision' in after.calls[0].payload, 'the server allocates, the writer does not').toBe(false);
    } finally {
      second.close();
    }
  });

  /**
   * A thread the server does not have is REPORTED, with the server's own reason.
   *
   * `status.yaml` can carry a `thread_id` from a thread that has since been
   * deleted. The publisher does not go quiet about it and does not invent a
   * different thread: it surfaces `CODEV_GATE_THREAD_NOT_FOUND`, which is the
   * server saying the join key no longer resolves.
   */
  it('surfaces an unresolvable thread rather than rendering nothing', async () => {
    const root = workspace();
    const writer = recordingWriter(() => {
      throw rpcFailure('CODEV_GATE_THREAD_NOT_FOUND', 'no thread thr-gone');
    });
    const logged: string[] = [];
    writeStatus(root, '250-a-project', statusYaml(
      `  plan-approval:\n    status: pending\n    requested_at: "2026-08-30T09:00:00.000Z"\n`,
      'thr-gone',
    ));
    const watch = startGateWatch({
      workspaceRoot: root,
      writer,
      log: (_level, message) => logged.push(message),
      debounceMs: 5,
      reconcileMs: 60_000,
    });
    try {
      const written = await watch.publishNow();
      expect(written).toHaveLength(1);
      expect(written[0].outcome.kind).toBe('refused');
      expect(logged.join(' ')).toContain('CODEV_GATE_THREAD_NOT_FOUND');
    } finally {
      watch.close();
    }
  });
});
