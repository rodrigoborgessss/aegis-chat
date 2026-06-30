// sw.js — service worker do PWA. Mete em cache o "casco" da app para abrir
// offline e instalar no ecrã inicial. Não toca na API (/api/*) nem no WebSocket
// (que nem sequer passa por aqui). Para publicar uma versão nova, sobe o CACHE.
const CACHE = "aegis-v6";
const ASSETS = [
  "/", "/index.html", "/app.js",
  "/ratchet.js", "/session.js", "/group.js", "/store.js", "/vault.js", "/dmsync.js",
  "/vendor/argon2.min.js", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                       // POST /api -> direto à rede
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // só os nossos próprios ficheiros
  if (url.pathname.startsWith("/api/")) return;           // nunca cachear a API

  if (req.mode === "navigate") {                          // páginas: rede primeiro, cache offline
    e.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }
  // restantes assets: cache primeiro, com atualização em segundo plano
  e.respondWith(caches.match(req).then(hit =>
    hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => hit)
  ));
});

// --- notificações push (sem conteúdo: só avisa que há mensagem) ---
self.addEventListener("push", e => {
  e.waitUntil(self.registration.showNotification("AegisChat", {
    body: "Nova mensagem", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "aegis-msg",
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});
