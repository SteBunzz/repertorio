// Service worker: tiene l'app sul dispositivo così si apre anche senza connessione.
// Con la connessione scarica sempre i file più recenti; offline usa la copia salvata.
const VERSION = "repertorio-v2";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const SHELL = [
  "./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"
];
const SDK_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => SDK + f);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    await Promise.all(SDK_FILES.map(async url => {
      try { const res = await fetch(url, { mode: "cors" }); if (res.ok) await cache.put(url, res); } catch {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function cacheable(url){
  return url.origin === self.location.origin ||
    url.href.startsWith(SDK) ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isPage = req.mode === "navigate";
    const key = isPage ? "./index.html" : req;
    const cached = await cache.match(key, { ignoreSearch: isPage });
    const sameOrigin = url.origin === self.location.origin;

    if (sameOrigin){
      try {
        const res = await Promise.race([
          fetch(isPage ? req : new Request(req, { cache: "no-cache" })),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), cached ? 4000 : 15000))
        ]);
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      } catch {
        return cached || new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }

    const network = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached){ event.waitUntil(network); return cached; }
    const res = await network;
    return res || new Response("Offline", { status: 503, statusText: "Offline" });
  })());
});
