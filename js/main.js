// Start-up and screen routing (#connect, #live, #codes, #vehicle, #console, #about).
import { app } from './app.js';
import { renderConnect } from './ui/connect.js';
import { renderVehicle } from './ui/vehicle.js';
import { renderDiagnostics } from './ui/diagnostics.js';
import { renderDashboard, updateDashboard } from './ui/dashboard.js';
import { mountConsole } from './ui/log.js';

const SCREENS = ['connect', 'live', 'codes', 'vehicle', 'console', 'about'];
const $ = (id) => document.getElementById(id);

function route() {
  const name = SCREENS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'connect';
  for (const s of SCREENS) {
    $(`screen-${s}`).hidden = s !== name;
    document.querySelector(`nav a[href="#${s}"]`)?.setAttribute('aria-current', s === name ? 'page' : 'false');
  }
  // Live polling only runs while the Live screen is open.
  if (name === 'live') app.startLive();
  else app.stopLive();
  render();
}

const STATUS_TEXT = { idle: 'Not connected', connecting: 'Connecting', connected: 'Adapter connected', ready: 'Car connected', disconnected: 'Disconnected' };

function render() {
  const pill = $('status');
  pill.textContent = app.busy ? 'Working…' : app.demo && app.connected ? 'Demo car' : STATUS_TEXT[app.status] ?? app.status;
  pill.dataset.state = app.busy ? 'busy' : app.status;
  if (!$('screen-connect').hidden) renderConnect($('screen-connect'), app);
  if (!$('screen-vehicle').hidden) renderVehicle($('screen-vehicle'), app);
  if (!$('screen-codes').hidden) renderDiagnostics($('screen-codes'), app);
  if (!$('screen-live').hidden) {
    // Connected (or discovery finished) while already on the Live screen.
    if (!app.live && app.canGoLive) app.startLive();
    renderDashboard($('screen-live'), app);
  } else {
    document.body.classList.remove('driving');
  }
}

for (const el of document.querySelectorAll('[data-version]')) el.textContent = `v${app.version}`;
if (app.preview) {
  const badge = document.createElement('span');
  badge.className = 'preview-badge';
  badge.textContent = `preview: ${app.preview}`;
  document.querySelector('.top h1')?.append(' ', badge);
}
for (const el of document.querySelectorAll('[data-name]')) el.textContent = app.name;
document.title = app.name;
mountConsole($('screen-console'), app);
app.on(render);
app.onLive(() => updateDashboard($('screen-live'), app));
// Values can stop arriving (engine computer quiet), so refresh staleness/engine state too.
setInterval(() => app.live && updateDashboard($('screen-live'), app), 1000);
window.addEventListener('hashchange', route);
route();
app.logger.info(`${app.name} v${app.version} started. ${app.bleAvailable ? 'Web Bluetooth available.' : 'No Web Bluetooth in this browser.'}`);

// Offline support: a service worker keeps a saved copy so KapOBD opens
// without a phone signal. Some in-app iPhone browsers don't allow service
// workers; the app then simply works online as before.
const OFFLINE_TEXT = {
  checking: 'Checking whether KapOBD can be saved for offline use…',
  ready: 'Ready: KapOBD is saved on this device and opens without a signal.',
  unavailable: 'Not available in this browser. KapOBD still works whenever you have a signal.',
};
function showOffline() {
  for (const el of document.querySelectorAll('[data-offline]')) el.textContent = OFFLINE_TEXT[app.offline] ?? '';
}
if (typeof navigator !== 'undefined' && navigator.serviceWorker && window.isSecureContext) {
  navigator.serviceWorker
    .register(`sw.js?v=${app.version}`)
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      app.logger.info('Offline copy ready (service worker active)');
      app.set({ offline: 'ready' });
    })
    .catch((err) => {
      app.logger.warn(`Offline copy not available: ${err?.message ?? err}`);
      app.set({ offline: 'unavailable' });
    });
} else {
  app.offline = 'unavailable';
}
window.addEventListener('online', () => app.set({ online: true }));
window.addEventListener('offline', () => app.set({ online: false }));
app.on(showOffline);
showOffline();

// Debug handle for desktop testing.
window.obdApp = app;
