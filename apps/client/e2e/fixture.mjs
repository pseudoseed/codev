/**
 * Two live codev-agent hosts, two real workspaces, and a static server for the
 * built client — the harness the two-machine criteria need.
 *
 * NOT a mock. Each host is `tools/codev-agent-host`, mounting the real route
 * table, the real registry, the real status reader and porch's own `approve`
 * over a real `global.db` and real `status.yaml` files. A single-server
 * approximation of "two machines, one stopped" is not evidence of anything, so
 * there are two processes and one of them really gets killed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLIENT_ROOT, '..', '..');
const HOST_DIR = join(REPO_ROOT, 'tools', 'codev-agent-host');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const temporary = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function statusYaml(projectId, title, gate) {
  const lines = [
    `id: '${projectId}'`,
    `title: ${title}`,
    'protocol: air',
    'phase: implement',
    'plan_phases: []',
    'current_plan_phase: null',
    'gates:',
    '  pr:',
    '    status: pending',
  ];
  if (gate) {
    lines.push(`    requested_at: '2026-08-30T00:00:00.000Z'`);
    lines.push('    request:');
    lines.push(`      question: ${JSON.stringify(gate.question)}`);
    lines.push('      choices:');
    for (const choice of gate.choices) {
      lines.push(`        - label: ${JSON.stringify(choice.label)}`);
      lines.push(`          consequence: ${JSON.stringify(choice.consequence)}`);
      if (choice.recommended) lines.push('          recommended: true');
    }
  }
  lines.push('iteration: 1', 'build_complete: false', 'history: []', '');
  return lines.join('\n');
}

/**
 * A workspace with an architect and two builders, one of them holding a
 * requested gate carrying #128's structured question.
 */
/**
 * @param {string} label
 * @param {object|null} gate
 * @param {{ skipChecks?: boolean, extraBuilders?: number, messagesPerAgent?: number }} [options]
 *   `skipChecks: false` leaves the phase's real checks in place, which is what
 *   production has. The route then refuses rather than running a build inside an
 *   HTTP request, and the e2e exercises that branch instead of only the one
 *   where checks are skipped.
 *
 *   `extraBuilders` appends plain, ungated builders to the two this always
 *   makes. Criterion 4 is stated for SIX, and six is not an arbitrary number:
 *   it is the count at which a near-square grid is 3x2 and the arithmetic the
 *   plan corrected (400x300 was impossible, 340x240 is not) actually binds.
 *
 *   `messagesPerAgent` seeds mailbox rows, because criterion 4 asks each pane
 *   for its last three messages and a pane with none cannot demonstrate it.
 */
export function makeWorkspace(label, gate, options = {}) {
  const root = scratch(`codev-e2e-${label}-`);
  const skipChecks = options.skipChecks !== false;
  // `breakCommit` installs a pre-commit hook that always fails, so `git commit`
  // fails for real while `writeState` has already put the approved gate on disk.
  // `writeStateAndCommit` skips git entirely under VITEST, so this is the only
  // place in the repo where that failure can actually be produced — the host
  // runs as a child process with no VITEST set.
  const breakCommit = options.breakCommit === true;
  const config = JSON.stringify(skipChecks
    ? { porch: { checks: { build: { skip: true }, tests: { skip: true } } } }
    : {});
  mkdirSync(join(root, '.codev'), { recursive: true });
  writeFileSync(join(root, '.codev', 'config.json'), config);
  // The REAL protocol definitions, because `porch approve` loads the protocol to
  // find the phase's gate and checks. A workspace without them fails with
  // "Protocol 'air' not found", which is porch working correctly on a workspace
  // this harness had not finished building.
  cpSync(join(REPO_ROOT, 'codev-skeleton', 'protocols'), join(root, 'codev', 'protocols'), { recursive: true });

  const builders = [
    { id: `builder-${label}-quiet`, projectId: `${label}-quiet`, gate: null },
    { id: `builder-${label}-gated`, projectId: `${label}-gated`, gate },
  ];
  for (let index = 0; index < (options.extraBuilders ?? 0); index += 1) {
    builders.push({
      id: `builder-${label}-n${index}`,
      projectId: `${label}-n${index}`,
      gate: null,
    });
  }
  for (const builder of builders) {
    builder.worktree = join(root, '.builders', builder.id);
    const projectDir = join(builder.worktree, 'codev', 'projects', builder.projectId);
    mkdirSync(projectDir, { recursive: true });
    builder.statusPath = join(projectDir, 'status.yaml');
    writeFileSync(builder.statusPath, statusYaml(builder.projectId, `${label} work`, builder.gate));
    mkdirSync(join(builder.worktree, '.codev'), { recursive: true });
    writeFileSync(join(builder.worktree, '.codev', 'config.json'), config);
    cpSync(join(REPO_ROOT, 'codev-skeleton', 'protocols'),
      join(builder.worktree, 'codev', 'protocols'), { recursive: true });
  }

  // porch COMMITS every state write, so each worktree is a real repository with
  // a real remote. Faking the environment to skip the git half would leave the
  // one thing this test claims to prove — that porch wrote status.yaml — running
  // on a path production never takes.
  for (const builder of builders) {
    const origin = join(root, 'remotes', `${builder.id}.git`);
    mkdirSync(origin, { recursive: true });
    git(origin, ['init', '--bare', '--initial-branch=main']);
    git(builder.worktree, ['init', '--initial-branch=main']);
    git(builder.worktree, ['config', 'user.email', 'harness@example.invalid']);
    git(builder.worktree, ['config', 'user.name', 'e2e harness']);
    git(builder.worktree, ['add', '.']);
    git(builder.worktree, ['commit', '-m', 'harness: initial state']);
    git(builder.worktree, ['remote', 'add', 'origin', origin]);
    git(builder.worktree, ['push', '-u', 'origin', 'HEAD']);
    if (breakCommit) {
      const hook = join(builder.worktree, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "e2e: refusing to commit" >&2\nexit 1\n', { mode: 0o755 });
    }
  }

  const perAgent = options.messagesPerAgent ?? 0;
  const messages = [];
  for (const agent of ['main', ...builders.map((builder) => builder.id)]) {
    for (let index = 0; index < perAgent; index += 1) {
      messages.push({
        to: agent,
        from: agent === 'main' ? 'human' : 'main',
        // Numbered oldest-to-newest so a spec can assert the ORDER a pane shows
        // them in, not merely that three of something rendered.
        body: `${agent} message ${index + 1}`,
      });
    }
  }

  const seedPath = join(root, 'seed.json');
  writeFileSync(seedPath, JSON.stringify({
    architect: 'main',
    builders: builders.map(({ id, worktree }) => ({ id, worktree })),
    messages,
  }));
  return { root, builders, seedPath, dbPath: join(root, 'global.db') };
}

export function startHost({ port, workspace, machine }) {
  return new Promise((ready, fail) => {
    const stateRoot = scratch(`codev-e2e-state-${machine}-`);
    /*
     * `--import tsx`, NOT `tsx <file>`.
     *
     * The tsx CLI spawns the real server as a CHILD, so killing the process
     * this harness holds killed a wrapper and left the server listening. The
     * test then watched a client stay LIVE against a host it believed it had
     * stopped — a harness lying to the test in exactly the direction that makes
     * a passing result meaningless. One process, one kill.
     */
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      join(HOST_DIR, 'agent-host.ts'),
      '--port', String(port),
      '--db', workspace.dbPath,
      '--seed', workspace.seedPath,
      '--workspace', workspace.root,
      '--state', stateRoot,
      '--machine', machine,
    ], { cwd: HOST_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });

    let buffer = '';
    let announced = null;
    let pendingRevoke = null;
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // porch writes its own progress to stdout during an approval. Only the
        // harness's own JSON lines are messages; the rest is a server logging.
        if (!line.startsWith('{')) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.revoked !== undefined) {
          pendingRevoke?.();
          pendingRevoke = null;
          continue;
        }
        if (message.ready && !announced) {
          announced = {
            ...message,
            stateRoot,
            revoke: () => new Promise((done) => {
              pendingRevoke = done;
              child.stdin.write('revoke\n');
            }),
            /* Kills, then PROVES it: a stop that only claims to have stopped is
               how the wrapper bug above went unnoticed. */
            stop: async () => {
              child.kill('SIGKILL');
              await waitForPortClosed(message.port);
            },
          };
          ready(announced);
        }
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[${machine}] ${chunk}`));
    child.on('exit', (code, signal) => {
      if (!announced) fail(new Error(`${machine} host exited ${code ?? signal} before it was ready`));
    });
  });
}

/**
 * Serve the built client, and reverse-proxy each machine under `/m/<id>/`.
 *
 * THE PROXY IS PART OF THE HARNESS RATHER THAN THE BROWSER'S ROUTE TABLE,
 * because Playwright's `route.fetch` buffers a whole response before it can
 * fulfill one — and the response under test is an SSE stream that never ends.
 * Interception delivered a stream that was live on the wire and empty in the
 * page, which is a harness failure that reads exactly like a broken client.
 *
 * Same-origin also keeps `connect-src 'self'` closed, which is the posture the
 * client actually ships with; a test that had to widen the CSP to reach a
 * second port would not be testing what runs.
 */
export function serveClient(port, machines) {
  const dist = join(CLIENT_ROOT, 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('apps/client/dist is not built; run "pnpm build" in apps/client first');
  }
  const sockets = new Set();

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/client/machines.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(machines().map((machine) => ({ ...machine, origin: `/m/${machine.id}` }))));
      return;
    }

    const proxied = /^\/m\/([^/]+)(\/.*)$/.exec(req.url ?? '');
    if (proxied) {
      const machine = machines().find((candidate) => candidate.id === proxied[1]);
      if (!machine) {
        res.writeHead(404, { 'Content-Type': MIME['.json'] });
        res.end('{"signal":"UNKNOWN_MACHINE"}');
        return;
      }
      const target = new URL(machine.origin);
      const upstream = request({
        host: target.hostname,
        port: target.port,
        path: proxied[2],
        method: req.method,
        headers: { ...req.headers, host: target.host },
      }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        /*
         * `pipe` DOES NOT END THE DESTINATION WHEN THE SOURCE ERRORS. Killing
         * the upstream aborts `answer` and leaves `res` open forever, so the
         * browser sits on a stream that will never speak again — the client's
         * own silence deadline is the only thing that would eventually notice,
         * and a harness that hides a dead server from the page under test is
         * testing nothing. Destroy it, which is what a real proxy does.
         */
        answer.on('aborted', () => res.destroy());
        answer.on('error', () => res.destroy());
      });
      // A dead upstream is a 502, not a hung request. The client is written to
      // survive one; a hang would just look like the client failing to notice.
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': MIME['.json'] });
        res.end('{"signal":"UPSTREAM_GONE"}');
      });
      req.pipe(upstream);
      res.on('close', () => upstream.destroy());
      return;
    }

    const relative = path.replace(/^\/client\/?/, '') || 'index.html';
    const file = join(dist, relative);
    const target = file.startsWith(dist) && existsSync(file) && extname(file) !== ''
      ? file
      : join(dist, 'index.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      // The header form of the directive a <meta> CSP cannot carry.
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(readFileSync(target));
  });

  // A page holding an open SSE connection keeps `close()` waiting forever, and
  // a hung teardown reads as a failing test.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.shutdown = () => new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    server.close(done);
  });
  return new Promise((ready) => server.listen(port, '127.0.0.1', () => ready(server)));
}

/** Resolve once nothing is listening on `port`, or throw after `timeoutMs`. */
async function waitForPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((done) => {
      const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); done(true); });
      socket.on('error', () => done(false));
    });
    if (!open) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`port ${port} is still listening; the host was not actually stopped`);
}

export function readStatus(statusPath) {
  return readFileSync(statusPath, 'utf8');
}

export function cleanupScratch() {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}
