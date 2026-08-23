const logEl = document.getElementById('log');
const ctxEl = document.getElementById('ctx');

function log(line) {
  logEl.textContent += line + '\n';
}

const standalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

ctxEl.innerHTML = [
  `protocol: <b>${location.protocol}</b>`,
  `host: <b>${location.host}</b>`,
  `secureContext: <b>${String(window.isSecureContext)}</b>`,
  `standalone: <b>${String(standalone)}</b>`,
  `notification: <b>${('Notification' in window) ? Notification.permission : 'no API'}</b>`,
  `serviceWorker: <b>${('serviceWorker' in navigator) ? 'yes' : 'no'}</b>`,
  `variant: <b>root</b>`,
].join('<br>');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((reg) => log('sw registered: ' + reg.scope))
    .catch((err) => log('sw failed: ' + err));
} else {
  log('no serviceWorker');
}

document.getElementById('perm').onclick = async () => {
  if (!('Notification' in window)) {
    log('Notification API missing');
    return;
  }
  const result = await Notification.requestPermission();
  log('permission: ' + result);
};

document.getElementById('sub').onclick = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    log('PushManager missing (Safari tab cannot do this; install to Home Screen)');
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const vapid = await (await fetch('/vapid-public.json')).json();
  const bytes = Uint8Array.from(atob(vapid.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  log(JSON.stringify(sub.toJSON()));
};
