/**
 * Issue #21 — a hold that could never resolve, and an alert naming a remedy
 * that does not work.
 *
 * A message to a builder holds with reason `busy` and never delivers, because
 * the agent left text in its own composer — Claude Code's suggested next action,
 * e.g. "spawn a real opencode builder and send it a message". Verified five
 * times on 2026-08-21 by reading the terminal buffer directly via
 * `GET /api/terminals/<id>/output`.
 *
 * The gate is RIGHT every time: injecting into a composer holding text would
 * corrupt the agent's input. The gap is that nothing owns clearing a prompt the
 * agent abandoned, and the documented escape does not work:
 *
 *   > Remedy: run `afx inbox` to inspect; `afx interrupt builder-x` clears a
 *   > stuck composer.
 *
 * `afx interrupt` sends ESC. ESC does not clear typed text. Running it changed
 * nothing and the alert fired again three minutes later. `afx send --interrupt`
 * sends Ctrl+C first, which does — documented as a way to send a message, not as
 * the remedy for this state, so nobody found it.
 *
 * Two situations reached the operator as the same word. `user-text` is an
 * abandoned draft a human can safely clear; `busy-indicator` is an agent
 * mid-turn that must not be touched. The gate distinguishes them internally and
 * the distinction stopped there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue, setHeldReason, findStarvingAgents } from '../db/mailbox.js';
import { heldRemedy } from '../servers/mailbox-wiring.js';

const testDir = resolve(process.cwd(), '.test-issue-21-hold-detail');
let db: Database.Database;

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new Database(resolve(testDir, 'global.db'));
  db.exec(GLOBAL_SCHEMA);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function held(toAgent = 'builder-x') {
  return enqueue(db, {
    workspacePath: '/ws/a',
    toAgent,
    body: 'b',
    formattedMessage: 'f',
  });
}

describe('#21: the two situations that arrived as one word', () => {
  it('records WHICH not-clean verdict held the row, not just that one did', () => {
    const draft = held('builder-draft');
    const midTurn = held('builder-busy');

    setHeldReason(db, draft.id, 'busy', Date.now(), 'user-text');
    setHeldReason(db, midTurn.id, 'busy', Date.now(), 'busy-indicator');

    const read = (id: string) =>
      db.prepare('SELECT reason, hold_detail FROM mailbox WHERE id = ?').get(id) as
        { reason: string; hold_detail: string };

    // Identical before — this is the whole defect.
    expect(read(draft.id).reason).toBe(read(midTurn.id).reason);
    // Distinguishable now.
    expect(read(draft.id).hold_detail).toBe('user-text');
    expect(read(midTurn.id).hold_detail).toBe('busy-indicator');
  });

  it('leaves the detail null on a row that has never been through the gate', () => {
    // "Not recorded" must stay expressible. A row held before the migration
    // genuinely does not know, and inventing a kind would pick a remedy for it.
    const row = held();

    expect(row.hold_detail).toBeNull();
  });

  it('carries the detail to the starvation alarm alongside the reason', () => {
    const row = held('builder-x');
    setHeldReason(db, row.id, 'busy', Date.now(), 'user-text');

    const [agent] = findStarvingAgents(db, Date.now());

    expect(agent.toAgent).toBe('builder-x');
    expect(agent.reason).toBe('busy');
    expect(agent.detail).toBe('user-text');
  });
});

describe('#21: the alert names a remedy that works', () => {
  it('an abandoned draft gets the command that actually clears a composer', () => {
    const text = heldRemedy('builder-x', 'user-text');

    expect(text).toContain('afx send builder-x --interrupt');
    expect(text).toContain('Ctrl+C');
  });

  it('and says outright that the old remedy does not clear typed text', () => {
    // The line that cost five manual interventions. Someone who has been running
    // `afx interrupt` needs to be told why it changed nothing.
    const text = heldRemedy('builder-x', 'user-text');

    expect(text).toContain("'afx interrupt' sends ESC, which does not");
  });

  it('a live turn is told to WAIT, not to clear anything', () => {
    // The opposite situation. Clearing here corrupts a turn in progress, so the
    // remedy for the other case must not be offered.
    const text = heldRemedy('builder-x', 'busy-indicator');

    expect(text).toContain('MID-TURN');
    expect(text).toContain('Do not clear');
    expect(text).not.toContain('--interrupt "');
  });

  it('an unrecognized screen says so instead of guessing a remedy', () => {
    const text = heldRemedy('builder-x', 'no-composer-marker');

    expect(text).toContain('screen problem');
    expect(text).toContain('no-composer-marker');
    expect(text).not.toContain('--interrupt "');
  });

  it('a row with no recorded detail gets the same honest non-answer', () => {
    const text = heldRemedy('builder-x', null);

    expect(text).toContain('could not read a ready prompt');
    expect(text).not.toContain('--interrupt "');
  });

  it('the three remedies are actually different advice', () => {
    const texts = [
      heldRemedy('b', 'user-text'),
      heldRemedy('b', 'busy-indicator'),
      heldRemedy('b', null),
    ];

    expect(new Set(texts).size).toBe(3);
  });
});
