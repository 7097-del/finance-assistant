/* Service Worker —— 网络优先 + 离线兜底
 *
 * 【重要】旧版本用的是「缓存优先 + 固定版本号 ffa-v1」，
 * 导致手机一旦装到主屏，之后无论怎么更新代码，打开的永远是第一次缓存的旧页面。
 * 现在改为：代码文件一律先走网络（拿到就更新缓存），断网时才回落到缓存。
 * 每次发版只需改下面的 VERSION，旧缓存会被自动清空。
 */
const VERSION = '2026-08-01-7';
const CACHE = 'ffa-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/store.js',
  './js/remote.js',
  './js/api.js',
  './js/ui.js',
  './js/app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
  if (e.data === 'get-version' && e.source) e.source.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 行情接口一律走网络，绝不缓存
  if (url.hostname.indexOf('1234567.com.cn') !== -1 || url.hostname.indexOf('eastmoney') !== -1) return;
  // 跨域资源不接管
  if (url.origin !== self.location.origin) return;

  // API 请求（/api/*）一律只走网络，且失败时返回 JSON 404，
  // 绝不兜底返回 index.html —— 否则前端会把「首页 HTML」误判成「存在后端」而弹出设口令。
  if (url.pathname.indexOf('/api/') === 0) {
    e.respondWith(
      fetch(req).catch(() => new Response('{"code":404,"msg":"no backend"}', {
        status: 404, headers: { 'content-type': 'application/json' },
      }))
    );
    return;
  }

  // 网络优先：拿到新内容就顺手更新缓存；断网才用缓存
  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
