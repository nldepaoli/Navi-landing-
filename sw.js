// Deliberately does nothing but exist. The chat requires a live network
// connection to function at all (every message hits the backend), so
// there's no meaningful offline experience to build toward, and any
// caching here would risk serving a stale bundle.js after a future
// deploy. Its only job is to satisfy PWA installability criteria —
// letting the site be added to a home screen and launch full-screen.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally not calling event.respondWith — every request just
  // falls through to the network exactly as if this file didn't exist.
});
