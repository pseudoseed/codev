self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Codev', body: 'exp-39 push' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data = { title: 'Codev', body: event.data.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Codev', {
    body: data.body || '',
    tag: 'exp-39',
    data,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/v2/spike/'));
});
