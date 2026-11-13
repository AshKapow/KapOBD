// Mode 06: on-board monitor test results (read-only). CAN layout only:
// each record is MID, TID, UASID, value (2 bytes), min limit (2), max limit (2).
// Pass/fail is computed on the raw numbers, so it is right even when the
// scaling (UASID) isn't in our table; unknown scalings are shown raw.

import { hex2, decodeBitmap, isBitmapPid } from './pids.js';
import { positive } from './modes.js';

// Standard monitor IDs (SAE J1979). Manufacturer test IDs are not standard.
export function midName(mid) {
  const bank = (n) => `bank ${n}`;
  if (mid >= 0x01 && mid <= 0x10) return `O2 sensor ${bank(((mid - 1) >> 2) + 1)} sensor ${((mid - 1) & 3) + 1}`;
  if (mid >= 0x21 && mid <= 0x24) return `Catalyst ${bank(mid - 0x20)}`;
  if (mid >= 0x31 && mid <= 0x34) return `EGR ${bank(mid - 0x30)}`;
  if (mid >= 0x35 && mid <= 0x38) return `VVT ${bank(mid - 0x34)}`;
  const named = {
    0x39: 'Evaporative system (cap off / 0.150″ leak)',
    0x3a: 'Evaporative system (0.090″ leak)',
    0x3b: 'Evaporative system (0.040″ leak)',
    0x3c: 'Evaporative system (0.020″ leak)',
    0x3d: 'Evaporative purge flow',
    0xa1: 'Misfire (all cylinders)',
    0xb0: 'Particulate filter bank 1',
    0xb1: 'Particulate filter bank 2',
  };
  if (named[mid]) return named[mid];
  if (mid >= 0x41 && mid <= 0x50) return `O2 sensor heater ${bank(((mid - 0x41) >> 2) + 1)} sensor ${((mid - 0x41) & 3) + 1}`;
  if (mid >= 0x61 && mid <= 0x64) return `Heated catalyst ${bank(mid - 0x60)}`;
  if (mid >= 0x71 && mid <= 0x74) return `Secondary air ${mid - 0x70}`;
  if (mid >= 0x81 && mid <= 0x84) return `Fuel system ${bank(mid - 0x80)}`;
  if (mid >= 0x85 && mid <= 0x86) return `Boost pressure ${bank(mid - 0x84)}`;
  if (mid >= 0x90 && mid <= 0x91) return `NOx adsorber ${bank(mid - 0x8f)}`;
  if (mid >= 0x98 && mid <= 0x99) return `NOx catalyst ${bank(mid - 0x97)}`;
  if (mid >= 0xa2 && mid <= 0xad) return `Misfire cylinder ${mid - 0xa1}`;
  return `Monitor ${hex2(mid)}`;
}

export function testName(mid, tid) {
  // Standardised for the misfire monitors.
  if (mid >= 0xa1 && mid <= 0xad) {
    if (tid === 0x0b) return 'Misfires, average of the last 10 drives';
    if (tid === 0x0c) return 'Misfires, this or the last drive';
  }
  return tid >= 0x80 ? `Manufacturer test ${hex2(tid)}` : `Test ${hex2(tid)}`;
}

// Unit-and-scaling IDs we're confident of: [scale, unit, offset].
// 0x80+ are the signed versions of 0x00+.
const UASID = {
  0x01: [1, ''],
  0x02: [0.1, ''],
  0x03: [0.01, ''],
  0x04: [0.001, ''],
  0x07: [0.25, 'rpm'],
  0x09: [1, 'km/h'],
  0x0a: [0.122, 'mV'],
  0x0b: [0.001, 'V'],
  0x0c: [0.01, 'V'],
  0x0e: [0.001, 'A'],
  0x0f: [0.01, 'A'],
  0x10: [1, 'ms'],
  0x11: [100, 'ms'],
  0x12: [1, 's'],
  0x14: [1, 'Ω'],
  0x16: [0.1, '°C', -40],
  0x1a: [1, 'kPa'],
  0x24: [1, 'counts'],
  0x25: [1, 'km'],
  0x27: [0.01, 'g/s'],
  0x2f: [0.01, '%'],
};

export function scale(uasid, raw) {
  const signed = uasid >= 0x80;
  const n = signed && raw >= 0x8000 ? raw - 0x10000 : raw;
  const base = UASID[uasid & 0x7f];
  // Signed temperatures have no offset; unsigned 0x16 does.
  if (!base) return { value: n, unit: '', known: false };
  const [k, unit, offset = 0] = base;
  return { value: n * k + (signed ? 0 : offset), unit, known: true };
}

/** Parse the records of one 06 <MID> reply (bytes after the 0x46 service byte). */
export function parseRecords(bytes) {
  const out = [];
  for (let i = 0; i + 9 <= bytes.length; i += 9) {
    const [mid, tid, uasid, vh, vl, nh, nl, xh, xl] = bytes.slice(i, i + 9);
    const signed = uasid >= 0x80;
    const s16 = (h, l) => {
      const n = h * 256 + l;
      return signed && n >= 0x8000 ? n - 0x10000 : n;
    };
    const raw = { value: s16(vh, vl), min: s16(nh, nl), max: s16(xh, xl) };
    const passed = raw.value >= raw.min && raw.value <= raw.max;
    const v = scale(uasid, vh * 256 + vl);
    const lo = scale(uasid, nh * 256 + nl);
    const hi = scale(uasid, xh * 256 + xl);
    out.push({ mid, tid, uasid, name: testName(mid, tid), value: v.value, min: lo.value, max: hi.value, unit: v.unit, known: v.known, passed, raw });
  }
  return out;
}

/**
 * Read every supported monitor's results. CAN only (older protocols use a
 * different layout). Returns { supported: bool, monitors: [{ ecu, mid, name, tests }] }.
 */
export async function readMonitorTests(elm, { onStep } = {}) {
  if (elm.protocol === 'legacy') return { supported: false, reason: 'This car’s protocol uses an older format for self-test results that KapOBD doesn’t read yet.', monitors: [] };
  const mids = new Map(); // ecu -> [mid]
  for (let base = 0; base <= 0xe0; base += 0x20) {
    const res = await elm.send('06' + hex2(base));
    const msgs = positive(res, 0x06, base).filter((m) => m.bytes.length >= 6);
    if (!msgs.length) break;
    let more = false;
    for (const m of msgs) {
      const list = decodeBitmap(m.bytes.slice(2, 6), base);
      const ids = mids.get(m.ecu) ?? [];
      for (const id of list) if (!isBitmapPid(id) && !ids.includes(id)) ids.push(id);
      mids.set(m.ecu, ids);
      if (list.includes(base + 0x20)) more = true;
    }
    if (!more) break;
  }
  if (!mids.size) return { supported: false, reason: 'This car didn’t report any self-test results.', monitors: [] };

  const monitors = [];
  const all = [...new Set([...mids.values()].flat())].sort((a, b) => a - b);
  for (const mid of all) {
    onStep?.(midName(mid));
    const res = await elm.send('06' + hex2(mid), { timeoutMs: 3000 });
    for (const m of positive(res, 0x06, mid)) {
      const tests = parseRecords(m.bytes.slice(1)).filter((t) => t.mid === mid);
      if (tests.length) monitors.push({ ecu: m.ecu, mid, name: midName(mid), tests });
    }
  }
  const failed = monitors.flatMap((m) => m.tests.filter((t) => !t.passed).map((t) => ({ ...t, monitor: m.name, ecu: m.ecu })));
  elm.log.info(`Self-tests: ${monitors.length} monitors, ${monitors.reduce((n, m) => n + m.tests.length, 0)} results, ${failed.length} outside limits`);
  return { supported: true, monitors, failed, readAt: Date.now() };
}
