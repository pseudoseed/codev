/**
 * Issue #272 — the project title is a name, and the wire carries it.
 *
 * Three seams, and none of them is the function that computes the name (that is
 * covered in `issue-272-workspace-projection.test.ts`):
 *
 *   the READ    `readProjectRows` against a real HTTP server, because what is under
 *               test is what a shell snapshot actually looks like — including the
 *               `title` field the reconciler compares against, which the previous
 *               reader dropped on the floor.
 *   the WRITE   `project.meta.update` as it goes onto the wire, dispatched through a
 *               fake transport. A rename that sends the wrong command type or fills
 *               in fields nobody asked to change would pass every test above it.
 *   the WIRING  a source guard on the one call site that cannot be driven without a
 *               live server, in the pattern `issue-227-thread-seams.test.ts` uses for
 *               the same reason. The behavioural proof of that line is the live run
 *               at the dev-approval gate; this is the durable half.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { createProject, updateProjectMeta } from '../../../../porch-driver/src/thread.js';
import { readProjectRows } from '../thread-backend.js';

const source = (rel: string): string =>
  readFileSync(resolvePath(import.meta.dirname, rel), 'utf-8');

let server: Server | undefined;
const dirs: string[] = [];

afterEach(async () => {
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serveShell(body: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
  const address = server!.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

function journal(): DispatchJournal {
  const dir = mkdtempSync(join(tmpdir(), 'issue-272-'));
  dirs.push(dir);
  return new DispatchJournal(join(dir, 'commands.jsonl'));
}

describe('readProjectRows', () => {
  it('carries the title, which is the field the reconciler compares', () => {
    // The reader this replaced kept only `id` and `workspaceRoot`. A reconciler
    // reading that list can tell a project exists and can never tell what it is
    // called — so every legacy title would have survived every sweep, silently.
    return serveShell({
      projects: [
        { id: 'p-1', title: 'codev:/w/alpha', workspaceRoot: '/w/alpha' },
        { id: 'p-2', title: 'beta', workspaceRoot: '/w/beta' },
      ],
      threads: [],
    }).then(async (base) => {
      expect(await readProjectRows(base, 'tok')).toEqual({
        kind: 'ok',
        projects: [
          { id: 'p-1', title: 'codev:/w/alpha', workspaceRoot: '/w/alpha' },
          { id: 'p-2', title: 'beta', workspaceRoot: '/w/beta' },
        ],
      });
    });
  });

  it('drops a row with no workspace root rather than giving it an empty one', async () => {
    const base = await serveShell({
      projects: [{ id: 'p-1', title: 'nowhere' }, { id: 'p-2', title: 'beta', workspaceRoot: '/w/beta' }],
      threads: [],
    });
    const read = await readProjectRows(base, 'tok');
    // An empty root would match the next row that also failed to decode, and the
    // reconciler would then think a workspace already had a project.
    expect(read).toEqual({ kind: 'ok', projects: [{ id: 'p-2', title: 'beta', workspaceRoot: '/w/beta' }] });
  });

  it('says it could not tell rather than reporting an empty project list', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('');
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
    const address = server!.address() as { port: number };
    const read = await readProjectRows(`http://127.0.0.1:${address.port}`, 'tok');
    // `{ kind: 'ok', projects: [] }` here would make the reconciler create a project
    // for every workspace it knows, against a server that already has them.
    expect(read.kind).toBe('unknown');
  });
});

describe('the project commands on the wire', () => {
  it('project.create carries the bare name as the title', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await createProject(
      { call: async (_method, payload) => void sent.push(payload as Record<string, unknown>) },
      journal(),
      { title: 'codev-1455', workspaceRoot: '/Users/chris/dev/codev-1455' },
    );
    expect(sent[0]).toMatchObject({
      type: 'project.create',
      title: 'codev-1455',
      workspaceRoot: '/Users/chris/dev/codev-1455',
    });
  });

  it('project.meta.update sends the title and nothing else', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await updateProjectMeta(
      { call: async (_method, payload) => void sent.push(payload as Record<string, unknown>) },
      journal(),
      { projectId: 'p-1', title: 'codev-1455' },
    );
    const payload = sent[0]!;
    expect(payload).toMatchObject({ type: 'project.meta.update', projectId: 'p-1', title: 'codev-1455' });
    // Absent means "leave unchanged". Filling these in from a snapshot would turn
    // every rename into an overwrite of whatever the helper last read.
    expect(payload).not.toHaveProperty('workspaceRoot');
    expect(payload).not.toHaveProperty('defaultModelSelection');
    expect(payload).not.toHaveProperty('scripts');
  });

  it('omits the title entirely when no rename was asked for', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await updateProjectMeta(
      { call: async (_method, payload) => void sent.push(payload as Record<string, unknown>) },
      journal(),
      { projectId: 'p-1' },
    );
    // A `title: undefined` on the payload is not the same as an absent one: the
    // command schema requires a non-empty string when the field is present.
    expect(sent[0]).not.toHaveProperty('title');
  });
});

describe('the connect path names the project after its directory', () => {
  /**
   * A source guard, for the reason `issue-227-thread-seams.test.ts` gives: this call
   * site sits inside `initialiseThreadBackend`, past a token exchange, a WebSocket
   * ticket and an upgrade, and cannot be reached without a live server. The live run
   * at the dev-approval gate is the behavioural proof; what a reader can check here
   * is that the line still says what it said.
   */
  it('passes the leaf name, not the prefixed absolute path', () => {
    const src = source('../thread-backend.ts');
    expect(src).toContain('title: workspaceLeafName(config.workspaceRoot)');
    // The exact string this issue is about. It renders verbatim as the sidebar
    // heading, because a single-member project group's label IS its title.
    expect(src).not.toContain('title: `codev:${config.workspaceRoot}`');
  });
});
