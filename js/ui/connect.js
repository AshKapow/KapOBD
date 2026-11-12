import { h, replace, messageBox } from './dom.js';
import { MOCK_PROFILES } from '../transport/mock.js';
import { load, save } from '../storage.js';

const TRANSPORTS = [
  { id: 'ble', label: 'Bluetooth adapter', sub: 'Veepeak OBDCheck BLE+ or other ELM327 BLE' },
  ...Object.entries(MOCK_PROFILES).map(([id, p]) => ({ id: `sim-${id}`, label: p.label, sub: p.description })),
];

const RATES = [0, 0.05, 0.2, 0.5];

export function renderConnect(el, app) {
  const s = app.settings;
  const connected = app.connected;
  const disabled = !!app.busy;

  const transportPicker = h(
    'fieldset',
    { class: 'choices', disabled: connected || disabled },
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

  const bleOptions =
    s.transport === 'ble'
      ? h(
          'div',
          { class: 'options' },
          !app.bleAvailable
            ? h('div', { class: 'msg warn' }, 'This browser has no Web Bluetooth. On iPhone/iPad, open this page in the free Bluefy browser. On a computer or Android, use Chrome. The simulators still work here.')
            : null,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.showAll, disabled: connected, onchange: (e) => app.updateSettings({ showAll: e.target.checked }) }), 'Show all Bluetooth devices (use if the adapter isn’t listed)'),
          h(
            'details',
            {},
            h('summary', {}, 'Advanced'),
            h(
              'label',
              { class: 'row' },
              'BLE write mode ',
              h(
                'select',
                {
                  disabled: connected,
                  onchange: (e) => {
                    save('bleWriteMode', e.target.value);
                    app.set({});
                  },
                },
                ['auto', 'with', 'without'].map((m) => h('option', { value: m, selected: load('bleWriteMode', 'auto') === m }, m === 'auto' ? 'Auto' : `Write ${m} response`)),
              ),
            ),
          ),
        )
      : h(
          'details',
          { class: 'options' },
          h('summary', {}, 'Simulator error injection'),
          rateSelect('Reply with NO DATA', 'noDataRate', s, app, connected),
          rateSelect('Lose responses (timeouts)', 'dropRate', s, app, connected),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.sim.tinyFragments, disabled: connected, onchange: (e) => app.updateSettings({ sim: { tinyFragments: e.target.checked } }) }), 'Tiny BLE fragments (1–6 bytes)'),
          h('p', { class: 'hint' }, 'Applies when you next connect.'),
        );

  const mainButton = connected
    ? h('button', { class: 'btn big secondary', disabled, onclick: () => app.disconnect() }, 'Disconnect')
    : h(
        'button',
        { class: 'btn big primary', disabled: disabled || (s.transport === 'ble' && !app.bleAvailable), onclick: () => app.connect() },
        app.status === 'connecting' ? 'Connecting…' : 'Connect',
      );

  const reconnect =
    app.status === 'disconnected' && app.transport
      ? h('button', { class: 'btn big', disabled, onclick: () => app.reconnect() }, 'Reconnect to ' + app.transport.label)
      : null;

  replace(
    el,
    h('h2', {}, 'Connect'),
    !connected ? transportPicker : null,
    !connected ? bleOptions : null,
    h('div', { class: 'actions' }, mainButton, reconnect),
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
    h('p', { class: 'hint' }, 'Plug the adapter in, switch the ignition on (engine can stay off), then tap Connect. After any test, open Console and tap Copy log.'),
  );
}

function rateSelect(label, key, s, app, disabled) {
  return h(
    'label',
    { class: 'row' },
    label + ' ',
    h(
      'select',
      { disabled, onchange: (e) => app.updateSettings({ sim: { [key]: Number(e.target.value) } }) },
      RATES.map((r) => h('option', { value: r, selected: s.sim[key] === r }, r ? `${r * 100}%` : 'Never')),
    ),
  );
}

function statusCard(app) {
  const i = app.transport?.info;
  const init = app.init;
  const rows = [
    ['Status', app.status],
    ['Device', i?.device || app.transport?.label],
    ['GATT', i ? `service ${i.service} · notify ${i.notify} · write ${i.write} (${i.writeMode} response)` : null],
    ['Adapter ID', init?.adapterId ?? app.identify?.id],
    ['Adapter voltage', init?.voltage],
    ['Protocol', init?.protocolName ?? init?.protocol],
    ['ECUs answering', init?.ecus?.join(', ')],
    ['VIN', app.profile ? app.profile.vin ?? 'not reported' : null],
  ].filter(([, v]) => v);
  return h('dl', { class: 'card kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}
