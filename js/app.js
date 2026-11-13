// Application state and actions. Screens read `app` and call its actions;
// they re-render on app.on('change').

import { Logger } from './logger.js';
import { Elm327, CommandRejected } from './elm327.js';
import { BleTransport, bleAvailable, describeError } from './transport/ble.js';
import { MockTransport, MOCK_PROFILES } from './transport/mock.js';
import { discoverVehicle, snapshot, saveProfile, loadProfiles, deleteProfile, setNickname, setEcuNames, ecuLabel } from './vehicle.js';
import { load, save } from './storage.js';
import { readAllCodes, checkClearConditions, clearAndVerify } from './diagnostics.js';
import { loadDtcTable } from './obd/dtc.js';
import { LivePoller, defaultTiles, isLivePid, AutoDrive, livePids } from './poller.js';
import { DEFAULT_UNITS, formatValue } from './obd/pids.js';
import { readMonitorTests } from './obd/mode06.js';
import { readVehicleInfo } from './obd/vehicleinfo.js';
import { decodeVin } from './obd/vin.js';
import { loadHistory, saveHistory, updateHistory, recordClear } from './history.js';
import { loadMaintenance, saveMaintenance, addEntry, removeEntry, setDue, maintenanceFor, dueStatus, describeDue } from './maintenance.js';
import { sampleVoltage, average, rateResting, rateCranking, rateCharging, engineStarted, crankMinimum } from './battery.js';
import { buildReport } from './report.js';
import { APP_NAME, APP_VERSION } from './version.js';

const DEFAULT_SETTINGS = {
  transport: 'ble', // 'ble' | 'sim-<profile>' (simulators: developer mode only)
  showAll: false,
  autoDiscover: true,
  includeFrags: true,
  sim: { noDataRate: 0, dropRate: 0, tinyFragments: false, parked: false },
  units: { ...DEFAULT_UNITS }, // speed mph|kmh, temp C|F, distance mi|km
  tiles: {}, // per vehicle profile key: the live tiles chosen, in order
  autoDriving: true, // switch to the driving view once the car is moving
};

export const MAX_TILES = 8;

// The simulated car behind the public "Try a demo" button.
export const DEMO_PROFILE = 'petrol';

/** Branch preview builds live under /preview/<branch>/ on the Pages site. */
function detectPreview() {
  try {
    return /\/preview\/([^/]+)\//.exec(globalThis.location?.pathname ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Developer mode (all simulators + error injection): add ?dev to the address. */
function detectDevMode() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('dev');
  } catch {
    return false;
  }
}

function loadSettings() {
  const s = load('settings', {});
  const merged = {
    ...DEFAULT_SETTINGS,
    ...s,
    sim: { ...DEFAULT_SETTINGS.sim, ...(s?.sim ?? {}) },
    units: { ...DEFAULT_SETTINGS.units, ...(s?.units ?? {}) },
    tiles: { ...(s?.tiles ?? {}) },
  };
  // A simulator saved by an older version may no longer exist.
  if (merged.transport !== 'ble' && !MOCK_PROFILES[String(merged.transport).replace(/^sim-/, '')]) merged.transport = 'ble';
  return merged;
}

function friendlyError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'NotFoundError') return 'No device was selected (or none was found). Make sure the adapter is plugged in and the ignition is on, then try again. If it does not appear, tick “Show all Bluetooth devices”.';
  if (err.name === 'SecurityError') return 'The browser blocked Bluetooth. The page must be opened over HTTPS and Connect must be tapped directly.';
  if (err.name === 'NetworkError') return `Bluetooth connection failed: ${err.message}. Try again; if it keeps failing, unplug the adapter for 10 seconds.`;
  if (err instanceof CommandRejected) return `Blocked by the safety allow-list: ${err.message}`;
  if (err.name === 'BluetoothRequestError') {
    const d = err.detail ?? {};
    const said = [d.name && d.name !== 'Error' ? d.name : null, d.message || d.raw].filter(Boolean).join(': ');
    return `Bluetooth couldn’t open the device list${said ? ` (the browser said “${said}”)` : ''}. Check that Bluetooth is switched on and that the browser is allowed to use it (on iPhone/iPad: Settings → Bluefy → Bluetooth), then try again. If it keeps happening, copy the log from the Console screen.`;
  }
  const d = describeError(err);
  return d.message || d.raw || 'Unknown error';
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
  devMode: detectDevMode(),
  preview: detectPreview(), // branch name when running a preview build
  demo: false, // connected to the public demo car (nothing is saved)
  diag: null, // last fault-code read (see diagnostics.js readAllCodes)
  dtcTable: {},
  clearFlow: null, // { step: 'warn' | 'conditions' | 'confirm' | 'result', ... }
  selfTests: null, // mode 06 results (obd/mode06.js readMonitorTests)
  vehicleInfo: null, // mode 09 names / calibration IDs per ECU
  history: loadHistory(), // fault-code history per vehicle
  maintenance: loadMaintenance(), // maintenance log per vehicle
  batteryTest: null, // { step, skipCrank, live, resting, crankMin, charging, ... }
  batteryResults: load('battery', {}), // last battery test per vehicle
  report: null, // { title, html, text }
  live: null, // LivePoller while the Live screen is polling
  liveDetail: null, // PID shown full-screen on the Live screen
  liveSeconds: 60, // graph window on the detail view
  editingTiles: false,
  driving: false, // driving view: big numbers, no menus
  _listeners: new Set(),
  _liveListeners: new Set(),
  _liveTimer: null,

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  set(patch) {
    if ('profile' in patch) setEcuNames(patch.profile?.ecuNames);
    Object.assign(this, patch);
    for (const fn of this._listeners) fn(this);
  },

  updateSettings(patch) {
    const settings = {
      ...this.settings,
      ...patch,
      sim: { ...this.settings.sim, ...(patch.sim ?? {}) },
      units: { ...this.settings.units, ...(patch.units ?? {}) },
    };
    save('settings', settings);
    this.set({ settings });
  },

  get connected() {
    return this.status === 'connected' || this.status === 'ready';
  },

  /** Header lines for "Copy log", so a pasted log is self-describing. */
  logHeader() {
    const lines = [`# ${this.name} v${this.version} — log copied ${new Date().toString()}`];
    if (this.preview) lines.push(`# Preview build of branch: ${this.preview}`);
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

  /**
   * Must be called straight from a tap: no await before transport.connect().
   * Normal mode always uses Bluetooth; { demo: true } uses the demo car;
   * developer mode (?dev) uses whatever is picked on the Connect screen.
   */
  connect({ demo = false } = {}) {
    if (this.busy || this.connected) return;
    const s = this.settings;
    const kind = demo ? `sim-${DEMO_PROFILE}` : this.devMode ? s.transport : 'ble';
    let t;
    if (kind === 'ble') {
      t = new BleTransport(this.logger);
    } else {
      const profile = kind.replace(/^sim-/, '');
      if (!MOCK_PROFILES[profile]) return this.set({ error: `Unknown simulator ${profile}` });
      t = new MockTransport(this.logger, demo ? { profile, label: 'Demo car (simulated)', parked: true } : { profile, ...s.sim });
    }
    this.demo = demo;
    let p;
    try {
      p = t.connect({ showAll: s.showAll });
    } catch (err) {
      p = Promise.reject(err);
    }
    this.logger.info(`Connect: ${t.label} (app v${this.version})`);
    this.set({ status: 'connecting', busy: 'Connecting…', error: null, notice: null, init: null, identify: null, profile: null, snapshot: null, diag: null, clearFlow: null, selfTests: null, vehicleInfo: null, batteryTest: null, report: null });
    p.then(
      async () => {
        this._attach(t);
        this.set({ status: 'connected', busy: null });
        await this.runInit();
      },
      (err) => {
        const d = describeError(err);
        this.logger.error(`Connect failed: ${d.name}: ${d.message || '(no message)'} [type=${typeof err} code=${d.code ?? '-'} raw=${d.raw}]`);
        this.set({ status: 'idle', busy: null, error: friendlyError(err) });
      },
    );
  },

  _attach(t) {
    t.ondisconnect = () => {
      this.logger.warn('Adapter disconnected');
      this.live?.stop('disconnected');
      this.live = null;
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
    await this.stopLive();
    t.ondisconnect = null;
    await t.disconnect();
    this.set({ status: 'idle', busy: null, elm: null, demo: false, notice: 'Disconnected.' });
  },

  async _action(label, fn) {
    if (this.busy || !this.elm) return;
    // One conversation with the adapter at a time: live polling pauses for actions.
    if (this.live) await this.stopLive();
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
      const found = await discoverVehicle(this.elm, { adapter, onStep: (s) => this.set({ progress: s }) });
      const vehicleInfo = await readVehicleInfo(this.elm, found, { onStep: (s) => this.set({ progress: s }) });
      found.ecuNames = Object.fromEntries(Object.entries(vehicleInfo).filter(([, v]) => v.name).map(([id, v]) => [id, v.name.name]));
      this.set({ vehicleInfo });
      if (this.demo) {
        // The demo car is never saved, so it can't clutter Saved vehicles.
        this.set({ profile: found, notice: 'This is a simulated demo car: the values are made up and nothing is saved. Have a look at Vehicle and Console.' });
        return;
      }
      const profile = saveProfile(found);
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

  // --- live data ----------------------------------------------------------------

  /** Live-screen subscribers get value updates (throttled), not full re-renders. */
  onLive(fn) {
    this._liveListeners.add(fn);
    return () => this._liveListeners.delete(fn);
  },

  _liveChanged() {
    if (this._liveTimer) return;
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this._checkAutoDrive();
      for (const fn of this._liveListeners) fn(this);
    }, 250);
  },

  _checkAutoDrive() {
    if (!this.live || !this._autoDrive || !this.settings.autoDriving) return;
    const speed = this.live.value(0x0d, 3000); // km/h
    if (this._autoDrive.update(speed, Date.now(), { driving: this.driving })) {
      this.logger.info('Car is moving: switched to the driving view automatically');
      this.setDriving(true);
    }
  },

  /** The tiles for the current vehicle: saved choice, else the defaults. */
  tiles() {
    const p = this.profile;
    if (!p) return [];
    const saved = this.settings.tiles?.[p.key];
    const list = Array.isArray(saved) ? saved : defaultTiles(p.supported01);
    return list.filter((pid) => p.supported01.includes(pid) && isLivePid(pid)).slice(0, MAX_TILES);
  },

  setTiles(list) {
    const p = this.profile;
    if (!p) return;
    const tiles = list.filter((pid) => p.supported01.includes(pid) && isLivePid(pid)).slice(0, MAX_TILES);
    this.updateSettings({ tiles: { ...this.settings.tiles, [p.key]: tiles } });
    this.live?.setPids(livePids(tiles, p.supported01));
  },

  resetTiles() {
    const p = this.profile;
    if (!p) return;
    const tiles = { ...this.settings.tiles };
    delete tiles[p.key];
    this.updateSettings({ tiles });
    this.live?.setPids(livePids(this.tiles(), p.supported01));
  },

  get canGoLive() {
    return this.status === 'ready' && !!this.profile && !this.busy && !!this.elm;
  },

  startLive() {
    if (this.live || !this.canGoLive) return;
    this._autoDrive = new AutoDrive();
    const poller = new LivePoller(this.elm, {
      // Speed and RPM always, for the engine badge and auto driving view.
      pids: livePids(this.tiles(), this.profile.supported01),
      ecus: this.profile.ecus,
      onUpdate: () => this._liveChanged(),
      onStop: (reason) => {
        if (this.live === poller) this.set({ live: null, notice: reason === 'disconnected' ? null : this.notice });
      },
    });
    this.live = poller;
    poller.start();
    this.set({});
  },

  async stopLive() {
    const p = this.live;
    if (!p) return;
    this.live = null;
    await p.stop();
    this.set({ driving: false });
  },

  setDriving(on) {
    // Leaving the driving view while moving means "not now": don't switch back until the car stops.
    if (!on && this.driving) this._autoDrive?.dismiss();
    this.set({ driving: !!on, liveDetail: null, editingTiles: false });
    if (on) globalThis.scrollTo?.(0, 0);
  },

  /** Simulators only: park the car (codes can be cleared) or drive it (live data moves). */
  get simParked() {
    return this.transport?.kind === 'mock' ? !!this.transport.sim?.opts.parked : null;
  },

  setSimParked(parked) {
    if (this.transport?.kind !== 'mock' || !this.transport.sim) return;
    this.transport.sim.setParked(!!parked);
    this.logger.info(`Simulator: car ${parked ? 'parked (ignition on, engine off)' : 'driving'}`);
    this.set({});
  },

  // --- fault codes ------------------------------------------------------------

  async runReadCodes() {
    await this._action('Reading fault codes…', async () => {
      const [diag, dtcTable] = await Promise.all([readAllCodes(this.elm, { onStep: (s) => this.set({ progress: s }) }), loadDtcTable()]);
      this.set({ diag, dtcTable });
      this._recordHistory(diag);
    });
  },

  // Clear-codes flow (brief section 7). Each step must be passed in order;
  // mode 04 is only sent from runClear() at the 'confirm' step.
  startClear() {
    if (!this.connected || !this.diag) return;
    this.set({ clearFlow: { step: 'warn', understood: false }, error: null, notice: null });
  },

  updateClear(patch) {
    if (this.clearFlow) this.set({ clearFlow: { ...this.clearFlow, ...patch } });
  },

  cancelClear() {
    this.set({ clearFlow: null });
  },

  async runClearCheck() {
    if (this.clearFlow?.step !== 'conditions') return;
    await this._action('Checking the engine is off…', async () => {
      const check = await checkClearConditions(this.elm, this.profile?.supported01 ?? [0x0c, 0x0d]);
      this.updateClear({ check, engineOffConfirmed: false });
    });
  },

  async runClear() {
    const f = this.clearFlow;
    if (f?.step !== 'confirm' || !f.understood || !f.engineOffConfirmed || f.check?.problems?.length) return;
    this.updateClear({ step: 'sending' });
    let outcome = null;
    await this._action('Clearing fault codes…', async () => {
      outcome = await clearAndVerify(this.elm, { onStep: (s) => this.set({ progress: s }) });
    });
    // Whatever happened, show the result; never try again automatically.
    this.set({ clearFlow: { step: 'result', outcome }, diag: outcome?.after ?? this.diag });
    if (outcome && this._savesData) {
      const history = updateHistory(recordClear(this.history, this.profile.key, outcome), this.profile.key, outcome.after);
      saveHistory(history);
      this.set({ history });
    }
  },

  // --- saved per-vehicle data (never for the demo car) -----------------------------

  get _savesData() {
    return !!this.profile && !this.demo;
  },

  _recordHistory(diag) {
    if (!this._savesData || !diag) return;
    const history = updateHistory(this.history, this.profile.key, diag);
    saveHistory(history);
    this.set({ history });
  },

  // --- self-tests (mode 06) and vehicle info (mode 09) --------------------------

  async runSelfTests() {
    await this._action('Reading self-test results…', async () => {
      const selfTests = await readMonitorTests(this.elm, { onStep: (s) => this.set({ progress: s }) });
      this.set({ selfTests });
    });
  },

  async runVehicleInfo() {
    if (!this.profile) return;
    await this._action('Reading vehicle details…', async () => {
      const vehicleInfo = await readVehicleInfo(this.elm, this.profile, { onStep: (s) => this.set({ progress: s }) });
      const ecuNames = Object.fromEntries(Object.entries(vehicleInfo).filter(([, v]) => v.name).map(([id, v]) => [id, v.name.name]));
      const profile = this._savesData ? saveProfile({ ...this.profile, ecuNames }) : { ...this.profile, ecuNames };
      this.set({ vehicleInfo, profile, profiles: loadProfiles() });
    });
  },

  get decodedVin() {
    return this.profile?.vin ? decodeVin(this.profile.vin) : null;
  },

  // --- battery and charging test ------------------------------------------------

  startBatteryTest() {
    this.set({ batteryTest: { step: 'intro', skipCrank: false, live: null }, error: null, notice: null });
  },

  updateBattery(patch) {
    if (this.batteryTest) this.set({ batteryTest: { ...this.batteryTest, ...patch } });
  },

  cancelBatteryTest() {
    this.set({ batteryTest: null });
  },

  async runBatteryResting() {
    await this._action('Measuring the resting voltage…', async () => {
      const samples = await sampleVoltage(this.elm, 3000, { onSample: (v) => this.updateBattery({ live: v }) });
      const resting = average(samples);
      this.logger.info(`Battery test: resting ${resting?.toFixed(2)} V from ${samples.length} readings`);
      this.updateBattery({ resting, step: this.batteryTest?.skipCrank ? 'charge-ready' : 'crank-ready' });
    });
  },

  async runBatteryCrank() {
    await this._action('Start the engine now…', async () => {
      // Simulators: the engine "starts" by itself a moment into this step.
      if (this.simParked) setTimeout(() => this.setSimParked(false), 1500);
      const samples = await sampleVoltage(this.elm, 20000, { stop: engineStarted, onSample: (v) => this.updateBattery({ live: v }) });
      const started = engineStarted(samples);
      const crankMin = crankMinimum(samples);
      this.logger.info(`Battery test: ${started ? 'engine start seen' : 'no engine start seen'}, lowest ${crankMin?.toFixed(2)} V`);
      this.updateBattery({ crankMin: started ? crankMin : null, crankSeen: started, step: 'charge-ready' });
    });
    if (this.batteryTest?.crankSeen) await this.runBatteryCharging();
  },

  async runBatteryCharging() {
    await this._action('Measuring the charging voltage…', async () => {
      if (this.simParked) this.setSimParked(false); // simulators: switch on fully first
      const samples = await sampleVoltage(this.elm, 4000, { onSample: (v) => this.updateBattery({ live: v }) });
      const charging = average(samples);
      this.logger.info(`Battery test: charging ${charging?.toFixed(2)} V`);
      this._finishBattery({ charging });
    });
  },

  _finishBattery(patch) {
    const b = { ...this.batteryTest, ...patch };
    const restingRating = rateResting(b.resting);
    const crankRating = b.skipCrank ? null : rateCranking(b.crankMin);
    const chargingRating = rateCharging(b.charging);
    const order = ['good', 'ok', 'low', 'weak'];
    const levels = [restingRating, crankRating, chargingRating].filter((r) => r && r.level !== 'unknown').map((r) => r.level);
    const overall = levels.sort((x, y) => order.indexOf(y) - order.indexOf(x))[0] ?? 'unknown';
    const result = { at: Date.now(), resting: b.resting, crankMin: b.crankMin ?? null, charging: b.charging, skippedCrank: !!b.skipCrank, restingRating, crankRating, chargingRating, overall };
    let batteryResults = this.batteryResults;
    if (this._savesData) {
      batteryResults = { ...batteryResults, [this.profile.key]: result };
      save('battery', batteryResults);
    }
    this.set({ batteryTest: { ...b, step: 'result', result }, batteryResults });
  },

  get lastBattery() {
    return this.batteryTest?.result ?? (this.profile ? this.batteryResults[this.profile.key] : null) ?? null;
  },

  // --- maintenance log ------------------------------------------------------------

  get maintenanceHere() {
    return this.profile ? maintenanceFor(this.maintenance, this.profile.key) : null;
  },

  get dueHere() {
    const m = this.maintenanceHere;
    return m ? dueStatus(m.due).map((d) => ({ ...d, text: describeDue(d) })) : [];
  },

  _saveMaintenance(maintenance) {
    saveMaintenance(maintenance);
    this.set({ maintenance });
  },

  addMaintenance(entry) {
    if (this._savesData) this._saveMaintenance(addEntry(this.maintenance, this.profile.key, entry));
  },

  removeMaintenance(id) {
    if (this._savesData) this._saveMaintenance(removeEntry(this.maintenance, this.profile.key, id));
  },

  setMaintenanceDue(patch) {
    if (this._savesData) this._saveMaintenance(setDue(this.maintenance, this.profile.key, patch));
  },

  // --- health report ------------------------------------------------------------------

  async runReport({ includeValues = true } = {}) {
    if (!this.profile) return;
    await this._action('Preparing the health report…', async () => {
      const step = (s) => this.set({ progress: s });
      const [diag, dtcTable] = await Promise.all([readAllCodes(this.elm, { onStep: step }), loadDtcTable()]);
      this.set({ diag, dtcTable });
      this._recordHistory(diag);
      if (!this.vehicleInfo) this.set({ vehicleInfo: await readVehicleInfo(this.elm, this.profile, { onStep: step }) });
      if (!this.selfTests) this.set({ selfTests: await readMonitorTests(this.elm, { onStep: step }) });
      let values = [];
      if (includeValues) {
        step('current values');
        const rows = await snapshot(this.elm, this.profile);
        const units = this.settings.units;
        values = rows.filter((r) => r.value != null && typeof r.value !== 'object').map((r) => ({ name: r.name, text: formatValue(r.pid, r.value, units) }));
      }
      this.set({ report: buildReport(this.reportData(values)) });
      this.logger.info('Health report created');
    });
  },

  reportData(values = []) {
    const p = this.profile;
    const vin = this.decodedVin;
    const units = this.settings.units;
    const diag = this.diag && {
      ...this.diag,
      freeze: this.diag.freeze && { ...this.diag.freeze, values: this.diag.freeze.values.map((x) => ({ ...x, display: formatValue(x.pid, x.value, units) })) },
    };
    return {
      appName: this.name,
      version: this.version,
      generatedAt: Date.now(),
      vehicle: {
        name: p.nickname ?? null,
        vin: p.vin,
        simulated: this.transport?.kind === 'mock',
        make: vin?.manufacturer,
        region: vin?.region,
        modelYear: vin?.modelYear,
        protocol: p.protocolName ?? p.protocol,
        fuelType: typeof p.fuelType === 'string' ? p.fuelType : null,
      },
      ecus: Object.keys(p.ecus).map((id) => ({ id, calIds: this.vehicleInfo?.[id]?.calIds ?? [], cvns: this.vehicleInfo?.[id]?.cvns ?? [] })),
      ecuLabel,
      diag,
      dtcTable: this.dtcTable,
      selfTests: this.selfTests,
      battery: this.lastBattery,
      maintenance: this._savesData ? { due: this.dueHere, entries: this.maintenanceHere.entries } : null,
      values,
    };
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
