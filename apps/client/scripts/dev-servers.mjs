/**
 * Stand up N codev-agent hosts over throwaway workspaces and write
 * `.dev-machines.json` for them, so `pnpm dev` shows a real tree with no Tower,
 * no pairing and nothing touched.
 *
 *   node scripts/dev-servers.mjs            # two machines, one holding a gate
 *   node scripts/dev-servers.mjs --keep     # leave the workspaces on disk
 *
 * Runs until interrupted. Each host is the real route table, registry and status
 * reader — the same processes the two-machine e2e drives — so what you see is
 * what the client does against a real server, not a fixture of one.
 */
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, startHost, cleanupScratch } from '../e2e/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const keep = process.argv.includes('--keep');

const GATE = {
  question: 'Ship the porch driver behind a flag, or on by default?',
  choices: [
    { label: 'Behind a flag', consequence: 'Existing workspaces keep the PTY path until they opt in.', recommended: true },
    { label: 'On by default', consequence: 'Every workspace moves at once; a regression hits everyone.' },
    { label: 'Split the release', consequence: 'Two releases, two migration windows, twice the support surface.' },
  ],
};

const specs = [
  { id: 'alpha', gate: GATE },
  { id: 'beta', gate: null },
];

const hosts = [];
for (const spec of specs) {
  const workspace = makeWorkspace(spec.id, spec.gate);
  const host = await startHost({ port: 0, workspace, machine: spec.id });
  hosts.push({ spec, workspace, host });
}

const machines = hosts.map(({ spec, host }) => ({
  id: spec.id,
  label: spec.id,
  origin: `http://127.0.0.1:${host.port}`,
  workspacePath: host.workspacePath,
  credential: host.credential,
}));

const target = join(CLIENT_ROOT, '.dev-machines.json');
writeFileSync(target, `${JSON.stringify(machines, null, 2)}\n`, { mode: 0o600 });

console.log(`wrote ${target}`);
for (const machine of machines) {
  console.log(`  ${machine.id} → ${machine.origin}  (${machine.workspacePath})`);
}
console.log('');
console.log('Now run, in another shell:  pnpm dev');
console.log('Then open the URL it prints. Ctrl-C here to stop the hosts.');
console.log('');
console.log('To watch a subtree go DISCONNECTED, stop one host. To see ACCESS REVOKED,');
console.log('type "revoke <id>" below.');

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  for (const line of chunk.split('\n')) {
    const [command, id] = line.trim().split(/\s+/);
    if (command !== 'revoke' || !id) continue;
    const found = hosts.find(({ spec }) => spec.id === id);
    if (!found) {
      console.log(`no machine "${id}"`);
      continue;
    }
    await found.host.revoke();
    console.log(`revoked ${id}; its subtree should fail closed within a few seconds`);
  }
});

function shutdown() {
  for (const { host } of hosts) void host.stop().catch(() => {});
  if (!keep) {
    cleanupScratch();
    rmSync(target, { force: true });
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
