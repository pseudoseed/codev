/**
 * Pair this browser's machine with a running codev-agent and write the result to
 * `apps/client/.dev-machines.json`, which the dev server reads.
 *
 *   node scripts/pair-dev.mjs [--origin http://127.0.0.1:4100] [--workspace <abs path>]
 *                             [--machine dev-local] [--id local]
 *
 * Pairing is normally an operator action with a token read off another screen,
 * and `afx pair issue --purpose machine-credential` is the command for it. This
 * script does both halves — issue, then redeem — in one place because a DEV
 * client that cannot authenticate cannot show anything, and one command beats
 * two on every `pnpm dev`.
 *
 * It writes a REAL credential to the real store. **Revoke it with
 * `afx pair revoke <name>`**, not with `DELETE /api/agent/v1/machines/<name>`:
 * that route is `human-session`, so it requires already holding the credential
 * you are trying to withdraw.
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

/*
 * THE TOWER KEY IS USED HERE AND NEVER WRITTEN DOWN.
 *
 * `~/.agent-farm/local-key` is Tower's all-or-nothing shared secret: it cannot be
 * revoked for one machine without rotating it for all. It is needed for THIS
 * script's redemption call, which is a local operator action, and it must never
 * reach `.dev-machines.json` — that file is served to the browser, and a page
 * holding this key would have Tower-wide access to every workspace on the host,
 * which revoking the machine credential would not take away.
 *
 * The client does not need it. `isRequestAllowed` exempts `/api/agent/v1/*` from
 * the shared key exactly so a paired device can reach the surface holding only
 * what pairing gave it.
 *
 * NOTE ON WHAT MINTING PROVES: nothing about human presence. This script can mint
 * a token because it can write the pairing store, and so can every agent running
 * as this user. The `authority` string it records says only that this script
 * minted it. See `pairing.ts` `issue()`.
 */
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
  process.stdout.write(new PairingStore().issue({
    ttlMs: 5 * 60_000,
    purpose: 'machine-credential',
    authority: 'apps/client scripts/pair-dev.mjs, run by whoever ran this script',
  }).token);
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
const entry = { id, label: machineName, origin, workspacePath, credential: body.credential };
const machines = [...existing.filter((machine) => machine.id !== id), entry];
writeFileSync(target, `${JSON.stringify(machines, null, 2)}\n`, { mode: 0o600 });

console.log(`paired "${machineName}" (id: ${id}) with ${origin} for ${workspacePath}`);
console.log(`wrote ${target} — ${machines.length} machine(s); the dev server proxies each at /m/<id>`);
