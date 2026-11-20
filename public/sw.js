/*
 * Service worker for the installed app.
 * Only public files are stored: the page design, logos and the offline page. Pages and data are
 * never stored, because they hold personal and salary details and must stay on the server.
 */
const CACHE = "pau-loans-v3";
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

  // Pages load straight from the server. The offline page is shown only when the page really cannot be
  // reached. The browser's own "online" flag is not used: on some computers it says offline while the
  // network works, which wrongly stopped people signing in. Sign-in and sign-out (/api/) are left alone.
  if (request.mode === "navigate") {
    if (url.pathname.startsWith("/api/")) return;
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE).then((page) => page || Response.error())));
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
