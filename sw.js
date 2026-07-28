/* 极简 Service Worker：缓存应用外壳，支持离线打开（PWA） */
const CACHE = 'ffa-v1';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/store.js',
  './js/api.js',
  './js/ui.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 天天基金行情接口走网络，不缓存
  if (url.hostname.indexOf('1234567.com.cn') !== -1 || url.hostname.indexOf('eastmoney') !== -1) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        try {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        } catch (_) {}
        return resp;
      }).catch(() => cached);
    })
  );
});
