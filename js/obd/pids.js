// Mode 01 PID definitions and decode formulas (brief section 6).
// decode() takes the data bytes after "41 <pid>" and returns a number,
// string or object. Never hard-code what a car supports: the UI only shows
// PIDs the car reports in its supported-PID bitmaps.

const u16 = (d) => d[0] * 256 + d[1];
const pct = (d) => (d[0] * 100) / 255;
const temp = (d) => d[0] - 40;
const trim = (d) => ((d[0] - 128) * 100) / 128;

export const FUEL_TYPES = {
  0x00: 'Not available', 0x01: 'Petrol', 0x02: 'Methanol', 0x03: 'Ethanol', 0x04: 'Diesel',
  0x05: 'LPG', 0x06: 'CNG', 0x07: 'Propane', 0x08: 'Electric', 0x09: 'Bi-fuel petrol',
  0x0a: 'Bi-fuel methanol', 0x0b: 'Bi-fuel ethanol', 0x0c: 'Bi-fuel LPG', 0x0d: 'Bi-fuel CNG',
  0x0e: 'Bi-fuel propane', 0x0f: 'Bi-fuel electricity', 0x10: 'Bi-fuel electric + combustion',
  0x11: 'Hybrid petrol', 0x12: 'Hybrid ethanol', 0x13: 'Hybrid diesel', 0x14: 'Hybrid electric',
  0x15: 'Hybrid electric + combustion', 0x16: 'Hybrid regenerative', 0x17: 'Bi-fuel diesel',
};

export const OBD_STANDARDS = {
  1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD and OBD-II', 4: 'OBD-I', 5: 'Not OBD compliant',
  6: 'EOBD (Europe)', 7: 'EOBD and OBD-II', 8: 'EOBD and OBD', 9: 'EOBD, OBD and OBD-II',
  10: 'JOBD (Japan)', 11: 'JOBD and OBD-II', 12: 'JOBD and EOBD', 13: 'JOBD, EOBD and OBD-II',
  17: 'EMD', 18: 'EMD+', 19: 'HD OBD-C', 20: 'HD OBD', 21: 'WWH OBD', 23: 'HD EOBD-I',
  24: 'HD EOBD-I N', 25: 'HD EOBD-II', 26: 'HD EOBD-II N', 28: 'OBDBr-1', 29: 'OBDBr-2',
  30: 'KOBD', 31: 'IOBD I', 32: 'IOBD II', 33: 'HD EOBD-IV',
};

const FUEL_SYSTEM = { 0: 'Off', 1: 'Open loop (cold)', 2: 'Closed loop', 4: 'Open loop (load/decel)', 8: 'Open loop (fault)', 16: 'Closed loop (fault)' };

const SPARK_MONITORS = ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air', 'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR / VVT'];
const COMPRESSION_MONITORS = ['NMHC catalyst', 'NOx / SCR', null, 'Boost pressure', null, 'Exhaust gas sensor', 'Particulate filter', 'EGR / VVT'];
const CONTINUOUS_MONITORS = ['Misfire', 'Fuel system', 'Components'];

/** PID 01: MIL, DTC count and readiness monitors. */
export function decodeMonitorStatus([a = 0, b = 0, c = 0, d = 0]) {
  const compression = !!(b & 0x08);
  const monitors = [];
  CONTINUOUS_MONITORS.forEach((name, i) => {
    const supported = !!(b & (1 << i));
    const incomplete = !!(b & (1 << (i + 4)));
    monitors.push({ name, continuous: true, status: supported ? (incomplete ? 'not ready' : 'ready') : 'not supported' });
  });
  const names = compression ? COMPRESSION_MONITORS : SPARK_MONITORS;
  names.forEach((name, i) => {
    if (!name) return;
    const supported = !!(c & (1 << i));
    const incomplete = !!(d & (1 << i));
    monitors.push({ name, continuous: false, status: supported ? (incomplete ? 'not ready' : 'ready') : 'not supported' });
  });
  return { mil: !!(a & 0x80), dtcCount: a & 0x7f, ignition: compression ? 'compression' : 'spark', monitors };
}

/**
 * poll: 'fast' (every cycle) | 'slow' (every N cycles) | 'once'
 * group: 'main' | 'advanced' | 'info'
 */
export const PIDS = {
  0x01: { name: 'Monitor status', unit: '', bytes: 4, decode: decodeMonitorStatus, poll: 'once', group: 'info' },
  0x03: { name: 'Fuel system status', unit: '', bytes: 2, decode: (d) => FUEL_SYSTEM[d[0]] ?? `0x${d[0].toString(16)}`, poll: 'slow', group: 'advanced' },
  0x04: { name: 'Engine load', unit: '%', bytes: 1, decode: pct, poll: 'fast', group: 'main' },
  0x05: { name: 'Coolant temp', unit: '°C', kind: 'temp', bytes: 1, decode: temp, poll: 'slow', group: 'main' },
  0x06: { name: 'Short-term fuel trim (bank 1)', unit: '%', bytes: 1, decode: trim, poll: 'slow', group: 'advanced' },
  0x07: { name: 'Long-term fuel trim (bank 1)', unit: '%', bytes: 1, decode: trim, poll: 'slow', group: 'advanced' },
  0x08: { name: 'Short-term fuel trim (bank 2)', unit: '%', bytes: 1, decode: trim, poll: 'slow', group: 'advanced' },
  0x09: { name: 'Long-term fuel trim (bank 2)', unit: '%', bytes: 1, decode: trim, poll: 'slow', group: 'advanced' },
  0x0b: { name: 'Intake manifold pressure', unit: 'kPa', bytes: 1, decode: (d) => d[0], poll: 'fast', group: 'advanced' },
  0x0c: { name: 'RPM', unit: 'rpm', digits: 0, bytes: 2, decode: (d) => u16(d) / 4, poll: 'fast', group: 'main' },
  0x0d: { name: 'Speed', unit: 'km/h', digits: 0, kind: 'speed', bytes: 1, decode: (d) => d[0], poll: 'fast', group: 'main' },
  0x0e: { name: 'Timing advance', unit: '°', bytes: 1, decode: (d) => d[0] / 2 - 64, poll: 'slow', group: 'advanced' },
  0x0f: { name: 'Intake air temp', unit: '°C', kind: 'temp', bytes: 1, decode: temp, poll: 'slow', group: 'main' },
  0x10: { name: 'MAF air flow', unit: 'g/s', bytes: 2, decode: (d) => u16(d) / 100, poll: 'fast', group: 'advanced' },
  0x11: { name: 'Throttle', unit: '%', bytes: 1, decode: pct, poll: 'fast', group: 'main' },
  0x13: { name: 'O2 sensors present', unit: '', bytes: 1, decode: (d) => `0x${d[0].toString(16).padStart(2, '0')}`, poll: 'once', group: 'info' },
  0x1c: { name: 'OBD standard', unit: '', bytes: 1, decode: (d) => OBD_STANDARDS[d[0]] ?? `type ${d[0]}`, poll: 'once', group: 'info' },
  0x1f: { name: 'Run time since start', unit: 's', bytes: 2, decode: u16, poll: 'slow', group: 'main' },
  0x21: { name: 'Distance with MIL on', unit: 'km', kind: 'distance', bytes: 2, decode: u16, poll: 'once', group: 'info' },
  0x2f: { name: 'Fuel level', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'main' },
  0x30: { name: 'Warm-ups since codes cleared', unit: '', bytes: 1, decode: (d) => d[0], poll: 'once', group: 'info' },
  0x31: { name: 'Distance since codes cleared', unit: 'km', kind: 'distance', bytes: 2, decode: u16, poll: 'once', group: 'info' },
  0x33: { name: 'Barometric pressure', unit: 'kPa', bytes: 1, decode: (d) => d[0], poll: 'slow', group: 'advanced' },
  0x3c: { name: 'Catalyst temp (B1S1)', unit: '°C', kind: 'temp', bytes: 2, decode: (d) => u16(d) / 10 - 40, poll: 'slow', group: 'advanced' },
  0x42: { name: 'Control module voltage', unit: 'V', digits: 2, bytes: 2, decode: (d) => u16(d) / 1000, poll: 'slow', group: 'main' },
  0x43: { name: 'Absolute load', unit: '%', bytes: 2, decode: (d) => (u16(d) * 100) / 255, poll: 'slow', group: 'advanced' },
  0x44: { name: 'Commanded air-fuel ratio (λ)', unit: '', bytes: 2, decode: (d) => (u16(d) * 2) / 65536, poll: 'slow', group: 'advanced' },
  0x45: { name: 'Relative throttle', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x46: { name: 'Ambient air temp', unit: '°C', kind: 'temp', bytes: 1, decode: temp, poll: 'slow', group: 'main' },
  0x47: { name: 'Absolute throttle B', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x49: { name: 'Accelerator pedal D', unit: '%', bytes: 1, decode: pct, poll: 'fast', group: 'advanced' },
  0x4a: { name: 'Accelerator pedal E', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x4c: { name: 'Commanded throttle actuator', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x4d: { name: 'Time with MIL on', unit: 'min', bytes: 2, decode: u16, poll: 'once', group: 'info' },
  0x4e: { name: 'Time since codes cleared', unit: 'min', bytes: 2, decode: u16, poll: 'once', group: 'info' },
  0x51: { name: 'Fuel type', unit: '', bytes: 1, decode: (d) => FUEL_TYPES[d[0]] ?? `type 0x${d[0].toString(16)}`, poll: 'once', group: 'info' },
  0x5b: { name: 'Hybrid battery remaining life', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'main' },
  0x5c: { name: 'Oil temp', unit: '°C', kind: 'temp', bytes: 1, decode: temp, poll: 'slow', group: 'main' },

  // Wider coverage for other people's cars: older petrol, diesel, newer cars.
  0x0a: { name: 'Fuel pressure', unit: 'kPa', bytes: 1, decode: (d) => d[0] * 3, poll: 'slow', group: 'advanced' },
  0x22: { name: 'Fuel rail pressure (rel. manifold)', unit: 'kPa', bytes: 2, decode: (d) => u16(d) * 0.079, poll: 'slow', group: 'advanced' },
  0x23: { name: 'Fuel rail pressure', unit: 'kPa', digits: 0, bytes: 2, decode: (d) => u16(d) * 10, poll: 'slow', group: 'advanced' },
  0x2c: { name: 'Commanded EGR', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x2d: { name: 'EGR error', unit: '%', bytes: 1, decode: (d) => (d[0] * 100) / 128 - 100, poll: 'slow', group: 'advanced' },
  0x2e: { name: 'Commanded evaporative purge', unit: '%', bytes: 1, decode: pct, poll: 'slow', group: 'advanced' },
  0x3d: { name: 'Catalyst temp (B2S1)', unit: '°C', kind: 'temp', bytes: 2, decode: (d) => u16(d) / 10 - 40, poll: 'slow', group: 'advanced' },
  0x3e: { name: 'Catalyst temp (B1S2)', unit: '°C', kind: 'temp', bytes: 2, decode: (d) => u16(d) / 10 - 40, poll: 'slow', group: 'advanced' },
  0x3f: { name: 'Catalyst temp (B2S2)', unit: '°C', kind: 'temp', bytes: 2, decode: (d) => u16(d) / 10 - 40, poll: 'slow', group: 'advanced' },
  0x52: { name: 'Ethanol fuel', unit: '%', bytes: 1, decode: pct, poll: 'once', group: 'info' },
  0x59: { name: 'Fuel rail absolute pressure', unit: 'kPa', digits: 0, bytes: 2, decode: (d) => u16(d) * 10, poll: 'slow', group: 'advanced' },
  0x5a: { name: 'Relative accelerator pedal', unit: '%', bytes: 1, decode: pct, poll: 'fast', group: 'advanced' },
  0x5d: { name: 'Fuel injection timing', unit: '°', bytes: 2, decode: (d) => u16(d) / 128 - 210, poll: 'slow', group: 'advanced' },
  0x5e: { name: 'Engine fuel rate', unit: 'L/h', bytes: 2, decode: (d) => u16(d) / 20, poll: 'slow', group: 'main' },
  0x61: { name: 'Driver demand torque', unit: '%', bytes: 1, decode: (d) => d[0] - 125, poll: 'fast', group: 'advanced' },
  0x62: { name: 'Actual engine torque', unit: '%', bytes: 1, decode: (d) => d[0] - 125, poll: 'fast', group: 'advanced' },
  0x63: { name: 'Engine reference torque', unit: 'Nm', bytes: 2, decode: u16, poll: 'once', group: 'info' },
  // Byte A says which of two sensors is present; report sensor 1, else 2.
  0x67: { name: 'Coolant temp (sensor 1/2)', unit: '°C', kind: 'temp', bytes: 3, decode: (d) => (d[0] & 1 ? d[1] : d[2]) - 40, poll: 'slow', group: 'advanced' },
  0xa6: { name: 'Odometer', unit: 'km', kind: 'distance', digits: 0, bytes: 4, decode: (d) => (d[0] * 2 ** 24 + d[1] * 2 ** 16 + d[2] * 2 ** 8 + d[3]) / 10, poll: 'once', group: 'info' },
};

// 0x14–0x1B: narrowband O2 sensors (older petrol cars). A = volts × 200.
for (let i = 0; i < 8; i++) {
  const bank = i < 4 ? 1 : 2;
  const sensor = (i % 4) + 1;
  PIDS[0x14 + i] = { name: `O2 sensor B${bank}S${sensor} voltage`, unit: 'V', digits: 2, bytes: 2, decode: (d) => d[0] / 200, poll: 'slow', group: 'advanced' };
}

/** PIDs 0x00, 0x20, 0x40 … are supported-PID bitmaps, not data. */
export const isBitmapPid = (pid) => pid % 0x20 === 0;

/** Decode a 4-byte supported-PID bitmap for the range base+1 … base+0x20. */
export function decodeBitmap(bytes, base) {
  const out = [];
  for (let bit = 0; bit < 32; bit++) {
    if (bytes[bit >> 3] & (0x80 >> (bit & 7))) out.push(base + bit + 1);
  }
  return out;
}

export function decodePid(pid, data) {
  const def = PIDS[pid];
  if (!def) return { pid, name: `PID ${hex2(pid)}`, raw: data, value: null, known: false };
  if (data.length < def.bytes) return { pid, name: def.name, raw: data, value: null, known: true, error: 'short reply' };
  return { pid, name: def.name, unit: def.unit, raw: data, value: def.decode(data), known: true };
}

export function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

// --- units -------------------------------------------------------------------

export const DEFAULT_UNITS = { speed: 'mph', temp: 'C', distance: 'mi' };

/** Convert a decoded metric value into display units: { value, unit }. */
export function toDisplay(pid, value, units = DEFAULT_UNITS) {
  const def = PIDS[pid];
  if (!def || typeof value !== 'number') return { value, unit: def?.unit ?? '' };
  if (def.kind === 'speed' && units.speed === 'mph') return { value: value * 0.621371, unit: 'mph' };
  if (def.kind === 'distance' && units.distance === 'mi') return { value: value * 0.621371, unit: 'mi' };
  if (def.kind === 'temp' && units.temp === 'F') return { value: (value * 9) / 5 + 32, unit: '°F' };
  return { value, unit: def.unit };
}

export function formatValue(pid, value, units = DEFAULT_UNITS) {
  if (value == null) return '—';
  if (typeof value === 'object') {
    if (pid === 0x01) return `MIL ${value.mil ? 'ON' : 'off'}, ${value.dtcCount} code(s)`;
    return JSON.stringify(value);
  }
  const d = toDisplay(pid, value, units);
  if (typeof d.value !== 'number') return String(d.value);
  const def = PIDS[pid];
  const digits = def?.digits ?? (Math.abs(d.value) >= 100 || Number.isInteger(d.value) ? 0 : 1);
  return `${d.value.toFixed(digits)}${d.unit ? ' ' + d.unit : ''}`;
}
