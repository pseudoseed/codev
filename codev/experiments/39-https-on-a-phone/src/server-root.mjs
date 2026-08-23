import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ws'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public-root');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PORT = Number(process.env.EXP39_ROOT_PORT || 4111);
const SUBS_PATH = path.join(ARTIFACTS, 'subscriptions-root.json');
const VAPID_PATH = path.join(ARTIFACTS, 'vapid.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function servePublic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

function loadSubscriptions() {
  if (!fs.existsSync(SUBS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubscriptions(list) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(SUBS_PATH, JSON.stringify(list, null, 2));
}

function loadOrCreateVapid() {
  if (fs.existsSync(VAPID_PATH)) {
    const existing = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    if (existing.privateKey && !String(existing.privateKey).includes('BEGIN')) return existing;
  }
  const webpush = require('web-push');
  const keys = webpush.generateVAPIDKeys();
  const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'https://ade.pseudoseed.com' };
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2));
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

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString(), variant: 'root' }));
  ws.on('message', (data) => {
    ws.send(data);
  });
});

const vapid = loadOrCreateVapid();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/status.json' && req.method === 'GET') {
    sendJson(res, 200, {
      experiment: 39,
      variant: 'root',
      port: PORT,
      vapidPublicKey: vapid.publicKey,
    });
    return;
  }

  if (url.pathname === '/vapid-public.json' && req.method === 'GET') {
    sendJson(res, 200, { publicKey: vapid.publicKey });
    return;
  }

  if (url.pathname === '/subscribe' && req.method === 'POST') {
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

  if (url.pathname === '/push' && req.method === 'POST') {
    const list = loadSubscriptions();
    if (list.length === 0) {
      sendJson(res, 400, { error: 'no subscriptions' });
      return;
    }
    const webpush = require('web-push');
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const payload = JSON.stringify({
      title: 'Builder is gate-waiting',
      body: 'exp-39 root test push',
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
    fs.writeFileSync(path.join(ARTIFACTS, 'last-push-root.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    sendJson(res, 200, { results });
    return;
  }

  if (servePublic(req, res, url)) return;
  res.writeHead(404);
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/echo') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`exp-39 root http://127.0.0.1:${PORT}/\n`);
});
