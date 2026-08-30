/**
 * Pair this browser's machine with a running codev-agent and write the result to
 * `apps/client/.dev-machines.json`, which the dev server reads.
 *
 *   node scripts/pair-dev.mjs [--origin http://127.0.0.1:4100] [--workspace <abs path>]
 *                             [--machine dev-local] [--id local]
 *
 * Pairing is normally an operator action with a token read off another screen.
 * There is no CLI for it yet, and a client that cannot authenticate cannot show
 * anything, so this does both halves — issue, then redeem — in one place. It
 * writes a REAL credential to the real store; revoke it with
 * `DELETE /api/agent/v1/machines/<name>`.
 *
 * For a self-contained tree with no Tower at all, use `scripts/dev-servers.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLIENT_ROOT, '..', '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const origin = flag('origin', 'http://127.0.0.1:4100');
const workspacePath = resolve(flag('workspace', REPO_ROOT));
const machineName = flag('machine', 'dev-local');
const id = flag('id', 'local');

const keyPath = join(homedir(), '.agent-farm', 'local-key');
if (!existsSync(keyPath)) {
  console.error(`no Tower key at ${keyPath}; is Tower running on this machine?`);
  process.exit(1);
}
const towerKey = readFileSync(keyPath, 'utf8').trim();

/*
 * The token is minted through the package's own store rather than reimplemented
 * here. Its file format is an implementation detail of `PairingStore`, and a
 * second writer that "knows" the format is a second thing to keep in step.
 */
const token = execFileSync(process.execPath, ['--import', 'tsx', '-e', `
  import { PairingStore } from ${JSON.stringify(join(REPO_ROOT, 'packages/codev/src/agent-farm/lib/pairing.ts'))};
  process.stdout.write(new PairingStore().issue({ ttlMs: 5 * 60_000 }).token);
`], { cwd: join(REPO_ROOT, 'packages', 'codev'), encoding: 'utf8' }).trim();

const response = await fetch(`${origin}/api/agent/v1/pairing/redeem`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'codev-tower-key': towerKey,
    'x-codev-pairing-token': token,
  },
  body: JSON.stringify({ machine: machineName }),
});
const body = await response.json().catch(() => ({}));
if (response.status !== 201 || typeof body.credential !== 'string') {
  console.error(`pairing refused (${response.status}): ${body.signal ?? ''} ${body.message ?? ''}`);
  process.exit(1);
}

const target = join(CLIENT_ROOT, '.dev-machines.json');
const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : [];
const entry = { id, label: machineName, origin, workspacePath, credential: body.credential, towerKey };
const machines = [...existing.filter((machine) => machine.id !== id), entry];
writeFileSync(target, `${JSON.stringify(machines, null, 2)}\n`, { mode: 0o600 });

console.log(`paired "${machineName}" (id: ${id}) with ${origin} for ${workspacePath}`);
console.log(`wrote ${target} — ${machines.length} machine(s); the dev server proxies each at /m/<id>`);
