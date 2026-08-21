/**
 * The opencode consult lane (#22) — a Grok reviewer on an account no other lane shares.
 *
 * Two properties carry this lane, and both are here because of what they prevent:
 *
 *  1. **An unknown model id is named before the spawn.** Live-probed 2026-08-21:
 *     `opencode run -m x-ai/grok-4.6` exits 1 with EMPTY stdout and
 *     `UnknownError: Unexpected server error` on stderr — text that identifies neither the model
 *     nor the mistake. The pre-flight against `opencode models` is the only place a message can
 *     say "you wrote `x-ai/`, this machine has `xai/`".
 *
 *  2. **Nothing degrades into a passing review.** #20: porch counts a lane that never produced
 *     a verdict as an approval. So a missing CLI, a rejected id, a non-zero exit, and empty
 *     output all throw, and none of them leaves a review file behind for porch to find.
 *
 * Uses a real fake `opencode` binary (the `agy-lane-model.test.ts` pattern) rather than a module
 * mock, so argv, exit codes and stream routing are genuinely exercised — `opencode` writes its
 * banner to stderr and only the review to stdout, and that split is load-bearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _runOpencodeConsultation,
  resolveOpencodeBin,
  listOpencodeModels,
  opencodeReviewHeader,
  resolveLaneModelChoice,
  DEFAULT_OPENCODE_MODEL,
} from '../index.js';
import {
  assertOpencodeModelAvailable,
  MODEL_CONFIGURABLE_LANES,
  VALID_LANE_NAMES,
  validateLaneList,
  validateConsultModels,
} from '../../../lib/consult-lanes.js';

const ENV_KEYS = [
  'CODEV_OPENCODE_BIN',
  'FAKE_OPENCODE_ARGV_LOG',
  'FAKE_OPENCODE_MODE',
  'HOME',
  'CODEV_METRICS_DB',
] as const;

/**
 * Fake opencode. Records argv, answers `models` with a catalog shaped like the real one (note
 * `xai/`, not `x-ai/`), then behaves per FAKE_OPENCODE_MODE.
 *
 * The banner on stderr is not decoration: it reproduces the real CLI's stream split, so a test
 * that asserts "stdout IS the review" is asserting something real.
 */
const FAKE_OPENCODE_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === 'models') {
  process.stdout.write('opencode/big-pickle\\nxai/grok-4.3\\nxai/grok-4.6\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_OPENCODE_ARGV_LOG, JSON.stringify(argv));
process.stderr.write('\\n> build · fake\\n');
const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
if (mode === 'reject') {
  process.stderr.write('Error: {"name":"UnknownError","data":{"message":"Unexpected server error."}}\\n');
  process.exit(1);
}
if (mode === 'empty') { process.exit(0); }
process.stdout.write('Looks fine to me.\\n\\nVERDICT: APPROVE\\nSUMMARY: ok\\nCONFIDENCE: HIGH\\n');
process.exit(0);
`;

let dir: string;
let savedEnv: Record<string, string | undefined>;
let argvLog: string;

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codev', 'config.json'), JSON.stringify(config));
}

function opencodeArgv(): string[] {
  return JSON.parse(fs.readFileSync(argvLog, 'utf-8'));
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-lane-'));
  const fakeBin = path.join(dir, 'opencode');
  fs.writeFileSync(fakeBin, FAKE_OPENCODE_SOURCE, { mode: 0o755 });
  argvLog = path.join(dir, 'argv.json');

  process.env.CODEV_OPENCODE_BIN = fakeBin;
  process.env.FAKE_OPENCODE_ARGV_LOG = argvLog;
  process.env.FAKE_OPENCODE_MODE = 'ok';
  // A real ~/.codev/config.json would otherwise leak an opencode model into every assertion.
  process.env.HOME = path.join(dir, 'fake-home');

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- registration ---------------------------------------------------------------------

describe('opencode is a first-class lane', () => {
  it('is selectable in porch.consultation lane lists', () => {
    expect(VALID_LANE_NAMES).toContain('opencode');
    expect(() => validateLaneList(['gemini', 'claude', 'opencode'], 'porch.consultation.models'))
      .not.toThrow();
  });

  it('accepts a configured model id, which is the point of adding it', () => {
    expect(MODEL_CONFIGURABLE_LANES).toContain('opencode');
    expect(() => validateConsultModels({ opencode: 'xai/grok-4.6' })).not.toThrow();
  });

  it('rejects a syntactically invalid id like any other configurable lane', () => {
    expect(() => validateConsultModels({ opencode: '-leading-dash' })).toThrow(/Invalid model id/);
  });
});

// --- argv -----------------------------------------------------------------------------

describe('argv', () => {
  it('runs `opencode run -m <id> <prompt>`', async () => {
    await _runOpencodeConsultation('the query', 'the role', dir);
    const argv = opencodeArgv();
    expect(argv[0]).toBe('run');
    expect(argv).toContain('-m');
    expect(argv[argv.indexOf('-m') + 1]).toBe(DEFAULT_OPENCODE_MODEL);
  });

  it('folds the role into the prompt — opencode has no system-prompt flag', async () => {
    await _runOpencodeConsultation('the query', 'the role', dir);
    const prompt = opencodeArgv().at(-1)!;
    expect(prompt).toContain('the role');
    expect(prompt).toContain('the query');
  });

  it('sends the configured model id rather than the shipped default', async () => {
    writeConfig({ consult: { models: { opencode: 'xai/grok-4.3' } } });
    await _runOpencodeConsultation('q', 'role', dir);
    const argv = opencodeArgv();
    expect(argv[argv.indexOf('-m') + 1]).toBe('xai/grok-4.3');
  });

  it('lets --model-id outrank config', async () => {
    writeConfig({ consult: { models: { opencode: 'xai/grok-4.3' } } });
    const choice = resolveLaneModelChoice(dir, 'opencode', DEFAULT_OPENCODE_MODEL, 'xai/grok-4.6');
    await _runOpencodeConsultation('q', 'role', dir, undefined, undefined, choice);
    const argv = opencodeArgv();
    expect(argv[argv.indexOf('-m') + 1]).toBe('xai/grok-4.6');
  });
});

// --- the review -----------------------------------------------------------------------

describe('the review output', () => {
  it('is stdout, with the VERDICT line intact', async () => {
    const outputPath = path.join(dir, 'review.md');
    await _runOpencodeConsultation('q', 'role', dir, outputPath);
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('VERDICT: APPROVE');
    // The banner opencode writes to stderr must not end up in the review.
    expect(content).not.toContain('> build · fake');
  });

  it('names the model that produced it — Grok 4.6 and Grok 4.3 are not interchangeable evidence', async () => {
    writeConfig({ consult: { models: { opencode: 'xai/grok-4.3' } } });
    const outputPath = path.join(dir, 'review.md');
    await _runOpencodeConsultation('q', 'role', dir, outputPath);
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('xai/grok-4.3');
    expect(content).toContain('consult.models.opencode');
  });

  it('puts the header where it cannot shadow the verdict', () => {
    const header = opencodeReviewHeader({
      id: 'xai/grok-4.6', key: null, source: null, fromFlag: false,
    });
    // parseVerdict scans last→first; a header carrying its own VERDICT token would win.
    expect(header).not.toContain('VERDICT');
    expect(header).toContain('xai/grok-4.6');
  });
});

// --- failing loudly --------------------------------------------------------------------

describe('an unknown model id fails before the spawn', () => {
  it('names the right prefix when only the prefix is wrong', () => {
    const available = ['xai/grok-4.6', 'xai/grok-4.3', 'opencode/big-pickle'];
    expect(() => assertOpencodeModelAvailable('x-ai/grok-4.6', available, 'consult.models.opencode'))
      .toThrow(/xai\/grok-4\.6/);
    expect(() => assertOpencodeModelAvailable('x-ai/grok-4.6', available, 'consult.models.opencode'))
      .toThrow(/Did you mean/);
  });

  it('names where the bad id came from', () => {
    expect(() => assertOpencodeModelAvailable('x-ai/grok-4.6', ['xai/grok-4.6'], '--model-id'))
      .toThrow(/--model-id/);
  });

  it('lists the real catalog when the name is wrong too', () => {
    expect(() => assertOpencodeModelAvailable('xai/grok-9', ['xai/grok-4.6'], null))
      .toThrow(/opencode models.* on this machine offers/s);
  });

  it('never falls back to a working id', () => {
    expect(() => assertOpencodeModelAvailable('x-ai/grok-4.6', ['xai/grok-4.6'], null))
      .toThrow(/does not fall back/);
  });

  it('passes an id the catalog does offer', () => {
    expect(() => assertOpencodeModelAvailable('xai/grok-4.6', ['xai/grok-4.6'], null)).not.toThrow();
  });

  it('treats an unreadable catalog as unknown, not as "nothing is valid"', () => {
    // A broken `opencode models` must not fail every review — the provider stays the authority.
    expect(() => assertOpencodeModelAvailable('xai/anything', [], null)).not.toThrow();
  });

  it('rejects through the lane, without spawning a review', async () => {
    writeConfig({ consult: { models: { opencode: 'x-ai/grok-4.6' } } });
    await expect(_runOpencodeConsultation('q', 'role', dir)).rejects.toThrow(/Unknown opencode model/);
    expect(fs.existsSync(argvLog)).toBe(false);
  });
});

describe('nothing degrades into a passing review (#20)', () => {
  it('a non-zero exit rejects', async () => {
    process.env.FAKE_OPENCODE_MODE = 'reject';
    await expect(_runOpencodeConsultation('q', 'role', dir))
      .rejects.toThrow(/opencode exited with code 1/);
  });

  it('a non-zero exit carries opencode\'s own diagnostic text', async () => {
    process.env.FAKE_OPENCODE_MODE = 'reject';
    await expect(_runOpencodeConsultation('q', 'role', dir)).rejects.toThrow(/UnknownError/);
  });

  it('empty output rejects rather than passing as a silent skip', async () => {
    process.env.FAKE_OPENCODE_MODE = 'empty';
    await expect(_runOpencodeConsultation('q', 'role', dir))
      .rejects.toThrow(/produced no review output/);
  });

  it('a missing CLI rejects', async () => {
    process.env.CODEV_OPENCODE_BIN = path.join(dir, 'not-installed');
    await expect(_runOpencodeConsultation('q', 'role', dir)).rejects.toThrow(/opencode not found/);
  });

  it('leaves no stale review file for porch to accept', async () => {
    // The failure mode this guards: consult writes to a deterministic per-iteration path, so a
    // review from an EARLIER run of the same iteration would be read as this one's.
    const outputPath = path.join(dir, 'review.md');
    fs.writeFileSync(outputPath, 'stale review from a previous run\nVERDICT: APPROVE\n');
    process.env.FAKE_OPENCODE_MODE = 'reject';

    await _runOpencodeConsultation('q', 'role', dir, outputPath).catch(() => {});

    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('discards a stale review on a rejected model id too', async () => {
    const outputPath = path.join(dir, 'review.md');
    fs.writeFileSync(outputPath, 'stale review\nVERDICT: APPROVE\n');
    writeConfig({ consult: { models: { opencode: 'x-ai/grok-4.6' } } });

    await _runOpencodeConsultation('q', 'role', dir, outputPath).catch(() => {});

    expect(fs.existsSync(outputPath)).toBe(false);
  });
});

// --- binary resolution ------------------------------------------------------------------

describe('binary resolution', () => {
  it('honours CODEV_OPENCODE_BIN', () => {
    expect(resolveOpencodeBin()).toBe(process.env.CODEV_OPENCODE_BIN);
  });

  it('returns null for an override that does not exist, rather than silently using PATH', () => {
    process.env.CODEV_OPENCODE_BIN = path.join(dir, 'nope');
    expect(resolveOpencodeBin()).toBeNull();
  });

  it('refuses to reach the real binary from an unpinned test', () => {
    delete process.env.CODEV_OPENCODE_BIN;
    // A billed Grok call per spawn is not something a suite should reach by omission.
    expect(() => resolveOpencodeBin()).toThrow(/CODEV_OPENCODE_BIN/);
  });

  it('reads the catalog from the resolved binary', () => {
    expect(listOpencodeModels(process.env.CODEV_OPENCODE_BIN!)).toEqual([
      'opencode/big-pickle', 'xai/grok-4.3', 'xai/grok-4.6',
    ]);
  });

  it('returns an empty catalog rather than throwing when the listing fails', () => {
    expect(listOpencodeModels(path.join(dir, 'nope'))).toEqual([]);
  });
});
