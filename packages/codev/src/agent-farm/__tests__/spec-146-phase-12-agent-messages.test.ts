/**
 * The last three messages on every row (Spec 146, Phase 12, criteria 4 and 4b).
 *
 * ## Why the mailbox, and why bodies stop at this surface
 *
 * Criterion 4 asks each pane to show "the last three agent messages" and 4b the
 * architect's last one. Nothing on the agent wire carried messages, and the
 * mailbox is the only durable record of them — `pruneTerminal` keeps resolved
 * rows for a retention window, so a delivered message is still readable after it
 * arrived.
 *
 * Bodies travel on `/api/agent/v1/*` ONLY. The v2/overview surface stays
 * count-only (`heldCount`, "never message bodies") because it is reached with
 * Tower's shared key rather than a per-machine revocable credential. Two
 * surfaces, two trust levels, one rule each.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue, markDelivered, recentByAgent, RECENT_MESSAGE_BODY_LIMIT } from '../db/mailbox.js';
import { readThreadRegistry } from '../servers/thread-registry.js';
import { projectHierarchy } from '../servers/v2-projection.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codev-phase12-messages-'));
  dirs.push(dir);
  return normalizeWorkspacePath(dir);
}

function seeded(workspace: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  db.prepare(`
    INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
    VALUES (?, 'main', 0, 0, 'seeded', 'term-main')
  `).run(workspace);
  db.prepare(`
    INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, spawned_by_architect)
    VALUES (?, 'builder-air-234', 'builder-air-234', ?, 'builder/air-234', 'term-234', 'main')
  `).run(workspace, join(workspace, '.builders', 'air-234'));
  return db;
}

function send(
  db: Database.Database,
  workspace: string,
  toAgent: string,
  body: string,
  at: number,
  fromName = 'main',
): string {
  const row = enqueue(db, {
    workspacePath: workspace,
    toAgent,
    body,
    formattedMessage: body,
    fromAgent: 'architect',
    fromAgentName: fromName,
  }, at);
  return row.id;
}

describe('recentByAgent', () => {
  it('returns the newest three per agent, newest first', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    for (let index = 0; index < 5; index += 1) {
      send(db, workspace, 'builder-air-234', `message ${index}`, 1_000 + index);
    }
    const recent = recentByAgent(db, workspace);
    db.close();

    expect(recent.get('builder-air-234')!.map((message) => message.body))
      .toEqual(['message 4', 'message 3', 'message 2']);
  });

  it('keeps each agent to its own messages', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    send(db, workspace, 'builder-air-234', 'for the builder', 1_000);
    send(db, workspace, 'main', 'for the architect', 1_001);
    const recent = recentByAgent(db, workspace);
    db.close();

    expect(recent.get('builder-air-234')!.map((m) => m.body)).toEqual(['for the builder']);
    expect(recent.get('main')!.map((m) => m.body)).toEqual(['for the architect']);
  });

  it('does not cross a workspace boundary', () => {
    const alpha = tmp();
    const beta = tmp();
    const db = seeded(alpha);
    send(db, alpha, 'builder-air-234', 'alpha work', 1_000);
    send(db, beta, 'builder-air-234', 'beta work', 1_001);
    const recent = recentByAgent(db, alpha);
    db.close();

    expect(recent.get('builder-air-234')!.map((m) => m.body)).toEqual(['alpha work']);
  });

  /*
   * A DELIVERED MESSAGE IS STILL A MESSAGE. Restricting this to held rows would
   * make every pane empty in the normal case — a message is held only when the
   * recipient's prompt was busy — which is the loudest possible way to render
   * "nothing was said" for a busy workspace.
   */
  it('shows delivered messages, and marks the ones still held', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    const first = send(db, workspace, 'builder-air-234', 'delivered one', 1_000);
    send(db, workspace, 'builder-air-234', 'still waiting', 1_001);
    markDelivered(db, first, 1_050);

    const recent = recentByAgent(db, workspace).get('builder-air-234')!;
    db.close();

    expect(recent.map((m) => m.body)).toEqual(['still waiting', 'delivered one']);
    expect(recent[0].held).toBe(true);
    expect(recent[1].held).toBeUndefined();
  });

  /*
   * THE FLAG IS THE POINT. A body cut at the limit that renders without saying
   * so is a partial message reported as a complete short one.
   */
  it('truncates a long body and says that it did', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    send(db, workspace, 'builder-air-234', 'x'.repeat(RECENT_MESSAGE_BODY_LIMIT + 50), 1_000);
    const [message] = recentByAgent(db, workspace).get('builder-air-234')!;
    db.close();

    expect(message.body).toHaveLength(RECENT_MESSAGE_BODY_LIMIT);
    expect(message.truncated).toBe(true);
  });

  it('leaves a body at exactly the limit unmarked', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    send(db, workspace, 'builder-air-234', 'x'.repeat(RECENT_MESSAGE_BODY_LIMIT), 1_000);
    const [message] = recentByAgent(db, workspace).get('builder-air-234')!;
    db.close();

    expect(message.truncated).toBeUndefined();
  });

  it('names the sender identity rather than the sender kind', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    send(db, workspace, 'builder-air-234', 'from a named architect', 1_000, 'secondary');
    const [message] = recentByAgent(db, workspace).get('builder-air-234')!;
    db.close();

    expect(message.from).toBe('secondary');
  });
});

describe('the snapshot the client reads', () => {
  it('attaches each agent its own messages and reports the log as available', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    send(db, workspace, 'builder-air-234', 'get on with phase 12', 1_000);
    send(db, workspace, 'main', 'the builder flagged scope', 1_001, 'human');

    const snapshot = readThreadRegistry(db, workspace, []);
    db.close();

    expect(snapshot.messageLog).toBe('available');
    const builder = snapshot.identities.find((identity) => identity.roleId === 'builder-air-234')!;
    const architect = snapshot.identities.find((identity) => identity.roleId === 'main')!;
    expect(builder.messages!.map((m) => m.body)).toEqual(['get on with phase 12']);
    expect(architect.messages!.map((m) => m.body)).toEqual(['the builder flagged scope']);
  });

  /*
   * EMPTY IS NOT UNKNOWN. An agent nobody has written to carries no `messages`
   * and the snapshot says the log was `available`, so a pane can state "no
   * messages" as a fact rather than as an absence it cannot explain.
   */
  it('omits messages for an agent that has none, while still saying the log was read', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    const snapshot = readThreadRegistry(db, workspace, []);
    db.close();

    expect(snapshot.messageLog).toBe('available');
    for (const identity of snapshot.identities) {
      expect(identity.messages).toBeUndefined();
    }
  });

  it('reports an unreadable log as unreadable, with a signal, rather than as empty', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    // The one table the snapshot needs and the identities do not. Dropping it
    // produces the real failure rather than a mocked one.
    db.exec('DROP TABLE mailbox');

    const snapshot = readThreadRegistry(db, workspace, []);
    db.close();

    expect(snapshot.messageLog).toBe('unreadable');
    expect(snapshot.signals.map((signal) => signal.code)).toContain('MESSAGE_LOG_UNREADABLE');
    // The rows are still published: a mailbox failure must not blank the tree.
    expect(snapshot.identities.map((identity) => identity.roleId).sort())
      .toEqual(['builder-air-234', 'main']);
  });
});

/**
 * THE BOUNDARY, PINNED BY A TEST RATHER THAN BY ONE CALL SITE.
 *
 * Message bodies are allowed on `/api/agent/v1/*`, which authenticates with a
 * per-machine revocable credential. They are NOT allowed on the v2 and overview
 * surfaces, which authenticate with Tower's shared key — `heldCount`, "count
 * only, never message bodies" (`packages/types/src/api.ts`).
 *
 * Today that holds because `readThreadRegistry` has exactly one production
 * caller. That is a convention, and a convention is what the next person adding
 * a convenient field will not know about. This asserts the payload instead: the
 * v2 projection is built over a workspace whose mailbox is full, and its
 * serialised output is searched for the bodies.
 *
 * `V2Deps.heldByAgent` returning a boolean rather than rows is the structural
 * reason it holds; if someone widens that to carry rows, this fails.
 */
describe('the v2 surface carries no message bodies', () => {
  it('projects a workspace with a full mailbox and serialises none of it', () => {
    const workspace = tmp();
    const db = seeded(workspace);
    const secret = 'THE-BODY-THAT-MUST-NOT-TRAVEL';
    send(db, workspace, 'builder-air-234', secret, 1_000);
    send(db, workspace, 'main', secret, 1_001);

    // The agent surface DOES carry it — otherwise this test would pass simply
    // because nothing was written anywhere.
    const agentSurface = JSON.stringify(readThreadRegistry(db, workspace, []));
    expect(agentSurface).toContain(secret);

    const projection = projectHierarchy(Date.now(), {
      listWorkspaces: () => [workspace],
      discoverBuilders: () => [],
      getBuilders: () => [{
        id: 'builder-air-234',
        name: 'builder-air-234',
        worktree: join(workspace, '.builders', 'air-234'),
        branch: 'builder/air-234',
        status: 'running',
        terminal_id: 'term-234',
        spawned_by_architect: 'main',
      }] as never,
      getArchitects: () => [{ id: 'main', terminal_id: 'term-main' }] as never,
      // A BOOLEAN. This is the structural reason bodies cannot reach v2.
      heldByAgent: () => true,
      sessionForRole: () => true,
      sessionForTerminal: () => true,
      terminalsForWorkspace: () => 1,
      lastDataAt: () => Date.now(),
      bytesWritten: () => 0,
    });
    db.close();

    const v2Surface = JSON.stringify(projection);
    expect(v2Surface).not.toContain(secret);
    expect(v2Surface).not.toContain('"messages"');
  });
});
