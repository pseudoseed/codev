/**
 * A standalone codev-agent host: Tower's protocol-state surface, and nothing
 * else, on a port of its own.
 *
 * Why this exists rather than a second Tower. Two machines are a hard
 * requirement (criteria 7, 8 and 15), and a second Tower against the live
 * `~/.agent-farm` would share the real global.db, cron, delayed-send and the PTY
 * manager with the one driving the actual builders. This process mounts the same
 * route table, the same registry and the same status reader over a database
 * SNAPSHOT and a scratch credential root, so it can be started, stopped and
 * revoked without touching anything real.
 *
 *   tsx agent-host.ts --port 4101 --db <path> --workspace <path> --state <dir> --machine <name>
 *
 * `--seed <file.json>` creates the database from `GLOBAL_SCHEMA` and inserts the
 * architect and builder rows it names. It exists so an end-to-end harness can
 * stand up a second machine without carrying a native database dependency of its
 * own, and it refuses to touch a database that already exists.
 *
 * It prints one JSON line on stdout carrying the credential it minted, so a
 * caller never has to scrape a log for a secret.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../../packages/codev/src/agent-farm/db/schema.js';
import {
  ApprovalCapabilityStore,
  ApprovalNonceStore,
} from '../../packages/codev/src/agent-farm/lib/approval-capability.js';
import { MachineCredentialStore } from '../../packages/codev/src/agent-farm/lib/machine-credentials.js';
import { PairingStore } from '../../packages/codev/src/agent-farm/lib/pairing.js';
import { ApprovalOperationStore } from '../../packages/codev/src/agent-farm/lib/approval-operations.js';
import {
  HumanPairedSessionRegistry,
  handleAgentRoute,
  initAgentRoutes,
} from '../../packages/codev/src/agent-farm/servers/agent-routes.js';
import { normalizeWorkspacePath } from '../../packages/codev/src/agent-farm/utils/workspace-path.js';

interface Seed {
  readonly architect: string;
  readonly builders: ReadonlyArray<{ readonly id: string; readonly worktree: string }>;
}

/**
 * Build the database this host will then open READ-ONLY.
 *
 * Refuses an existing file rather than merging into it: a seed that silently
 * adopted whatever was already there would make a test's starting state a
 * function of what the last run left behind.
 */
function seedDatabase(dbPath: string, workspace: string, seedPath: string): void {
  if (existsSync(dbPath)) throw new Error(`--seed refuses to write over ${dbPath}`);
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
  const db = new Database(dbPath);
  db.exec(GLOBAL_SCHEMA);
  db.prepare(`
    INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id)
    VALUES (?, ?, 0, 0, 'seeded', ?)
  `).run(workspace, seed.architect, `term-${seed.architect}`);
  for (const builder of seed.builders) {
    db.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, spawned_by_architect)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workspace, builder.id, builder.id, builder.worktree,
      `builder/${builder.id}`, `term-${builder.id}`, seed.architect);
  }
  db.prepare('INSERT OR IGNORE INTO known_workspaces (workspace_path, name) VALUES (?, ?)')
    .run(workspace, workspace.split('/').pop() ?? workspace);
  db.close();
}

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

const port = Number(arg('port'));
const dbPath = arg('db');
const workspace = normalizeWorkspacePath(arg('workspace'));
const stateRoot = arg('state');
const machineName = arg('machine', 'host');

mkdirSync(stateRoot, { recursive: true });
/*
 * Everything this host does through agent-farm resolves here, not in the
 * operator's `~/.agent-farm`. Approving a gate makes porch notify the builder's
 * terminal, and an unscoped host would send that at the real Tower driving real
 * builders — from a process whose whole point is that it touches nothing real.
 */
process.env.CODEV_AGENT_FARM_DIR = stateRoot;
const seedPath = process.argv.indexOf('--seed') >= 0 ? arg('seed') : null;
if (seedPath) seedDatabase(dbPath, workspace, seedPath);
const database = new Database(dbPath, { readonly: true, fileMustExist: true });

const machineCredentials = new MachineCredentialStore({ root: `${stateRoot}/machines` });
const credential = machineCredentials.issue({ machine: machineName });

initAgentRoutes({
  db: () => database,
  log: (level, message) => process.stderr.write(`[${level}] ${message}\n`),
  isKnownWorkspace: (candidate) => normalizeWorkspacePath(candidate) === workspace,
  humanSessions: new HumanPairedSessionRegistry(),
  approvalCapabilities: new ApprovalCapabilityStore({ root: `${stateRoot}/approval`, machine: machineName }),
  approvalNonces: new ApprovalNonceStore({ root: `${stateRoot}/approval` }),
  machineCredentials,
  pairings: new PairingStore({ root: `${stateRoot}/pairing` }),
  /*
   * Spec 236: this host accepts asynchronous approvals too.
   *
   * Without it the route answers 501 and a client falls back to the synchronous
   * one — which refuses any project whose phase declares checks, i.e. every real
   * one. An end-to-end harness standing up "a second machine" would then be
   * unable to exercise the path this initiative added, and the coverage would
   * look complete while testing the case that already worked.
   */
  approvalOperations: new ApprovalOperationStore({ root: `${stateRoot}/approval` }),
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (handleAgentRoute(req, res, url)) return;
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"signal":"NOT_FOUND"}');
});

// Loopback only. This host has no Tower key in front of it, so its reachability
// boundary is the interface it binds and its authentication boundary is the
// machine credential — the two are not the same thing and neither substitutes.
server.listen(port, '127.0.0.1', () => {
  // The ACTUAL port, which is the only useful one when `--port 0` was asked for.
  // A harness that has to guess a free port is a harness that fails on a reused
  // one, and reports it as the service being broken.
  const bound = (server.address() as { port: number }).port;
  process.stdout.write(`${JSON.stringify({
    ready: true,
    port: bound,
    machine: machineName,
    workspacePath: workspace,
    credential: credential.presentation,
  })}\n`);
});

/*
 * Revocation on demand, so criterion 15 can be driven from a test without
 * reaching into this process's memory. `revoke` is what an operator does
 * through the authenticated route; here it is a line on stdin because the test
 * harness owns this process and a second authenticated client just to revoke
 * would be ceremony around the thing being tested.
 */
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\n')) {
    const command = line.trim();
    if (command === 'revoke') {
      const revoked = machineCredentials.revoke(machineName);
      process.stdout.write(`${JSON.stringify({ revoked, machine: machineName })}\n`);
    }
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); database.close(); process.exit(0); });
}
