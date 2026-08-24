/**
 * Issue #65 — a guessed secondary artifact burns the review round it is attached to.
 *
 * The original report was that `afx spawn` hands builders an unrelated old spec
 * when the issue number collides with a zero-padded filename. That half is fixed
 * (#69: the spawn-side lookup is exact-match only), and the uiv2 architect
 * confirmed it by observation — `afx spawn 83` resolved
 * `codev/specs/83-v2-client-shell.md` correctly with
 * `0083-protocol-agnostic-spawn.md` sitting right beside it.
 *
 * What was still broken is narrower and was mis-attributed to spawn: the consult
 * lane. `codev/plans/` held `0083-protocol-agnostic-spawn.md` and no `83-*`, so
 * eleven consecutive `consult --type spec --issue 83` rounds each attached a
 * stale January draft about a different subject as "the plan", and every
 * reviewer spent part of its answer saying the plan looked unrelated.
 *
 * `artifactHeading` already warns on an inexact match, and that warning WORKED —
 * the reviewers all flagged it. It just does not help. The round is spent either
 * way.
 *
 * So the rule turns on who asked for the document. The PRIMARY artifact (the one
 * named by `--type`) keeps the lenient fallback and its warning: you asked for it
 * by id, refusing would block the review, and genuinely zero-padded legacy
 * projects must still resolve. The SECONDARY one — the plan attached to a spec
 * review, the spec attached to a plan review — is offered because it usually
 * helps, and a guess usually does not. Omitting it costs nothing.
 *
 * Not a one-file collision: 82 project ids in this repo have only a zero-padded
 * plan, so renumbering the colliding artifact would fix #83 and leave 81 others.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getResolver, matchesProjectIdExact } from '../../porch/artifacts.js';
import { dropIfGuessed } from '../index.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#65: the collision is real and is not one file', () => {
  it('this repo still has both spellings sitting side by side', () => {
    // If someone renumbers these, the test below stops proving anything, so say
    // so here rather than letting it silently pass.
    const specs = fs.readdirSync(path.join(REPO_ROOT, 'codev', 'specs'));

    expect(specs).toContain('83-v2-client-shell.md');
    expect(specs).toContain('0083-protocol-agnostic-spawn.md');
  });

  it('dozens of ids have ONLY a zero-padded plan, which is what makes this general', () => {
    const plans = fs.readdirSync(path.join(REPO_ROOT, 'codev', 'plans'));
    const padded = new Set<string>();
    const unpadded = new Set<string>();
    for (const f of plans) {
      const p = /^0+(\d+)-/.exec(f);
      if (p) padded.add(p[1]);
      const u = /^([1-9]\d*)-/.exec(f);
      if (u) unpadded.add(u[1]);
    }
    const onlyPadded = [...padded].filter(id => !unpadded.has(id));

    expect(onlyPadded.length).toBeGreaterThan(50);
  });
});

describe('#65: exactness is what separates the two cases', () => {
  it('treats an unpadded name as project N', () => {
    expect(matchesProjectIdExact('83-v2-client-shell', '83')).toBe(true);
  });

  it('does NOT treat a zero-padded name as project N', () => {
    // The whole distinction. `0083-...` is a different document that collides on
    // the number, not project 83 wearing leading zeros.
    expect(matchesProjectIdExact('0083-protocol-agnostic-spawn', '83')).toBe(false);
  });

  it('still treats a zero-padded name as its own literal id', () => {
    // A genuinely zero-padded legacy project asked for by its padded id resolves
    // exactly, so the lenient fallback is not the only thing keeping it working.
    expect(matchesProjectIdExact('0083-protocol-agnostic-spawn', '0083')).toBe(true);
  });
});

describe('#65: the resolver still hands back the guess, which is why the caller must decide', () => {
  it('returns a zero-stripped plan for an id with no exact plan', () => {
    // Not a bug in the resolver: the lenient fallback exists so genuinely
    // zero-padded legacy projects resolve. It is the CALLER that must not attach
    // this to a review as if it were context.
    const r = getResolver(REPO_ROOT);
    const plans = fs.readdirSync(path.join(REPO_ROOT, 'codev', 'plans'));
    const padded = plans.find(f => /^0+\d+-/.test(f));
    const id = String(Number(/^0+(\d+)-/.exec(padded!)![1]));

    const resolved = r.findPlanBaseName(id, '');

    // Either it resolved exactly (someone added a canonical plan since) or it
    // guessed — and if it guessed, the guess is the padded sibling.
    if (resolved && !matchesProjectIdExact(resolved, id)) {
      expect(resolved).toMatch(/^0+\d+-/);
    }
  });

  it('resolves 83 exactly now that the canonical plan exists', () => {
    // The project-83 run created codev/plans/83-v2-client-shell.md, so the
    // reported symptom no longer reproduces on THIS id. That is why the fix is
    // tested against the rule rather than against project 83.
    const r = getResolver(REPO_ROOT);

    expect(r.findPlanBaseName('83', '')).toBe('83-v2-client-shell');
    expect(r.findSpecBaseName('83', '')).toBe('83-v2-client-shell');
  });
});

describe('#65: dropIfGuessed — the rule itself', () => {
  const ref = (label: string) => ({ content: '# doc', label, requestedId: '83' });

  it('keeps an exactly-matched secondary artifact', () => {
    const kept = dropIfGuessed(ref('83-v2-client-shell'), 'plan', '83');

    expect(kept?.label).toBe('83-v2-client-shell');
  });

  it('drops the zero-stripped guess that cost eleven review rounds', () => {
    const dropped = dropIfGuessed(ref('0083-protocol-agnostic-spawn'), 'plan', '83');

    expect(dropped).toBeNull();
  });

  it('says on stderr why it dropped it, so the omission is not itself silent', () => {
    // A missing plan with no explanation is the same defect facing the other
    // way: the operator cannot tell "no plan exists" from "we declined one".
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });

    dropIfGuessed(ref('0083-protocol-agnostic-spawn'), 'plan', '83');

    const said = lines.join('\n');
    expect(said).toContain('0083-protocol-agnostic-spawn');
    expect(said).toContain('zero-stripping');
    expect(said).toContain('--plan-file');
  });

  it('passes null through — a genuinely absent artifact is not a dropped one', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });

    expect(dropIfGuessed(null, 'plan', '83')).toBeNull();
    expect(lines).toEqual([]);
  });

  it('leaves a non-numeric label alone rather than guessing about it', () => {
    // The bare-id fallback and prefix-style ids are not id-prefixed artifact
    // names; exactness says nothing useful about them.
    const kept = dropIfGuessed(ref('some-unnumbered-doc'), 'plan', '83');

    expect(kept?.label).toBe('some-unnumbered-doc');
  });

  it('names the right kind in the message', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });

    dropIfGuessed(ref('0083-protocol-agnostic-spawn'), 'spec', '83');

    expect(lines.join('\n')).toContain('--spec-file');
  });

  it('keeps a padded artifact when the padded id is what was asked for', () => {
    // A genuinely zero-padded legacy project consulting on its own id must not
    // lose its own plan to this rule.
    const kept = dropIfGuessed(
      { content: '# doc', label: '0083-protocol-agnostic-spawn', requestedId: '0083' },
      'plan',
      '0083',
    );

    expect(kept?.label).toBe('0083-protocol-agnostic-spawn');
  });
});
