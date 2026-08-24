import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const PORT = Number(process.env.FIXTURE_PORT ?? 4173);
const KEY = 'ab'.repeat(32);
const KEY_RE = /^[0-9a-f]{64}$/;
const ASSET_EXT = new Set(['.js', '.css', '.map', '.svg', '.woff2', '.png', '.ico']);

const COUNTS = { workspaces: 22, builders: { total: 58, byStatus: { running: 10 } }, gateWaiting: 3 };

function zeros() {
  return Array.from({ length: 20 }, () => 0);
}

function node(over) {
  return {
    parentId: null,
    status: 'running',
    flags: { heldMail: false },
    lastDataAt: null,
    buckets: zeros(),
    ...over,
  };
}

const DEFAULT_NODES = [
  node({ id: 'workspace:/tmp/alpha', kind: 'workspace', name: 'alpha' }),
  node({ id: 'architect:1', kind: 'architect', parentId: 'workspace:/tmp/alpha', name: 'arch' }),
  node({ id: 'builder:1', kind: 'builder', parentId: 'workspace:/tmp/alpha', name: 'b1', status: 'running' }),
  node({
    id: 'builder:2',
    kind: 'builder',
    parentId: 'workspace:/tmp/alpha',
    name: 'b2',
    status: 'gate-waiting',
  }),
];

const state = {
  workspacesStatus: 200,
  workspacesBody: { workspaces: [{ path: '/tmp/alpha', name: 'alpha' }] },
  eventsStatus: 200,
  honorResume: true,
  streamId: 's1',
  seq: 0,
  nodes: DEFAULT_NODES,
  dark: [],
  pending: [],
  clients: [],
  unreachable: false,
  lastEvents: { since: null, stream: null, mode: null },
};

function injectV2Key(html, key) {
  if (!KEY_RE.test(key) || !html.includes('</head>')) return html;
  return html.replace('</head>', `<script>window.__CODEV_TOWER_KEY__=${JSON.stringify(key)};</script></head>`);
}

function writeSse(res, frame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function snapshot(resumed) {
  return {
    seq: state.seq,
    type: 'snapshot',
    streamId: state.streamId,
    resumed,
    nodes: state.nodes,
    counts: COUNTS,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveIndex(res) {
  const file = path.join(DIST, 'index.html');
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    res.writeHead(404);
    res.end('no dist');
    return;
  }
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Vary');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(injectV2Key(html, KEY));
}

function serveAsset(res, urlPath) {
  const rel = urlPath.slice('/v2/assets/'.length);
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(rel);
  if (!ASSET_EXT.has(ext)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const full = path.resolve(path.join(DIST, 'assets'), rel);
  const root = path.resolve(path.join(DIST, 'assets')) + path.sep;
  if (!full.startsWith(root)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const mime = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  try {
    const buf = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function handleEvents(req, res, url) {
  if (state.unreachable) {
    req.socket.destroy();
    return;
  }
  if (state.eventsStatus !== 200) {
    res.writeHead(state.eventsStatus);
    res.end('');
    return;
  }
  const since = url.searchParams.get('since');
  const stream = url.searchParams.get('stream');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const client = { res, closed: false };
  state.clients.push(client);
  req.on('close', () => {
    client.closed = true;
    state.clients = state.clients.filter((c) => c !== client);
  });
  const resumeOk = state.honorResume && since !== null && stream === state.streamId;
  state.lastEvents = { since, stream, mode: resumeOk ? 'resumed' : 'snapshot' };
  if (resumeOk) {
    writeSse(res, { seq: state.seq, type: 'resumed', from: Number(since) });
    for (const f of state.pending) writeSse(res, f);
    state.pending = [];
  } else {
    state.pending = [];
    writeSse(res, snapshot(false));
    for (const d of state.dark) {
      writeSse(res, { seq: state.seq, type: 'dark', id: d.id, reason: d.reason });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (state.unreachable && url.pathname.startsWith('/api/')) {
    req.socket.destroy();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__fixture/last-events') {
    json(res, 200, state.lastEvents);
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/__fixture/')) {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/__fixture/reset') {
      state.workspacesStatus = 200;
      state.workspacesBody = { workspaces: [{ path: '/tmp/alpha', name: 'alpha' }] };
      state.eventsStatus = 200;
      state.honorResume = true;
      state.streamId = 's1';
      state.seq = 0;
      state.nodes = [...DEFAULT_NODES];
      state.dark = [];
      state.pending = [];
      state.unreachable = false;
      state.lastEvents = { since: null, stream: null, mode: null };
      for (const c of state.clients) {
        c.closed = true;
        c.res.end();
      }
      state.clients = [];
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/workspaces') {
      if (body.status) state.workspacesStatus = body.status;
      if (body.body !== undefined) state.workspacesBody = body.body;
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/unreachable') {
      state.unreachable = true;
      // An unreachable Tower has no live streams either. Destroying the socket
      // (rather than ending the response) is what makes the client's fetch
      // throw, which is the failure #106 is about.
      for (const c of state.clients) {
        c.closed = true;
        c.res.socket?.destroy();
      }
      state.clients = [];
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/honor-resume') {
      state.honorResume = Boolean(body.honor);
      if (body.streamId) state.streamId = body.streamId;
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/disconnect') {
      for (const c of state.clients) {
        c.closed = true;
        c.res.end();
      }
      state.clients = [];
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__fixture/push') {
      const frames = body.frames;
      for (const f of frames) {
        state.seq += 1;
        const framed = { ...f, seq: state.seq };
        if (state.clients.length === 0) state.pending.push(framed);
        else {
          for (const c of state.clients) {
            if (!c.closed) writeSse(c.res, framed);
          }
        }
      }
      json(res, 200, { ok: true, seq: state.seq });
      return;
    }
    json(res, 404, { error: 'unknown fixture' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/workspaces') {
    if (state.workspacesStatus !== 200) {
      res.writeHead(state.workspacesStatus);
      res.end('');
      return;
    }
    json(res, 200, state.workspacesBody);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v2/events') {
    handleEvents(req, res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v2/') {
    serveIndex(res);
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/v2/assets/')) {
    serveAsset(res, url.pathname);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fixture on ${PORT}\n`);
});
