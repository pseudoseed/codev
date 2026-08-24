/**
 * Issue #54 — an unrunnable review must not read like a completed one.
 *
 * `consult -m opencode --type spec --issue 52` printed a template-not-found
 * line and, as reported, exited 0 with that line as the entire output file. Exit
 * 0 means every caller — a porch step, a script, a background invocation —
 * records a consultation that never happened. It is indistinguishable from a
 * clean pass unless a human notices the output file is two lines long.
 *
 * The exit code and the missing-output-file behaviour were fixed by #43's work
 * and are held here by regression tests so they cannot come back.
 *
 * What #54 still asked for was the message. Three dead ends existed, and each
 * pointed at a path rather than at the fix:
 *
 *   1. bare `--type spec`     → the type is protocol-scoped; `--protocol` is the fix
 *   2. `--type spec --protocol bugfix` → real type, wrong protocol; another one has it
 *   3. `--type nonsense`      → not a review type at all; naming a path reads as
 *                               "create this file" when nothing has ever written it
 *
 * Only (1) was covered.
 */

import { describe, it, expect } from 'vitest';
import { listConsultTypes } from '../../../lib/skeleton.js';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages', 'codev', 'dist', 'cli.js');

/** Run the built CLI. Skipped when dist is absent (source-only checkout). */
function runConsult(args: string[]): { status: number | null; stderr: string; outFile: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'c54-'));
  const outFile = path.join(dir, 'review.md');
  const r = spawnSync(process.execPath, [CLI, 'consult', '--output', outFile, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status, stderr: (r.stderr ?? '') + (r.stdout ?? ''), outFile };
}

const hasDist = fs.existsSync(CLI);

describe('#54: the shape of the report — a review that could not run is not a success', () => {
  it.runIf(hasDist)('exits non-zero when no template resolves', () => {
    const { status } = runConsult(['-m', 'opencode', '--type', 'spec', '--issue', '52']);

    expect(status).not.toBe(0);
  });

  it.runIf(hasDist)('writes no output file, so nothing downstream reads an error as a review', () => {
    // The original report: the output file existed and contained the error line
    // and nothing else. A caller that checks "did the file appear" was satisfied.
    const { outFile } = runConsult(['-m', 'opencode', '--type', 'spec', '--issue', '52']);

    expect(fs.existsSync(outFile)).toBe(false);
  });

  it.runIf(hasDist)('exits non-zero for a type that exists nowhere, too', () => {
    const { status } = runConsult(['-m', 'opencode', '--type', 'nonsense-type', '--issue', '52']);

    expect(status).not.toBe(0);
  });
});

describe('#54: the message names the fix, not a path to go create', () => {
  it.runIf(hasDist)('a protocol-scoped type names the protocols that have it', () => {
    const { stderr } = runConsult(['-m', 'opencode', '--type', 'spec', '--issue', '52']);

    expect(stderr).toContain('protocol-scoped');
    expect(stderr).toMatch(/--protocol with one of: .*spir/);
  });

  it.runIf(hasDist)('the WRONG protocol points at the right one instead of an unresolved path', () => {
    // `bugfix` has no spec review; `spir` and `aspir` do. Naming the unresolved
    // path here sends you off to create a file that exists next door.
    const { stderr, status } = runConsult(['-m', 'opencode', '--type', 'spec', '--protocol', 'bugfix', '--issue', '52']);

    expect(status).not.toBe(0);
    expect(stderr).toContain('has no spec review');
    expect(stderr).toMatch(/lives under: .*spir/);
    expect(stderr).not.toContain('Prompt template not found');
  });

  it.runIf(hasDist)('an unknown type is told it is unknown, and what the real ones are', () => {
    const { stderr } = runConsult(['-m', 'opencode', '--type', 'nonsense-type', '--issue', '52']);

    expect(stderr).toContain('Unknown review type "nonsense-type"');
    expect(stderr).toContain('Available review types:');
    expect(stderr).toContain('spec');
    // The old message. It named a path nothing has ever written, which reads as
    // an instruction to create it.
    expect(stderr).not.toContain('Prompt template not found');
  });
});

describe('#54: listConsultTypes', () => {
  it('finds the protocol-scoped types and says who owns them', () => {
    const types = listConsultTypes(REPO_ROOT);
    const spec = types.find(t => t.type === 'spec');

    expect(spec).toBeDefined();
    expect(spec!.protocols).toContain('spir');
    expect(spec!.protocols).toContain('aspir');
  });

  it('marks a bare type with no owners, which is how the caller knows --protocol is not needed', () => {
    const integration = listConsultTypes(REPO_ROOT).find(t => t.type === 'integration');

    expect(integration).toBeDefined();
    expect(integration!.protocols).toEqual([]);
  });

  it('returns types sorted, with owners sorted, so the error message is stable', () => {
    const types = listConsultTypes(REPO_ROOT);

    expect(types.map(t => t.type)).toEqual([...types.map(t => t.type)].sort());
    for (const t of types) {
      expect(t.protocols).toEqual([...t.protocols].sort());
    }
  });

  it('reports nothing rather than throwing when the tiers cannot be read', () => {
    // An unreadable tier is not this function's error to raise; the caller falls
    // back to the plain not-found message rather than inventing a remedy.
    expect(() => listConsultTypes(path.join(tmpdir(), 'c54-does-not-exist'))).not.toThrow();
  });
});
