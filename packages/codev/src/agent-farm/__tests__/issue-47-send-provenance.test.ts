/**
 * Issue #47 — a misroute report that could not be answered.
 *
 * Thirteen builder messages arrived in the wrong architect's inbox. The obvious
 * hypothesis was that `afx send architect` ignores `spawned_by_architect`, but
 * the mailbox table disproves it: `builder-spir-52 -> uiv2` appears five times,
 * and no uiv2-owned builder ever reached `main`.
 *
 * Every misrouted row instead had `from_agent = 'architect'`, and an architect
 * sender routing to `main` is the documented, correct rule. So the real question
 * was how a builder's status message came to be sent by something identifying as
 * an architect — and that question was **unanswerable**, because:
 *
 *   - `from_agent` stores the literal 'architect' for every architect alike.
 *     Six existed in one database (main, uiv2, entries, org-ui, main2, ade) with
 *     no way to tell which had sent.
 *   - `to_agent` stores only the RESOLVED recipient, so `architect` and
 *     `architect:main` are indistinguishable after the fact — and those are
 *     precisely the two forms the anti-spoofing rules treat differently.
 *
 * A builder that lost its identity and got reclassified produces a byte-identical
 * row to an architect that sent deliberately. These columns separate them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue } from '../db/mailbox.js';

const testDir = resolve(process.cwd(), '.test-issue-47-provenance');
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

function send(over: Partial<Parameters<typeof enqueue>[1]> = {}) {
  return enqueue(db, {
    workspacePath: '/ws/a',
    toAgent: 'main',
    body: 'b',
    formattedMessage: 'f',
    ...over,
  });
}

describe('#47: the two rows that used to be identical', () => {
  it('separates an architect that sent deliberately from a builder that was reclassified', () => {
    // THE test. Both rows have from_agent='architect' and to_agent='main',
    // which is all the schema recorded before — indistinguishable.
    const deliberate = send({ fromAgent: 'architect', fromAgentName: 'uiv2', requestedTo: 'architect:main' });
    const reclassified = send({ fromAgent: 'architect', fromAgentName: null, requestedTo: 'architect' });

    expect(deliberate.from_agent).toBe(reclassified.from_agent);
    expect(deliberate.to_agent).toBe(reclassified.to_agent);

    // ...and now they are not.
    expect(deliberate.from_agent_name).toBe('uiv2');
    expect(deliberate.requested_to).toBe('architect:main');
    expect(reclassified.from_agent_name).toBeNull();
    expect(reclassified.requested_to).toBe('architect');
  });

  it('records which architect sent, where six collapse to one string', () => {
    const names = ['main', 'uiv2', 'entries', 'org-ui', 'main2', 'ade'];
    const rows = names.map(n => send({ fromAgent: 'architect', fromAgentName: n, requestedTo: 'architect' }));

    expect(new Set(rows.map(r => r.from_agent)).size).toBe(1);
    expect(new Set(rows.map(r => r.from_agent_name))).toEqual(new Set(names));
  });

  it('distinguishes the bare form from the explicit one', () => {
    // The anti-spoofing rules treat these differently, so which was typed is
    // load-bearing — and it was the one thing not written down.
    const bare = send({ requestedTo: 'architect', toAgent: 'main' });
    const explicit = send({ requestedTo: 'architect:main', toAgent: 'main' });

    expect(bare.to_agent).toBe(explicit.to_agent);
    expect(bare.requested_to).not.toBe(explicit.requested_to);
  });

  it('keeps the builder id in from_agent_name, so the column is always answerable', () => {
    const row = send({ fromAgent: 'builder-spir-52', fromAgentName: 'builder-spir-52', toAgent: 'uiv2' });

    expect(row.from_agent_name).toBe('builder-spir-52');
  });
});

describe('#47: recording nothing is not the same as recording a guess', () => {
  it('leaves both columns null when the sender could not be identified', () => {
    // An older CLI against a newer Tower. "Not recorded" must stay expressible;
    // inventing a name would put the original ambiguity back with more
    // confidence attached.
    const row = send({ fromAgent: 'architect' });

    expect(row.from_agent_name).toBeNull();
    expect(row.requested_to).toBeNull();
  });

  it('does not reject a send that omits provenance', () => {
    expect(() => send({ fromAgent: 'architect' })).not.toThrow();
  });
});

describe('#47: the query the issue could not run', () => {
  it('finds architect-sent messages that were NOT typed as architect:main', () => {
    // The discriminating query. On the real data this separates "uiv2 chose to
    // message main" from "something addressed 'architect' and got resolved
    // there" — which is the whole question 13 occurrences could not settle.
    send({ fromAgent: 'architect', fromAgentName: 'uiv2', requestedTo: 'architect:main', toAgent: 'main' });
    send({ fromAgent: 'architect', fromAgentName: 'uiv2', requestedTo: 'architect', toAgent: 'main' });
    send({ fromAgent: 'builder-spir-52', fromAgentName: 'builder-spir-52', requestedTo: 'architect', toAgent: 'uiv2' });

    const rows = db
      .prepare(
        `SELECT from_agent_name, requested_to FROM mailbox
         WHERE to_agent = 'main' AND from_agent = 'architect' AND requested_to = 'architect'`,
      )
      .all() as Array<{ from_agent_name: string; requested_to: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].from_agent_name).toBe('uiv2');
  });
});
