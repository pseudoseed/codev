/**
 * Issues #25, #35, #43 — consult saying the wrong thing when it cannot tell.
 *
 *   #43 A bare `--type pr` failed by naming `codev/consult-types/pr-review.md`,
 *       a path that has never shipped in any release. The reader is being told
 *       to create a file; the actual fix is `--protocol`.
 *   #35 A 0-byte PR diff produced a prompt saying `Changed Files (0)`, and
 *       three lanes returned APPROVE (HIGH) on nothing.
 *   #25 The agy skip artifact ended with "install the CLI and sign in"
 *       regardless of cause — two wrong instructions for a quota wall.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agyRemedy,
  buildOpencodeArgs,
  extractSandboxPaths,
  _consultSandboxDirForTest as _consultSandboxDir,
} from '../commands/consult/index.js';
import { protocolsProvidingConsultType } from '../lib/skeleton.js';

describe('#43: a protocol-scoped review type must name the real remedy', () => {
  it('finds the protocols that actually ship pr-review.md', () => {
    const owners = protocolsProvidingConsultType('pr-review.md');

    // Whichever tier answers, the answer must be non-empty and must include the
    // protocols this repo ships. If this ever returns [], the error message
    // correctly falls back to the plain not-found rather than guessing.
    expect(owners.length).toBeGreaterThan(0);
    expect(owners).toContain('bugfix');
    expect(owners).toContain('pir');
  });

  it('reports nothing for a review type no protocol provides', () => {
    // "I could not find an owner" must be expressible. Returning a plausible
    // list here would be a second wrong remedy replacing the first.
    expect(protocolsProvidingConsultType('nonsense-review.md')).toEqual([]);
  });

  it('integration-review is NOT protocol-scoped, so it needs no --protocol', () => {
    // The one type that legitimately resolves bare. Pinned so a future change
    // that moves it under protocols/ has to notice.
    expect(protocolsProvidingConsultType('integration-review.md')).toEqual([]);
  });
});

describe('#25: the agy skip remedy must match the actual failure', () => {
  it('does NOT advise installing the CLI when the cause is a quota wall', () => {
    // The CLI is installed. Saying "install it" is a detour, and saying
    // "sign in again" does not refill a quota.
    const remedy = agyRemedy('agy exited with code 1', 'Error: RESOURCE_EXHAUSTED: quota exceeded for model');

    // Asserted against the INSTRUCTION, not the word: the message legitimately
    // says "the CLI is installed and signed in", which is the point being made.
    expect(remedy).not.toMatch(/install the cli|https:\/\/antigravity/i);
    expect(remedy).toMatch(/quota|rate limit/i);
  });

  it('recognises a rate limit by HTTP status alone', () => {
    expect(agyRemedy('agy exited with code 1', 'request failed: 429 Too Many Requests'))
      .toMatch(/quota|rate limit/i);
  });

  it('DOES advise installing when the CLI is genuinely missing', () => {
    expect(agyRemedy('agy CLI not found (install: https://antigravity.google/cli/install.sh)'))
      .toMatch(/install/i);
  });

  it('advises signing in for an auth failure', () => {
    const remedy = agyRemedy('agy exited with code 1', 'Error: 401 Unauthorized — no credentials found');

    expect(remedy).toMatch(/sign in/i);
    expect(remedy).not.toMatch(/install/i);
  });

  it('advises re-running for a timeout', () => {
    expect(agyRemedy('agy timed out producing the review')).toMatch(/time budget|re-run/i);
  });

  it('offers NO remedy for an unrecognised failure', () => {
    // The point of the whole change. A guessed remedy costs more than no
    // remedy, because the reader acts on it. The caller shows agy's raw output
    // instead.
    expect(agyRemedy('agy exited with code 1', 'Segmentation fault')).toBe('');
  });

  it('reads the reason as well as the tail, so a cause named either way is caught', () => {
    expect(agyRemedy('agy quota exhausted', '')).toMatch(/quota|rate limit/i);
  });
});

describe('#44: the opencode arg vector', () => {
  it('puts `--` immediately before the prompt so yargs cannot eat it', () => {
    // `-f/--file` is declared `[array]` and yargs arrays are greedy. Without
    // the separator the prompt becomes another filename and the lane dies with
    // `Error: File not found: <the entire prompt>`. Verified live against the
    // installed CLI before this test was written.
    const args = buildOpencodeArgs('xai/grok-4.6', ['/tmp/s/a.md', '/tmp/s/b.diff'], 'review this');

    expect(args[args.length - 1]).toBe('review this');
    expect(args[args.length - 2]).toBe('--');
  });

  it('emits the separator even with NO attachments', () => {
    // Harmless when empty (verified live), and making it conditional is one
    // more branch that can be wrong on the path that matters.
    const args = buildOpencodeArgs('xai/grok-4.6', [], 'review this');

    expect(args[args.length - 2]).toBe('--');
    expect(args).not.toContain('-f');
  });

  it('pairs each attachment with its own -f', () => {
    const args = buildOpencodeArgs('m', ['/a', '/b'], 'p');
    const flags = args.filter(a => a === '-f');

    expect(flags).toHaveLength(2);
    expect(args[args.indexOf('-f') + 1]).toBe('/a');
  });

  it('keeps the model flag ahead of the separator', () => {
    const args = buildOpencodeArgs('xai/grok-4.6', ['/a'], 'p');

    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('--'));
    expect(args[args.indexOf('-m') + 1]).toBe('xai/grok-4.6');
  });
});

describe('#25: the not-found remedy must not catch a model-not-found', () => {
  it('does NOT say "install the CLI" for a 404 from the provider', () => {
    // The lane passes --model-id, so "model not found" in stderr is a live
    // possibility. Matching it against the combined haystack produced exactly
    // the wrong-remedy class this function exists to remove.
    const remedy = agyRemedy('agy exited with code 1', 'Error: model not found: gemini-9-ultra');

    expect(remedy).not.toMatch(/install the cli/i);
  });

  it('does NOT say "install the CLI" for a 404 Not Found', () => {
    expect(agyRemedy('agy exited with code 1', 'request failed: 404 Not Found'))
      .not.toMatch(/install the cli/i);
  });

  it('STILL says install when the reason is a genuinely missing binary', () => {
    expect(agyRemedy('agy CLI not found (install: https://antigravity.google/cli/install.sh)'))
      .toMatch(/install the cli/i);
  });
});

describe('#44: extractSandboxPaths', () => {
  it('returns nothing when the sandbox was never created', () => {
    // No consult artifacts this process, so there is nothing to attach. Must be
    // empty, not a guess at a path that might exist.
    expect(extractSandboxPaths('**Diff file**: `/var/folders/xx/codev-consult-abc/pr-1.diff`'))
      .toEqual([]);
  });

  it('ignores paths outside the sandbox even when the sandbox exists', () => {
    const sandbox = _consultSandboxDir();
    const inside = path.join(sandbox, 'pr-7.diff');
    fs.writeFileSync(inside, 'diff --git a/x b/x\n');

    const text = [
      '**Diff file**: `' + inside + '`',
      'Also see `/etc/passwd` and `' + path.join(os.tmpdir(), 'elsewhere.diff') + '`',
    ].join('\n');

    expect(extractSandboxPaths(text)).toEqual([inside]);
  });

  it('skips a sandbox path that is named but does not exist', () => {
    // The prompt can name a file a previous run cleaned up. Attaching a
    // non-existent path would make opencode fail on a file nobody needed.
    const sandbox = _consultSandboxDir();
    const missing = path.join(sandbox, 'never-written.diff');

    expect(extractSandboxPaths('**Diff file**: `' + missing + '`')).toEqual([]);
  });

  it('deduplicates a path named more than once', () => {
    const sandbox = _consultSandboxDir();
    const p1 = path.join(sandbox, 'pr-9.diff');
    fs.writeFileSync(p1, 'x');

    expect(extractSandboxPaths('`' + p1 + '` and again `' + p1 + '`')).toEqual([p1]);
  });
});
