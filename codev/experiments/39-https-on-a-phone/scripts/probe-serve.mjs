import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

function whichTailscale() {
  try {
    return execFileSync('which', ['tailscale'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function serveStatus() {
  try {
    return execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
  } catch (err) {
    return String(err.stdout || err.stderr || err);
  }
}

function fetchHttps(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: true }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const cert = res.socket.getPeerCertificate();
        resolve({
          status: res.statusCode,
          issuer: cert && cert.issuer ? cert.issuer : null,
          subject: cert && cert.subject ? cert.subject : null,
          valid_to: cert ? cert.valid_to : null,
          authorized: res.socket.authorized,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 400),
        });
      });
    }).on('error', reject);
  });
}

async function main() {
  const bin = whichTailscale();
  const result = { at: new Date().toISOString(), tailscale: bin };
  if (!bin) {
    result.pass = false;
    result.reason = 'tailscale binary not found';
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'serve-probe.json'), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }
  const statusRaw = serveStatus();
  result.serveStatus = statusRaw.slice(0, 4000);
  let url = null;
  try {
    const parsed = JSON.parse(statusRaw);
    const httpsMap = parsed.Web || parsed.tcp || parsed;
    result.parsed = parsed;
    const text = JSON.stringify(parsed);
    const match = text.match(/https:\/\/[a-z0-9.-]+/);
    if (match) url = match[0];
    void httpsMap;
  } catch {
    const match = statusRaw.match(/https:\/\/[a-z0-9.-]+/);
    if (match) url = match[0];
  }
  if (!url) {
    result.pass = false;
    result.reason = 'no https URL in tailscale serve status';
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'serve-probe.json'), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }
  result.url = url;
  result.fetch = await fetchHttps(`${url}/v2/spike/`);
  result.pass = result.fetch.status === 200 && result.fetch.authorized === true;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'serve-probe.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
