// Service worker: tiene l'app sul dispositivo così si apre anche senza connessione.
// I dati (brani e playlist) li gestisce Firestore con la sua cache offline.
// Quando modifichi i file dell'app, cambia VERSION per forzare l'aggiornamento.
const VERSION = "repertorio-v1";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const SHELL = [
  "./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"
];
const SDK_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => SDK + f);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
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
  if (!cacheable(url)) return; // Firestore e login passano direttamente in rete

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isPage = req.mode === "navigate";
    const cached = await cache.match(isPage ? "./index.html" : req, { ignoreSearch: isPage });
    // Mostra subito la copia salvata e intanto aggiorna in background
    const network = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(isPage ? "./index.html" : req, res.clone());
      return res;
    }).catch(() => null);
    if (cached){ event.waitUntil(network); return cached; }
    const res = await network;
    return res || new Response("Offline", { status: 503, statusText: "Offline" });
  })());
});
