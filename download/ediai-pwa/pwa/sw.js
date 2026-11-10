/* Service Worker для PWA «Ежедневник».
 * Приложение полностью статическое: страницы и ассеты — network-first
 * с офлайн-фолбэком; иконки/manifest — cache-first.
 * Все пути вычисляются от scope регистрации, поэтому SW работает
 * и в корне (/), и в папке сайта (/pwa/ — ediai.ru, GitHub Pages).
 * Дополнительно: Web Push — напоминания в назначенное время
 * (отправляет push-sender на хостинге, подписки в api.php).
 */
const CACHE = "planner-cache-v4";
const ROOT = new URL(self.registration.scope).pathname; // "/" или "/pwa/"
const PRECACHE = [
  `${ROOT}manifest.webmanifest`,
  `${ROOT}icons/icon-192.png`,
  `${ROOT}icons/icon-512.png`,
  `${ROOT}icons/apple-touch-icon.png`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(ROOT)) return;

  // статические иконки — cache-first
  if (url.pathname.startsWith(`${ROOT}icons/`) || url.pathname === `${ROOT}manifest.webmanifest`) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // страницы и ассеты — network-first с офлайн-фолбэком
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell =
            (await cache.match(ROOT)) || (await cache.match(`${ROOT}?source=pwa`));
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});

/* ------------------------------ Web Push ------------------------------ */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : "Напоминание" };
  }
  const iconUrl = new URL("icons/icon-192.png", self.registration.scope).href;
  const title = typeof data.title === "string" && data.title ? data.title : "Ежедневник";
  const body =
    typeof data.body === "string" && data.body ? data.body : "Пора выполнить дело";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: iconUrl,
      badge: iconUrl,
      tag,
      renotify: !!tag,
      // при открытии уведомления перейдём в приложение (scope = адрес приложения)
      data: { url: typeof data.url === "string" && data.url ? data.url : self.registration.scope },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        // уже открыто — выводим окно вперёд
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          try {
            await client.navigate(url);
          } catch (err) {
            await client.postMessage({ type: "push-opened" });
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
