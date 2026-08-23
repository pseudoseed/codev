import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { WebSocket } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ws'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PORT = Number(process.env.EXP39_PORT || 4110);
const TOWER_PORT = Number(process.env.EXP39_TOWER_PORT || 4100);
const KEY_PATH = process.env.EXP39_KEY_PATH || path.join(os.homedir(), '.agent-farm', 'local-key');
const FAKE_MAGIC = 'chris-mac.tailnet.ts.net';

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 8000),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function waitOpen(ws, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws timeout')), ms);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', (err) => { clearTimeout(t); reject(err); });
  });
}

function collectMessages(ws, ms = 1500) {
  return new Promise((resolve) => {
    const messages = [];
    const onMsg = (data) => messages.push(Buffer.from(data));
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve(messages);
    }, ms);
  });
}

async function main() {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim();
  const findings = { at: new Date().toISOString(), gates: {}, notes: [] };

  const towerHealthLocal = await request({ hostname: '127.0.0.1', port: TOWER_PORT, path: '/health', method: 'GET', headers: { host: 'localhost:4100' } });
  const towerHealthMagic = await request({ hostname: '127.0.0.1', port: TOWER_PORT, path: '/health', method: 'GET', headers: { host: FAKE_MAGIC } });
  findings.gates.host_reject_magicdns = {
    pass: towerHealthLocal.status === 200 && towerHealthMagic.status === 401,
    localhost: towerHealthLocal.status,
    magicdns: towerHealthMagic.status,
    magicBody: towerHealthMagic.body.slice(0, 200),
  };

  let serverProc = null;
  let startedHere = false;
  try {
    await request({ hostname: '127.0.0.1', port: PORT, path: '/v2/spike/status.json', method: 'GET' });
  } catch {
    serverProc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    startedHere = true;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ingress did not start')), 4000);
      serverProc.stdout.on('data', (buf) => {
        if (String(buf).includes('exp-39 ingress')) {
          clearTimeout(t);
          resolve();
        }
      });
      serverProc.on('error', reject);
    });
  }

  const spike = await request({ hostname: '127.0.0.1', port: PORT, path: '/v2/spike/', method: 'GET', headers: { host: FAKE_MAGIC } });
  const proxiedHealth = await request({ hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', headers: { host: FAKE_MAGIC } });
  findings.gates.ingress_host_rewrite = {
    pass: spike.status === 200 && proxiedHealth.status === 200 && spike.body.includes('Experiment 39'),
    spike: spike.status,
    proxiedHealth: proxiedHealth.status,
  };

  const echo = new WebSocket(`ws://127.0.0.1:${PORT}/v2/spike/echo`);
  await waitOpen(echo);
  echo.send('exp-39-ping');
  const echoMsgs = await collectMessages(echo, 800);
  echo.close();
  const echoText = echoMsgs.map((b) => b.toString('utf8'));
  findings.gates.local_echo_ws = {
    pass: echoText.some((t) => t.includes('exp-39-ping')),
    messages: echoText,
  };

  const created = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/terminals',
    method: 'POST',
    headers: {
      host: FAKE_MAGIC,
      'content-type': 'application/json',
      'codev-tower-key': key,
    },
    body: JSON.stringify({ command: 'cat', label: 'exp-39-throwaway', cols: 80, rows: 24 }),
  });
  let terminalId = null;
  try {
    terminalId = JSON.parse(created.body).id;
  } catch {
    terminalId = null;
  }
  findings.notes.push({ createStatus: created.status, createBody: created.body.slice(0, 500) });

  if (terminalId) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/${terminalId}`, ['codev.tower.v1', `codev-key.${key}`], {
      headers: { host: FAKE_MAGIC },
    });
    try {
      await waitOpen(ws);
      const payload = Buffer.concat([Buffer.from([0x01]), Buffer.from('exp-39-terminal-ping\n')]);
      ws.send(payload);
      const msgs = await collectMessages(ws, 1200);
      const decoded = msgs.map((buf) => {
        if (buf[0] === 0x01) return { type: 'data', text: buf.subarray(1).toString('utf8') };
        if (buf[0] === 0x00) return { type: 'control', text: buf.subarray(1).toString('utf8') };
        return { type: 'other', text: buf.toString('utf8').slice(0, 200) };
      });
      const echoed = decoded.some((m) => m.type === 'data' && m.text.includes('exp-39-terminal-ping'));
      findings.gates.local_terminal_ws = {
        pass: echoed,
        terminalId,
        frames: decoded.slice(0, 8),
      };
    } catch (err) {
      findings.gates.local_terminal_ws = { pass: false, terminalId, error: String(err) };
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
    await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/terminals/${terminalId}`,
      method: 'DELETE',
      headers: { host: FAKE_MAGIC, 'codev-tower-key': key },
    });
  } else {
    findings.gates.local_terminal_ws = { pass: false, error: 'create failed' };
  }

  const assets = [
    { path: '/v2/spike/', typePrefix: 'text/html', needle: 'Experiment 39' },
    { path: '/v2/spike/manifest.webmanifest', typePrefix: 'application/manifest+json', needle: 'standalone' },
    { path: '/v2/spike/sw.js', typePrefix: 'text/javascript', needle: 'showNotification' },
    { path: '/v2/spike/app.js', typePrefix: 'text/javascript', needle: 'PushManager' },
    { path: '/v2/spike/icon-180.png', typePrefix: 'image/png', needle: null },
    { path: '/v2/spike/icon-192.png', typePrefix: 'image/png', needle: null },
  ];
  const assetResults = [];
  for (const asset of assets) {
    const res = await request({ hostname: '127.0.0.1', port: PORT, path: asset.path, method: 'GET' });
    const type = res.headers['content-type'] || '';
    const swAllowed = asset.path.endsWith('/sw.js') ? res.headers['service-worker-allowed'] : undefined;
    const ok = res.status === 200
      && type.startsWith(asset.typePrefix)
      && (asset.needle == null || res.body.includes(asset.needle))
      && (asset.path.endsWith('/sw.js') ? swAllowed === '/v2/spike/' : true);
    assetResults.push({ path: asset.path, pass: ok, status: res.status, type, swAllowed });
  }
  findings.gates.pwa_assets = {
    pass: assetResults.every((a) => a.pass),
    assets: assetResults,
  };

  const vapidRes = await request({ hostname: '127.0.0.1', port: PORT, path: '/v2/spike/vapid-public.json', method: 'GET' });
  let vapidPublic = null;
  try { vapidPublic = JSON.parse(vapidRes.body).publicKey; } catch { vapidPublic = null; }
  const vapidBytes = vapidPublic ? Buffer.from(vapidPublic.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : Buffer.alloc(0);
  findings.gates.vapid = {
    pass: vapidRes.status === 200 && vapidBytes.length === 65 && vapidBytes[0] === 0x04,
    status: vapidRes.status,
    publicKeyLen: vapidPublic ? vapidPublic.length : 0,
    uncompressedBytes: vapidBytes.length,
  };

  const fakeEndpoint = 'https://exp39.invalid/push/fake-sub';
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const subRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/v2/spike/subscribe',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: fakeEndpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    }),
  });
  let subBody = {};
  try { subBody = JSON.parse(subRes.body); } catch { subBody = { raw: subRes.body.slice(0, 200) }; }
  findings.gates.subscribe = {
    pass: subRes.status === 200 && subBody.ok === true && subBody.count >= 1,
    status: subRes.status,
    count: subBody.count,
  };

  const emptyPush = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/v2/spike/push',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  let pushBody = {};
  try { pushBody = JSON.parse(emptyPush.body); } catch { pushBody = { raw: emptyPush.body.slice(0, 300) }; }
  const first = Array.isArray(pushBody.results) ? pushBody.results[0] : null;
  findings.gates.push_plumbing = {
    pass: emptyPush.status === 200 && first && first.ok === false && String(first.endpoint || '').includes('exp39.invalid'),
    status: emptyPush.status,
    resultOk: first ? first.ok : null,
    error: first ? String(first.error || '').slice(0, 200) : null,
  };

  findings.gates.serve_https = { pass: false, skipped: 'gate 1 blocked on external GitOps hostname, not a technical failure' };
  findings.gates.pwa_install = { pass: false, skipped: 'needs physical device after hostname exists' };
  findings.gates.push_permission = { pass: false, skipped: 'needs physical device after hostname exists' };
  findings.gates.delivered_push = { pass: false, skipped: 'needs physical device after hostname exists' };

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const out = path.join(ARTIFACTS, 'local-probes.json');
  fs.writeFileSync(out, JSON.stringify(findings, null, 2));
  process.stdout.write(JSON.stringify(findings, null, 2) + '\n');

  if (startedHere && serverProc) {
    serverProc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
