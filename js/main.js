// Start-up and screen routing (#connect, #vehicle, #console, #about).
import { app } from './app.js';
import { renderConnect } from './ui/connect.js';
import { renderVehicle } from './ui/vehicle.js';
import { renderDiagnostics } from './ui/diagnostics.js';
import { mountConsole } from './ui/log.js';

const SCREENS = ['connect', 'vehicle', 'codes', 'console', 'about'];
const $ = (id) => document.getElementById(id);

function route() {
  const name = SCREENS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'connect';
  for (const s of SCREENS) {
    $(`screen-${s}`).hidden = s !== name;
    document.querySelector(`nav a[href="#${s}"]`)?.setAttribute('aria-current', s === name ? 'page' : 'false');
  }
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
window.addEventListener('hashchange', route);
route();
app.logger.info(`${app.name} v${app.version} started. ${app.bleAvailable ? 'Web Bluetooth available.' : 'No Web Bluetooth in this browser.'}`);

// Debug handle for desktop testing.
window.obdApp = app;
