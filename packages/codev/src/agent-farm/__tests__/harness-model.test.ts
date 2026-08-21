/**
 * Unit tests for Issue #2: `(harness, model)` as a first-class per-spawn pair.
 *
 * The failure this whole change exists to prevent is a flag that is registered,
 * documented, and inert — which is exactly how `--model-id` shipped once already
 * (see commands/consult/cli-options.ts, spec 1286). So the tests here are less
 * about "the flag parses" and more about "the flag provably reaches argv, or
 * provably refuses".
 */

import { describe, it, expect } from 'vitest';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  OPENCODE_HARNESS,
  BUILTIN_HARNESSES,
  buildCustomHarnessProvider,
  validateCustomHarnessConfig,
  assertHarnessAcceptsModel,
  ModelUnsupportedError,
} from '../utils/harness.js';

describe('built-in harness model selection (Issue #2)', () => {
  // Verified against the installed CLIs, not assumed: claude `--model <model>`,
  // codex-cli 0.148.0 `-m, --model <MODEL>`, opencode 1.18.18 `-m, --model`.
  const cases = [
    ['claude', CLAUDE_HARNESS, 'sonnet'],
    ['codex', CODEX_HARNESS, 'gpt-5.6-sol'],
    ['opencode', OPENCODE_HARNESS, 'x-ai/grok-4.6'],
  ] as const;

  for (const [name, harness, modelId] of cases) {
    it(`${name} emits both argv and script forms`, () => {
      expect(harness.buildModelArgs!(modelId)).toEqual(['--model', modelId]);
      expect(harness.buildScriptModelArg!(modelId)).toBe(`--model '${modelId}'`);
    });
  }

  it('every built-in accepts a model — none is silently selector-less', () => {
    for (const [name, provider] of Object.entries(BUILTIN_HARNESSES)) {
      expect(provider.buildModelArgs, `${name} buildModelArgs`).toBeDefined();
      expect(provider.buildScriptModelArg, `${name} buildScriptModelArg`).toBeDefined();
    }
  });

  it('shell-escapes the model id in the script form', () => {
    // Model ids reach the fragment as raw CLI values, unlike promptFileReadExpr
    // which arrives pre-quoted. A quote must not be able to close the string and
    // append a command to the generated launch script.
    expect(CLAUDE_HARNESS.buildScriptModelArg!("evil'; rm -rf /; '"))
      .toBe(`--model 'evil'\\''; rm -rf /; '\\'''`);
  });

  it('opencode keeps provider/model intact — the Grok path depends on the slash', () => {
    expect(OPENCODE_HARNESS.buildScriptModelArg!('x-ai/grok-4.6')).toContain('x-ai/grok-4.6');
  });
});

describe('assertHarnessAcceptsModel (Issue #2)', () => {
  const selectorLess = { buildRoleInjection: () => ({ args: [], env: {} }), buildScriptRoleInjection: () => ({ fragment: '', env: {} }) };

  it('passes for a harness that has both model hooks', () => {
    expect(() => assertHarnessAcceptsModel('claude', CLAUDE_HARNESS)).not.toThrow();
  });

  it('throws ModelUnsupportedError for a harness with no model selector', () => {
    // The whole point: a model requested against a harness that cannot honour it
    // must fail, not be quietly dropped on the floor.
    expect(() => assertHarnessAcceptsModel('mystery', selectorLess))
      .toThrow(ModelUnsupportedError);
  });

  it('names the harness and the accepting alternatives, so the error is actionable', () => {
    const err = (() => {
      try { assertHarnessAcceptsModel('mystery', selectorLess); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err!.message).toContain('mystery');
    expect(err!.message).toMatch(/claude/);
    expect(err!.message).toContain('modelArgs');
  });
});

describe('custom harness model selection (Issue #2)', () => {
  const base = { roleArgs: [], roleScriptFragment: '' };

  it('expands ${MODEL} in both forms', () => {
    const provider = buildCustomHarnessProvider({
      ...base,
      modelArgs: ['--pick', '${MODEL}'],
      modelScriptFragment: '--pick ${MODEL}',
    });
    expect(provider.buildModelArgs!('m1')).toEqual(['--pick', 'm1']);
    expect(provider.buildScriptModelArg!('m1')).toBe('--pick m1');
  });

  it('omitting the fields leaves the hooks undefined, which reads as "no selector"', () => {
    // This is the load-bearing back-compat property: every custom harness written
    // before Issue #2 keeps behaving identically, and `--model` against it errors
    // rather than silently doing nothing.
    const provider = buildCustomHarnessProvider(base);
    expect(provider.buildModelArgs).toBeUndefined();
    expect(provider.buildScriptModelArg).toBeUndefined();
    expect(() => assertHarnessAcceptsModel('legacy', provider)).toThrow(ModelUnsupportedError);
  });

  it('does not interpret $& / $` in a model id during expansion', () => {
    const provider = buildCustomHarnessProvider({ ...base, modelScriptFragment: '--pick ${MODEL}' });
    expect(provider.buildScriptModelArg!('$&x')).toBe('--pick $&x');
  });

  it('validates the new optional fields without breaking existing configs', () => {
    expect(() => validateCustomHarnessConfig('ok', base)).not.toThrow();
    expect(() => validateCustomHarnessConfig('ok', { ...base, modelArgs: ['--m', '${MODEL}'], command: 'x' })).not.toThrow();
    expect(() => validateCustomHarnessConfig('bad', { ...base, modelArgs: 'nope' })).toThrow(/modelArgs/);
    expect(() => validateCustomHarnessConfig('bad', { ...base, modelArgs: [1] })).toThrow(/only strings/);
    expect(() => validateCustomHarnessConfig('bad', { ...base, modelScriptFragment: 7 })).toThrow(/modelScriptFragment/);
    expect(() => validateCustomHarnessConfig('bad', { ...base, command: 7 })).toThrow(/command/);
  });
});
