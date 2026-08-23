import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ws'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PORT = Number(process.env.EXP39_ROOT_PORT || 4111);
const CHROME = process.env.EXP39_CHROME || '/opt/homebrew/bin/chromium';
const CDP_PORT = Number(process.env.EXP39_CDP_PORT || 9223);

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

function collectMessages(ws, ms = 800) {
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

function cdpCall(ws, id, method, params, ms = 15000) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id !== id) return;
      ws.off('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`cdp timeout ${method}`));
    }, ms);
  });
}

async function probeBrowser() {
  if (!fs.existsSync(CHROME)) {
    return { pass: false, skipped: `chromium not at ${CHROME}` };
  }
  const profile = fs.mkdtempSync(path.join(ARTIFACTS, 'chrome-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${PORT}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      await request({ hostname: '127.0.0.1', port: CDP_PORT, path: '/json/version', method: 'GET' });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!ready) {
    chrome.kill('SIGTERM');
    return { pass: false, error: 'cdp did not come up' };
  }

  try {
    const list = await request({ hostname: '127.0.0.1', port: CDP_PORT, path: '/json/list', method: 'GET' });
    const targets = JSON.parse(list.body);
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) return { pass: false, error: 'no page target', targets: targets.map((t) => t.type) };

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await waitOpen(ws, 5000);
    await cdpCall(ws, 1, 'Runtime.enable', {});
    await cdpCall(ws, 2, 'Page.enable', {});
    try {
      await cdpCall(ws, 3, 'Browser.grantPermissions', {
        origin: `http://127.0.0.1:${PORT}`,
        permissions: ['notifications'],
      });
    } catch (err) {
      // older chromium may reject this; SW register can still be scored
      void err;
    }
    await cdpCall(ws, 4, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await new Promise((r) => setTimeout(r, 1500));

    const evalResult = await cdpCall(ws, 5, 'Runtime.evaluate', {
      expression: `(() => {
        return navigator.serviceWorker.getRegistration('/').then((reg) => {
          if (!reg) return { registered: false };
          return {
            registered: true,
            scope: reg.scope,
            active: Boolean(reg.active),
            installing: Boolean(reg.installing),
            waiting: Boolean(reg.waiting),
          };
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = evalResult && evalResult.result ? evalResult.result.value : null;
    const pass = Boolean(value && value.registered && String(value.scope || '').endsWith('/') && (value.active || value.installing || value.waiting));

    let subscribe = null;
    if (pass) {
      try {
        await cdpCall(ws, 6, 'Runtime.evaluate', {
          expression: 'Notification.requestPermission()',
          awaitPromise: true,
          returnByValue: true,
        }, 10000);
        await cdpCall(ws, 7, 'Runtime.evaluate', {
          expression: 'document.getElementById("sub").click(); true',
          returnByValue: true,
        });
        await new Promise((r) => setTimeout(r, 4000));
        const logResult = await cdpCall(ws, 8, 'Runtime.evaluate', {
          expression: `(() => {
            const text = document.getElementById('log') ? document.getElementById('log').textContent : '';
            const match = text.match(/\\{"endpoint":"[^"]+"/);
            let host = null;
            try {
              const start = text.indexOf('{"endpoint":');
              if (start >= 0) {
                const parsed = JSON.parse(text.slice(start));
                host = parsed.endpoint ? new URL(parsed.endpoint).host : null;
                return {
                  printed: Boolean(parsed.endpoint && parsed.keys && parsed.keys.p256dh && parsed.keys.auth),
                  endpointHost: host,
                  hasKeys: Boolean(parsed.keys && parsed.keys.p256dh && parsed.keys.auth),
                  logHasSw: text.includes('sw registered:'),
                };
              }
            } catch (err) {
              return { printed: false, parseError: String(err), logHasSw: text.includes('sw registered:') };
            }
            return { printed: false, logHasSw: text.includes('sw registered:'), snippet: text.slice(0, 200) };
          })()`,
          returnByValue: true,
        });
        subscribe = logResult && logResult.result ? logResult.result.value : null;
      } catch (err) {
        subscribe = { error: String(err) };
      }
    }

    ws.close();
    const subscribePass = Boolean(subscribe && subscribe.printed && subscribe.endpointHost && subscribe.hasKeys);
    return { pass: pass && subscribePass, registration: value, subscribe };
  } finally {
    chrome.kill('SIGTERM');
  }
}

async function main() {
  const findings = { at: new Date().toISOString(), variant: 'root', port: PORT, gates: {} };

  let serverProc = null;
  let startedHere = false;
  try {
    await request({ hostname: '127.0.0.1', port: PORT, path: '/status.json', method: 'GET' });
  } catch {
    serverProc = spawn(process.execPath, [path.join(ROOT, 'src', 'server-root.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    startedHere = true;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('root server did not start')), 4000);
      serverProc.stdout.on('data', (buf) => {
        if (String(buf).includes('exp-39 root')) {
          clearTimeout(t);
          resolve();
        }
      });
      serverProc.on('error', reject);
    });
  }

  const assets = [
    { path: '/', typePrefix: 'text/html', needle: 'root-scoped' },
    { path: '/manifest.webmanifest', typePrefix: 'application/manifest+json', needle: '"scope": "/"' },
    { path: '/sw.js', typePrefix: 'text/javascript', needle: "openWindow('/')" },
    { path: '/app.js', typePrefix: 'text/javascript', needle: 'JSON.stringify(sub.toJSON())' },
    { path: '/vapid-public.json', typePrefix: 'application/json', needle: '"publicKey"' },
    { path: '/icon-180.png', typePrefix: 'image/png', needle: null },
    { path: '/icon-192.png', typePrefix: 'image/png', needle: null },
  ];
  const assetResults = [];
  for (const asset of assets) {
    const res = await request({ hostname: '127.0.0.1', port: PORT, path: asset.path, method: 'GET' });
    const type = res.headers['content-type'] || '';
    const swAllowed = asset.path === '/sw.js' ? res.headers['service-worker-allowed'] : undefined;
    const ok = res.status === 200
      && type.startsWith(asset.typePrefix)
      && (asset.needle == null || res.body.includes(asset.needle))
      && (asset.path === '/sw.js' ? swAllowed === '/' : true);
    assetResults.push({ path: asset.path, pass: ok, status: res.status, type, swAllowed });
  }
  findings.gates.pwa_assets = { pass: assetResults.every((a) => a.pass), assets: assetResults };

  const html = await request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'GET' });
  const app = await request({ hostname: '127.0.0.1', port: PORT, path: '/app.js', method: 'GET' });
  findings.gates.no_backend_writes = {
    pass: !html.body.includes('id="echo"')
      && !html.body.includes('id="push"')
      && !app.body.includes('/subscribe')
      && !app.body.includes('/push')
      && app.body.includes('JSON.stringify(sub.toJSON())')
      && app.body.includes('/vapid-public.json'),
  };

  findings.gates.browser_sw = await probeBrowser();

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'root-probes.json'), JSON.stringify(findings, null, 2));
  process.stdout.write(JSON.stringify(findings, null, 2) + '\n');

  if (startedHere && serverProc) serverProc.kill('SIGTERM');
  process.exit(findings.gates.pwa_assets.pass && findings.gates.no_backend_writes.pass && findings.gates.browser_sw.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
