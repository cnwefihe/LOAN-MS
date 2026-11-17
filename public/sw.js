/*
 * Service worker for the installed app.
 * Only public files are stored: the page design, logos and the offline page. Pages and data are
 * never stored, because they hold personal and salary details and must stay on the server.
 */
const CACHE = "pau-loans-v2";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/pwa/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages load straight from the server. The offline page is shown only when the device has no connection,
  // never for a page that is slow or for sign-in and sign-out, which go to Microsoft.
  if (request.mode === "navigate") {
    if (self.navigator.onLine === false && !url.pathname.startsWith("/api/")) event.respondWith(caches.match(OFFLINE));
    return;
  }

  // File names under /_next/static change with each release, so a stored copy is always right.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pwa/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      })),
    );
  }
});
