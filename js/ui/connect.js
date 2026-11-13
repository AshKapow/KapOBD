import { h, replace, messageBox } from './dom.js';
import { MOCK_PROFILES } from '../transport/mock.js';
import { load, save } from '../storage.js';

// Developer mode only (?dev): every simulator, for testing without a car.
const TRANSPORTS = [
  { id: 'ble', label: 'Bluetooth adapter', sub: 'ELM327-compatible Bluetooth LE adapter' },
  ...Object.entries(MOCK_PROFILES).map(([id, p]) => ({ id: `sim-${id}`, label: p.label, sub: p.description })),
];

const RATES = [0, 0.05, 0.2, 0.5];

export function renderConnect(el, app) {
  const s = app.settings;
  const connected = app.connected;
  const disabled = !!app.busy;
  const usingBle = !app.devMode || s.transport === 'ble';

  const mainButton = connected
    ? h('button', { class: 'btn big secondary', disabled, onclick: () => app.disconnect() }, app.demo ? 'End demo' : 'Disconnect')
    : h(
        'button',
        { class: 'btn big primary', disabled: disabled || (usingBle && !app.bleAvailable), onclick: () => app.connect() },
        app.status === 'connecting' ? 'Connecting…' : usingBle ? 'Connect to adapter' : 'Connect to simulator',
      );

  const reconnect =
    app.status === 'disconnected' && app.transport
      ? h('button', { class: 'btn big', disabled, onclick: () => app.reconnect() }, 'Reconnect to ' + app.transport.label)
      : null;

  replace(
    el,
    h('h2', {}, 'Connect'),
    !app.online ? h('div', { class: 'msg ok' }, app.offline === 'ready' ? 'No internet connection: KapOBD is running from its saved copy. Everything works except fetching updates.' : 'No internet connection.') : null,
    app.devMode ? h('div', { class: 'msg warn' }, 'Developer mode: simulators and error injection are available. Remove ?dev from the address to leave it.') : null,
    !connected && app.devMode ? transportPicker(app, disabled) : null,
    !connected && usingBle ? bleOptions(app) : null,
    !connected && !usingBle ? simOptions(app) : null,
    h('div', { class: 'actions' }, mainButton, reconnect),
    !connected && !app.devMode ? demoOffer(app, disabled) : null,
    messageBox(app),
    connected || app.init ? statusCard(app) : null,
    connected
      ? h(
          'div',
          { class: 'actions wrap' },
          h('button', { class: 'btn', disabled, onclick: () => app.runIdentify() }, 'Adapter test (ATZ, ATI)'),
          h('button', { class: 'btn', disabled, onclick: () => app.runInit() }, 'Run init again'),
          h('button', { class: 'btn', disabled: disabled || app.status !== 'ready', onclick: () => app.runDiscover() }, 'Discover vehicle'),
        )
      : null,
    connected
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.autoDiscover, onchange: (e) => app.updateSettings({ autoDiscover: e.target.checked }) }), 'Discover the vehicle automatically after init')
      : null,
    !connected ? h('p', { class: 'hint' }, 'Plug the adapter into the car’s OBD port, switch the ignition on (the engine can stay off), then tap Connect.') : null,
    h('p', { class: 'hint' }, h('a', { href: '#about' }, 'About KapOBD, safety and privacy')),
  );
}

function transportPicker(app, disabled) {
  const s = app.settings;
  return h(
    'fieldset',
    { class: 'choices', disabled },
    h('legend', {}, 'Connect to'),
    TRANSPORTS.map((t) =>
      h(
        'label',
        { class: 'choice' + (s.transport === t.id ? ' selected' : '') },
        h('input', { type: 'radio', name: 'transport', value: t.id, checked: s.transport === t.id, onchange: () => app.updateSettings({ transport: t.id }) }),
        h('span', {}, h('strong', {}, t.label), h('small', {}, t.sub)),
      ),
    ),
  );
}

function bleOptions(app) {
  const s = app.settings;
  return h(
    'div',
    { class: 'options' },
    !app.bleAvailable
      ? h('div', { class: 'msg warn' }, 'This browser can’t use Bluetooth. On iPhone or iPad, open this page in the free Bluefy browser. On Android, use Chrome; on a computer, Chrome or Edge.')
      : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.showAll, onchange: (e) => app.updateSettings({ showAll: e.target.checked }) }), 'Show all Bluetooth devices (use if your adapter isn’t listed)'),
    h(
      'details',
      {},
      h('summary', {}, 'Advanced'),
      h(
        'label',
        { class: 'row' },
        'Bluetooth write mode ',
        h(
          'select',
          {
            onchange: (e) => {
              save('bleWriteMode', e.target.value);
              app.set({});
            },
          },
          ['auto', 'with', 'without'].map((m) => h('option', { value: m, selected: load('bleWriteMode', 'auto') === m }, m === 'auto' ? 'Auto' : `Write ${m} response`)),
        ),
      ),
    ),
  );
}

function simOptions(app) {
  const s = app.settings;
  return h(
    'details',
    { class: 'options' },
    h('summary', {}, 'Simulator options'),
    rateSelect('Reply with NO DATA', 'noDataRate', s, app),
    rateSelect('Lose responses (timeouts)', 'dropRate', s, app),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.sim.tinyFragments, onchange: (e) => app.updateSettings({ sim: { tinyFragments: e.target.checked } }) }), 'Tiny Bluetooth fragments (1–6 bytes)'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.sim.parked, onchange: (e) => app.updateSettings({ sim: { parked: e.target.checked } }) }), 'Car parked: ignition on, engine off (needed to test clearing codes)'),
    h('p', { class: 'hint' }, 'Applies when you next connect.'),
  );
}

function demoOffer(app, disabled) {
  return h(
    'div',
    { class: 'demo' },
    h('span', { class: 'hint' }, 'No adapter yet?'),
    h('button', { class: 'btn small', disabled, onclick: () => app.connect({ demo: true }) }, 'Try a demo with a simulated car'),
  );
}

function rateSelect(label, key, s, app) {
  return h(
    'label',
    { class: 'row' },
    label + ' ',
    h(
      'select',
      { onchange: (e) => app.updateSettings({ sim: { [key]: Number(e.target.value) } }) },
      RATES.map((r) => h('option', { value: r, selected: s.sim[key] === r }, r ? `${r * 100}%` : 'Never')),
    ),
  );
}

function statusCard(app) {
  const i = app.transport?.info;
  const init = app.init;
  const rows = [
    ['Status', app.demo ? `${app.status} (demo: simulated data)` : app.status],
    ['Device', app.transport?.label || i?.device],
    ['Bluetooth', i && !app.demo ? `service ${i.service} · notify ${i.notify} · write ${i.write} (${i.writeMode} response)` : null],
    ['Adapter ID', init?.adapterId ?? app.identify?.id],
    ['Adapter voltage', init?.voltage],
    ['Protocol', init?.protocolName ?? init?.protocol],
    ['ECUs answering', init?.ecus?.join(', ')],
    ['VIN', app.profile ? app.profile.vin ?? 'not reported' : null],
  ].filter(([, v]) => v);
  return h('dl', { class: 'card kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}
