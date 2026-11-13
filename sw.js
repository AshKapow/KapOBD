// Service worker: lets KapOBD open without a phone signal.
// Strategy: network first (so updates arrive straight away), falling back to
// the saved copy when offline or when the network takes longer than 3 s.
// Registered as sw.js?v=<version>, so each new version installs fresh and
// replaces the old saved copy.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `kapobd-${VERSION}`;
const NETWORK_TIMEOUT_MS = 3000;

// Every app file, saved on install so the first visit is enough to work
// offline. tests/offline.test.js checks this list matches the repository.
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'data/dtc-codes.json',
  'data/wmi.js',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'js/app.js',
  'js/battery.js',
  'js/diagnostics.js',
  'js/elm327.js',
  'js/history.js',
  'js/logger.js',
  'js/main.js',
  'js/maintenance.js',
  'js/obd/dtc.js',
  'js/obd/mode06.js',
  'js/obd/modes.js',
  'js/obd/pids.js',
  'js/obd/readiness-guide.js',
  'js/obd/vehicleinfo.js',
  'js/obd/vin.js',
  'js/poller.js',
  'js/report.js',
  'js/storage.js',
  'js/transport/ble.js',
  'js/transport/mock.js',
  'js/ui/chart.js',
  'js/ui/connect.js',
  'js/ui/dashboard.js',
  'js/ui/diagnostics.js',
  'js/ui/dom.js',
  'js/ui/log.js',
  'js/ui/vehicle.js',
  'js/vehicle.js',
  'js/version.js',
];

// Save each file on its own (not cache.addAll, which is all-or-nothing): one
// file failing to save must not throw away the whole offline copy. Anything
// missed is saved later by the network-first handler.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = [...new Set(FILES.map((f) => new URL(f, self.registration.scope).href))];
      await Promise.all(
        urls.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* saved later when it's next fetched online */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kapobd-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Only this copy of the app's own files: not other sites, and not branch previews below it. */
function ours(request) {
  if (request.method !== 'GET') return false;
  const scope = self.registration.scope;
  if (!request.url.startsWith(scope)) return false;
  const rest = request.url.slice(scope.length);
  return !rest.startsWith('preview/');
}

self.addEventListener('fetch', (event) => {
  if (!ours(event.request)) return;
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate';
  const fromCache = () => cache.match(request, { ignoreSearch: isPage }).then((r) => r ?? (isPage ? cache.match('./') : undefined));

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (response.ok && response.type === 'basic') cache.put(isPage ? './' : request, response.clone());
    return response;
  } catch {
    const cached = await fromCache();
    if (cached) return cached;
    return new Response('KapOBD is offline and this file isn’t saved yet. Open KapOBD once with a connection first.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
