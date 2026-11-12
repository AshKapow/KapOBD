// Application state and actions. Screens read `app` and call its actions;
// they re-render on app.on('change').

import { Logger } from './logger.js';
import { Elm327, CommandRejected } from './elm327.js';
import { BleTransport, bleAvailable } from './transport/ble.js';
import { MockTransport, MOCK_PROFILES } from './transport/mock.js';
import { discoverVehicle, snapshot, saveProfile, loadProfiles, deleteProfile, setNickname } from './vehicle.js';
import { load, save } from './storage.js';
import { APP_NAME, APP_VERSION } from './version.js';

const DEFAULT_SETTINGS = {
  transport: 'ble', // 'ble' | 'sim-clio' | 'sim-mazda'
  showAll: false,
  autoDiscover: true,
  includeFrags: true,
  sim: { noDataRate: 0, dropRate: 0, tinyFragments: false },
};

function loadSettings() {
  const s = load('settings', {});
  return { ...DEFAULT_SETTINGS, ...s, sim: { ...DEFAULT_SETTINGS.sim, ...(s?.sim ?? {}) } };
}

function friendlyError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'NotFoundError') return 'No device was selected (or none was found). Make sure the adapter is plugged in and the ignition is on, then try again. If it does not appear, tick “Show all Bluetooth devices”.';
  if (err.name === 'SecurityError') return 'The browser blocked Bluetooth. The page must be opened over HTTPS and Connect must be tapped directly.';
  if (err.name === 'NetworkError') return `Bluetooth connection failed: ${err.message}. Try again; if it keeps failing, unplug the adapter for 10 seconds.`;
  if (err instanceof CommandRejected) return `Blocked by the safety allow-list: ${err.message}`;
  return err.message || String(err);
}

export const app = {
  name: APP_NAME,
  version: APP_VERSION,
  logger: new Logger(),
  transport: null,
  elm: null,
  status: 'idle', // idle | connecting | connected | ready | disconnected
  busy: null, // text while an action runs
  progress: '',
  error: null,
  notice: null,
  init: null,
  identify: null,
  profile: null,
  snapshot: null,
  profiles: loadProfiles(),
  settings: loadSettings(),
  previousLog: null,
  bleAvailable: bleAvailable(),
  _listeners: new Set(),

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  set(patch) {
    Object.assign(this, patch);
    for (const fn of this._listeners) fn(this);
  },

  updateSettings(patch) {
    const settings = { ...this.settings, ...patch, sim: { ...this.settings.sim, ...(patch.sim ?? {}) } };
    save('settings', settings);
    this.set({ settings });
  },

  get connected() {
    return this.status === 'connected' || this.status === 'ready';
  },

  /** Header lines for "Copy log", so a pasted log is self-describing. */
  logHeader() {
    const lines = [`# ${this.name} v${this.version} — log copied ${new Date().toString()}`];
    if (typeof navigator !== 'undefined') lines.push(`# Browser: ${navigator.userAgent}`);
    const t = this.transport;
    if (t?.info) {
      const i = t.info;
      lines.push(`# Transport: ${t.kind} “${i.device}” service ${i.service}, notify ${i.notify}, write ${i.write} (write ${i.writeMode} response)`);
      lines.push(`# GATT: ${i.services.map((s) => `${s.uuid}{${s.chars.join(' ')}}`).join(' ')}`);
      if (i.simulator) lines.push(`# Simulator: ${JSON.stringify(i.simulator)}`);
    } else {
      lines.push(`# Transport: ${t ? t.kind : 'none'} (not connected)`);
    }
    if (this.init) {
      lines.push(`# Adapter: ${this.init.adapterId ?? '?'}; voltage ${this.init.voltage ?? '?'}; protocol ${this.init.protocol ?? '?'} ${this.init.protocolName ?? ''}`);
    }
    if (this.elm) lines.push(`# Stats: ${JSON.stringify(this.elm.stats)}`);
    if (this.profile) {
      const p = this.profile;
      lines.push(`# Vehicle: ${p.nickname ? `“${p.nickname}” ` : ''}VIN ${p.vin ?? 'not reported'}; fuel ${p.fuelType ?? '?'}; ECUs ${Object.keys(p.ecus).join(', ')}`);
    }
    lines.push('#');
    return lines;
  },

  // --- actions ---------------------------------------------------------------

  /** Must be called straight from a tap: no await before transport.connect(). */
  connect() {
    if (this.busy || this.connected) return;
    const s = this.settings;
    let t;
    if (s.transport === 'ble') {
      t = new BleTransport(this.logger);
    } else {
      const profile = s.transport.replace(/^sim-/, '');
      if (!MOCK_PROFILES[profile]) return this.set({ error: `Unknown simulator ${profile}` });
      t = new MockTransport(this.logger, { profile, ...s.sim });
    }
    let p;
    try {
      p = t.connect({ showAll: s.showAll });
    } catch (err) {
      p = Promise.reject(err);
    }
    this.logger.info(`Connect: ${t.label} (app v${this.version})`);
    this.set({ status: 'connecting', busy: 'Connecting…', error: null, notice: null, init: null, identify: null, profile: null, snapshot: null });
    p.then(
      async () => {
        this._attach(t);
        this.set({ status: 'connected', busy: null });
        await this.runInit();
      },
      (err) => {
        this.logger.error(`Connect failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
        this.set({ status: 'idle', busy: null, error: friendlyError(err) });
      },
    );
  },

  _attach(t) {
    t.ondisconnect = () => {
      this.logger.warn('Adapter disconnected');
      this.set({ status: 'disconnected', busy: null, error: 'The adapter disconnected. Tap Reconnect, or Connect to pick it again.' });
    };
    this.transport = t;
    this.elm = new Elm327(t, this.logger);
  },

  async reconnect() {
    if (this.busy || !this.transport) return;
    this.set({ busy: 'Reconnecting…', error: null });
    try {
      await this.transport.reconnect();
      this._attach(this.transport);
      this.set({ status: 'connected', busy: null });
      await this.runInit();
    } catch (err) {
      this.logger.error(`Reconnect failed: ${err.message}`);
      this.set({ busy: null, error: friendlyError(err) });
    }
  },

  async disconnect() {
    const t = this.transport;
    if (!t) return;
    t.ondisconnect = null;
    await t.disconnect();
    this.set({ status: 'idle', busy: null, elm: null, notice: 'Disconnected.' });
  },

  async _action(label, fn) {
    if (this.busy || !this.elm) return;
    this.set({ busy: label, error: null, notice: null, progress: '' });
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${label} failed: ${err.message}`);
      this.set({ error: friendlyError(err) });
    } finally {
      this.set({ busy: null, progress: '' });
    }
  },

  async runIdentify() {
    await this._action('Adapter test (ATZ, ATI)…', async () => {
      const r = await this.elm.identify();
      this.set({ identify: r, notice: r.ok ? `Adapter replied: ${r.id}` : null, error: r.ok ? null : 'The adapter did not reply to ATI. Copy the log and send it back.' });
    });
  },

  async runInit() {
    let ok = false;
    await this._action('Initialising adapter…', async () => {
      const r = await this.elm.init({ onStep: (s) => this.set({ progress: s }) });
      ok = r.ok;
      this.set({ init: r, status: r.ok ? 'ready' : 'connected', error: r.error });
    });
    if (ok && this.settings.autoDiscover) await this.runDiscover();
  },

  async runDiscover() {
    await this._action('Asking the car what it supports…', async () => {
      const adapter = { ...(this.transport?.info ?? {}), id: this.init?.adapterId ?? null };
      delete adapter.services;
      const profile = saveProfile(await discoverVehicle(this.elm, { adapter, onStep: (s) => this.set({ progress: s }) }));
      this.set({ profile, profiles: loadProfiles(), notice: `Vehicle profile saved (${profile.vin ?? 'no VIN reported'}).` });
    });
  },

  async runSnapshot() {
    if (!this.profile) return;
    await this._action('Reading every supported value once…', async () => {
      const rows = await snapshot(this.elm, this.profile, { onValue: (r) => this.set({ snapshot: [...r], progress: `${r.length} read` }) });
      this.set({ snapshot: rows });
    });
  },

  /** Console: send one typed command. The allow-list still applies. */
  async sendManual(cmd) {
    if (!this.elm) return this.set({ error: 'Not connected.' });
    try {
      return await this.elm.send(cmd);
    } catch (err) {
      this.set({ error: friendlyError(err) });
      return null;
    }
  },

  renameProfile(key, nickname) {
    const updated = setNickname(key, nickname);
    this.set({ profiles: loadProfiles(), renaming: null, profile: this.profile?.key === key && updated ? updated : this.profile });
  },

  removeProfile(key) {
    deleteProfile(key);
    this.set({ profiles: loadProfiles(), profile: this.profile?.key === key ? null : this.profile });
  },
};

// --- log persistence: keep the last session's log in case the page reloads ---
const LOG_KEY = 'lastLog';
app.previousLog = load(LOG_KEY, null);
let logDirty = false;
app.logger.subscribe(() => (logDirty = true));
setInterval(() => {
  if (!logDirty) return;
  logDirty = false;
  save(LOG_KEY, { savedAt: Date.now(), version: APP_VERSION, header: app.logHeader(), entries: app.logger.entries.slice(-1500) });
}, 3000);
