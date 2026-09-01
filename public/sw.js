// Service Worker for フリモーラ
const CACHE_NAME = 'furimora-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network-only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() =>
      new Response(JSON.stringify({ error: 'オフラインです' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // HTML と アプリのJSモジュール: network-first (常に最新のコードを取得)
  // /js/ は index.html から読む共通ロジック（clone-service.js 等）。cache-first だと
  // 更新しても古い版が配られ続けるため、HTML と同じ扱いにする。
  if (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.startsWith('/js/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // その他の静的アセット: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// Push notifications (future use)
self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json() || {};
    } catch (e) {
      try {
        data = { body: event.data.text() || '新しい通知があります' };
      } catch (e2) {
        data = {};
      }
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'フリモーラ', {
      body: data.body || '新しい通知があります',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/')
  );
});
