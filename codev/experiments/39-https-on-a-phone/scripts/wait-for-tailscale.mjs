import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'tailscale-ready.json');
const deadline = Date.now() + 2 * 60 * 60 * 1000;

function snapshot() {
  try {
    const bin = execFileSync('which', ['tailscale'], { encoding: 'utf8' }).trim();
    let status = '';
    try {
      status = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
    } catch (err) {
      status = String(err.stdout || err.stderr || err.message || err);
    }
    let parsed = null;
    try { parsed = JSON.parse(status); } catch { parsed = null; }
    const backend = parsed && parsed.BackendState;
    const dns = parsed && parsed.Self && parsed.Self.DNSName;
    const running = backend === 'Running' && Boolean(dns);
    return { bin, backend: backend || null, dns: dns || null, running, raw: parsed ? undefined : status.slice(0, 500) };
  } catch {
    return { bin: null, backend: null, dns: null, running: false };
  }
}

while (Date.now() < deadline) {
  const snap = snapshot();
  if (snap.running) {
    const result = { at: new Date().toISOString(), ready: true, ...snap };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15000));
}

const result = { at: new Date().toISOString(), ready: false, reason: 'timeout 2h', ...snapshot() };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result) + '\n');
process.exit(2);
