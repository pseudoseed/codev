/**
 * Spec 250, Phase 5 — the vendored contract, regenerated from the fork.
 *
 * Phases 2-4 changed the fork. Nothing in this repository knew about those
 * changes: `packages/types/src/t3/generated/` was still emitted from
 * `pin.upstreamBase`, so `porch-driver` and `codev-agent` would have been sending
 * fields against a contract that had never heard of them. This phase regenerates,
 * and these are the assertions that say it actually happened rather than that the
 * generator exited zero.
 *
 * The centre of the file is the verdict the churn classifier refused to give.
 * `classify-churn.mjs --fork-drift` reports three commits as
 * `consumed-change-undecidable` — it stops being confident inside a union and
 * says so instead of guessing. Regenerating without deciding those would convert
 * an explicit "I could not tell" into a silent green, which is the one thing this
 * project has spent five phases refusing to do. So the union change is decided
 * here, by measurement: the frame that the customization added is checked against
 * a union with the new alternatives and against the same union without them.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shapeCheck, describeMismatches } from '../../../types/src/t3/shape-check.js';
import { t3Schemas, t3Defs, t3Methods } from '../../../types/src/t3/index.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — a dependency-free .mjs helper shared with the build tools, not a package
import { DEFAULT_UPSTREAM_ROOT } from '../../../../tools/t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const t3Root = join(repoRoot, 'packages', 'types', 'src', 't3');
const generated = join(t3Root, 'generated');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const pin = readJson(join(t3Root, 'pin.json'));
const document = readJson(join(generated, 'schema.json'));
const defs = document.$defs as Record<string, Record<string, unknown>>;
const schemas = document.schemas as Record<string, Record<string, unknown>>;
const sourceHash = readJson(join(generated, 'source-hash.json'));
const methodsJson = readJson(join(generated, 'methods.json'));
const typeDeclarations = readFileSync(join(generated, 'types.d.ts'), 'utf8');

type Node = Record<string, any>;
const alternatives = (node: Node): Node[] => (node.anyOf ?? node.oneOf ?? []) as Node[];
/** The union member whose discriminant `field` is exactly `literal`. */
function member(node: Node, field: string, literal: string): Node {
  const found = alternatives(node).find((m) => m.properties?.[field]?.enum?.[0] === literal);
  expect(found, `no union member with ${field} === "${literal}"`).toBeDefined();
  return found as Node;
}

const check = (value: unknown, schema: Node, options = {}) =>
  shapeCheck(value, schema as never, defs as never, options);
const expectMatches = (value: unknown, schema: Node, why: string) => {
  const result = check(value, schema);
  expect(result.matches, `${why}\n${describeMismatches(result)}`).toBe(true);
};

// ---------------------------------------------------------------- provenance

describe('spec 250: the vendored contract came from the fork', () => {
  it('pins the fork head, and it is not the upstream base', () => {
    expect(pin.contractSource).toBe('fork');
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      pin.commit,
      'the two identities have to differ for any of this to be a test rather than a tautology',
    ).not.toBe(pin.upstreamBase);
  });

  /**
   * Two sections, and they must DIFFER.
   *
   * `files` alone says "the artifacts match the source they came from", which is
   * a claim the generator can make about itself. The `upstream` section is the
   * other end of the comparison: it records what upstream's bytes were at
   * `upstreamBase`, so the fork's divergence is a fact on disk rather than an
   * inference. Two identical sections would mean the fork carries no
   * customization at all, which after four phases is a failure, not a pass.
   */
  it('source-hash.json carries both the fork hashes and the upstream ones', () => {
    expect(sourceHash.commit).toBe(pin.commit);
    expect(sourceHash.upstream?.commit).toBe(pin.upstreamBase);
    expect(
      sourceHash.upstream?.available,
      `no upstream measurement: ${sourceHash.upstream?.reason ?? 'no reason given'}`,
    ).toBe(true);

    const differing = pin.closure.filter(
      (file: string) => sourceHash.files[file] !== sourceHash.upstream.files[file],
    );
    expect(differing.length, 'the fork and upstream sections are identical').toBeGreaterThan(0);
    expect(sourceHash.forkDrift?.measured).toBe(true);
    expect([...sourceHash.forkDrift.changedFiles].sort()).toEqual([...differing].sort());
  });

  /**
   * The attribution names a commit that does not exist where it says it does.
   *
   * `ATTRIBUTION.md` and the `types.d.ts` header both read `pin.repo` and
   * `pin.commit`, which were the same source until this phase. They are not any
   * more: `pin.commit` is a fork commit, and pointing a reader at
   * `pingdotgg/t3code` for it sends them somewhere it has never been. These files
   * leave the repository inside a published package, so the provenance they carry
   * has to be findable.
   */
  it('attributes the artifacts to the fork AND to what it branched from', () => {
    const attribution = readFileSync(join(generated, 'ATTRIBUTION.md'), 'utf8');
    for (const fragment of [pin.forkRepo, pin.commit, pin.repo, pin.upstreamBase, 'MIT License']) {
      expect(attribution, `ATTRIBUTION.md does not name ${fragment}`).toContain(fragment);
    }
  });

  /**
   * Derived from the directory, not from a list of files.
   *
   * The first cut of this named `ATTRIBUTION.md` and `types.d.ts`. There were
   * three emitted provenance headers, the third came from a separate hand-written
   * string in the generator, and correcting two left the one that ships — the
   * runtime module — attributing a fork-only commit to `pingdotgg/t3code`. Review
   * caught it; the enumeration is what let it through.
   *
   * The rule instead: **any** generated artifact naming the upstream repository
   * must also name the fork and the base it branched from, whatever the file is
   * called. A fourth artifact acquiring a header is covered before it exists.
   */
  it('no generated artifact names upstream alone', () => {
    // Every artifact, with no extension filter. An earlier draft skipped `.json`,
    // which is the same enumeration shape this test exists to remove — a JSON
    // artifact that starts carrying a `_comment` provenance line would be exempt
    // for a reason nobody chose. Filtering on the CLAIM below is the whole test;
    // nothing needs excluding in advance. Review flagged it as non-blocking.
    const artifacts = readdirSync(generated);
    expect(artifacts.length, 'read no artifacts, so this test would pass against anything')
      .toBeGreaterThan(4);

    const claiming = artifacts.filter((file) =>
      readFileSync(join(generated, file), 'utf8').includes(pin.repo),
    );
    expect(
      claiming.length,
      'no artifact carries a provenance line at all, which is not what this is checking for',
    ).toBeGreaterThan(2);

    for (const file of claiming) {
      const text = readFileSync(join(generated, file), 'utf8');
      expect(text, `${file} names ${pin.repo} without naming the fork it was generated from`)
        .toContain(pin.forkRepo);
      expect(
        text,
        `${file} names ${pin.repo} beside a commit that exists only in the fork, and does not `
          + 'name the upstream base a reader could actually find there',
      ).toContain(pin.upstreamBase);
    }
  });

  /**
   * One date per identity, for the same reason there is one commit per identity.
   * They were a single field while the commits were equal; now that they differ, a
   * single date is right for one identity and wrong for the other with nothing in
   * the file to say which.
   */
  it('carries a date for each commit, and they are not the same date', () => {
    expect(pin.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pin.upstreamBaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pin.commitDate).not.toBe(pin.upstreamBaseDate);
    // The verify line about the UPSTREAM checkout must quote the upstream date.
    const harness = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    expect(harness).toContain('verified upstream');
    expect(harness).not.toMatch(/verified upstream[^\n]*pin\.commitDate/);
  });

  /**
   * The closure did not widen.
   *
   * `role` is a plain `Schema.Literals` union and `ThreadId` already lived in
   * `baseSchemas.ts`, so neither new field reaches a file outside the nine. The
   * generator fails if the real import graph does, which makes a widening a
   * deliberate decision rather than something that happens quietly; this asserts
   * the decision was not made.
   */
  it('still vendors exactly the nine closure files', () => {
    expect(pin.closure).toHaveLength(9);
    expect(Object.keys(sourceHash.files).sort()).toEqual([...pin.closure].sort());
    expect(Object.keys(sourceHash.upstream.files).sort()).toEqual([...pin.closure].sort());
  });
});

// ---------------------------------------------------------------- the four fields

describe('spec 250: the four new fields survived generation as real types', () => {
  const threadCreate = member(schemas.dispatchCommandInput, 'type', 'thread.create');
  const snapshotThread = member(schemas.subscribeThreadOutput, 'kind', 'snapshot')
    .properties.snapshot.properties.thread as Node;

  it('role and parentThreadId reach the command input', () => {
    expect(threadCreate.properties.role).toBeDefined();
    expect(threadCreate.properties.parentThreadId).toBeDefined();
    // Optional on the wire, deliberately: an upstream client that never heard of
    // either field must keep dispatching `thread.create` unchanged.
    expect(threadCreate.required).not.toContain('role');
    expect(threadCreate.required).not.toContain('parentThreadId');
  });

  it('all four reach the thread read model', () => {
    for (const field of ['role', 'parentThreadId', 'codevGate', 'gateRevision']) {
      expect(snapshotThread.properties[field], `${field} missing from the snapshot thread`).toBeDefined();
    }
  });

  /**
   * Present is not the same as typed. `{}` emits for a schema whose constraints
   * did not survive the transform, and it accepts literally any value — the
   * failure mode `generated/LOSSY.md` exists to name. A field that arrived as
   * `unknown` would satisfy "is in schema.json" and check nothing.
   */
  it('none of them emitted as an unconstrained node', () => {
    const constrained = (node: Node): boolean => {
      if (!node || typeof node !== 'object') return false;
      if (Object.keys(node).length === 0) return false;
      if (node.$ref) return true;
      const alts = alternatives(node);
      if (alts.length > 0) return alts.every(constrained);
      return Boolean(node.type || node.enum || node.properties);
    };
    for (const field of ['role', 'parentThreadId', 'codevGate', 'gateRevision']) {
      expect(constrained(snapshotThread.properties[field]), `${field} emitted with no constraints`).toBe(true);
    }
    // types.d.ts is the surface a caller actually programs against.
    expect(typeDeclarations).toContain('"role"?: "architect" | "builder"');
    expect(typeDeclarations).toMatch(/"codevGate"\?: \{/);
    expect(typeDeclarations).toMatch(/"gateRevision"(\??): number/);
    expect(typeDeclarations).not.toMatch(/"(codevGate|parentThreadId)"\??: unknown/);
  });

  it('the role enum is enforced, not emitted as a bare string', () => {
    const base = {
      type: 'thread.create', commandId: 'cmd-1', threadId: 'thr-1', projectId: 'prj-1',
      title: 'a thread', modelSelection: { model: 'sonnet' }, runtimeMode: 'full-access',
      branch: null, worktreePath: null, createdAt: '2026-08-30T00:00:00.000Z',
    };
    expectMatches({ ...base, role: 'builder', parentThreadId: 'thr-0' }, threadCreate,
      'a hierarchy-carrying thread.create must round-trip');
    expectMatches({ ...base, role: null, parentThreadId: null }, threadCreate,
      'an architect thread has no parent and must still round-trip');
    expect(
      check({ ...base, role: 'reviewer' }, threadCreate).matches,
      'a role outside the union must not pass — if it does the enum did not survive emission',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- codev.gateWrite

describe('spec 250: codev.gateWrite is vendored, not merely present in the contract', () => {
  /**
   * `generate.mjs` iterates `Object.entries(pin.methods)`, NOT the contract's own
   * RPC map. A method that exists in the fork and is absent from `pin.methods` is
   * silently ignored: no schema, no entry in `methods.json`, and `checked.ts`
   * reports `unchecked` for every payload — which is not a failure anyone sees.
   * So the list is the thing to assert, and it is asserted in both directions.
   */
  it('the pin and the generated method map agree exactly', () => {
    const pinned = Object.keys(pin.methods).filter((m) => !m.startsWith('_')).sort();
    expect(Object.keys(methodsJson).sort()).toEqual(pinned);
    expect(pinned).toContain('codev.gateWrite');
  });

  it('its schemas were emitted and are reachable through the package index', () => {
    expect(t3Methods['codev.gateWrite']).toEqual({
      input: 'CodevGateWriteInput', output: 'CodevGateWriteResult', stream: false,
    });
    expect(t3Schemas.CodevGateWriteInput).toBeDefined();
    expect(t3Schemas.CodevGateWriteResult).toBeDefined();
  });

  it('a gate write and its result round-trip through shapeCheck', () => {
    const set = member(schemas.CodevGateWriteInput, 'type', 'codev.gate.set');
    expectMatches(
      {
        type: 'codev.gate.set', commandId: 'cmd-2', threadId: 'thr-1',
        gate: {
          gateName: 'plan-approval', requestedAt: '2026-08-30T00:00:00.000Z',
          question: 'Delete the legacy table, or keep it?',
          choices: [{ label: 'Delete it', consequence: 'Migrate references first.', recommended: true }],
        },
        createdAt: '2026-08-30T00:00:00.000Z',
      },
      set,
      'the gate-set command shape',
    );
    expectMatches(
      { threadId: 'thr-1', gateRevision: 4, cleared: false },
      schemas.CodevGateWriteResult,
      'the gate-write result shape',
    );
  });
});

// ---------------------------------------------------------------- the verdict

/**
 * The union change the churn classifier could not decide.
 *
 * `classify-churn.mjs` marks a comparison `unknown` the moment a union's JSON
 * differs at all, additive or not. Three fork commits land there. Read member by
 * member, matched on the discriminant, the cumulative change from `upstreamBase`
 * to `pin.commit` is:
 *
 *   subscribeThread output  four fields added to the snapshot thread, two to the
 *                           `thread.created` payload, and two ALTERNATIVES added
 *                           to the `OrchestrationEvent` union
 *   dispatchCommand input   two optional fields added to `thread.create`
 *
 * Nothing removed, nothing newly required, no type narrowed, no enum member lost,
 * `additionalProperties` unchanged. So the verdict is non-breaking in every
 * respect but one: on an OUTPUT, a new union alternative is a shape the client
 * must now handle. A client shape-checking the stream against the
 * pre-regeneration contract rejects a `codev.gate-set` frame outright, because it
 * matches no member of the union that client knows.
 *
 * That is a real break, in exactly one direction, and regenerating is the fix.
 * These tests measure both halves rather than restating the paragraph.
 */
describe('spec 250: the undecidable union verdict, measured', () => {
  const streamOut = schemas.subscribeThreadOutput;
  const eventFrame = member(streamOut, 'kind', 'event');
  const eventUnion = eventFrame.properties.event as Node;

  const gateSetFrame = {
    kind: 'event',
    event: {
      sequence: 12,
      eventId: 'evt-1',
      aggregateKind: 'thread',
      aggregateId: 'thr-1',
      occurredAt: '2026-08-30T00:00:00.000Z',
      commandId: 'cmd-2',
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: 'codev.gate-set',
      payload: {
        threadId: 'thr-1',
        gate: { gateName: 'plan-approval', requestedAt: '2026-08-30T00:00:00.000Z' },
        gateRevision: 4,
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    },
  };

  it('the regenerated contract accepts a gate-set frame', () => {
    expectMatches(gateSetFrame, streamOut, 'the frame the customization added');
  });

  /**
   * The other half, and the one that makes the first half mean something.
   *
   * Rebuilding the pre-regeneration union by REMOVING the two `codev.*`
   * alternatives is the whole before-state that matters here: the emitted shape
   * of every upstream alternative is unchanged, so the only difference between
   * the old artifact and the new one, for this frame, is their presence. If the
   * frame passed against this too, the union membership would not be what decides
   * acceptance and the "breaking" half of the verdict would be wrong.
   */
  it('a contract without those alternatives rejects it — which is what makes the change breaking', () => {
    const withoutCodevEvents = {
      ...streamOut,
      anyOf: alternatives(streamOut).map((frame) =>
        frame.properties?.kind?.enum?.[0] !== 'event'
          ? frame
          : {
              ...frame,
              properties: {
                ...frame.properties,
                event: {
                  ...(frame.properties.event as Node),
                  anyOf: alternatives(frame.properties.event as Node).filter(
                    (m) => !String(m.properties?.type?.enum?.[0] ?? '').startsWith('codev.'),
                  ),
                },
              },
            },
      ),
    };
    const removed =
      alternatives(eventUnion).length - alternatives(
        (withoutCodevEvents.anyOf.find((f: Node) => f.properties?.kind?.enum?.[0] === 'event') as Node)
          .properties.event as Node,
      ).length;
    expect(removed, 'the fixture removed nothing, so it is not the pre-regeneration shape').toBe(2);
    expect(
      check(gateSetFrame, withoutCodevEvents).matches,
      'a client on the upstream-generated contract must reject this frame',
    ).toBe(false);
  });

  it('both new alternatives are there, not just the one under test', () => {
    const types = alternatives(eventUnion).map((m) => m.properties?.type?.enum?.[0]);
    expect(types).toContain('codev.gate-set');
    expect(types).toContain('codev.gate-cleared');
  });

  /**
   * The non-breaking half: additive means NOTHING WAS LOST. Asserting only that
   * our two alternatives arrived would pass just as happily against a
   * regeneration that dropped half of upstream's event types.
   *
   * Read from the upstream checkout at `upstreamBase`, so the comparison is
   * against upstream's own source rather than against a list copied into this
   * file that would go stale at the first rebase. Skips when the checkout is
   * absent — "I had nothing to compare against" is not "nothing was lost".
   */
  const upstreamRoot: string = process.env.T3CODE_ROOT ?? DEFAULT_UPSTREAM_ROOT;
  const upstreamOrchestration = join(upstreamRoot, pin.contractsRoot, 'orchestration.ts');
  it.skipIf(!existsSync(upstreamOrchestration))(
    'kept every event type upstream had at upstreamBase',
    () => {
      const atBase = execFileSync(
        'git',
        ['-C', upstreamRoot, 'show', `${pin.upstreamBase}:${pin.contractsRoot}/orchestration.ts`],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      const start = atBase.indexOf('export const OrchestrationEvent = Schema.Union([');
      expect(start, 'could not find the event union in upstream orchestration.ts').toBeGreaterThan(-1);
      const end = atBase.indexOf('\n]);', start);
      const upstreamTypes = [...atBase.slice(start, end).matchAll(/type: Schema\.Literal\("([^"]+)"\)/g)]
        .map((m) => m[1]);
      expect(
        upstreamTypes.length,
        'extracted no event types, so this test would pass against anything',
      ).toBeGreaterThan(10);

      const emitted = new Set(alternatives(eventUnion).map((m) => m.properties?.type?.enum?.[0]));
      for (const type of upstreamTypes) {
        expect(emitted.has(type), `${type} was in upstream's event union and is not in ours`).toBe(true);
      }
      expect(emitted.size).toBe(upstreamTypes.length + 2);
    },
  );
});

// ---------------------------------------------------------------- shape-check untouched

/**
 * `shape-check.ts` states what it is: a lower bound in one direction (every
 * branded id lost its constraint on the way out) and stricter in another
 * (`additionalProperties: false` against a decoder that ignores excess, which is
 * why excess is ignored by default). Adding four fields must not quietly turn it
 * into a claim of validity it does not make.
 */
describe('spec 250: the four new fields did not relax the checker', () => {
  it('has no special case for any of them', () => {
    const source = readFileSync(join(t3Root, 'shape-check.ts'), 'utf8');
    for (const field of ['role', 'parentThreadId', 'codevGate', 'gateRevision', 'gateWrite']) {
      // Word-bounded: the claim is that no FIELD is named, not that the letters
      // never occur. A substring match would fire on an ordinary English word.
      expect(
        new RegExp(`\\b${field}\\b`).test(source),
        `shape-check.ts names ${field}; it must stay field-agnostic`,
      ).toBe(false);
    }
  });

  /**
   * The one change this phase DID make to the checker, and why it is a
   * strengthening rather than a relaxation.
   *
   * Phase 4's gate payload bounds `choices` to one-to-five entries, and it is the
   * first schema in the vendored closure to emit `minItems`/`maxItems`. An
   * unimplemented keyword makes `shapeCheck` THROW — it refuses to report a match
   * for a constraint it did not check — so vendoring `codev.gateWrite` without
   * implementing them left every gate-write payload check raising
   * `UnsupportedKeywordError` at the call site instead of returning a result.
   * Found by running the round-trip above, not by reading the schema.
   *
   * So the keywords are now implemented and enforced. Nothing that previously
   * passed now fails, and nothing that previously failed now passes.
   */
  it('enforces the bounded-array keywords rather than throwing on them', () => {
    const set = member(schemas.CodevGateWriteInput, 'type', 'codev.gate.set');
    const choice = { label: 'Delete it', consequence: 'Migrate references first.' };
    const command = (choices: unknown[]) => ({
      type: 'codev.gate.set', commandId: 'cmd-4', threadId: 'thr-1',
      gate: { gateName: 'plan-approval', requestedAt: '2026-08-30T00:00:00.000Z', choices },
      createdAt: '2026-08-30T00:00:00.000Z',
    });

    expect(() => check(command([choice]), set)).not.toThrow();
    expectMatches(command([choice, choice]), set, 'two choices are within the bound');
    expect(check(command([]), set).matches, 'an empty choice list is below minItems').toBe(false);
    expect(
      check(command(Array.from({ length: 6 }, () => choice)), set).matches,
      'six choices are above maxItems',
    ).toBe(false);
  });

  it('still fails a payload missing a required field', () => {
    const set = member(schemas.CodevGateWriteInput, 'type', 'codev.gate.set');
    const withoutGate = {
      type: 'codev.gate.set', commandId: 'cmd-3', threadId: 'thr-1',
      createdAt: '2026-08-30T00:00:00.000Z',
    };
    expect(check(withoutGate, set).matches).toBe(false);
  });

  it('still mirrors the decoder on excess by default, and still tightens on request', () => {
    const result = { threadId: 'thr-1', gateRevision: 4, cleared: false, somethingNew: 1 };
    expect(
      check(result, schemas.CodevGateWriteResult).matches,
      'excess is ignored by default because the server strips it rather than rejecting it',
    ).toBe(true);
    expect(
      check(result, schemas.CodevGateWriteResult, { excess: 'error' }).matches,
      'the opt-in strict mode must still report it',
    ).toBe(false);
  });
});
