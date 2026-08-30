/**
 * EVERY CLASS THE PAGE EMITS HAS A RULE (Spec 236, phase 6).
 *
 * ## Why this exists
 *
 * Phase 6 added one new element, `.gate-progress`, and forgot its CSS. Nothing
 * in the suite could see that: it rendered, its text was correct, and every
 * assertion about it passed — while it displayed at the browser's default 16px
 * with default margins inside an 11px panel. A review caught it by reading, and
 * a review is not a mechanism.
 *
 * This is the same failure #112 shipped: a component test asserts that the name
 * renders and passes happily while the thing that made it legible is gone. A
 * green suite cannot detect design infidelity, so the one part of it that CAN be
 * mechanised — that a class the page emits is a class the stylesheet knows — is.
 *
 * ## What it does NOT claim
 *
 * That the rule is right, or that the element looks correct. Only that the
 * stylesheet has heard of it. Judging the appearance still means opening the
 * page, and no test here pretends otherwise.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/**
 * The class names the components actually emit.
 *
 * Template holes are stripped rather than guessed at: `${down ? 'is-stale' : ''}`
 * contributes nothing here, and the literals around it still do. A collector that
 * tried to evaluate them would be a small interpreter with its own bugs.
 */
function emittedClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      for (const name of raw.split(/\s+/)) {
        if (name.length > 0) classes.add(name);
      }
    }
  }
  return classes;
}

describe('the stylesheet knows every class the page emits', () => {
  it('collects a plausible number of classes, so it cannot pass by seeing none', () => {
    // The anchor. A collector that stopped matching this file's style would
    // otherwise report an empty set and a clean pass.
    const classes = emittedClasses();
    expect(classes.size).toBeGreaterThan(30);
    expect(classes).toContain('gate-progress');
    expect(classes).toContain('status-stamp');
  });

  it('has a rule for each of them', () => {
    const css = readFileSync(join(SRC, 'client.css'), 'utf8')
      + readFileSync(join(SRC, 'tokens.css'), 'utf8');
    const unstyled = [...emittedClasses()].filter((name) => !css.includes(`.${name}`)).sort();
    expect(
      unstyled,
      'these classes are emitted by a component and appear in no stylesheet, so they render at '
      + 'the browser\'s defaults. That is invisible to every other test in this suite — it is how '
      + 'phase 6 shipped .gate-progress at 16px inside an 11px panel.',
    ).toEqual([]);
  });
});
