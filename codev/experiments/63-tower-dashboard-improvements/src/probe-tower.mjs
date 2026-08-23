import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadWsCtor() {
  if (typeof WebSocket === 'function') return { Ctor: WebSocket, kind: 'global' };
  const require = createRequire(import.meta.url);
  const candidates = [
    '/Users/chris/dev/codev-1455/packages/codev/node_modules/ws',
    join(process.cwd(), 'node_modules/ws'),
    join(process.cwd(), 'packages/codev/node_modules/ws'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    return { Ctor: require(p), kind: p };
  }
  throw new Error('No WebSocket constructor. Pass --experimental-websocket or install ws.');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOWER = 'http://127.0.0.1:4100';
const KEY_PATH = join(homedir(), '.agent-farm', 'local-key');

function loadKey() {
  try {
    return readFileSync(KEY_PATH, 'utf8').trim();
  } catch (err) {
    return null;
  }
}

async function towerFetch(key, path, opts = {}) {
  const headers = {
    'codev-tower-key': key,
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${TOWER}${path}`, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function decodeFrame(buf) {
  if (buf.byteLength === 0) return { type: 'empty' };
  const bytes = new Uint8Array(buf);
  const prefix = bytes[0];
  const payload = bytes.subarray(1);
  if (prefix === 0x00) {
    const json = new TextDecoder().decode(payload);
    return { type: 'control', message: JSON.parse(json) };
  }
  if (prefix === 0x01) {
    return { type: 'data', text: new TextDecoder().decode(payload) };
  }
  return { type: 'unknown', prefix };
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (Buffer.isBuffer(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return data;
}

function attachPty(key, id) {
  const { Ctor, kind } = loadWsCtor();
  const controlTypes = [];
  const dataChunks = [];
  const protocols = ['codev.tower.v1', `codev-key.${key}`];
  const ws = new Ctor(`ws://127.0.0.1:4100/ws/terminal/${id}`, protocols);
  if (ws.binaryType !== undefined) ws.binaryType = 'arraybuffer';

  const onMessage = (data) => {
    try {
      const frame = decodeFrame(toArrayBuffer(data));
      if (frame.type === 'control') controlTypes.push(frame.message.type);
      if (frame.type === 'data') dataChunks.push(frame.text);
    } catch (err) {
      controlTypes.push(`decode-error:${err.message}`);
    }
  };

  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('message', (ev) => onMessage(ev.data));
  } else {
    ws.on('message', onMessage);
  }

  return {
    kind,
    controlTypes,
    dataChunks,
    close: () => {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function probeTower() {
  const key = loadKey();
  const result = {
    generatedAt: new Date().toISOString(),
    tower: TOWER,
    keyPresent: Boolean(key),
    daemon: null,
    createEmpty: null,
    updateMissing: null,
    browse: null,
    pty: null,
  };

  if (!key) {
    result.daemon = { ok: false, reason: 'no ~/.agent-farm/local-key' };
    return result;
  }

  try {
    const health = await towerFetch(key, '/health');
    result.daemon = { ok: health.status === 200, status: health.status, body: health.json || health.text };
  } catch (err) {
    result.daemon = { ok: false, reason: err.message };
    return result;
  }

  result.createEmpty = await towerFetch(key, '/api/create', {
    method: 'POST',
    body: JSON.stringify({}),
  }).then((r) => ({ status: r.status, body: r.json || r.text }));

  result.updateMissing = await towerFetch(key, '/api/update', {
    method: 'POST',
    body: JSON.stringify({ path: '/tmp' }),
  }).then((r) => ({ status: r.status, body: r.json || r.text }));

  result.browse = await towerFetch(key, '/api/browse?path=/tmp').then((r) => ({
    status: r.status,
    suggestionCount: Array.isArray(r.json?.suggestions) ? r.json.suggestions.length : null,
  }));

  const created = await towerFetch(key, '/api/terminals', {
    method: 'POST',
    body: JSON.stringify({
      command: 'sh',
      args: ['-c', 'printf "hello-0063\\n"; sleep 0.2; printf "done\\n"; exit 7'],
      cwd: '/tmp',
      label: 'exp-63-oneshot',
      cols: 80,
      rows: 24,
    }),
  });

  if (created.status !== 201 || !created.json?.id) {
    result.pty = {
      created: false,
      status: created.status,
      body: created.json || created.text,
    };
    return result;
  }

  const id = created.json.id;
  let attach;
  try {
    attach = attachPty(key, id);
  } catch (err) {
    result.pty = {
      created: true,
      id,
      persistent: created.json.persistent,
      wsError: err.message,
    };
    await towerFetch(key, `/api/terminals/${id}`, { method: 'DELETE' });
    return result;
  }

  let info = null;
  for (let i = 0; i < 20; i++) {
    const got = await towerFetch(key, `/api/terminals/${id}`);
    info = got.json;
    if (info?.status === 'exited') break;
    await sleep(150);
  }
  await sleep(250);
  attach.close();

  const del = await towerFetch(key, `/api/terminals/${id}`, { method: 'DELETE' });

  const data = attach.dataChunks.join('');
  result.pty = {
    created: true,
    id,
    persistent: created.json.persistent,
    wsPath: created.json.wsPath,
    wsKind: attach.kind,
    data,
    sawHello: data.includes('hello-0063'),
    controlTypes: attach.controlTypes,
    controlHasExit: attach.controlTypes.includes('exit'),
    polled: info,
    exitCode: info?.exitCode,
    status: info?.status,
    deleted: del.status,
  };

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await probeTower();
  const out = join(root, 'artifacts', 'tower-probe.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(out);
}
