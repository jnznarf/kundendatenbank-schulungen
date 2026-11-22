// Service Worker: hält die App-Dateien auf dem Gerät vor, damit die App schnell
// startet und auch ohne Netz geöffnet werden kann. Daten aus Supabase werden hier
// NICHT zwischengespeichert (das macht die App selbst als Lesekopie).
const VERSION = "v1";
const CACHE = "kundendatenbank-" + VERSION;
const SHELL = [
  "./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./vendor/supabase.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst (damit Updates sofort ankommen), bei fehlendem Netz aus dem Speicher.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});
