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
 * It prints one JSON line on stdout carrying the credential it minted, so a
 * caller never has to scrape a log for a secret.
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  ApprovalCapabilityStore,
  ApprovalNonceStore,
} from '../../packages/codev/src/agent-farm/lib/approval-capability.js';
import { MachineCredentialStore } from '../../packages/codev/src/agent-farm/lib/machine-credentials.js';
import { PairingStore } from '../../packages/codev/src/agent-farm/lib/pairing.js';
import {
  HumanPairedSessionRegistry,
  handleAgentRoute,
  initAgentRoutes,
} from '../../packages/codev/src/agent-farm/servers/agent-routes.js';
import { normalizeWorkspacePath } from '../../packages/codev/src/agent-farm/utils/workspace-path.js';

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
  process.stdout.write(`${JSON.stringify({
    ready: true,
    port,
    machine: machineName,
    workspacePath: workspace,
    credential: credential.presentation,
  })}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); database.close(); process.exit(0); });
}
