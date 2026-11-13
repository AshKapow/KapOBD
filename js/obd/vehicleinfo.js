// Mode 09 vehicle information beyond the VIN (CAN layout): each computer's
// name (0A), calibration IDs (04), calibration verification numbers (06) and
// in-use performance counters (08 spark, 0B compression ignition).

import { hex2 } from './pids.js';
import { positive } from './modes.js';

const ascii = (bytes) => String.fromCharCode(...bytes.filter((b) => b >= 0x20 && b < 0x7f)).trim();

/** 09 0A: "ECM-EngineControl" → { short: 'ECM', name: 'Engine Control' } */
export function parseEcuName(bytes) {
  const text = ascii(bytes.slice(3));
  if (!text) return null;
  const [short, ...rest] = text.split('-');
  const long = rest.join('-').trim();
  // Split CamelCase for readability: "EngineControl" → "Engine Control".
  const name = (long || short).replace(/([a-z])([A-Z])/g, '$1 $2');
  return { short: short.trim(), name, raw: text };
}

/** 09 04: one or more 16-character calibration IDs. */
export function parseCalIds(bytes) {
  const count = bytes[2];
  const out = [];
  for (let i = 0; i < count; i++) {
    const id = ascii(bytes.slice(3 + i * 16, 3 + (i + 1) * 16));
    if (id) out.push(id);
  }
  return out;
}

/** 09 06: one or more 4-byte calibration verification numbers, as hex. */
export function parseCvns(bytes) {
  const count = bytes[2];
  const out = [];
  for (let i = 0; i < count; i++) {
    const b = bytes.slice(3 + i * 4, 3 + (i + 1) * 4);
    if (b.length === 4) out.push(b.map(hex2).join(''));
  }
  return out;
}

const SPARK_PAIRS = ['Catalyst bank 1', 'Catalyst bank 2', 'O2 sensor bank 1', 'O2 sensor bank 2', 'EGR / VVT', 'Secondary air', 'Evaporative system', 'Rear O2 sensor bank 1', 'Rear O2 sensor bank 2'];
const COMPRESSION_PAIRS = ['NMHC catalyst', 'NOx catalyst', 'NOx adsorber', 'Particulate filter', 'Exhaust gas sensor', 'EGR / VVT', 'Boost pressure', 'Fuel system'];

/**
 * 09 08 / 09 0B in-use performance tracking: how many times each monitor has
 * completed versus how many times the conditions to run it were met.
 */
export function parsePerformance(bytes, compression = false) {
  const count = bytes[2];
  const n = [];
  for (let i = 0; i < count; i++) n.push(bytes[3 + i * 2] * 256 + bytes[4 + i * 2]);
  if (n.length < 2) return null;
  const names = compression ? COMPRESSION_PAIRS : SPARK_PAIRS;
  const monitors = [];
  for (let i = 0; i < names.length; i++) {
    const completed = n[2 + i * 2];
    const conditions = n[3 + i * 2];
    if (completed == null || conditions == null) break;
    if (!completed && !conditions) continue; // not fitted / not used
    monitors.push({ name: names[i], completed, conditions, ratio: conditions ? completed / conditions : null });
  }
  return { drivingCycles: n[0], ignitionCycles: n[1], monitors };
}

/**
 * Read names, calibration IDs, CVNs and performance counters for every
 * computer that supports them. Returns { [ecu]: { name, calIds, cvns, performance } }.
 */
export async function readVehicleInfo(elm, profile, { onStep } = {}) {
  const info = {};
  const ecu = (id) => (info[id] ??= { name: null, calIds: [], cvns: [], performance: null });
  if (elm.protocol === 'legacy') return info; // older protocols use a different layout
  const supported = new Set(Object.values(profile?.ecus ?? {}).flatMap((e) => e.supported09 ?? []));
  const want = (pid) => !supported.size || supported.has(pid);

  if (want(0x0a)) {
    onStep?.('computer names');
    for (const m of positive(await elm.send('090A', { timeoutMs: 3000 }), 0x09, 0x0a)) ecu(m.ecu).name = parseEcuName(m.bytes);
  }
  if (want(0x04)) {
    onStep?.('calibration IDs');
    for (const m of positive(await elm.send('0904', { timeoutMs: 3000 }), 0x09, 0x04)) ecu(m.ecu).calIds = parseCalIds(m.bytes);
  }
  if (want(0x06)) {
    onStep?.('calibration verification numbers');
    for (const m of positive(await elm.send('0906', { timeoutMs: 3000 }), 0x09, 0x06)) ecu(m.ecu).cvns = parseCvns(m.bytes);
  }
  for (const [pid, compression] of [[0x08, false], [0x0b, true]]) {
    if (!supported.has(pid)) continue;
    onStep?.('self-check counters');
    for (const m of positive(await elm.send('09' + hex2(pid), { timeoutMs: 3000 }), 0x09, pid)) ecu(m.ecu).performance = parsePerformance(m.bytes, compression);
  }
  const names = Object.entries(info).filter(([, v]) => v.name).map(([id, v]) => `${id}=${v.name.raw}`);
  elm.log.info(`Vehicle info: ${Object.keys(info).length} computer(s)${names.length ? `; names ${names.join(', ')}` : ''}`);
  return info;
}
