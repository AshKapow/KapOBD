// Vehicle screen: details (VIN, computers), health report, battery test,
// maintenance log, every-value snapshot and saved vehicles.
import { h, replace, messageBox, confirmButton, copyText } from './dom.js';
import { PIDS, hex2, formatValue, FUEL_TYPES } from '../obd/pids.js';
import { ecuLabel } from '../vehicle.js';
import { ENTRY_TYPES } from '../maintenance.js';

const pidName = (p) => PIDS[p]?.name ?? 'Unknown PID';
const LEVEL_TEXT = { good: 'Good', ok: 'OK', low: 'Low', weak: 'Needs attention', unknown: '—' };

// Form drafts survive re-renders (the screen redraws on every app change).
const draft = { entry: { open: false, date: '', type: 'Service', mileage: '', note: '' }, reportValues: true };

export function renderVehicle(el, app) {
  const p = app.profile;
  const disabled = !!app.busy || !app.connected;
  replace(
    el,
    h('h2', {}, 'Vehicle'),
    messageBox(app),
    p && app.report ? reportPanel(app) : null,
    p ? profileView(p, app, disabled) : h('p', { class: 'hint' }, app.connected ? 'Connected. Tap “Discover vehicle” on the Connect screen.' : 'Connect first. The car is asked what it supports; nothing is assumed.'),
    savedProfiles(app),
  );
}

function profileView(p, app, disabled) {
  return [
    detailsCard(p, app),
    h(
      'div',
      { class: 'actions wrap' },
      h('button', { class: 'btn primary', disabled, onclick: () => app.runReport({ includeValues: draft.reportValues }) }, 'Create health report'),
      h('button', { class: 'btn', disabled: disabled || !!app.batteryTest, onclick: () => app.startBatteryTest() }, 'Battery test'),
    ),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.reportValues, onchange: (e) => (draft.reportValues = e.target.checked) }), 'Include current values in the report'),
    app.batteryTest ? batteryView(app) : lastBatteryNote(app),
    maintenanceCard(app),
    computersCard(p, app, disabled),
    h('div', { class: 'actions' }, h('button', { class: 'btn', disabled, onclick: () => app.runSnapshot() }, 'Read every value once')),
    app.snapshot ? snapshotTable(app.snapshot, app) : null,
  ];
}

// --- details --------------------------------------------------------------------

function detailsCard(p, app) {
  const fuel = typeof p.fuelType === 'string' ? p.fuelType : p.fuelType != null ? FUEL_TYPES[p.fuelType] : null;
  const simulated = app.transport?.kind === 'mock';
  const vin = app.decodedVin;
  const rows = [
    ['VIN', p.vin ?? 'not reported'],
    ['Make', simulated ? 'Simulated car' : vin?.valid ? vin.manufacturer ?? 'Not in KapOBD’s list' : null],
    ['Built in', !simulated && vin?.valid ? vin.region : null],
    ['Model year', !simulated ? vin?.modelYear : null],
    ['Fuel type', fuel ?? 'not reported'],
    ['Protocol', p.protocolName ?? p.protocol ?? '?'],
    ['Computers', Object.keys(p.ecus).length],
    ['Last seen', new Date(p.lastSeen).toLocaleString('en-GB')],
  ].filter(([, v]) => v != null && v !== '');
  const due = app._savesData ? app.dueHere.filter((d) => d.state !== 'ok') : [];
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, p.nickname ?? 'This vehicle'),
    due.length ? due.map((d) => h('div', { class: `msg ${d.state === 'overdue' ? 'error' : 'warn'}` }, d.text)) : null,
    h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
  );
}

function computersCard(p, app, disabled) {
  const info = app.vehicleInfo ?? {};
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, `Computers (${Object.keys(p.ecus).length})`),
    Object.entries(p.ecus).map(([id, e]) => {
      const i = info[id];
      const mon = p.monitor?.[id];
      return h(
        'details',
        { class: 'ecu' },
        h('summary', {}, ecuLabel(id)),
        h(
          'dl',
          { class: 'kv' },
          i?.calIds?.length ? [h('dt', {}, 'Calibration'), h('dd', {}, i.calIds.join(', '))] : null,
          i?.cvns?.length ? [h('dt', {}, 'Verification no.'), h('dd', {}, i.cvns.join(', '))] : null,
          mon ? [h('dt', {}, 'Warning light'), h('dd', {}, `${mon.mil ? 'ON' : 'off'}, ${mon.dtcCount} stored code(s)`)] : null,
          [h('dt', {}, 'Live values'), h('dd', {}, `${e.supported01.length} supported`)],
        ),
        i?.performance?.monitors?.length
          ? h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, h('th', {}, 'Self-check'), h('th', {}, 'Completed'), h('th', {}, 'Chances'))),
              h('tbody', {}, i.performance.monitors.map((m) => h('tr', {}, h('td', {}, m.name), h('td', {}, String(m.completed)), h('td', {}, String(m.conditions))))),
            )
          : null,
        i?.performance ? h('p', { class: 'hint' }, `How often each self-check has completed, out of the drives where it could run (${i.performance.ignitionCycles} ignition cycles in total).`) : null,
        h('details', {}, h('summary', {}, 'Supported values'), h('ul', { class: 'pids' }, e.supported01.map((pid) => h('li', { class: PIDS[pid] ? '' : 'unknown' }, h('code', {}, hex2(pid)), ' ', pidName(pid))))),
      );
    }),
    !app.vehicleInfo ? h('button', { class: 'btn small', disabled, onclick: () => app.runVehicleInfo() }, 'Read computer details') : null,
  );
}

// --- health report ---------------------------------------------------------------

function reportPanel(app) {
  const r = app.report;
  const frame = h('iframe', { class: 'report-frame', title: r.title });
  frame.srcdoc = r.html;
  const file = () => new File([r.html], `${r.title.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').toLowerCase()}.html`, { type: 'text/html' });
  const status = h('span', { class: 'hint' });
  const flash = (t) => {
    status.textContent = t;
    setTimeout(() => (status.textContent = ''), 4000);
  };
  const share = async () => {
    try {
      const f = file();
      if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: r.title });
      else if (navigator.share) await navigator.share({ title: r.title, text: r.text });
      else flash('Sharing isn’t available here: use Download or Copy text.');
    } catch {
      /* cancelled */
    }
  };
  const download = () => {
    const a = h('a', { href: URL.createObjectURL(file()), download: file().name });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  };
  return h(
    'section',
    { class: 'card report' },
    h('h3', {}, 'Health report'),
    frame,
    h(
      'div',
      { class: 'actions wrap' },
      typeof navigator !== 'undefined' && navigator.share ? h('button', { class: 'btn primary', onclick: share }, 'Share') : null,
      h('button', { class: 'btn', onclick: download }, 'Download'),
      h('button', { class: 'btn', onclick: async () => flash((await copyText(r.text)) ? 'Report copied as text.' : 'Copy failed.') }, 'Copy as text'),
      h('button', { class: 'btn', onclick: () => { try { frame.contentWindow.print(); } catch { flash('Printing isn’t available here: use Share or Download.'); } } }, 'Print'),
      h('button', { class: 'btn secondary', onclick: () => app.set({ report: null }) }, 'Close'),
    ),
    status,
    h('p', { class: 'hint' }, 'The report includes the VIN. Remove it before sharing publicly if you’d rather keep it private.'),
  );
}

// --- battery test ------------------------------------------------------------------

function batteryView(app) {
  const b = app.batteryTest;
  const disabled = !!app.busy;
  const cancel = h('button', { class: 'btn secondary', disabled, onclick: () => app.cancelBatteryTest() }, 'Cancel');
  const live = app.busy && b.live != null ? h('div', { class: 'battery-live' }, h('span', { class: 'num' }, b.live.toFixed(2)), h('span', { class: 'unit' }, ' V')) : null;
  const line = (label, v, rating) => (v == null ? null : h('p', {}, `${label}: `, h('strong', {}, `${v.toFixed(2)} V`), rating ? ` · ${rating.text}` : ''));
  let body;
  if (b.step === 'intro') {
    body = [
      h('p', {}, 'Checks the 12 V battery and the charging system using the voltage at the OBD port. Nothing is sent to the car’s computers.'),
      h('ol', {}, h('li', {}, 'Engine off, ignition on. For the most accurate result the car should have been parked for at least an hour.'), h('li', {}, 'KapOBD measures the resting voltage, then asks you to start the engine and watches the voltage dip while it cranks.'), h('li', {}, 'With the engine running, it checks the charging voltage.')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: b.skipCrank, onchange: (e) => app.updateBattery({ skipCrank: e.target.checked }) }), 'This car doesn’t use the 12 V battery to start the engine (most hybrids and electric cars)'),
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', disabled, onclick: () => app.runBatteryResting() }, 'Measure resting voltage')),
    ];
  } else if (b.step === 'crank-ready') {
    body = [
      line('Resting', b.resting, null),
      h('p', {}, 'Next, tap the button and then start the engine within 20 seconds. Leave it running afterwards.'),
      app.simParked != null ? h('p', { class: 'hint' }, 'Simulator: the engine starts by itself a moment after you tap.') : null,
      live,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', disabled, onclick: () => app.runBatteryCrank() }, 'Watch the engine start')),
    ];
  } else if (b.step === 'charge-ready') {
    body = [
      line('Resting', b.resting, null),
      !b.skipCrank && !b.crankSeen ? h('div', { class: 'msg warn' }, 'No engine start was seen in 20 seconds. If the engine is running now, measure the charging voltage; otherwise cancel and try again.') : null,
      h('p', {}, b.skipCrank ? 'Switch the car on fully (READY on a hybrid) and wait a few seconds, then measure the charging voltage.' : 'With the engine running, measure the charging voltage.'),
      live,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', disabled, onclick: () => app.runBatteryCharging() }, 'Measure charging')),
    ];
  } else if (b.step === 'result') {
    const r = b.result;
    body = [
      h('p', { class: `battery-overall ${r.overall}` }, `Overall: ${LEVEL_TEXT[r.overall]}`),
      line('Resting', r.resting, r.restingRating),
      r.skippedCrank ? h('p', {}, 'While starting: not tested.') : r.crankMin != null ? line('Lowest while starting', r.crankMin, r.crankRating) : h('p', {}, 'While starting: no start was seen.'),
      line('Charging', r.charging, r.chargingRating),
      h('p', { class: 'hint' }, 'Rules of thumb only: a garage load test is the definitive check. Readings are a little lower with the ignition on, and higher just after driving.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', disabled, onclick: () => app.startBatteryTest() }, 'Test again'), h('button', { class: 'btn secondary', onclick: () => app.cancelBatteryTest() }, 'Close')),
    ];
  }
  return h('section', { class: 'card flow' }, h('h3', {}, 'Battery and charging test'), live && b.step !== 'crank-ready' && b.step !== 'charge-ready' ? live : null, body);
}

function lastBatteryNote(app) {
  const r = app.lastBattery;
  if (!r) return null;
  return h('p', { class: 'hint' }, `Last battery test ${new Date(r.at).toLocaleDateString('en-GB')}: ${LEVEL_TEXT[r.overall]}.`);
}

// --- maintenance ---------------------------------------------------------------------

function maintenanceCard(app) {
  if (app.demo) return null;
  const m = app.maintenanceHere;
  if (!m) return null;
  const e = draft.entry;
  const dueInput = (label, key) =>
    h('label', { class: 'row' }, label + ' ', h('input', { type: 'date', value: m.due[key] ?? '', onchange: (ev) => app.setMaintenanceDue({ [key]: ev.target.value }) }));
  const form = e.open
    ? h(
        'form',
        {
          class: 'maint-form',
          onsubmit: (ev) => {
            ev.preventDefault();
            app.addMaintenance({ date: e.date, type: e.type, mileage: e.mileage, note: e.note });
            draft.entry = { open: false, date: '', type: 'Service', mileage: '', note: '' };
            app.set({});
          },
        },
        h('label', { class: 'row' }, 'Date ', h('input', { type: 'date', value: e.date || new Date().toISOString().slice(0, 10), oninput: (ev) => (e.date = ev.target.value) })),
        h('label', { class: 'row' }, 'Type ', h('select', { onchange: (ev) => (e.type = ev.target.value) }, ENTRY_TYPES.map((t) => h('option', { value: t, selected: e.type === t }, t)))),
        h('label', { class: 'row' }, 'Mileage ', h('input', { type: 'number', inputmode: 'numeric', min: '0', value: e.mileage, placeholder: 'optional', oninput: (ev) => (e.mileage = ev.target.value) })),
        h('label', { class: 'row' }, 'Notes ', h('input', { type: 'text', maxlength: '300', value: e.note, placeholder: 'optional', oninput: (ev) => (e.note = ev.target.value) })),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn secondary', type: 'button', onclick: () => { e.open = false; app.set({}); } }, 'Cancel')),
      )
    : h('button', { class: 'btn small', onclick: () => { e.open = true; e.date = new Date().toISOString().slice(0, 10); app.set({}); } }, 'Add an entry');
  return h(
    'details',
    { class: 'card', open: e.open },
    h('summary', {}, `Maintenance${m.entries.length ? ` (${m.entries.length})` : ''}`),
    h('div', { class: 'due' }, dueInput('Next MOT', 'mot'), dueInput('Next service', 'service')),
    app.dueHere.length ? h('p', { class: 'hint' }, app.dueHere.map((d) => d.text).join(' · ')) : h('p', { class: 'hint' }, 'Set due dates to get a reminder here when they’re within 30 days.'),
    m.entries.length
      ? h(
          'ul',
          { class: 'saved' },
          m.entries.map((x) =>
            h(
              'li',
              {},
              h('span', {}, h('strong', {}, `${x.type}`), h('small', {}, ` ${new Date(x.date).toLocaleDateString('en-GB')}${x.mileage != null ? ` · ${x.mileage.toLocaleString('en-GB')} miles` : ''}${x.note ? ` · ${x.note}` : ''}`)),
              confirmButton('Remove', () => app.removeMaintenance(x.id), { class: 'btn small secondary', armedLabel: 'Tap again to remove' }),
            ),
          ),
        )
      : null,
    form,
    h('p', { class: 'hint' }, 'Kept on this device only.'),
  );
}

// --- snapshot and saved vehicles ----------------------------------------------------------

function snapshotTable(rows, app) {
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
          h('td', {}, r.ecu ? ecuLabel(r.ecu) : '—'),
          h('td', {}, r.error ? h('span', { class: 'muted' }, r.error) : r.known === false ? h('code', {}, r.raw.map(hex2).join(' ')) : formatValue(r.pid, r.value, app.settings.units)),
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
                h('small', {}, `${p.nickname ? ` ${p.vin ?? ''}` : ''} · ${p.supported01.length} PIDs · ${Object.keys(p.ecus).length} ECU(s) · ${new Date(p.lastSeen).toLocaleDateString('en-GB')}`),
              ),
          app.renaming === p.key
            ? null
            : h(
                'span',
                { class: 'row' },
                h('button', { class: 'btn small', onclick: () => app.set({ profile: p, snapshot: null, report: null, vehicleInfo: null, selfTests: null, batteryTest: null }) }, 'View'),
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
