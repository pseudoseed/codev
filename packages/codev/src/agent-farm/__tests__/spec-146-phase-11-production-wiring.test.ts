/**
 * WHAT THE PRODUCTION PATH ACTUALLY PRODUCES (Spec 146, Phase 11).
 *
 * The recurring defect in this initiative is code that passes its tests and that
 * production never reaches. Phase 5's registry published only thread-backed rows
 * while every real row was terminal-backed. Phase 6 and 7 built an approval
 * capability with no route that could obtain or spend one. Phase 9 shipped a
 * production path that sent `branch: ''`. In all four the tests drove the unit
 * directly, so nothing asked what the wired-up system does.
 *
 * This file asks. It reads the REAL `initAgentRoutes` call in `tower-server.ts`
 * and asserts what the client will therefore see — including the parts that are
 * NOT yet wired, because a gap nobody wrote down is a gap somebody re-discovers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { readThreadRegistry } from '../servers/thread-registry.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const SERVERS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'servers');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-phase11-wiring-'));
  dirs.push(dir);
  return dir;
}

/**
 * The `initAgentRoutes({...})` call as Tower actually writes it, with comments
 * removed — the comment beside the call NAMES the missing option, and a check
 * that reads prose is a check that passes on a promise.
 *
 * ## If this file fails, read the message before assuming a wiring change
 *
 * It reads SOURCE, so a refactor of `tower-server.ts` can break it without
 * anything about the wiring changing. Each failure below says which it is: a
 * call that moved or was renamed, an argument object it could not parse, an
 * extraction that went blind, or a `t3codeSnapshot` that genuinely appeared. The
 * first three are this test needing an update; only the last is a real change,
 * and it is good news.
 *
 * The extent is found by BRACE DEPTH rather than by a literal `\n  });`. The
 * indentation-sensitive version failed on a reformat of `tower-server.ts` and
 * read as a wiring regression, sending the next person hunting a change that was
 * whitespace. And when this really cannot find the call it says which of the two
 * it is, because "no call" and "no end" have different remedies.
 */
function towerInitCall(): string {
  const source = readFileSync(join(SERVERS, 'tower-server.ts'), 'utf8');
  const open = source.indexOf('initAgentRoutes({');
  expect(
    open,
    'tower-server.ts no longer contains a call to initAgentRoutes. This test is about '
    + 'WHAT that call passes; if the call moved or was renamed, point this at its new form.',
  ).toBeGreaterThan(-1);

  const from = source.indexOf('{', open);
  let depth = 0;
  let close = -1;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  expect(
    close,
    'found initAgentRoutes( but its argument object has unbalanced braces, so this test '
    + 'could not read what it passes. That is a parsing failure here, NOT a wiring change.',
  ).toBeGreaterThan(from);

  return source.slice(from, close + 1)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('criterion 3 is NOT met by the production path, and this records why', () => {
  /*
   * SPEC 146 CRITERION 3 IS UNMET AND DELIBERATELY UNTICKED.
   *
   * "Correct live status on every row" includes working / turning / settled,
   * and those three come from t3code's session state. Tower passes no
   * `t3codeSnapshot`, so the registry takes its `not-provided` branch and no row
   * can ever derive to any of the three from a real Tower. Blocked rows work,
   * because those come from porch.
   *
   * If a later phase wires a provider, this test fails and has to be rewritten —
   * which is the point. It is a tripwire on a stated gap, not a blessing of it.
   */
  it('Tower passes no t3codeSnapshot, so session state is never observable', () => {
    const call = towerInitCall();
    // A sanity anchor: if the extraction goes blind, this fails FIRST and says so,
    // rather than the absence check passing on an empty string.
    expect(call, 'the extracted call is missing options it certainly passes; the reader has gone blind')
      .toContain('isKnownWorkspace');
    expect(
      call,
      'tower-server.ts now passes t3codeSnapshot. Criterion 3 may finally be reachable — '
      + 'update this test and the README rather than deleting it.',
    ).not.toContain('t3codeSnapshot');
  });

  it('a snapshot built without a provider reports not-provided, never an empty session', () => {
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    const workspace = normalizeWorkspacePath(tmp());
    db.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
      VALUES (?, 'main', 0, 0, 'seeded', 'term-main')
    `).run(workspace);

    const snapshot = readThreadRegistry(db, workspace, []);
    db.close();

    // The field the client reads to tell "asked and got nothing" from "never
    // asked". Without it the two are the same payload.
    expect(snapshot.t3code).toBe('not-provided');
    // And no identity carries a session to derive from.
    //
    // The field was `sessionState`, a bare string, until the eight-status
    // vocabulary landed. It is now a structured `session` because deciding
    // whether a row is finished needs the session's status AND the thread's
    // settledness — two facts on two objects in t3code's contract, which one
    // string could not carry. This assertion's MEANING is unchanged: nothing was
    // observed, and that is not "settled".
    for (const identity of snapshot.identities) {
      expect(identity.session).toBeUndefined();
    }
  });

  /*
   * The other half of the same lesson, and the one that is MET: phase 5's
   * registry published only thread-backed rows, so a workspace whose rows are
   * all terminal-backed — which is every real workspace today — reported empty.
   */
  it('publishes the terminal-backed rows a real workspace actually has', () => {
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    const workspace = normalizeWorkspacePath(tmp());
    db.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
      VALUES (?, 'main', 0, 0, 'seeded', 'term-main')
    `).run(workspace);
    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, spawned_by_architect)
      VALUES (?, 'builder-air-220', 'builder-air-220', ?, 'builder/air-220', 'term-220', 'main')
    `).run(workspace, join(workspace, '.builders', 'air-220'));

    const snapshot = readThreadRegistry(db, workspace, []);
    db.close();

    expect(snapshot.identities.map((identity) => identity.roleId).sort())
      .toEqual(['builder-air-220', 'main']);
    for (const identity of snapshot.identities) {
      expect(identity.backing).toBe('terminal');
    }
    // The join the client groups the tree by.
    expect(snapshot.identities.find((identity) => identity.role === 'builder')?.spawnedByArchitect)
      .toBe('main');
  });
});
