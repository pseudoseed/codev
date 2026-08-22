/**
 * Issue #40 — the CRITICAL RULES box must tell a builder to start.
 *
 * ## The failure this pins
 *
 * A builder ended its turn at a plan-phase boundary with nothing blocking it
 * and idled for two hours. Asked why, it said it read porch's
 * `DO NOT start <next> until you run porch again` as a general stop-and-wait,
 * and treated the handoff as a reporting checkpoint.
 *
 * Both readings were available. The box porch marked CRITICAL contained one
 * prohibition, one conditional ("when complete, run porch done"), and one
 * imperative the builder could not perform — `/compact`, a slash command a
 * human types into a composer. Nothing in it said "begin the phase you were
 * just handed."
 *
 * These tests assert the box's *content*, not its formatting, because content
 * is what the failure was about. The affirmative rule must come first: a
 * builder that reads far enough to find rule 1 and stops there must have been
 * told to work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import { status } from '../index.js';
import type { ProjectState } from '../types.js';

const PROJECT = '9040-handoff';

describe('issue #40: phase-handoff CRITICAL RULES', () => {
  let root: string;
  let logged: string[];

  /**
   * A phased project sitting on `phase_1_a` with `phase_2_b` still pending —
   * the exact shape that produces the handoff box.
   */
  function writeProject(planPhases: ProjectState['plan_phases']): void {
    const dir = path.join(root, 'codev/projects', PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const state: ProjectState = {
      id: '9040',
      title: 'handoff',
      protocol: 'fixture-spir',
      phase: 'implement',
      plan_phases: planPhases,
      current_plan_phase: planPhases.find(p => p.status === 'in_progress')?.id ?? null,
      gates: {},
      iteration: 1,
      build_complete: false,
      history: [],
      started_at: 'T0',
      updated_at: 'T0',
    };
    fs.writeFileSync(path.join(dir, 'status.yaml'), yaml.dump(state));

    const proto = path.join(root, 'codev/protocols/fixture-spir');
    fs.mkdirSync(proto, { recursive: true });
    fs.writeFileSync(
      path.join(proto, 'protocol.json'),
      JSON.stringify({
        name: 'fixture-spir',
        version: '1.0.0',
        description: 'f',
        phases: [
          {
            id: 'implement',
            name: 'Implement',
            type: 'per_plan_phase',
            build: { prompt: 'i.md', artifact: 'src/**/*.ts' },
          },
        ],
      }),
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-handoff-40-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const out = (): string => logged.join('\n');

  /**
   * The box wraps, so a rule's text can straddle a line break. Assertions
   * about what a rule SAYS have to see the rule, not the frame: strip ANSI,
   * drop the borders, and collapse whitespace.
   */
  const boxText = (): string =>
    // eslint-disable-next-line no-control-regex
    out().replace(/\[[0-9;]*m/g, '')
      .split('\n')
      .filter(l => l.startsWith('║'))
      .map(l => l.slice(1).replace(/║$/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

  const MID_BUILD: ProjectState['plan_phases'] = [
    { id: 'phase_1_a', title: 'A', status: 'in_progress' },
    { id: 'phase_2_b', title: 'B', status: 'pending' },
  ];

  it('tells the builder to START the phase it was handed', async () => {
    writeProject(MID_BUILD);

    await status(root, '9040');

    expect(out()).toMatch(/START phase_1_a NOW/);
  });

  it('puts the affirmative rule FIRST, ahead of the prohibition', async () => {
    // Order is the whole point. A box that opens with "DO NOT" has told a
    // builder what not to do before it has told it to do anything, and the
    // conservative reading of that is to stop.
    writeProject(MID_BUILD);

    await status(root, '9040');

    const text = out();
    expect(text.indexOf('START phase_1_a NOW')).toBeGreaterThan(-1);
    expect(text.indexOf('START phase_1_a NOW')).toBeLessThan(text.indexOf('DO NOT start'));
  });

  it('says in the box that a handoff is not a stopping point', async () => {
    writeProject(MID_BUILD);

    await status(root, '9040');

    expect(boxText()).toMatch(/not a stopping point/i);
  });

  it('names the three things that DO justify stopping', async () => {
    // "Should I stop here?" must have a written answer, or it gets answered
    // by whichever reading looks safest.
    writeProject(MID_BUILD);

    await status(root, '9040');

    expect(boxText()).toMatch(/human gate/i);
    expect(boxText()).toMatch(/blocker you cannot resolve/i);
    expect(boxText()).toMatch(/question whose answer changes the work/i);
  });

  it('scopes the prohibition to the NAMED next phase', async () => {
    writeProject(MID_BUILD);

    await status(root, '9040');

    expect(boxText()).toMatch(/DO NOT start phase_2_b until you run porch again/);
  });

  it('still names the current phase on the LAST plan phase, where no next phase exists', async () => {
    // The unqualified "DO NOT start the next phase" is the line the builder
    // reported reading as stop-and-wait. It is unavoidable here — there is no
    // next phase to name — so the affirmative rule has to carry the weight.
    writeProject([
      { id: 'phase_1_a', title: 'A', status: 'complete' },
      { id: 'phase_2_b', title: 'B', status: 'in_progress' },
    ]);

    await status(root, '9040');

    expect(boxText()).toMatch(/START phase_2_b NOW/);
    expect(boxText()).toMatch(/DO NOT start the next phase until you run porch again/);
  });

  it('does not tell the builder to run /compact, which it cannot do', async () => {
    // `/compact` is typed by a human into a composer. Nothing in the codebase
    // consumes it, and a builder that treats it as a required step before
    // starting has an unsatisfiable precondition and stops.
    writeProject(MID_BUILD);

    await status(root, '9040');

    expect(out()).not.toMatch(/\/compact/);
  });

  it('keeps the box legible: every line closes its border', async () => {
    // The old box hand-padded each line, so any rule long enough to matter
    // broke the frame. Wrapping is what makes a full sentence affordable.
    writeProject(MID_BUILD);

    await status(root, '9040');

    // eslint-disable-next-line no-control-regex
    const plain = out().replace(/\[[0-9;]*m/g, '');
    const boxLines = plain.split('\n').filter(l => l.startsWith('║'));
    expect(boxLines.length).toBeGreaterThan(4);
    for (const line of boxLines) {
      expect(line.endsWith('║')).toBe(true);
    }
  });
});
