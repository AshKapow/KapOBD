// Live screen: value tiles with 60-second trend lines, a full-screen graph per
// value, the driving view, and the tile picker. renderDashboard() builds the
// structure; updateDashboard() refreshes values and graphs in place.
import { h, replace, messageBox } from './dom.js';
import { PIDS, toDisplay } from '../obd/pids.js';
import { isLivePid } from '../poller.js';
import { MAX_TILES } from '../app.js';
import { drawSparkline, drawLineChart } from './chart.js';
import { ecuLabel } from '../vehicle.js';

const STALE_MS = 5000;
let crosshairX = null; // detail graph pointer position (CSS px), or null
let wakeLock = null;

// --- value formatting -------------------------------------------------------------

/** Decimals for a value already in display units: whole degrees, whole % from 10 up. */
function digitsFor(pid, v, unit) {
  const def = PIDS[pid];
  return def?.digits ?? (def?.kind === 'temp' || Math.abs(v) >= 100 || (unit === '%' && Math.abs(v) >= 10) ? 0 : 1);
}

function parts(pid, value, units) {
  if (value == null) return { num: '—', unit: PIDS[pid]?.unit ?? '' };
  const d = toDisplay(pid, value, units);
  return { num: d.value.toFixed(digitsFor(pid, d.value, d.unit)), unit: d.unit };
}

const toDisplaySeries = (pid, pts, units) => pts.map((p) => ({ t: p.t, v: toDisplay(pid, p.v, units).value }));

function hybridDetail(detail) {
  if (!detail || detail.current == null) return null;
  const dir = detail.current > 0.5 ? 'discharging' : detail.current < -0.5 ? 'charging' : 'idle';
  const kw = detail.powerKw == null ? '' : ` · ${Math.abs(detail.powerKw).toFixed(1)} kW`;
  return `${Math.abs(detail.current).toFixed(1)} A ${dir}${kw}`;
}

const ENGINE_TEXT = { running: 'Engine running', off: 'Engine off', electric: 'Electric drive (engine off)', unknown: '' };

// --- render ----------------------------------------------------------------------

export function renderDashboard(el, app) {
  const driving = app.driving && !!app.live;
  document.body.classList.toggle('driving', driving);
  if (!driving) releaseWakeLock();

  if (!app.connected) {
    replace(el, h('h2', {}, 'Live data'), messageBox(app), h('p', { class: 'hint' }, 'Connect to your adapter on the Connect screen (or try the demo there), then come back here.'));
    return;
  }
  if (!app.profile) {
    replace(
      el,
      h('h2', {}, 'Live data'),
      messageBox(app),
      h('p', { class: 'hint' }, 'KapOBD needs to ask the car what it supports first.'),
      h('button', { class: 'btn primary', disabled: !!app.busy || app.status !== 'ready', onclick: () => app.runDiscover() }, 'Discover vehicle'),
    );
    return;
  }

  if (driving) replace(el, drivingView(app));
  else if (app.editingTiles) replace(el, tilePicker(app));
  else if (app.liveDetail != null) replace(el, detailView(app));
  else replace(el, overview(app));
  updateDashboard(el, app);
}

function engineBadge() {
  return h('span', { class: 'engine', 'data-engine': '' });
}

function overview(app) {
  const tiles = app.tiles();
  const showsUnverified = tiles.some((p) => PIDS[p]?.unverified);
  return [
    h('div', { class: 'live-head' }, h('h2', {}, 'Live data'), engineBadge()),
    messageBox(app),
    simCard(app),
    !app.live && !app.busy ? h('button', { class: 'btn primary', onclick: () => app.startLive() }, 'Start live data') : null,
    tiles.length
      ? h('div', { class: 'tiles' }, tiles.map((pid) => tile(app, pid)))
      : h('p', { class: 'hint' }, 'No live values chosen. Tap “Choose values”.'),
    h(
      'div',
      { class: 'actions wrap' },
      h('button', { class: 'btn', disabled: !app.live, onclick: () => enterDriving(app) }, 'Driving view'),
      h('button', { class: 'btn', onclick: () => app.set({ editingTiles: true }) }, 'Choose values'),
    ),
    h('p', { class: 'hint', 'data-rate': '' }),
    showsUnverified ? h('p', { class: 'hint' }, 'The hybrid battery voltage uses a formula that hasn’t been confirmed on a real car yet. Treat it as approximate.') : null,
    h('p', { class: 'hint' }, `Tap a value for a bigger graph.${app.settings.autoDriving ? ' Once the car is moving, this screen switches to the driving view by itself.' : ''} On hybrids, engine values often stop while the engine is off; that’s normal.`),
  ];
}

function tile(app, pid) {
  return h(
    'button',
    { class: 'tile', type: 'button', 'data-pid': String(pid), onclick: () => app.set({ liveDetail: pid }) },
    h('span', { class: 'tile-name' }, PIDS[pid].name),
    h('span', { class: 'tile-value' }, h('span', { class: 'num' }, '—'), ' ', h('span', { class: 'unit' })),
    h('span', { class: 'tile-sub' }),
    h('canvas', { class: 'spark', 'aria-hidden': 'true' }),
  );
}

function simCard(app) {
  const parked = app.simParked;
  if (parked == null) return null;
  return h(
    'div',
    { class: 'card sim' },
    h('span', {}, parked ? 'The simulated car is parked with the engine off.' : 'The simulated car is driving.'),
    h('button', { class: 'btn small', onclick: () => app.setSimParked(!parked) }, parked ? 'Start a demo drive' : 'Park the car'),
  );
}

function detailView(app) {
  const pid = app.liveDetail;
  const def = PIDS[pid];
  const canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': `${def.name} over the last ${app.liveSeconds === 60 ? 'minute' : '5 minutes'}` });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, canvas, tip);
  const move = (e) => {
    const r = canvas.getBoundingClientRect();
    crosshairX = e.clientX - r.left;
    updateDashboard(document.getElementById('screen-live'), app);
  };
  canvas.addEventListener('pointerdown', move);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', () => {
    crosshairX = null;
    updateDashboard(document.getElementById('screen-live'), app);
  });
  return [
    h('div', { class: 'live-head' }, h('button', { class: 'btn small secondary', onclick: () => { crosshairX = null; app.set({ liveDetail: null }); } }, '‹ All values'), engineBadge()),
    h('h2', {}, def.name),
    h('div', { class: 'detail-value', 'data-detail-value': '' }),
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
      [60, 300].map((s) => h('button', { class: 'btn small' + (app.liveSeconds === s ? ' selected' : ''), 'aria-pressed': String(app.liveSeconds === s), onclick: () => app.set({ liveSeconds: s }) }, s === 60 ? '1 min' : '5 min')),
    ),
    wrap,
    h('dl', { class: 'kv stats', 'data-stats': '' }),
    h('details', { class: 'card' }, h('summary', {}, 'Recent values'), h('table', { class: 'table recent' }, h('tbody', { 'data-recent': '' }))),
    def.unverified ? h('p', { class: 'hint' }, 'This value uses a formula that hasn’t been confirmed on a real car yet.') : null,
  ];
}

function drivingView(app) {
  const tiles = app.tiles().slice(0, 4);
  requestWakeLock();
  return [
    h('div', { class: 'drive-grid' }, tiles.map((pid) => h('div', { class: 'drive-tile', 'data-pid': String(pid) }, h('span', { class: 'tile-name' }, PIDS[pid].name), h('span', { class: 'drive-value' }, h('span', { class: 'num' }, '—'), h('span', { class: 'unit' }))))),
    h('div', { class: 'drive-engine' }, engineBadge()),
    h('button', { class: 'btn big secondary drive-exit', onclick: () => app.setDriving(false) }, 'Exit driving view'),
  ];
}

function tilePicker(app) {
  const p = app.profile;
  const chosen = app.tiles();
  const options = p.supported01.filter(isLivePid).sort((a, b) => (PIDS[a].group === 'main' ? 0 : 1) - (PIDS[b].group === 'main' ? 0 : 1) || a - b);
  const toggle = (pid, on) => app.setTiles(on ? [...chosen, pid] : chosen.filter((x) => x !== pid));
  const u = app.settings.units;
  const unitSelect = (label, key, opts) =>
    h('label', { class: 'row' }, label + ' ', h('select', { onchange: (e) => app.updateSettings({ units: { [key]: e.target.value } }) }, opts.map(([v, t]) => h('option', { value: v, selected: u[key] === v }, t))));
  return [
    h('h2', {}, 'Choose values'),
    h('p', { class: 'hint' }, `Pick up to ${MAX_TILES}. They’re saved for this vehicle; the first four appear in the driving view. Only values this car supports are listed.`),
    h(
      'ul',
      { class: 'picker' },
      options.map((pid) => {
        const on = chosen.includes(pid);
        return h(
          'li',
          {},
          h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: on, disabled: !on && chosen.length >= MAX_TILES, onchange: (e) => toggle(pid, e.target.checked) }),
            h('span', {}, PIDS[pid].name, on ? h('small', { class: 'muted' }, ` · #${chosen.indexOf(pid) + 1}`) : null),
          ),
        );
      }),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Driving view'),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: app.settings.autoDriving, onchange: (e) => app.updateSettings({ autoDriving: e.target.checked }) }),
        'Switch to the driving view automatically once the car is moving (above 5 mph)',
      ),
    ),
    h('div', { class: 'card' }, h('h3', {}, 'Units'), unitSelect('Speed', 'speed', [['mph', 'mph'], ['kmh', 'km/h']]), unitSelect('Temperature', 'temp', [['C', '°C'], ['F', '°F']]), unitSelect('Distance', 'distance', [['mi', 'miles'], ['km', 'km']])),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => app.set({ editingTiles: false }) }, 'Done'), h('button', { class: 'btn secondary', onclick: () => app.resetTiles() }, 'Reset to defaults')),
  ];
}

// --- live updates ---------------------------------------------------------------

export function updateDashboard(el, app) {
  if (!el || el.hidden) return;
  const live = app.live;
  const units = app.settings.units;
  const now = Date.now();

  for (const badge of el.querySelectorAll('[data-engine]')) {
    const state = live ? live.engineState(now) : 'unknown';
    badge.textContent = ENGINE_TEXT[state] ?? '';
    badge.dataset.state = state;
    badge.hidden = !badge.textContent;
  }

  const rate = el.querySelector('[data-rate]');
  if (rate) {
    if (!live) rate.textContent = app.busy ? '' : 'Live data is paused.';
    else {
      const pts = live.pids.length;
      rate.textContent = `About ${live.rate(now).toFixed(1)} readings a second across ${pts} value${pts === 1 ? '' : 's'}.`;
    }
  }

  for (const node of el.querySelectorAll('[data-pid]')) {
    const pid = Number(node.dataset.pid);
    const latest = live?.latest.get(pid);
    const fresh = latest && now - latest.t <= STALE_MS;
    const { num, unit } = parts(pid, fresh ? latest.value : null, units);
    node.querySelector('.num').textContent = num;
    node.querySelector('.unit').textContent = unit;
    node.classList.toggle('stale', !fresh);
    const sub = node.querySelector('.tile-sub');
    if (sub) sub.textContent = !live ? '' : !latest ? 'Waiting…' : !fresh ? 'No recent reply' : (pid === 0x9a && hybridDetail(latest.detail)) || '';
    const spark = node.querySelector('canvas.spark');
    if (spark && live) drawSparkline(spark, toDisplaySeries(pid, live.series(pid, 60, now), units), { seconds: 60, now });
  }

  // Detail view.
  const canvas = el.querySelector('canvas.chart');
  if (canvas && app.liveDetail != null) {
    const pid = app.liveDetail;
    const seconds = app.liveSeconds;
    const pts = live ? toDisplaySeries(pid, live.series(pid, seconds, now), units) : [];
    const { pick } = drawLineChart(canvas, pts, { seconds, now, crosshair: crosshairX });
    const latest = live?.latest.get(pid);
    const fresh = latest && now - latest.t <= STALE_MS;
    const p = parts(pid, fresh ? latest.value : null, units);
    const big = el.querySelector('[data-detail-value]');
    replace(big, h('span', { class: 'num' }, p.num), ' ', h('span', { class: 'unit' }, p.unit), pid === 0x9a && fresh && hybridDetail(latest.detail) ? h('div', { class: 'hint' }, hybridDetail(latest.detail)) : null);

    const tip = el.querySelector('.chart-tip');
    const hit = crosshairX != null ? pick(crosshairX) : null;
    if (hit) {
      const ago = Math.max(0, Math.round((now - hit.point.t) / 1000));
      tip.replaceChildren(h('strong', {}, `${hit.point.v.toFixed(digitsFor(pid, hit.point.v, p.unit))} ${p.unit}`), h('span', {}, ago ? `${ago} s ago` : 'now'));
      tip.hidden = false;
      tip.style.left = `${Math.min(canvas.clientWidth - 110, Math.max(0, hit.x - 55))}px`;
    } else tip.hidden = true;

    const s = live?.summary(pid, seconds, now);
    const conv = (v) => parts(pid, v, units);
    const stats = el.querySelector('[data-stats]');
    replace(
      stats,
      ...(s
        ? [['Lowest', conv(s.min)], ['Highest', conv(s.max)], ['Average', conv(s.avg)]].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, `${v.num} ${v.unit}`)])
        : [h('dt', {}, 'No values yet'), h('dd', {}, '')]),
      latest?.ecu ? h('dt', {}, 'From') : null,
      latest?.ecu ? h('dd', {}, ecuLabel(latest.ecu)) : null,
    );
    const recent = el.querySelector('[data-recent]');
    const rows = (live?.series(pid, seconds, now) ?? []).slice(-10).reverse();
    recent.replaceChildren(...rows.map((r) => h('tr', {}, h('td', {}, new Date(r.t).toLocaleTimeString()), h('td', {}, `${conv(r.v).num} ${conv(r.v).unit}`))));
  }
}

// --- driving view helpers -------------------------------------------------------------

function enterDriving(app) {
  app.setDriving(true);
  globalThis.scrollTo?.(0, 0);
}

async function requestWakeLock() {
  try {
    if (!wakeLock && navigator.wakeLock?.request) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* not supported (e.g. older iOS browsers): the user keeps the screen on themselves */
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

