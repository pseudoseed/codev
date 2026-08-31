/**
 * Issue #264 — a gate-approval notification must not reach a project it is not about.
 *
 * The delivery that prompted this had two hops, and each one is pinned here:
 *
 *   1. `resolveRecipientWorktree` — the recipient and the resolution workspace
 *      come from the PROJECT's worktree, so a project in workspace A cannot
 *      address a builder in workspace B. Before the fix there was no such
 *      resolution at all: porch handed `afx send` a bare project id and let the
 *      sending process's session decide the workspace.
 *
 *   2. `resolveTarget` / `resolveAgentInRegistry` with `exact` — a bare id must
 *      not tail-match a builder that merely ends with it, and the miss must name
 *      what it could not resolve. Before the fix `250` resolved to
 *      `builder-spir-250`, which is how a temp-workspace approval woke a live
 *      builder.
 *
 * The two-workspace fixture is the point: a single-workspace test cannot tell a
 * correct resolution from a lucky one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

const { mockGetWorkspaceTerminals, mockGetGlobalDbPath, mockGetBuilders } = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockGetGlobalDbPath: vi.fn<() => string>(),
  mockGetBuilders: vi.fn(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
}));

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js');
  return { ...actual, getGlobalDbPath: () => mockGetGlobalDbPath() };
});

vi.mock('../state.js', async () => {
  const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
  return { ...actual, getBuilders: (ws: string) => mockGetBuilders(ws) };
});

import { resolveTarget, resolveAgentInRegistry, isResolveError } from '../servers/tower-messages.js';
import {
  resolveRecipientWorktree,
  workspaceForWorktree,
  RecipientResolutionError,
} from '../commands/send.js';

// ---------------------------------------------------------------------------
// Fixture: two live workspaces, each with a builder whose id ends in `-250`.
// ---------------------------------------------------------------------------

const LIVE_WS = '/Users/dev/codev-1455';
const OTHER_WS = '/Users/dev/other-repo';

function terminalsFor(builderIds: string[]): WorkspaceTerminals {
  return {
    architects: new Map([['main', 'term-arch']]),
    builders: new Map(builderIds.map((id) => [id, `term-${id}`])),
    shells: new Map(),
    fileTabs: new Map(),
  };
}

describe('issue #264 — exact resolution refuses the builder tail match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceTerminals.mockReturnValue(
      new Map([
        [LIVE_WS, terminalsFor(['builder-spir-250'])],
        [OTHER_WS, terminalsFor(['builder-bugfix-250'])],
      ]),
    );
  });

  it('tail-matches a bare project id by default (the convenience being constrained)', () => {
    const result = resolveTarget('250', LIVE_WS);
    expect(isResolveError(result)).toBe(false);
    expect((result as { agent: string }).agent).toBe('builder-spir-250');
  });

  it('refuses to deliver a bare project id when the caller demands an exact match', () => {
    const result = resolveTarget('250', LIVE_WS, undefined, { exact: true });
    expect(isResolveError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });

  it('names the address, the workspace, and who is actually there', () => {
    const result = resolveTarget('250', LIVE_WS, undefined, { exact: true });
    const message = (result as { message: string }).message;
    expect(message).toContain('250');
    expect(message).toContain(LIVE_WS);
    expect(message).toContain('builder-spir-250');
    expect(message).toMatch(/nothing was delivered/i);
  });

  it('still resolves the canonical id it was actually given', () => {
    const result = resolveTarget('builder-spir-250', LIVE_WS, undefined, { exact: true });
    expect(isResolveError(result)).toBe(false);
    expect((result as { agent: string }).agent).toBe('builder-spir-250');
  });

  it('refuses the tail match on the offline-hold path too', () => {
    mockGetBuilders.mockReturnValue([{ id: 'builder-spir-250' }]);
    const held = resolveAgentInRegistry('250', LIVE_WS);
    expect(isResolveError(held)).toBe(false);

    const exact = resolveAgentInRegistry('250', LIVE_WS, undefined, { exact: true });
    expect(isResolveError(exact)).toBe(true);
    expect((exact as { message: string }).message).toContain('builder-spir-250');
  });
});

describe('issue #264 — the recipient comes from the project worktree, not the sender', () => {
  let farmDir: string;
  let dbPath: string;

  beforeEach(() => {
    // realpath, because `workspace_path` is stored canonicalized and macOS
    // resolves /var to /private/var — an unnormalized fixture would test the
    // symlink, not the lookup.
    farmDir = realpathSync(mkdtempSync(join(tmpdir(), 'bugfix-264-')));
    dbPath = join(farmDir, 'global.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE builders (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        worktree TEXT
      );
    `);
    // The shape that produced the misdelivery: two workspaces, two builders,
    // ids that tail-match the same project number.
    const insert = db.prepare('INSERT INTO builders (id, workspace_path, worktree) VALUES (?, ?, ?)');
    mkdirSync(join(farmDir, 'live', '.builders', 'spir-250'), { recursive: true });
    mkdirSync(join(farmDir, 'temp', '.builders', 'fake-250'), { recursive: true });
    insert.run('builder-spir-250', join(farmDir, 'live'), join(farmDir, 'live', '.builders', 'spir-250'));
    insert.run('builder-air-250', join(farmDir, 'temp'), join(farmDir, 'temp', '.builders', 'fake-250'));
    db.close();
    mockGetGlobalDbPath.mockReturnValue(dbPath);
  });

  afterEach(() => {
    rmSync(farmDir, { recursive: true, force: true });
  });

  it('resolves the builder that owns the worktree, in that worktree’s workspace', () => {
    const recipient = resolveRecipientWorktree(join(farmDir, 'temp', '.builders', 'fake-250'));
    expect(recipient.builderId).toBe('builder-air-250');
    expect(recipient.workspacePath).toBe(join(farmDir, 'temp'));
  });

  it('does not reach across workspaces to a builder whose id merely tail-matches', () => {
    const recipient = resolveRecipientWorktree(join(farmDir, 'live', '.builders', 'spir-250'));
    expect(recipient.builderId).toBe('builder-spir-250');
    expect(recipient.builderId).not.toBe('builder-air-250');
  });

  it('reports no recipient for a workspace root, rather than inventing one', () => {
    const recipient = resolveRecipientWorktree(join(farmDir, 'live'));
    expect(recipient.builderId).toBeNull();
    expect(recipient.workspacePath).toBe(join(farmDir, 'live'));
  });

  it('pins the workspace from the path alone when the caller names its own recipient', () => {
    // `notifyProtocolComplete` addresses `architect` and needs only the scope.
    // Reading global.db to learn what the path already says would let an
    // orphaned worktree suppress the cleanup trigger.
    expect(workspaceForWorktree(join(farmDir, 'live', '.builders', 'ghost-9'))).toBe(join(farmDir, 'live'));
    expect(workspaceForWorktree(join(farmDir, 'live'))).toBe(join(farmDir, 'live'));
  });

  it('throws, naming the worktree, when no builder owns it', () => {
    mkdirSync(join(farmDir, 'live', '.builders', 'ghost-9'), { recursive: true });
    expect(() => resolveRecipientWorktree(join(farmDir, 'live', '.builders', 'ghost-9')))
      .toThrow(RecipientResolutionError);
    expect(() => resolveRecipientWorktree(join(farmDir, 'live', '.builders', 'ghost-9')))
      .toThrow(/ghost-9/);
  });
});
