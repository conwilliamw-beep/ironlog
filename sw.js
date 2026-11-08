/* Ironlog service worker — network-first so updates land, cache fallback so the gym works offline. */
const CACHE = "ironlog-shell-v45";
const META = "ironlog-meta"; // holds the rest label the page saves for push alerts
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== META).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

/* Rest-over alert. The push carries no data; the label comes from the page's last save. */
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let label = "";
    try {
      const c = await caches.open(META);
      const r = await c.match(self.registration.scope + "__rest-label");
      if (r) label = (await r.json()).label || "";
    } catch (err) {}
    const test = label === "test";
    return self.registration.showNotification(test ? "Ironlog alerts are working" : "Rest over", {
      body: test ? "You'll get this when a rest timer ends." : (label ? "Next set · " + label : "Time for your next set"),
      tag: "ironlog-rest",
      renotify: true,
      icon: "icon-192.png",
    });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow("./");
  })());
});
