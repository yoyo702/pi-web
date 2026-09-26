/* TianForge's service worker makes the HTTPS app installable and shows
 * activity notifications sent with Web Push (server/web-push.cjs).
 * Requests intentionally stay network-first: caching Next.js development
 * assets here would make HMR and upgrades unreliable. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// Payload: { id, title, body, tag }. A newer message with the same tag (the
// same chat, session or terminal) replaces the one still on screen.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* show the fallback */ }
  event.waitUntil(self.registration.showNotification(data.title || "TianForge pi", {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { id: data.id || null },
  }));
});

// Opens the entry in an open TianForge window (AppShell listens for the
// message), or in a new one through `/?notification=<id>`. The focused or a
// visible window is preferred; one showing another page (login) loads the
// app instead. A window still loading misses the message, so it is kept until
// the window says it received it, or sent again when the window reports ready.
let pendingOpen = null;
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  const target = id ? `/?notification=${encodeURIComponent(id)}` : "/";
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .filter((candidate) => new URL(candidate.url).origin === self.location.origin);
    const client = windows.find((candidate) => candidate.focused) ?? windows.find((candidate) => candidate.visibilityState === "visible") ?? windows[0];
    if (!client) { await self.clients.openWindow(target); return; }
    await client.focus().catch(() => undefined);
    if (!id) return;
    if (new URL(client.url).pathname !== "/") {
      // navigate() only works for windows this worker controls.
      const navigated = await client.navigate(target).catch(() => null);
      if (!navigated) await self.clients.openWindow(target);
      return;
    }
    pendingOpen = { clientId: client.id, id, at: Date.now() };
    client.postMessage({ type: "pi-web:open-notification", id });
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (!pendingOpen || event.source?.id !== pendingOpen.clientId) return;
  if (data.type === "pi-web:notification-received" && data.id === pendingOpen.id) pendingOpen = null;
  if (data.type === "pi-web:ready") {
    if (Date.now() - pendingOpen.at < 30_000) event.source.postMessage({ type: "pi-web:open-notification", id: pendingOpen.id });
    pendingOpen = null;
  }
});
