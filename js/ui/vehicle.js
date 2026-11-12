import { h, replace, messageBox, confirmButton } from './dom.js';
import { PIDS, hex2, formatValue, FUEL_TYPES } from '../obd/pids.js';
import { ecuLabel } from '../vehicle.js';

const pidName = (p) => PIDS[p]?.name ?? 'Unknown PID';

export function renderVehicle(el, app) {
  const p = app.profile;
  const disabled = !!app.busy || !app.connected;
  replace(
    el,
    h('h2', {}, 'Vehicle'),
    messageBox(app),
    p ? profileView(p, app, disabled) : h('p', { class: 'hint' }, app.connected ? 'Connected. Tap “Discover vehicle” on the Connect screen.' : 'Connect first. The car is asked what it supports; nothing is assumed.'),
    savedProfiles(app),
  );
}

function profileView(p, app, disabled) {
  const fuel = typeof p.fuelType === 'string' ? p.fuelType : p.fuelType != null ? FUEL_TYPES[p.fuelType] : null;
  return [
    p.nickname ? h('h3', {}, p.nickname) : null,
    h(
      'dl',
      { class: 'card kv' },
      [
        ['VIN', p.vin ?? 'not reported'],
        ['Protocol', p.protocolName ?? p.protocol ?? '?'],
        ['Fuel type', fuel ?? 'not reported'],
        ['ECUs', Object.keys(p.ecus).length],
        ['Last seen', new Date(p.lastSeen).toLocaleString()],
      ].map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]),
    ),
    Object.entries(p.monitor ?? {}).map(([ecu, m]) => monitorCard(ecu, m)),
    Object.entries(p.ecus).map(([ecu, e]) =>
      h(
        'details',
        { class: 'card' },
        h('summary', {}, `${ecuLabel(ecu)} — ${e.supported01.length} mode 01 PIDs`),
        h('ul', { class: 'pids' }, e.supported01.map((pid) => h('li', { class: PIDS[pid] ? '' : 'unknown' }, h('code', {}, hex2(pid)), ' ', pidName(pid)))),
        e.supported09.length ? h('p', { class: 'hint' }, `Mode 09: ${e.supported09.map(hex2).join(' ')}`) : null,
      ),
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn', disabled, onclick: () => app.runSnapshot() }, 'Read every value once')),
    app.snapshot ? snapshotTable(app.snapshot) : null,
  ];
}

function monitorCard(ecu, m) {
  if (!m || typeof m !== 'object') return null;
  const supported = m.monitors.filter((x) => x.status !== 'not supported');
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, `${ecuLabel(ecu)}: warning light ${m.mil ? 'ON' : 'off'}, ${m.dtcCount} stored code(s)`),
    supported.length
      ? h('ul', { class: 'monitors' }, supported.map((x) => h('li', { class: x.status === 'ready' ? 'ready' : 'notready' }, `${x.name}: ${x.status}`)))
      : h('p', { class: 'hint' }, 'No readiness monitors reported by this ECU.'),
  );
}

function snapshotTable(rows) {
  return h(
    'table',
    { class: 'card table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'PID'), h('th', {}, 'Name'), h('th', {}, 'ECU'), h('th', {}, 'Value'))),
    h(
      'tbody',
      {},
      rows.map((r) =>
        h(
          'tr',
          {},
          h('td', {}, h('code', {}, hex2(r.pid))),
          h('td', {}, r.name ?? pidName(r.pid)),
          h('td', {}, r.ecu ?? '—'),
          h('td', {}, r.error ? h('span', { class: 'muted' }, r.error) : r.known === false ? h('code', {}, r.raw.map(hex2).join(' ')) : formatValue(r.pid, r.value)),
        ),
      ),
    ),
  );
}

function savedProfiles(app) {
  const list = Object.values(app.profiles ?? {}).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  if (!list.length) return null;
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Saved vehicles'),
    h('p', { class: 'hint' }, 'Give friends’ cars a name so you can tell them apart later.'),
    h(
      'ul',
      { class: 'saved' },
      list.map((p) =>
        h(
          'li',
          {},
          app.renaming === p.key
            ? renameForm(app, p)
            : h(
                'span',
                {},
                h('strong', {}, p.nickname ?? p.vin ?? p.key),
                h('small', {}, `${p.nickname ? ` ${p.vin ?? ''}` : ''} · ${p.supported01.length} PIDs · ${Object.keys(p.ecus).length} ECU(s) · ${new Date(p.lastSeen).toLocaleDateString()}`),
              ),
          app.renaming === p.key
            ? null
            : h(
                'span',
                { class: 'row' },
                h('button', { class: 'btn small', onclick: () => app.set({ profile: p, snapshot: null }) }, 'View'),
                h('button', { class: 'btn small', onclick: () => app.set({ renaming: p.key }) }, 'Rename'),
                confirmButton('Forget', () => app.removeProfile(p.key), { class: 'btn small secondary', armedLabel: 'Tap again to forget' }),
              ),
        ),
      ),
    ),
  );
}

function renameForm(app, p) {
  const input = h('input', { type: 'text', value: p.nickname ?? '', placeholder: 'e.g. Dave’s Golf', maxlength: '40', autocomplete: 'off' });
  queueMicrotask(() => input.focus());
  return h(
    'form',
    { class: 'cmd', onsubmit: (e) => { e.preventDefault(); app.renameProfile(p.key, input.value); } },
    input,
    h('button', { class: 'btn small primary', type: 'submit' }, 'Save'),
    h('button', { class: 'btn small secondary', type: 'button', onclick: () => app.set({ renaming: null }) }, 'Cancel'),
  );
}
