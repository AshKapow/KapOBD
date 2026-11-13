// Live-data polling (brief section 6): fast PIDs every cycle, one slow PID per
// cycle in rotation. Keeps a short history per PID for the graphs.

import { PIDS, hex2, decodePid } from './obd/pids.js';
import { positive } from './obd/modes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PIDs whose decoded value isn't a number, so they can't be a tile or a graph.
const NON_NUMERIC = new Set([0x01, 0x03, 0x13, 0x1c, 0x51]);

export const isLivePid = (pid) => !!PIDS[pid] && !NON_NUMERIC.has(pid) && PIDS[pid].poll !== 'once';

// Default dashboard (brief section 11): speed, RPM, coolant, voltage, fuel,
// hybrid battery (life, then pack voltage); topped up with other main values.
const DEFAULT_TILES = [0x0d, 0x0c, 0x05, 0x42, 0x2f, 0x5b, 0x9a];

export function defaultTiles(supported, max = 6) {
  const tiles = DEFAULT_TILES.filter((p) => supported.includes(p));
  for (const p of supported) {
    if (tiles.length >= max) break;
    if (!tiles.includes(p) && isLivePid(p) && PIDS[p].group === 'main') tiles.push(p);
  }
  return tiles.slice(0, max);
}

// Usual engine-computer addresses, used only to break ties.
const ENGINE_ECUS = ['7E8', '10', '18DAF110'];

/**
 * Order ECUs for "which answer do we show" when several reply to one PID.
 * ecus: a profile's { id: { supported01 } } map, or a plain list of ids.
 * The ECU supporting the most PIDs comes first: that's the engine computer
 * on almost every car, whatever its address (a real hybrid's is 18DAF115).
 */
export function ecuPreference(ecus) {
  const entries = Array.isArray(ecus) ? ecus.map((id) => [id, 0]) : Object.entries(ecus ?? {}).map(([id, e]) => [id, e?.supported01?.length ?? 0]);
  const known = (id) => {
    const i = ENGINE_ECUS.indexOf(id);
    return i < 0 ? 99 : i;
  };
  return entries.sort(([a, na], [b, nb]) => nb - na || known(a) - known(b) || a.localeCompare(b)).map(([id]) => id);
}

export class LivePoller {
  /**
   * pids: mode 01 PIDs to poll; ecus: the profile's ECU map (or a list of ids).
   * onUpdate(pid) after each new value; onStop(reason) when polling ends.
   */
  constructor(elm, { pids = [], ecus = [], historySeconds = 300, statsEveryMs = 10000, onUpdate, onStop } = {}) {
    this.elm = elm;
    this.pids = [...new Set(pids)].filter(isLivePid);
    this.ecuOrder = ecuPreference(ecus);
    this.historyMs = historySeconds * 1000;
    this.statsEveryMs = statsEveryMs;
    this.onUpdate = onUpdate;
    this.onStop = onStop;
    this.history = new Map(); // pid -> [{ t, v }]
    this.latest = new Map(); // pid -> { value, t, ecu }
    this.running = false;
    this.stats = { requests: 0, answered: 0, cycles: 0, startedAt: 0 };
    this._window = { at: 0, requests: 0, answered: 0, timeouts: 0 };
    this._done = Promise.resolve();
    this._slowIndex = 0;
    this._loggedRaw = new Set();
  }

  setPids(pids) {
    this.pids = [...new Set(pids)].filter(isLivePid);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();
    this._window = { at: Date.now(), requests: 0, answered: 0, timeouts: this.elm.stats.timeouts };
    this.elm.log.info(`Live data: polling ${this.pids.map(hex2).join(' ') || 'nothing'}`);
    this._done = this._loop();
  }

  /** Stop after the request in flight; resolves when the loop has exited. */
  async stop(reason = 'stopped') {
    if (!this.running) return this._done;
    this.running = false;
    this._stopReason = reason;
    return this._done;
  }

  /** One cycle's requests: every fast PID, then the next slow one. */
  nextBatch() {
    const fast = this.pids.filter((p) => PIDS[p].poll === 'fast');
    const slow = this.pids.filter((p) => PIDS[p].poll !== 'fast');
    const batch = [...fast];
    if (slow.length) batch.push(slow[this._slowIndex++ % slow.length]);
    return batch;
  }

  async _loop() {
    try {
      while (this.running) {
        const batch = this.nextBatch();
        if (!batch.length) {
          await sleep(500);
          continue;
        }
        for (const pid of batch) {
          if (!this.running) break;
          const ok = await this._read(pid);
          if (ok === 'disconnected') {
            this.running = false;
            this._stopReason = 'disconnected';
          }
        }
        this.stats.cycles++;
        this._maybeLogStats();
      }
    } finally {
      this.elm.log.info(`Live data: stopped (${this._stopReason ?? 'stopped'}) after ${this.stats.requests} requests`);
      this.onStop?.(this._stopReason ?? 'stopped');
    }
  }

  async _read(pid) {
    let res;
    try {
      res = await this.elm.send('01' + hex2(pid), { quiet: true });
    } catch (err) {
      this.elm.log.error(`Live data: ${err.message}`);
      return false;
    }
    this.stats.requests++;
    this._window.requests++;
    if (res.error === 'WRITE_FAILED') return 'disconnected';
    const msgs = positive(res, 0x01, pid);
    if (!msgs.length) return false;
    msgs.sort((a, b) => this.ecuOrder.indexOf(a.ecu) - this.ecuOrder.indexOf(b.ecu));
    const m = msgs[0];
    const d = decodePid(pid, m.bytes.slice(2));
    // Formulas not yet checked against a real car: log the first raw reply.
    if (PIDS[pid].unverified && !this._loggedRaw.has(pid)) {
      this._loggedRaw.add(pid);
      const raw = m.bytes.slice(2).map(hex2).join(' ');
      const detail = PIDS[pid].detail ? ` ${JSON.stringify(PIDS[pid].detail(m.bytes.slice(2)))}` : '';
      this.elm.log.info(`Live data: PID ${hex2(pid)} (unverified formula) from ${m.ecu}: raw ${raw} → ${d.value}${detail}`);
    }
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) return false;
    this.stats.answered++;
    this._window.answered++;
    this.record(pid, d.value, m.ecu, Date.now(), PIDS[pid].detail?.(m.bytes.slice(2)) ?? null);
    return true;
  }

  /** Store a value (also used by tests). `detail`: extra decoded fields (e.g. PID 9A current). */
  record(pid, value, ecu = null, t = Date.now(), detail = null) {
    const h = this.history.get(pid) ?? [];
    h.push({ t, v: value });
    const cutoff = t - this.historyMs;
    while (h.length && h[0].t < cutoff) h.shift();
    this.history.set(pid, h);
    this.latest.set(pid, { value, t, ecu, detail });
    this.onUpdate?.(pid);
  }

  /** Latest value if it's recent enough, otherwise null. */
  value(pid, maxAgeMs = 5000, now = Date.now()) {
    const l = this.latest.get(pid);
    return l && now - l.t <= maxAgeMs ? l.value : null;
  }

  /** Points from the last `seconds`, for graphs. */
  series(pid, seconds = 60, now = Date.now()) {
    const from = now - seconds * 1000;
    return (this.history.get(pid) ?? []).filter((p) => p.t >= from);
  }

  /** min / max / average over the last `seconds`. */
  summary(pid, seconds = 300, now = Date.now()) {
    const pts = this.series(pid, seconds, now);
    if (!pts.length) return null;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const p of pts) {
      min = Math.min(min, p.v);
      max = Math.max(max, p.v);
      sum += p.v;
    }
    return { min, max, avg: sum / pts.length, count: pts.length };
  }

  /**
   * 'running' | 'off' | 'electric' (engine off while moving) | 'unknown'.
   * A hybrid's engine computer often goes quiet with the engine stopped, so a
   * missing RPM while other values keep arriving also counts as off.
   */
  engineState(now = Date.now()) {
    if (!this.pids.includes(0x0c)) return 'unknown';
    const rpm = this.value(0x0c, 3000, now);
    const othersFresh = [...this.latest.entries()].some(([pid, l]) => pid !== 0x0c && now - l.t <= 3000);
    let off;
    if (rpm != null) off = rpm < 1;
    else if (othersFresh && now - this.stats.startedAt > 3000) off = true;
    else return 'unknown';
    if (!off) return 'running';
    const speed = this.value(0x0d, 3000, now);
    return speed != null && speed >= 1 ? 'electric' : 'off';
  }

  /** Requests per second over the last stats window. */
  rate(now = Date.now()) {
    const secs = (now - this._window.at) / 1000;
    return secs > 0 ? this._window.requests / secs : 0;
  }

  _maybeLogStats() {
    const now = Date.now();
    if (now - this._window.at < this.statsEveryMs) return;
    const w = this._window;
    const timeouts = this.elm.stats.timeouts - w.timeouts;
    const secs = (now - w.at) / 1000;
    this.elm.log.info(
      `Live data: ${w.requests} requests in ${secs.toFixed(0)} s (${(w.requests / secs).toFixed(1)}/s), ${w.requests - w.answered} without a value, ${timeouts} timeout(s), engine ${this.engineState(now)}`,
    );
    this._window = { at: now, requests: 0, answered: 0, timeouts: this.elm.stats.timeouts };
  }
}
