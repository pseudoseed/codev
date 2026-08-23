/**
 * Issue #27 — CI's worker-crash tolerance could never fire.
 *
 * Vitest's forks pool has a known crash during cleanup after all tests pass.
 * `test.yml` carried a guard written specifically to tolerate that:
 *
 *     grep -q "Test Files.*passed" out && ! grep -q "failed" out
 *
 * The second condition greps the bare word `failed` across the WHOLE captured
 * output, which includes everything the tests themselves print. Measured
 * against a real, fully GREEN CI run (GitHub Actions 32666076117): five
 * case-sensitive matches, none of them a failing test — two test names
 * (`reentry-failed`, `clear-failed`), one test title containing "a failed Tower
 * send", and two `git fetch ... failed` warnings from the consult tests.
 *
 * So the tolerance branch was unreachable and every worker crash was a hard
 * red. It cost a real diagnosis during PIR #13: the branch was red at HEAD
 * while a local run was green, and the builder spent a pass on a defect that
 * was not its own.
 *
 * These tests run the ACTUAL script the workflow calls, against a fixture
 * excerpted verbatim from that green CI run. A hand-written fixture would not
 * have caught this — the whole defect is about what real output contains.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'vitest-crash-tolerance.sh');
const GREEN_FIXTURE = path.join(__dirname, 'fixtures', 'vitest-green-with-crash.txt');

/** Run the guard. Returns true when it tolerates (exit 0). */
function tolerates(outputFile: string, vitestExit: number): boolean {
  const r = spawnSync('bash', [SCRIPT, outputFile, String(vitestExit)], { encoding: 'utf-8' });
  return r.status === 0;
}

function withTempOutput(content: string, fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'vct-'));
  const file = path.join(dir, 'vitest-output.txt');
  fs.writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('#27: the guard the old one replaced', () => {
  it('the fixture really does contain the word that broke it', () => {
    // If this ever stops being true the regression test below is vacuous.
    const text = fs.readFileSync(GREEN_FIXTURE, 'utf-8');
    const body = text.split('\n').filter(l => !l.startsWith('#')).join('\n');
    const occurrences = body.match(/failed/g) ?? [];

    expect(occurrences.length).toBeGreaterThanOrEqual(5);
  });

  it('the OLD condition rejects this green run — the bug, reproduced', () => {
    const body = fs.readFileSync(GREEN_FIXTURE, 'utf-8');
    const oldGuardWouldTolerate = /Test Files.*passed/.test(body) && !/failed/.test(body);

    expect(oldGuardWouldTolerate).toBe(false);
  });
});

describe('#27: the guard tolerates a crash after a green suite', () => {
  it('tolerates the real green CI output', () => {
    expect(tolerates(GREEN_FIXTURE, 1)).toBe(true);
  });

  it('passes through a zero exit untouched', () => {
    expect(tolerates(GREEN_FIXTURE, 0)).toBe(true);
  });
});

describe('#27: the guard still fails on anything that is not that', () => {
  it('fails when the summary reports failing tests', () => {
    withTempOutput(
      ' Test Files  1 failed | 286 passed (290)\n      Tests  2 failed | 5749 passed (5799)\n',
      file => expect(tolerates(file, 1)).toBe(false),
    );
  });

  it('fails when only ONE of the two summary lines reports a failure', () => {
    withTempOutput(
      ' Test Files  292 passed (292)\n      Tests  1 failed | 5802 passed (5803)\n',
      file => expect(tolerates(file, 1)).toBe(false),
    );
  });

  it('fails when vitest crashed BEFORE printing a summary', () => {
    // A crash with no summary is indistinguishable from a suite that never
    // ran. Tolerating it is how "vitest died on startup" gets reported as
    // "all tests passed".
    withTempOutput('some early crash output\nsegfault\n', file =>
      expect(tolerates(file, 1)).toBe(false),
    );
  });

  it('fails on empty output', () => {
    withTempOutput('', file => expect(tolerates(file, 1)).toBe(false));
  });

  it('fails when a test PRINTS a fake summary but no real one follows', () => {
    // Guard against the inverse of the original bug: matching on content a
    // test can emit. A printed line is not a summary unless vitest wrote it —
    // this one is tolerated only because the real summary is absent... and it
    // is not, so it must fail.
    withTempOutput('stdout | some.test.ts\nTest Files  999 passed (999)\n', file =>
      // Deliberately NOT tolerated: this line has no leading whitespace and no
      // companion `Tests` line, so it is not vitest's summary block.
      expect(tolerates(file, 1)).toBe(false),
    );
  });
});

describe('#27: a test name containing the word cannot flip the decision', () => {
  it('tolerates a green run whose tests are all named "... failed ..."', () => {
    withTempOutput(
      [
        'stdout | a.test.ts > reports a failed send',
        'stdout | b.test.ts > clear-failed path',
        'Warning: `git fetch origin nope` failed; proceeding',
        ' Test Files  292 passed | 3 skipped (295)',
        '      Tests  5803 passed | 60 skipped (5863)',
        '',
      ].join('\n'),
      file => expect(tolerates(file, 1)).toBe(true),
    );
  });

  it('but a real failure alongside those names still fails', () => {
    withTempOutput(
      [
        'stdout | a.test.ts > reports a failed send',
        ' Test Files  1 failed | 291 passed (292)',
        '      Tests  3 failed | 5800 passed (5803)',
        '',
      ].join('\n'),
      file => expect(tolerates(file, 1)).toBe(false),
    );
  });
});

describe('#27: ANSI colour does not hide the counts', () => {
  it('reads a summary with vitest colour codes', () => {
    // Vitest colours the counts, so `1 failed` arrives with escape sequences
    // between the number and the word in real output.
    const esc = '[31m';
    const reset = '[39m';
    withTempOutput(
      ` Test Files  ${esc}1 failed${reset} | 286 passed (290)\n      Tests  ${esc}2 failed${reset} | 5749 passed (5799)\n`,
      file => expect(tolerates(file, 1)).toBe(false),
    );
  });
});
