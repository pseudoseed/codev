import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const VAPID_PATH = process.env.EXP39_VAPID_PATH || path.join(ARTIFACTS, 'vapid.json');

function loadSub(arg) {
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.endpoint || !parsed.keys) throw new Error('subscription needs endpoint and keys');
  return parsed;
}

function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'invalid'; }
}

async function main() {
  const src = process.argv[2];
  if (!src) {
    process.stderr.write('usage: node scripts/send-push.mjs <subscription.json | ->\n');
    process.exit(2);
  }
  const vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  if (!vapid.publicKey || !vapid.privateKey) throw new Error('vapid.json missing keys');
  if (!vapid.subject) throw new Error('vapid.json missing subject; must be a real https origin or a real mailto, never localhost');
  const sub = loadSub(src);
  const webpush = require('web-push');
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const payload = JSON.stringify({
    title: 'Builder is gate-waiting',
    body: 'exp-39 test push',
    at: new Date().toISOString(),
  });
  let result;
  try {
    await webpush.sendNotification(sub, payload);
    result = { ok: true, endpointHost: hostOf(sub.endpoint) };
  } catch (err) {
    result = { ok: false, endpointHost: hostOf(sub.endpoint), error: String(err) };
  }
  const out = { at: new Date().toISOString(), result };
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'last-push-send.json'), JSON.stringify(out, null, 2));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
