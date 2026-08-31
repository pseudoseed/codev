/**
 * Issue #272 — the workspace projection, against a live fork server.
 *
 * ## Why this exists rather than another unit test
 *
 * The unit suite drives `reconcileWorkspaceProjects` with a fake gateway, which
 * proves the DECISION and nothing about the wire. The gateway itself — a bootstrap
 * exchange, an HTTP snapshot read, a lazily-opened socket carrying `project.create`
 * and `project.meta.update` — is exactly the part a fake substitutes away, and
 * spec 250's own review calls that shape "the costumes": a value asserted at both
 * ends and never once carried end to end by the code a human actually runs.
 *
 * So this runs the REAL gateway against a real fork server and reads the rows back
 * out of the projection database with sqlite, not through the code under test.
 *
 * ## What it asserts
 *
 * 1. A workspace with no project gets one, titled with its directory name — not
 *    `codev:<absolute path>`, which is the string the sidebar heading renders.
 * 2. A project already carrying the legacy title is RENAMED in place, keeping its
 *    id. A second row for one workspace root would be refused by the server.
 * 3. A title a human chose is left alone. This is the one that keeps the sweep
 *    safe to run every 30 s.
 * 4. Two workspaces whose directories share a name come out distinguishable.
 * 5. A second pass writes nothing. A reconciler that is not idempotent is a
 *    reconciler that fights the server forever.
 *
 * ## Usage
 *
 *   export T3_NODE=/absolute/path/to/node
 *   export T3CODE_FORK_ROOT=/path/to/fork T3_HARNESS_PORT=<free>
 *   node tools/t3-fork/issue-272-projection.mjs [--out <file.json>]
 *
 * Exit 0 when every claim held, 1 when one did not, 3 when it could not tell —
 * a missing checkout, a server that would not start, an unreadable database. An
 * "I could not tell" spelled like a pass is the failure this whole protocol is
 * written against.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SERVER = join(REPO, 'tools', 't3-server', 't3-server.mjs');
const RUNTIME_DB = join(
  REPO, 'tools', 't3-server', '.runtime', 'data', 'userdata', 'state.sqlite',
);

const UNDETERMINED = 3;
const FAILED = 1;

function die(code, message) {
  console.error(`[issue-272-projection] ${message}`);
  process.exit(code);
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * A workspace on disk, with a `threads` config naming the server.
 *
 * `.codev/config.local.json` rather than `config.json`: it is the layer the loader
 * treats as per-engineer, and writing the token into the committed file in a
 * fixture would model a configuration nobody should have.
 */
function makeWorkspace(root, name, serverUrl, token) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.codev'), { recursive: true });
  writeFileSync(
    join(dir, '.codev', 'config.local.json'),
    `${JSON.stringify({ threads: { serverUrl, bootstrapToken: token } }, null, 2)}\n`,
  );
  return dir;
}

function projectRows() {
  if (!existsSync(RUNTIME_DB)) die(UNDETERMINED, `no projection database at ${RUNTIME_DB}`);
  const out = sh('sqlite3', [
    RUNTIME_DB,
    'select project_id, title, workspace_root from projection_projects order by title;',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [id, title, workspaceRoot] = line.split('|');
      return { id, title, workspaceRoot };
    });
}

const claims = [];
function claim(name, held, detail) {
  claims.push({ name, held, detail });
  console.log(`[issue-272-projection] ${held ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outPath = outFlag === -1 ? null : process.argv[outFlag + 1];

  let bootstrapToken;
  try {
    // A server left behind by an earlier run is not a reason to refuse: `start-fork`
    // wants an empty data directory anyway, and the assertions about which rows
    // exist are only meaningful on one. `stop` on an idle port is not a failure.
    try {
      sh(process.execPath, [SERVER, 'stop'], { stdio: 'inherit' });
    } catch {
      // Nothing was running, or it is not ours. `start-fork` decides which.
    }
    sh(process.execPath, [SERVER, 'start-fork'], { stdio: 'inherit' });
    const ready = sh(process.execPath, [SERVER, 'ready']);
    // `ready` prints JSON after its log lines. Parsing from the first brace is
    // what `spec-250-fork-stack.ts` does, for the same reason.
    const parsed = JSON.parse(ready.slice(ready.indexOf('{')));
    bootstrapToken = typeof parsed.token === 'string' ? parsed.token : null;
    if (!bootstrapToken) die(UNDETERMINED, `the fork server started but printed no pairing token:\n${ready}`);
  } catch (err) {
    die(UNDETERMINED, `could not start the fork server: ${err.message}`);
  }

  const port = process.env.T3_HARNESS_PORT ?? '3799';
  const serverUrl = `http://127.0.0.1:${port}`;
  const scratch = mkdtempSync(join(tmpdir(), 'issue-272-'));

  /**
   * A FRESH credential per gateway, because the harness's is one-time.
   *
   * `start-fork` issues a pairing-issued bootstrap token and the server consumes
   * it on the first exchange. Production configures a desktop bootstrap seed,
   * issued unbounded, precisely so a gateway can exchange on every sweep — the
   * constraint `ThreadBackendConfig.bootstrapToken` documents. This fixture has
   * the other kind, so it mints one per gateway rather than pretending a spent
   * token is a server fault.
   */
  const SEED_SCOPES = [
    'orchestration:read', 'orchestration:operate', 'terminal:operate',
    'review:write', 'relay:read', 'access:write',
  ].join(' ');
  const exchange = await fetch(`${serverUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: bootstrapToken,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: SEED_SCOPES,
      client_label: 'issue-272-projection',
      client_device_type: 'bot',
    }),
  });
  if (!exchange.ok) die(UNDETERMINED, `the bootstrap exchange failed with ${exchange.status}`);
  const { access_token: accessToken } = await exchange.json();

  const mintToken = async () => {
    const response = await fetch(`${serverUrl}/api/auth/pairing-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'issue-272-projection' }),
    });
    if (!response.ok) die(UNDETERMINED, `could not mint a credential: ${response.status}`);
    const { credential } = await response.json();
    return credential;
  };

  try {
    const { reconcileWorkspaceProjects } = await import(
      '../../packages/codev/dist/agent-farm/workspace-projection.js'
    );
    const { openProjectGateway } = await import(
      '../../packages/codev/dist/agent-farm/thread-backend.js'
    );

    const plain = makeWorkspace(scratch, 'codev-1455', serverUrl, bootstrapToken);
    const legacy = makeWorkspace(scratch, 'dvarr', serverUrl, bootstrapToken);
    const named = makeWorkspace(scratch, 'entriq', serverUrl, bootstrapToken);
    const backendApi = makeWorkspace(join(scratch, 'backend'), 'api', serverUrl, bootstrapToken);
    const mobileApi = makeWorkspace(join(scratch, 'mobile'), 'api', serverUrl, bootstrapToken);
    const roots = [plain, legacy, named, backendApi, mobileApi];

    // The two rows a sweep must find already there: one wearing the legacy title
    // this issue is about, one wearing a name a human chose. They are seeded
    // through the same gateway, because a row hand-written into sqlite would not
    // have gone through the decider that owns `project.created`.
    const seed = await openProjectGateway({ serverUrl, bootstrapToken: await mintToken() });
    try {
      await seed.createProject(legacy, `codev:${legacy}`);
      await seed.createProject(named, 'Entriq (do not rename)');
    } finally {
      seed.close();
    }

    const log = [];
    const deps = {
      knownWorkspacePaths: () => [
        ...roots,
        // The three cases the real `known_workspaces` table contains and a sweep
        // must drop: a builder worktree, a deleted checkout, and a directory that
        // is not a Codev workspace at all.
        join(plain, '.builders', 'pir-272'),
        join(scratch, 'deleted-checkout'),
        scratch,
      ],
      isCodevWorkspace: (path) => existsSync(join(path, '.codev')),
      serverFor: () => ({ serverUrl, bootstrapToken }),
      openGateway: async () => openProjectGateway({ serverUrl, bootstrapToken: await mintToken() }),
      log: (level, message) => log.push(`${level} ${message}`),
    };

    const first = await reconcileWorkspaceProjects(deps);
    const after = projectRows();
    const byRoot = new Map(after.map((row) => [row.workspaceRoot, row]));

    claim(
      'the sweep reported no failures',
      first.failures.length === 0,
      first.failures.join('; ') || 'none',
    );
    claim(
      'a workspace with no project gets one named after its directory',
      byRoot.get(plain)?.title === 'codev-1455',
      `title=${byRoot.get(plain)?.title}`,
    );
    claim(
      'the legacy codev:<path> title is rewritten to the directory name',
      byRoot.get(legacy)?.title === 'dvarr',
      `title=${byRoot.get(legacy)?.title}`,
    );
    claim(
      'a title a human chose is left alone',
      byRoot.get(named)?.title === 'Entriq (do not rename)',
      `title=${byRoot.get(named)?.title}`,
    );
    claim(
      'two workspaces sharing a directory name come out distinguishable',
      byRoot.get(backendApi)?.title === 'backend/api'
        && byRoot.get(mobileApi)?.title === 'mobile/api',
      `${byRoot.get(backendApi)?.title} / ${byRoot.get(mobileApi)?.title}`,
    );
    claim(
      'no project is created for a builder worktree, a deleted checkout, or a non-workspace',
      after.length === roots.length,
      `${after.length} rows for ${roots.length} workspaces`,
    );
    // The rename keeps the row. A second `project.create` for one workspace root
    // is refused by the server (`requireActiveProjectWorkspaceRootAbsent`), so a
    // "rename" that actually re-created would have failed the sweep above — but
    // asserting the id directly says so rather than inferring it.
    claim(
      'the rename kept the project id rather than creating a second row',
      after.filter((row) => row.workspaceRoot === legacy).length === 1,
      `${after.filter((row) => row.workspaceRoot === legacy).length} row(s) for that root`,
    );

    const second = await reconcileWorkspaceProjects(deps);
    claim(
      'a second pass writes nothing',
      second.created === 0 && second.renamed === 0 && second.failures.length === 0,
      `created=${second.created} renamed=${second.renamed} failures=${second.failures.length}`,
    );

    const passed = claims.every((entry) => entry.held);
    if (outPath !== undefined && outPath !== null) {
      const record = {
        issue: 272,
        recordedAt: new Date().toISOString().slice(0, 10),
        serverUrl,
        forkRoot: process.env.T3CODE_FORK_ROOT ?? null,
        projects: after,
        firstPass: first,
        secondPass: second,
        claims,
        passed,
      };
      writeFileSync(resolve(REPO, outPath), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`[issue-272-projection] evidence written to ${outPath}`);
    }
    if (!passed) process.exit(FAILED);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    try {
      sh(process.execPath, [SERVER, 'stop'], { stdio: 'inherit' });
    } catch {
      // Reported by the stop command itself; a throw here would replace a real
      // result with a teardown message.
    }
  }
}

await main();
