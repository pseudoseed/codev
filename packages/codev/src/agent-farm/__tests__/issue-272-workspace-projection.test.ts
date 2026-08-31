/**
 * Issue #272 — every workspace is a named project row.
 *
 * The rules live in `workspace-projection.ts` and nothing here reaches a server, a
 * database or (except where the filter is the subject) a filesystem. What is being
 * tested is the DECISION: which paths are workspaces, what they are called, which
 * titles may be rewritten, and what a sweep does when one server is down.
 *
 * The fixture paths in the enumeration tests are taken from the real
 * `known_workspaces` table on 2026-08-31 — a parent directory, several deleted
 * checkouts and three `.builders/` worktrees. Every filter below exists because that
 * table contains a row it would otherwise let through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCodevWorkspaceDirectory } from '../workspace-projection-sweep.js';
import {
  codevWorkspaceRoots,
  isMachineWrittenTitle,
  planWorkspaceProjects,
  reconcileWorkspaceProjects,
  workspaceDisplayNames,
  workspaceLeafName,
  type ProjectRow,
  type WorkspaceProjectGateway,
  type WorkspaceProjectServer,
} from '../workspace-projection.js';

describe('workspaceLeafName', () => {
  it('names a workspace after its own directory', () => {
    expect(workspaceLeafName('/Users/chris/dev/codev-1455')).toBe('codev-1455');
  });

  it('ignores a trailing slash rather than producing an empty name', () => {
    expect(workspaceLeafName('/Users/chris/dev/dvarr/')).toBe('dvarr');
  });

  it('answers with something non-empty for a root with no segments', () => {
    // `project.create` requires a non-empty title. A blank one would be refused by
    // the server, which reports the failure somewhere far from the cause.
    expect(workspaceLeafName('/')).not.toBe('');
  });
});

describe('workspaceDisplayNames', () => {
  it('uses the bare directory name when it is unambiguous', () => {
    const names = workspaceDisplayNames([
      '/Users/chris/dev/codev-1455',
      '/Users/chris/dev/dvarr',
      '/Users/chris/dev/entriq',
    ]);
    expect(names.get('/Users/chris/dev/codev-1455')).toBe('codev-1455');
    expect(names.get('/Users/chris/dev/dvarr')).toBe('dvarr');
    expect(names.get('/Users/chris/dev/entriq')).toBe('entriq');
  });

  it('deepens both sides of a collision, and only that collision', () => {
    const names = workspaceDisplayNames([
      '/Users/chris/dev/backend/api',
      '/Users/chris/dev/mobile/api',
      '/Users/chris/dev/codev-1455',
    ]);
    expect(names.get('/Users/chris/dev/backend/api')).toBe('backend/api');
    expect(names.get('/Users/chris/dev/mobile/api')).toBe('mobile/api');
    // The uninvolved workspace keeps its one segment: an ambiguous pair elsewhere is
    // not a reason to make every other row longer.
    expect(names.get('/Users/chris/dev/codev-1455')).toBe('codev-1455');
  });

  it('keeps deepening until the names actually separate', () => {
    const names = workspaceDisplayNames(['/a/one/svc/api', '/a/two/svc/api']);
    expect(names.get('/a/one/svc/api')).toBe('one/svc/api');
    expect(names.get('/a/two/svc/api')).toBe('two/svc/api');
  });

  it('terminates when two roots cannot be separated at any depth', () => {
    // Two spellings of one path. `canonicalWorkspaceKey` should have collapsed these
    // upstream; if it did not, the namer must stop rather than spin forever.
    const names = workspaceDisplayNames(['/a/api', '/a/api/']);
    expect(names.get('/a/api')).toBe(names.get('/a/api/'));
  });
});

describe('codevWorkspaceRoots', () => {
  const isWorkspace = (path: string): boolean =>
    ['/Users/chris/dev/codev-1455', '/Users/chris/dev/dvarr', '/Users/chris/dev/entriq'].includes(
      path,
    );

  it('drops builder worktrees, non-workspaces, and deleted checkouts', () => {
    const roots = codevWorkspaceRoots(
      [
        '/Users/chris/dev/codev-1455',
        '/Users/chris/dev/codev-1455/.builders/pir-272',
        '/Users/chris/dev/dvarr',
        '/Users/chris/dev/dvarr/.builders/pir-180',
        // A parent directory a terminal was once opened in. It exists; it is not a
        // workspace, and a sidebar heading for it is a heading for something no
        // Codev command would accept.
        '/Users/chris/dev',
        // A checkout that has been deleted. Its row outlived it.
        '/Users/chris/dev/codev_new',
      ],
      isWorkspace,
    );
    expect(roots).toEqual(['/Users/chris/dev/codev-1455', '/Users/chris/dev/dvarr']);
  });

  it('collapses two spellings of one workspace into one root', () => {
    const roots = codevWorkspaceRoots(
      ['/Users/chris/dev/entriq', '/Users/chris/dev/entriq/'],
      (path) => isWorkspace(path.replace(/\/$/, '')),
    );
    // Two roots here would become two projects for one directory — the failure the
    // canonical key exists to prevent, arriving through a different door.
    expect(roots).toHaveLength(1);
  });

});

describe('isMachineWrittenTitle', () => {
  const row = (title: string, workspaceRoot: string): ProjectRow => ({
    id: 'p-1',
    title,
    workspaceRoot,
  });

  it('recognises the legacy prefixed-path title', () => {
    expect(
      isMachineWrittenTitle(
        row('codev:/Users/chris/dev/codev-1455', '/Users/chris/dev/codev-1455'),
      ),
    ).toBe(true);
  });

  it('recognises the leaf name the connect path writes', () => {
    expect(isMachineWrittenTitle(row('codev-1455', '/Users/chris/dev/codev-1455'))).toBe(true);
  });

  it('leaves a title a human chose alone', () => {
    expect(isMachineWrittenTitle(row('Codev', '/Users/chris/dev/codev-1455'))).toBe(false);
    expect(isMachineWrittenTitle(row('My Project', '/Users/chris/dev/codev-1455'))).toBe(false);
  });

  it('does not claim a codev-prefixed title naming some other path', () => {
    // The prefix alone is not the signal. A title has to name the project's OWN
    // workspace root to be one this code wrote.
    expect(
      isMachineWrittenTitle(row('codev:/somewhere/else', '/Users/chris/dev/codev-1455')),
    ).toBe(false);
  });
});

describe('planWorkspaceProjects', () => {
  const names = new Map([
    ['/w/alpha', 'alpha'],
    ['/w/beta', 'beta'],
  ]);

  it('creates a project for a workspace the server does not have', () => {
    expect(
      planWorkspaceProjects({ roots: ['/w/alpha'], names, projects: [] }),
    ).toEqual([{ kind: 'create', workspaceRoot: '/w/alpha', title: 'alpha' }]);
  });

  it('renames a legacy title and leaves a correct one alone', () => {
    const actions = planWorkspaceProjects({
      roots: ['/w/alpha', '/w/beta'],
      names,
      projects: [
        { id: 'p-alpha', title: 'codev:/w/alpha', workspaceRoot: '/w/alpha' },
        { id: 'p-beta', title: 'beta', workspaceRoot: '/w/beta' },
      ],
    });
    expect(actions).toEqual([{ kind: 'rename', projectId: 'p-alpha', title: 'alpha' }]);
  });

  it('deepens a leaf title the connect path wrote when the set makes it ambiguous', () => {
    const ambiguous = new Map([
      ['/w/backend/api', 'backend/api'],
      ['/w/mobile/api', 'mobile/api'],
    ]);
    const actions = planWorkspaceProjects({
      roots: ['/w/backend/api', '/w/mobile/api'],
      names: ambiguous,
      projects: [
        { id: 'p-1', title: 'api', workspaceRoot: '/w/backend/api' },
        { id: 'p-2', title: 'api', workspaceRoot: '/w/mobile/api' },
      ],
    });
    expect(actions).toEqual([
      { kind: 'rename', projectId: 'p-1', title: 'backend/api' },
      { kind: 'rename', projectId: 'p-2', title: 'mobile/api' },
    ]);
  });

  it('never renames a title a human chose, however wrong it looks', () => {
    const actions = planWorkspaceProjects({
      roots: ['/w/alpha'],
      names,
      projects: [{ id: 'p-alpha', title: 'Alpha (do not touch)', workspaceRoot: '/w/alpha' }],
    });
    expect(actions).toEqual([]);
  });

  it('leaves a project for a workspace it did not enumerate entirely alone', () => {
    // "I did not enumerate it" is not "it should not exist". Nothing here deletes.
    const actions = planWorkspaceProjects({
      roots: ['/w/alpha'],
      names,
      projects: [
        { id: 'p-alpha', title: 'alpha', workspaceRoot: '/w/alpha' },
        { id: 'p-other', title: 'codev:/w/gone', workspaceRoot: '/w/gone' },
      ],
    });
    expect(actions).toEqual([]);
  });

  it('matches a project stored under a different spelling of the same path', () => {
    const actions = planWorkspaceProjects({
      roots: ['/w/alpha'],
      names,
      projects: [{ id: 'p-alpha', title: 'alpha', workspaceRoot: '/w/alpha/' }],
    });
    // A second `project.create` here would be refused by the server, and the refusal
    // would read as "the server was named and could not be used".
    expect(actions).toEqual([]);
  });
});

describe('reconcileWorkspaceProjects', () => {
  const server: WorkspaceProjectServer = { serverUrl: 'http://t3', bootstrapToken: 'seed' };

  function fakeGateway(projects: ProjectRow[]) {
    const created: Array<{ workspaceRoot: string; title: string }> = [];
    const renamed: Array<{ projectId: string; title: string }> = [];
    let closed = 0;
    const gateway: WorkspaceProjectGateway = {
      readProjects: async () => projects,
      createProject: async (workspaceRoot, title) => {
        created.push({ workspaceRoot, title });
      },
      renameProject: async (projectId, title) => {
        renamed.push({ projectId, title });
      },
      close: () => {
        closed += 1;
      },
    };
    return { gateway, created, renamed, closed: () => closed };
  }

  it('opens ONE gateway for many workspaces sharing a server', async () => {
    const fake = fakeGateway([]);
    const openGateway = vi.fn(async () => fake.gateway);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha', '/w/beta', '/w/gamma'],
      isCodevWorkspace: () => true,
      serverFor: () => server,
      openGateway,
      log: () => {},
    });
    // The rejected implementation — `ensureThreadBackendReady` per root — would have
    // opened three, and held all three for the life of the process.
    expect(openGateway).toHaveBeenCalledTimes(1);
    expect(result.servers).toBe(1);
    expect(fake.created).toEqual([
      { workspaceRoot: '/w/alpha', title: 'alpha' },
      { workspaceRoot: '/w/beta', title: 'beta' },
      { workspaceRoot: '/w/gamma', title: 'gamma' },
    ]);
  });

  it('opens one gateway per distinct server', async () => {
    const one = fakeGateway([]);
    const two = fakeGateway([]);
    const openGateway = vi.fn(async (target: WorkspaceProjectServer) =>
      target.serverUrl === 'http://one' ? one.gateway : two.gateway,
    );
    await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha', '/w/beta'],
      isCodevWorkspace: () => true,
      serverFor: (root) =>
        root === '/w/alpha'
          ? { serverUrl: 'http://one', bootstrapToken: 's' }
          : { serverUrl: 'http://two', bootstrapToken: 's' },
      openGateway,
      log: () => {},
    });
    expect(openGateway).toHaveBeenCalledTimes(2);
    expect(one.created).toEqual([{ workspaceRoot: '/w/alpha', title: 'alpha' }]);
    expect(two.created).toEqual([{ workspaceRoot: '/w/beta', title: 'beta' }]);
  });

  it('skips a workspace that names no server without calling it a failure', async () => {
    const fake = fakeGateway([]);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha', '/w/pty-only'],
      isCodevWorkspace: () => true,
      serverFor: (root) => (root === '/w/alpha' ? server : null),
      openGateway: async () => fake.gateway,
      log: () => {},
    });
    expect(result.failures).toEqual([]);
    expect(fake.created).toEqual([{ workspaceRoot: '/w/alpha', title: 'alpha' }]);
  });

  it('reports a half-configured workspace as a failure rather than skipping it', async () => {
    const fake = fakeGateway([]);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha', '/w/broken'],
      isCodevWorkspace: () => true,
      serverFor: (root) => {
        if (root === '/w/broken') throw new Error('Incomplete "threads" config');
        return server;
      },
      openGateway: async () => fake.gateway,
      log: () => {},
    });
    // A mistake is not a decision to stay on PTY, and must not be spelled like one.
    expect(result.failures).toEqual(['/w/broken: Incomplete "threads" config']);
    expect(fake.created).toEqual([{ workspaceRoot: '/w/alpha', title: 'alpha' }]);
  });

  it('keeps reconciling the other servers when one is unreachable', async () => {
    const reachable = fakeGateway([]);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha', '/w/beta'],
      isCodevWorkspace: () => true,
      serverFor: (root) =>
        root === '/w/alpha'
          ? { serverUrl: 'http://down', bootstrapToken: 's' }
          : { serverUrl: 'http://up', bootstrapToken: 's' },
      openGateway: async (target) => {
        if (target.serverUrl === 'http://down') throw new Error('ECONNREFUSED');
        return reachable.gateway;
      },
      log: () => {},
    });
    expect(result.failures).toEqual(['http://down: ECONNREFUSED']);
    // One unreachable server must not hide every workspace behind every other one.
    expect(reachable.created).toEqual([{ workspaceRoot: '/w/beta', title: 'beta' }]);
  });

  it('closes the gateway even when the pass fails halfway through', async () => {
    const fake = fakeGateway([]);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha'],
      isCodevWorkspace: () => true,
      serverFor: () => server,
      openGateway: async () => ({
        ...fake.gateway,
        createProject: async () => {
          throw new Error('refused');
        },
        close: fake.gateway.close,
      }),
      log: () => {},
    });
    expect(result.failures).toEqual(['http://t3: refused']);
    expect(fake.closed()).toBe(1);
  });

  it('does not let one unreadable path stop the whole enumeration', async () => {
    const fake = fakeGateway([]);
    await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/locked', '/w/alpha'],
      isCodevWorkspace: (path) => {
        if (path === '/w/locked') throw new Error('EACCES');
        return true;
      },
      serverFor: () => server,
      openGateway: async () => fake.gateway,
      log: () => {},
    });
    // A path that cannot be examined is not a workspace this pass can project, and
    // it is not a reason to project none of the others either.
    expect(fake.created).toEqual([{ workspaceRoot: '/w/alpha', title: 'alpha' }]);
  });

  it('reconciles nothing and says why when the workspace list cannot be read', async () => {
    const openGateway = vi.fn(async () => fakeGateway([]).gateway);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => {
        throw new Error('database is locked');
      },
      isCodevWorkspace: () => true,
      serverFor: () => server,
      openGateway,
      log: () => {},
    });
    // "I could not read the workspaces" must never be recorded as "there were none".
    expect(result.failures).toEqual(['could not list known workspaces: database is locked']);
    expect(result.workspaces).toBe(0);
    expect(openGateway).not.toHaveBeenCalled();
  });

  it('writes nothing at all when every workspace is already correct', async () => {
    const fake = fakeGateway([{ id: 'p-alpha', title: 'alpha', workspaceRoot: '/w/alpha' }]);
    const result = await reconcileWorkspaceProjects({
      knownWorkspacePaths: () => ['/w/alpha'],
      isCodevWorkspace: () => true,
      serverFor: () => server,
      openGateway: async () => fake.gateway,
      log: () => {},
    });
    // The steady state, and the reason the gateway's socket is lazy: a pass with no
    // actions must not open one.
    expect(result).toMatchObject({ created: 0, renamed: 0, failures: [] });
    expect(fake.created).toEqual([]);
    expect(fake.renamed).toEqual([]);
  });
});

/**
 * The PRODUCTION predicate, against a real filesystem.
 *
 * Every test above injects `isCodevWorkspace`, and so does
 * `tools/t3-fork/issue-272-projection.mjs`. So the filter that actually decides
 * "deleted checkout" and "not a workspace" in Tower was substituted by every check
 * that claimed to cover it — a test that supplies the boundary itself cannot tell
 * you the boundary exists. Raised by the review consultation; this closes it.
 */
describe('isCodevWorkspaceDirectory', () => {
  const made: string[] = [];
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'issue-272-fs-'));
    made.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('accepts a directory carrying .codev', () => {
    const root = dir();
    mkdirSync(join(root, '.codev'));
    expect(isCodevWorkspaceDirectory(root)).toBe(true);
  });

  it('rejects a directory with no .codev', () => {
    // The real `known_workspaces` table holds `/Users/chris/dev` — a parent a
    // terminal was once opened in. A heading for it is a heading for something no
    // Codev command would accept.
    expect(isCodevWorkspaceDirectory(dir())).toBe(false);
  });

  it('rejects a path that does not exist', () => {
    // A deleted checkout whose row outlived it. This is the case the sweep must
    // not mint a permanent sidebar heading for.
    const root = dir();
    rmSync(root, { recursive: true, force: true });
    expect(isCodevWorkspaceDirectory(root)).toBe(false);
  });

  it('rejects a FILE, even one named like a workspace', () => {
    // `existsSync` alone would accept this; the `statSync().isDirectory()` guard is
    // what refuses it, and nothing else in the suite exercises that line.
    const root = dir();
    const file = join(root, 'not-a-dir');
    writeFileSync(file, '');
    expect(isCodevWorkspaceDirectory(file)).toBe(false);
  });

  it('rejects a path whose .codev is a file rather than a directory', () => {
    // `codev init` creates a directory. A stray file of that name is not a
    // workspace, and treating it as one would put an unopenable heading in the tree.
    const root = dir();
    writeFileSync(join(root, '.codev'), '');
    expect(isCodevWorkspaceDirectory(root)).toBe(false);
  });
});
