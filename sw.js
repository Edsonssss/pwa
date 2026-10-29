/* Service Worker: офлайн-оболочка приложения. */
const VERSION = 'v1.3.0';
const CACHE = `pwa-tasks-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/mask-icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-maskable-192.png',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
];

const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Задачи — нет сети</title><body style="font:17px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f2f2f7;color:#000"><div style="text-align:center;padding:24px"><h1 style="font-size:22px;margin:0 0 8px">Нет подключения</h1><p style="margin:0;opacity:.6">Приложение откроется, когда появится сеть или когда оболочка будет в кэше.</p></div>';

function offlineResponse() {
  return caches.match('./index.html').then((hit) =>
    hit || new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}

self.addEventListener('install', (event) => {
  // Без skipWaiting: новый SW встаёт в очередь, клиент сам решает, когда
  // обновиться (тост «Доступна новая версия»), чтобы не рвать живую сессию.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // чужие origin не трогаем
  // API синхронизации всегда идёт в сеть: кэш вернул бы устаревшие задачи/токены
  if (url.pathname.startsWith('/api/')) return;

  // Навигация: сеть → кэш (офлайн открываем оболочку или офлайн-страницу)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => offlineResponse())
    );
    return;
  }

  // Статика: stale-while-revalidate, с фолбэком вместо respondWith(undefined)
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || offlineResponse());
      return cached || network;
    })
  );
});
