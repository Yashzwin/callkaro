// CallKaro service worker — push notifications + offline cache.
const CACHE = 'callkaro-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './config.js',
               './firebase-config.js', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

// Network-first for pages/scripts so updates arrive; cache fallback offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  const isShellDoc = e.request.mode === 'navigate' ||
                     url.endsWith('/index.html') || url.endsWith('/index') ||
                     url.endsWith('config.js') || url.endsWith('firebase-config.js') ||
                     url.endsWith('.webmanifest');
  if (isShellDoc) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./')))
    );
    return;
  }
  // icons & everything else: cache-first
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      }).catch(() => cached)
    )
  );
});

// ---- Incoming-call push (sent by our server as an FCM data message) ----
// The payload can arrive in a few shapes depending on how it was sent:
//   FCM v1 data message : { from, priority, data: {type,from,code,url} }
//   FCM v1 notification : { notification: {title,body}, data: {...} }
//   plain web push      : { title, body, url }
self.addEventListener('push', function (event) {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) {
    try { msg = { body: event.data ? event.data.text() : '' }; } catch (e2) {}
  }

  const d = msg.data || msg;
  const isCall = d && (d.type === 'call' || msg.notification);
  if (!isCall) return; // ignore unrelated pushes

  const from   = (d.from || d.code || '').toString();
  const to     = (d.to || d.code || '').toString();
  const title  = '📞 Incoming Call';
  const body   = from ? (from + ' is calling you') : (msg.notification && msg.notification.body) || 'Someone is calling you';
  const url    = d.url || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'call-' + (from || 'someone'),
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      actions: [
        { action: 'answer',  title: 'Answer',  icon: './icon-answer.png' },
        { action: 'decline', title: 'Decline', icon: './icon-decline.png' }
      ],
      data: { url: url, from: from, to: to }
    })
  );
});

// ---- Notification buttons ----
// Answer: open/focus the app straight into the call (auto-picks up when the
//         mic permission is already granted). Decline: tell the caller
//         without even opening the app. ----
self.addEventListener('notificationclick', function (event) {
  const d = event.notification.data || {};
  const from = d.from || '';
  const origin = self.location.origin;

  if (event.action === 'decline') {
    event.notification.close();
    event.waitUntil(fetch(origin + '/decline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: from, to: d.to || '' })
    }).catch(function () {}));
    return;
  }

  event.notification.close();
  const wantAutoAnswer = event.action === 'answer';
  const openUrl = origin + '/' + (wantAutoAnswer && from
    ? '?answer=1&from=' + encodeURIComponent(from) : '');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if (client.url.indexOf(origin) === 0 && 'focus' in client) {
          if (wantAutoAnswer) client.postMessage({ type: 'auto-answer', from: from });
          return client.focus();
        }
      }
      return clients.openWindow(openUrl);
    })
  );
});
