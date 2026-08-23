import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ws'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PORT = Number(process.env.EXP39_PORT || 4110);
const TOWER_HOST = process.env.EXP39_TOWER_HOST || '127.0.0.1';
const TOWER_PORT = Number(process.env.EXP39_TOWER_PORT || 4100);
const KEY_PATH = process.env.EXP39_KEY_PATH || path.join(os.homedir(), '.agent-farm', 'local-key');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readKey() {
  try {
    return fs.readFileSync(KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function servePublic(req, res, url) {
  const rel = url.pathname === '/v2/spike' || url.pathname === '/v2/spike/'
    ? 'index.html'
    : url.pathname.slice('/v2/spike/'.length);
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return true;
  }
  const file = path.join(PUBLIC, rel || 'index.html');
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(400);
    res.end('bad path');
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/v2/spike/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

function loadSubscriptions() {
  const p = path.join(ARTIFACTS, 'subscriptions.json');
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubscriptions(list) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'subscriptions.json'), JSON.stringify(list, null, 2));
}

function loadOrCreateVapid() {
  const p = path.join(ARTIFACTS, 'vapid.json');
  if (fs.existsSync(p)) {
    const existing = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (existing.privateKey && !String(existing.privateKey).includes('BEGIN')) return existing;
  }
  const webpush = require('web-push');
  const keys = webpush.generateVAPIDKeys();
  const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'https://ade.pseudoseed.com' };
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(vapid, null, 2));
  return vapid;
}

async function readBody(req, max = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function proxyHeaders(req) {
  const headers = { ...req.headers, host: `localhost:${TOWER_PORT}` };
  delete headers['x-forwarded-host'];
  return headers;
}

function proxyHttp(req, res) {
  const headers = proxyHeaders(req);
  const upstream = http.request({
    hostname: TOWER_HOST,
    port: TOWER_PORT,
    path: req.url,
    method: req.method,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { error: 'UPSTREAM', message: String(err) });
    else res.destroy();
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const headerLines = [`${req.method} ${req.url} HTTP/1.1`, `Host: localhost:${TOWER_PORT}`];
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase() === 'host') continue;
    if (value == null) continue;
    const rendered = Array.isArray(value) ? value.join(', ') : value;
    headerLines.push(`${name}: ${rendered}`);
  }
  headerLines.push('', '');
  const upstream = net.connect(TOWER_PORT, TOWER_HOST, () => {
    upstream.write(headerLines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const fail = () => {
    try { socket.end(); } catch { /* already closed */ }
    try { upstream.end(); } catch { /* already closed */ }
  };
  upstream.on('error', fail);
  socket.on('error', fail);
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
  ws.on('message', (data) => {
    ws.send(data);
  });
});

const vapid = loadOrCreateVapid();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/v2/spike/status.json' && req.method === 'GET') {
    sendJson(res, 200, {
      experiment: 39,
      port: PORT,
      tower: `${TOWER_HOST}:${TOWER_PORT}`,
      keyPresent: Boolean(readKey()),
      secure: Boolean(req.socket.encrypted),
      host: req.headers.host || null,
      vapidPublicKey: vapid.publicKey,
    });
    return;
  }

  if (url.pathname === '/v2/spike/vapid-public.json' && req.method === 'GET') {
    sendJson(res, 200, { publicKey: vapid.publicKey });
    return;
  }

  if (url.pathname === '/v2/spike/subscribe' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || !body.endpoint) {
        sendJson(res, 400, { error: 'endpoint required' });
        return;
      }
      const list = loadSubscriptions().filter((s) => s.endpoint !== body.endpoint);
      list.push({ endpoint: body.endpoint, keys: body.keys || {}, at: new Date().toISOString() });
      saveSubscriptions(list);
      sendJson(res, 200, { ok: true, count: list.length });
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
    }
    return;
  }

  if (url.pathname === '/v2/spike/push' && req.method === 'POST') {
    const list = loadSubscriptions();
    if (list.length === 0) {
      sendJson(res, 400, { error: 'no subscriptions' });
      return;
    }
    let webpush;
    try {
      webpush = require('web-push');
    } catch {
      sendJson(res, 501, { error: 'web-push not installed', hint: 'npm install web-push --prefix codev/experiments/39-https-on-a-phone' });
      return;
    }
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const payload = JSON.stringify({
      title: 'Builder is gate-waiting',
      body: 'exp-39 test push',
      at: new Date().toISOString(),
    });
    const results = [];
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, payload);
        results.push({ endpoint: sub.endpoint, ok: true });
      } catch (err) {
        results.push({ endpoint: sub.endpoint, ok: false, error: String(err) });
      }
    }
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'last-push.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    sendJson(res, 200, { results });
    return;
  }

  if (url.pathname.startsWith('/v2/spike/') || url.pathname === '/v2/spike') {
    if (servePublic(req, res, url)) return;
    res.writeHead(404);
    res.end('not found');
    return;
  }

  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/v2/spike/echo') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`exp-39 ingress http://127.0.0.1:${PORT}/v2/spike/\n`);
});
