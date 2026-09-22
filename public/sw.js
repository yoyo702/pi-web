/* TianForge only needs a service worker to make the HTTPS app installable.
 * Requests intentionally stay network-first: caching Next.js development
 * assets here would make HMR and upgrades unreliable. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
