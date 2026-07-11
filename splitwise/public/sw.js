// Minimal service worker - just enough for "Add to Home Screen" to offer a
// real app install (Android/Chrome requires one). This app is a live
// dashboard over a local API, not an offline-first tool, so the strategy
// is network-first everywhere: always prefer live data, and only fall back
// to the cached app shell if there's no connection at all.
const CACHE_NAME = "splitwise-shell-v1";
const SHELL_ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((res) => res || caches.match("/index.html")))
  );
});
