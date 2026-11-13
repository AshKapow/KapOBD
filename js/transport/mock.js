// Simulated ELM327 adapter + cars. Same interface as BleTransport.
// Deliberately independent of the decoders in js/obd/ so tests that run the
// real decoders against it actually check something.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- byte helpers -----------------------------------------------------------
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const pct = (v) => [clampByte((v * 255) / 100)];
const u16 = (v) => {
  const n = Math.max(0, Math.min(65535, Math.round(v)));
  return [n >> 8, n & 0xff];
};
const u32 = (v) => {
  const n = Math.max(0, Math.round(v));
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
};
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const asciiPad = (text, len) => [...text.slice(0, len)].map((c) => c.charCodeAt(0)).concat(Array(Math.max(0, len - text.length)).fill(0));
// In-use performance counters (09 08 spark / 09 0B diesel): OBD cycles,
// ignitions, then completed/conditions pairs per monitor.
const IPT_SPARK = [112, 340, 18, 110, 0, 0, 25, 110, 0, 0, 30, 105, 0, 0, 6, 40, 22, 108, 0, 0];
const IPT_DIESEL = [96, 280, 20, 90, 15, 90, 0, 0, 4, 90, 18, 90, 22, 92, 25, 92, 30, 95];

/** Small deterministic PRNG (mulberry32) for repeatable simulations. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeDtc(code) {
  const letter = 'PCBU'.indexOf(code[0]);
  const d = code.slice(1).split('').map((c) => parseInt(c, 16));
  return [(letter << 6) | (d[0] << 4) | d[1], (d[2] << 4) | d[3]];
}

/** 4-byte supported-PID bitmap for the range base+1 … base+0x20. */
function bitmap(pids, base) {
  const bytes = [0, 0, 0, 0];
  for (const p of pids) {
    if (p > base && p <= base + 0x20) {
      const bit = p - base - 1; // 0 = MSB of byte A
      bytes[bit >> 3] |= 0x80 >> (bit & 7);
    }
  }
  if (pids.some((p) => p > base + 0x20)) bytes[3] |= 0x01; // "next range supported"
  return bytes;
}

// --- vehicle profiles -------------------------------------------------------
const CAN11 = { dpn: '6', kind: 'can11', name: 'ISO 15765-4 (CAN 11/500)' };
const CAN29 = { dpn: '7', kind: 'can29', name: 'ISO 15765-4 (CAN 29/500)' };
const K_LINE = { dpn: '3', kind: 'legacy', name: 'ISO 9141-2' };

export const MOCK_PROFILES = {
  // Modelled on a real field log from a full hybrid with a security gateway:
  // 29-bit CAN, five computers all answering the common PIDs, the engine
  // computer at 18DAF115 supporting ~50 PIDs, PID 9A on the hybrid computer,
  // fuel type reported as plain petrol, no fuel level (2F) or odometer (A6).
  hybrid: {
    label: 'Simulator: hybrid with security gateway',
    description: 'Five computers, engine often off, refuses clearing codes',
    protocol: CAN29,
    vin: 'SIMHYBRID00000001',
    hybrid: true,
    fuelType: 0x01, // the real car reports petrol, not a hybrid fuel type
    clear: 'refuse', // security gateway
    ecus: {
      '18DAF115': {
        name: 'engine',
        pids01: [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x15, 0x1C, 0x1F, 0x21, 0x24, 0x2C, 0x2D, 0x2E, 0x30, 0x31, 0x33, 0x3C, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x4A, 0x4C, 0x51, 0x5B, 0x5C, 0x5E, 0x62, 0x63, 0x67, 0x68, 0x78, 0x7A, 0x7C, 0x8B, 0x8E, 0x9D, 0x9E],
        pids09: [0x02, 0x04, 0x06, 0x08, 0x0A],
        info: { name: 'ECM-EngineControl', calid: 'SIMCAL-ENG-0001', cvn: [0x1a, 0x2b, 0x3c, 0x4d], ipt: IPT_SPARK },
        dtcs: true,
        delay: (s) => (s.engineOn ? 60 : 350), // engine computer is slow while the engine is stopped
      },
      '18DAF1DA': {
        name: 'hybrid',
        info: { name: 'HCM-HybridControl', calid: 'SIMCAL-HYB-0002', cvn: [0x5e, 0x6f, 0x70, 0x81] },
        pids01: [0x01, 0x04, 0x05, 0x0C, 0x0D, 0x1C, 0x1F, 0x21, 0x30, 0x31, 0x33, 0x41, 0x42, 0x43, 0x46, 0x49, 0x4A, 0x5B, 0x9A],
        pids09: [0x04, 0x06, 0x0A],
        dtcs: false,
        permanent: false,
        delay: () => 30,
      },
      '18DAF1DB': {
        name: 'other',
        info: { name: 'BECM-BatteryEnergy', calid: 'SIMCAL-BAT-0003', cvn: [0x92, 0xa3, 0xb4, 0xc5] },
        pids01: [0x01, 0x04, 0x05, 0x0C, 0x0D, 0x1C, 0x21, 0x30, 0x31, 0x33, 0x41, 0x42, 0x46, 0x5B],
        pids09: [0x04, 0x06, 0x0A],
        dtcs: false,
        permanent: false,
        delay: () => 30,
      },
      '18DAF1E3': {
        name: 'other',
        info: { name: 'TCM-TransmissionCtl', calid: 'SIMCAL-TRN-0004', cvn: [0xd6, 0xe7, 0xf8, 0x09] },
        pids01: [0x01, 0x04, 0x05, 0x0C, 0x0D, 0x1C, 0x21, 0x30, 0x31, 0x33, 0x41, 0x42, 0x43, 0x46, 0x5B],
        pids09: [0x04, 0x06, 0x0A],
        dtcs: false,
        permanent: false,
        delay: () => 30,
      },
      '18DAF1DF': {
        name: 'other',
        info: { name: 'EPS-PowerSteering', calid: 'SIMCAL-EPS-0005', cvn: [0x13, 0x24, 0x35, 0x46] },
        pids01: [0x01, 0x04, 0x05, 0x0C, 0x0D, 0x1C, 0x21, 0x30, 0x31, 0x33, 0x41, 0x42, 0x43, 0x46, 0x5B],
        pids09: [0x04, 0x06, 0x0A],
        dtcs: false,
        permanent: false,
        delay: () => 30,
      },
    },
    faults: { stored: ['P0420'], pending: ['P0171'], permanent: ['P0420'] },
    // Mode 06: catalyst result over its limit, matching the stored P0420.
    tests06: [
      [0x01, 0x81, 0x0a, 3690, 3279, 4918],
      [0x21, 0x80, 0x01, 260, 0, 200],
      [0x41, 0x81, 0x14, 9, 2, 15],
      [0xa1, 0x0b, 0x24, 0, 0, 30],
      [0xa1, 0x0c, 0x24, 0, 0, 65535],
    ],
  },
  petrol: {
    label: 'Simulator: petrol car',
    description: 'One ECU, lots of data, clearing allowed',
    protocol: CAN11,
    vin: 'SIMPETROL00000002',
    hybrid: false,
    fuelType: 0x01, // petrol
    clear: 'allow',
    ecus: {
      '7E8': {
        name: 'engine',
        pids01: [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x1C, 0x1F, 0x21, 0x2F, 0x30, 0x31, 0x33, 0x3C, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4A, 0x4C, 0x4D, 0x4E, 0x51],
        pids09: [0x02, 0x04, 0x06, 0x08, 0x0A],
        info: { name: 'ECM-EngineControl', calid: 'SIMCAL-PET-0100', cvn: [0xca, 0xfe, 0x12, 0x34], ipt: IPT_SPARK },
        dtcs: true,
        delay: () => 45,
      },
    },
    faults: { stored: ['P0301', 'P0128'], pending: [], permanent: ['P0301'] },
    // Mode 06: cylinder 1 misfire count over its limit, matching P0301.
    tests06: [
      [0x01, 0x81, 0x0a, 3690, 3279, 4918],
      [0x02, 0x81, 0x0a, 3772, 3279, 4918],
      [0x21, 0x80, 0x01, 120, 0, 200],
      [0x39, 0x80, 0x1a, 0, 0, 0],
      [0xa2, 0x0b, 0x24, 38, 0, 30],
      [0xa2, 0x0c, 0x24, 12, 0, 65535],
      [0xa3, 0x0b, 0x24, 0, 0, 30],
      [0xa4, 0x0b, 0x24, 1, 0, 30],
      [0xa5, 0x0b, 0x24, 0, 0, 30],
    ],
  },
  oldpetrol: {
    label: 'Simulator: older petrol car',
    description: 'K-line (ISO 9141-2), pre-CAN, 4 stored codes',
    protocol: K_LINE,
    vin: 'SIMOLDCAR00000003',
    hybrid: false,
    fuelType: null,
    clear: 'allow',
    noPermanent: true, // mode 0A did not exist yet
    ecus: {
      '10': {
        name: 'engine',
        pids01: [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x13, 0x14, 0x15, 0x1C],
        pids09: [0x02],
        dtcs: true,
        delay: () => 110,
      },
    },
    faults: { stored: ['P0171', 'P0300', 'P0442', 'P0128'], pending: ['P0420'], permanent: [] },
  },
  diesel: {
    label: 'Simulator: diesel (29-bit CAN)',
    description: 'Compression-ignition monitors, 2 ECUs',
    protocol: CAN29,
    vin: 'SIMDIESEL00000004',
    hybrid: false,
    diesel: true,
    fuelType: 0x04, // diesel
    clear: 'allow',
    ecus: {
      '18DAF110': {
        name: 'engine',
        pids01: [0x01, 0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x1C, 0x1F, 0x21, 0x23, 0x2C, 0x2F, 0x31, 0x33, 0x42, 0x46, 0x4D, 0x4E, 0x51, 0x5E, 0x61, 0x62, 0x63, 0xA6],
        pids09: [0x02, 0x04, 0x06, 0x0A, 0x0B],
        info: { name: 'ECM-EngineControl', calid: 'SIMCAL-DSL-0200', cvn: [0x0d, 0x1e, 0x2f, 0x30], ipt: IPT_DIESEL },
        dtcs: true,
        delay: () => 50,
      },
      '18DAF118': {
        name: 'transmission',
        pids01: [0x01, 0x0D],
        pids09: [0x04, 0x0A],
        info: { name: 'TCM-TransmissionCtl', calid: 'SIMCAL-TRN-0201', cvn: [] },
        dtcs: false,
        delay: () => 35,
      },
    },
    faults: { stored: [], pending: ['P0401'], permanent: [] },
    tests06: [
      [0x31, 0x80, 0x27, 1850, 1200, 2600],
      [0xb0, 0x80, 0x1a, 6, 0, 20],
    ],
  },
};

// --- simulated ELM327 -------------------------------------------------------
export class SimElm {
  constructor(profileName, opts, emit) {
    const p = MOCK_PROFILES[profileName];
    if (!p) throw new Error(`Unknown mock profile ${profileName}`);
    this.profile = p;
    this.kind = p.protocol.kind;
    this.opts = { latencyMs: 30, noDataRate: 0, dropRate: 0, tinyFragments: false, timeScale: 1, seed: null, parked: false, ...opts };
    // A seed makes every "random" event repeatable (tests); otherwise truly random.
    this.random = this.opts.seed == null ? Math.random : seededRandom(this.opts.seed);
    this.emit = emit;
    this.t0 = Date.now();
    this.inbuf = '';
    this.received = []; // every command line received, for tests
    this.faults = structuredClone(p.faults);
    this.mil = this.faults.stored.length > 0;
    this.monitorsIncomplete = p.diesel ? 0x40 : 0x04; // DPF / evap not ready
    this.distSinceClear = 4180;
    this.minsSinceClear = 9100;
    this.reset();
  }

  reset() {
    this.echo = true;
    this.linefeeds = true;
    this.spaces = true;
    this.headers = false;
    this.searched = false;
    this.last = null;
  }

  /** Park (ignition on, engine off) or start up. Starting a conventional engine cranks briefly. */
  setParked(parked) {
    if (this.opts.parked && !parked && !this.profile.hybrid) this.crankingUntil = Date.now() + 1300;
    this.opts.parked = !!parked;
  }

  input(text) {
    this.inbuf += text;
    let i;
    while ((i = this.inbuf.indexOf('\r')) >= 0) {
      const line = this.inbuf.slice(0, i);
      this.inbuf = this.inbuf.slice(i + 1);
      this.handle(line);
    }
  }

  state() {
    const t = ((Date.now() - this.t0) / 1000) * this.opts.timeScale;
    const cycle = t % 90;
    // parked: ignition on, engine off, stationary (what clearing codes needs).
    const parked = !!this.opts.parked;
    const speed = parked ? 0 : Math.max(0, 55 * (1 - Math.cos((2 * Math.PI * cycle) / 90)) / 2 + Math.sin(t / 3) * 2);
    const engineOn = parked ? false : this.profile.hybrid ? speed > 38 || (t % 300 > 240 && speed > 5) : true;
    const idle = this.profile.diesel ? 820 : 750;
    const rpm = engineOn ? (this.profile.hybrid ? 1250 + speed * 22 : idle + speed * 30) + Math.sin(t) * 30 : 0;
    const load = engineOn ? 18 + speed * 0.6 + Math.sin(t * 1.3) * 4 : 0;
    const coolant = Math.min(this.profile.hybrid ? 84 : 91, 18 + t * 0.4);
    return {
      t,
      speed,
      engineOn,
      rpm,
      load,
      throttle: engineOn ? 14 + speed * 0.35 : 0,
      coolant,
      oil: coolant - 4,
      iat: 17 + Math.sin(t / 20),
      ambient: 11,
      map: engineOn ? (this.profile.diesel ? 100 + load * 0.9 : 28 + load * 0.7) : 101,
      baro: 101,
      maf: engineOn ? (rpm / 1000) * (load / 10) : 0,
      fuel: Math.max(5, 62 - t * 0.002),
      // 12 V system: resting when parked, a dip while a conventional engine cranks, charging once running.
      volts:
        this.crankingUntil && Date.now() < this.crankingUntil
          ? 10.1 + Math.sin(t * 7) * 0.15
          : parked
            ? 12.55 + Math.sin(t / 7) * 0.02
            : engineOn || this.profile.hybrid
              ? 14.15 + Math.sin(t / 7) * 0.05
              : 12.6,
      hvBattery: 78,
      stft: engineOn ? Math.sin(t * 2) * 3 : 0,
      ltft: engineOn ? 2.3 : 0,
      runtime: t,
      railKpa: 30000 + load * 900,
      fuelRate: engineOn ? 0.8 + load * 0.08 : 0,
      odometerKm: 48213.4 + t * (speed / 3600),
      // Hybrid pack: positive current = discharging (electric drive), negative = charging.
      hvVolts: 232 + Math.sin(t / 9) * 6,
      hvAmps: parked ? 1.5 : engineOn ? -12 + Math.sin(t) * 4 : speed > 1 ? 18 + speed * 0.9 : 2,
    };
  }

  encodePid(pid, s, ecu) {
    switch (pid) {
      case 0x01: {
        const own = ecu.dtcs;
        const count = own ? this.faults.stored.length : 0;
        const a = (own && this.mil ? 0x80 : 0) | count;
        // Other computers: only the continuous "components" monitor, complete.
        if (!own) return [0x00, this.profile.diesel ? 0x0c : 0x04, 0x00, 0x00];
        // B: misfire/fuel/components supported (+ bit 3 for diesel); C: supported; D: incomplete
        return this.profile.diesel ? [a, 0x0f, 0xeb, this.monitorsIncomplete] : [a, 0x07, 0x65, this.monitorsIncomplete];
      }
      case 0x03: return [0x02, 0x00]; // closed loop
      case 0x04: return pct(s.load);
      case 0x05: return [clampByte(s.coolant + 40)];
      case 0x06: case 0x08: return [clampByte(128 + s.stft * 1.28)];
      case 0x07: case 0x09: return [clampByte(128 + s.ltft * 1.28)];
      case 0x0B: return [clampByte(s.map)];
      case 0x0C: return u16(s.rpm * 4);
      case 0x0D: return [clampByte(s.speed)];
      case 0x0E: return [clampByte((s.engineOn ? 12 : 0) * 2 + 128)];
      case 0x0F: return [clampByte(s.iat + 40)];
      case 0x10: return u16(s.maf * 100);
      case 0x11: return pct(s.throttle);
      case 0x13: return [0x03];
      case 0x14: case 0x15: return [clampByte((0.45 + Math.sin(s.t * 3) * 0.35) * 200), 0xff];
      case 0x1C: return [0x06]; // EOBD
      case 0x1F: return u16(s.runtime);
      case 0x21: return u16(0);
      case 0x23: return u16(s.railKpa / 10);
      case 0x2C: return pct(s.engineOn ? 20 : 0);
      case 0x2F: return pct(s.fuel);
      case 0x30: return [37];
      case 0x31: return u16(this.distSinceClear);
      case 0x33: return [clampByte(s.baro)];
      case 0x3C: return u16((s.engineOn ? 520 : 300) * 10 + 400);
      case 0x42: return u16(s.volts * 1000);
      case 0x43: return u16((s.load * 255) / 100);
      case 0x44: return u16((1.0 * 65536) / 2);
      case 0x45: case 0x47: case 0x49: case 0x4A: case 0x4C: return pct(s.throttle);
      case 0x46: return [clampByte(s.ambient + 40)];
      case 0x4D: return u16(0);
      case 0x4E: return u16(this.minsSinceClear);
      case 0x51: return this.profile.fuelType == null ? null : [this.profile.fuelType];
      case 0x5B: return pct(s.hvBattery);
      case 0x5C: return [clampByte(s.oil + 40)];
      case 0x5E: return u16(s.fuelRate * 20);
      case 0x61: return [clampByte(125 + s.load)];
      case 0x62: return [clampByte(125 + s.load * 0.95)];
      case 0x63: return u16(300);
      case 0xA6: return u32(s.odometerKm * 10);
      case 0x24: return [...u16((1.0 + Math.sin(s.t) * 0.02) * 32768), ...u16(0.5 * 8192)];
      case 0x2D: return [128];
      case 0x2E: return pct(s.engineOn ? 12 : 0);
      case 0x41: return [0x00, 0x07, 0x65, 0x65];
      case 0x67: return [0x01, clampByte(s.coolant + 40), 0x00];
      case 0x68: return [0x01, clampByte(s.iat + 40), 0, 0, 0, 0, 0];
      case 0x78: case 0x7C: return [0x01, ...u16(((s.engineOn ? 480 : 160) + 40) * 10), 0, 0, 0, 0, 0, 0];
      case 0x8E: return [clampByte(125 + 6)];
      case 0x9A: {
        const amps = Math.round(s.hvAmps * 10);
        return [0x07, 0x00, ...u16(s.hvVolts * 64), (amps >> 8) & 0xff, amps & 0xff, 0x00];
      }
      default: return null;
    }
  }

  /**
   * Payloads (service byte first) from one ECU: an array of messages, or
   * null for no answer. CAN sends one (ISO-TP framed) message; K-line cars
   * send several 7-byte messages for VINs and long code lists.
   */
  answer(ecu, mode, args) {
    const s = this.state();
    const legacy = this.kind === 'legacy';
    if (mode === 0x01) {
      const pid = args[0];
      if (pid === undefined) return null;
      if (pid % 0x20 === 0) {
        if (pid !== 0 && !ecu.pids01.some((p) => p > pid)) return null;
        return [[0x41, pid, ...bitmap(ecu.pids01, pid)]];
      }
      if (!ecu.pids01.includes(pid)) return null;
      // Hybrid engine computer sometimes skips a reply while the engine is stopped.
      if (this.profile.hybrid && ecu.name === 'engine' && !s.engineOn && this.random() < 0.1) return null;
      const data = this.encodePid(pid, s, ecu);
      return data ? [[0x41, pid, ...data]] : null;
    }
    if (mode === 0x02) {
      if (!ecu.dtcs) return null;
      const [pid, frame = 0] = args;
      const ffPids = [0x02, 0x04, 0x05, 0x0C, 0x0D];
      if (frame !== 0 || !this.faults.stored.length) return null;
      if (pid === 0x00) return [[0x42, 0x00, 0x00, ...bitmap(ffPids, 0)]];
      if (pid === 0x02) return [[0x42, 0x02, 0x00, ...encodeDtc(this.faults.stored[0])]];
      if (!ffPids.includes(pid)) return null;
      const snap = { ...s, load: 46, coolant: 88, rpm: 2140, speed: 63 };
      const data = this.encodePid(pid, snap, ecu);
      return data ? [[0x42, pid, 0x00, ...data]] : null;
    }
    if (mode === 0x03 || mode === 0x07 || mode === 0x0A) {
      if (mode === 0x0A && (this.profile.noPermanent || ecu.permanent === false)) return null;
      const list = ecu.dtcs ? this.faults[{ 3: 'stored', 7: 'pending', 10: 'permanent' }[mode]] : [];
      const bytes = list.flatMap(encodeDtc);
      if (!legacy) return [[0x40 + mode, list.length, ...bytes]];
      // K-line: 3 codes per message, no count byte, padded with 00 00.
      const out = [];
      for (let i = 0; i < Math.max(1, bytes.length); i += 6) {
        const chunk = bytes.slice(i, i + 6);
        while (chunk.length < 6) chunk.push(0);
        out.push([0x40 + mode, ...chunk]);
      }
      return out;
    }
    if (mode === 0x04) {
      if (this.profile.clear === 'refuse') return [[0x7f, 0x04, 0x22]];
      if (ecu.dtcs) {
        this.faults.stored = [];
        this.faults.pending = [];
        // permanent codes stay until the monitor passes on a later drive
        this.mil = false;
        this.monitorsIncomplete = this.profile.diesel ? 0xeb : 0x65;
        this.distSinceClear = 0;
        this.minsSinceClear = 0;
      }
      return [[0x44]];
    }
    if (mode === 0x06) {
      // Self-test results, CAN layout only, from the computer that holds the codes.
      if (this.kind === 'legacy' || !ecu.dtcs || !this.profile.tests06) return null;
      const tests = this.profile.tests06;
      const mids = [...new Set(tests.map((t) => t[0]))];
      const mid = args[0];
      if (mid === undefined) return null;
      if (mid % 0x20 === 0) {
        if (mid !== 0 && !mids.some((m) => m > mid)) return null;
        return [[0x46, mid, ...bitmap(mids, mid)]];
      }
      const recs = tests.filter((t) => t[0] === mid);
      if (!recs.length) return null;
      return [[0x46, ...recs.flatMap(([m, tid, uas, v, lo, hi]) => [m, tid, uas, ...u16(v), ...u16(lo), ...u16(hi)])]];
    }
    if (mode === 0x09) {
      const pid = args[0];
      if (pid === 0x00) return ecu.pids09.length ? [[0x49, 0x00, ...bitmap(ecu.pids09, 0)]] : null;
      if (pid === 0x02 && ecu.pids09.includes(0x02)) {
        const vin = [...this.profile.vin].map((c) => c.charCodeAt(0));
        if (!legacy) return [[0x49, 0x02, 0x01, ...vin]];
        const padded = [0, 0, 0, ...vin]; // 20 bytes → 5 messages of 4
        return [0, 1, 2, 3, 4].map((i) => [0x49, 0x02, i + 1, ...padded.slice(i * 4, i * 4 + 4)]);
      }
      const info = ecu.info;
      if (legacy || !info || !ecu.pids09.includes(pid)) return null;
      if (pid === 0x04) return [[0x49, 0x04, 0x01, ...asciiPad(info.calid, 16)]];
      if (pid === 0x06) return info.cvn.length ? [[0x49, 0x06, 0x01, ...info.cvn]] : null;
      if (pid === 0x0A) return [[0x49, 0x0a, 0x01, ...asciiPad(info.name, 20)]];
      if ((pid === 0x08 || pid === 0x0B) && info.ipt) return [[0x49, pid, info.ipt.length, ...info.ipt.flatMap(u16)]];
      return null;
    }
    // Anything else: service not supported (the app should never send these).
    return [[0x7f, mode, 0x11]];
  }

  /** ISO-TP framing of one payload. */
  static frames(payload) {
    if (payload.length <= 7) return [[payload.length, ...payload]];
    const out = [[0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)]];
    for (let o = 6, seq = 1; o < payload.length; o += 7, seq++) out.push([0x20 | (seq & 0x0f), ...payload.slice(o, o + 7)]);
    return out;
  }

  formatPayload(ecuId, payload) {
    const sp = this.spaces ? ' ' : '';
    const join = (bytes) => bytes.map(hex2).join(sp);
    if (this.kind === 'legacy') {
      if (!this.headers) return [join(payload)];
      // 3 header bytes (priority, receiver, sender), data, checksum
      const frame = [0x48, 0x6b, parseInt(ecuId, 16), ...payload];
      const sum = frame.reduce((a, b) => a + b, 0) & 0xff;
      return [join([...frame, sum])];
    }
    if (this.headers) return SimElm.frames(payload).map((f) => ecuId + sp + join(f));
    if (payload.length <= 7) return [join(payload)];
    const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0'), `0:${sp}${join(payload.slice(0, 6))}`];
    for (let o = 6, n = 1; o < payload.length; o += 7, n++) lines.push(`${(n % 16).toString(16).toUpperCase()}:${sp}${join(payload.slice(o, o + 7))}`);
    return lines;
  }

  handleAt(c) {
    const ok = { lines: ['OK'] };
    const proto = this.profile.protocol;
    if (c === 'Z' || c === 'WS') {
      this.reset();
      return { lines: ['', 'ELM327 v1.5'], delay: 600 };
    }
    if (c === 'D') { this.reset(); return ok; }
    if (c === 'I') return { lines: ['ELM327 v1.5'] };
    if (c === '@1') return { lines: ['OBDII to RS232 Interpreter'] };
    if (c === 'RV') return { lines: [`${this.state().volts.toFixed(1)}V`] };
    if (c === 'DPN') return { lines: [this.searched ? `A${proto.dpn}` : 'A0'] };
    if (c === 'DP') return { lines: [this.searched ? `AUTO, ${proto.name}` : 'AUTO'] };
    let m;
    if ((m = /^E([01])$/.exec(c))) { this.echo = m[1] === '1'; return ok; }
    if ((m = /^L([01])$/.exec(c))) { this.linefeeds = m[1] === '1'; return ok; }
    if ((m = /^S([01])$/.exec(c))) { this.spaces = m[1] === '1'; return ok; }
    if ((m = /^H([01])$/.exec(c))) { this.headers = m[1] === '1'; return ok; }
    if (/^SPA?[0-9A-C]$/.test(c)) { this.searched = false; return ok; }
    if (/^(AT[0-2]|ST[0-9A-F]{2}|CAF[01]|M[01]|SH[0-9A-F]{3,8}|CRA[0-9A-FX]*|AR|CEA.*)$/.test(c)) return ok;
    return { lines: ['?'] };
  }

  handle(line) {
    let cmd = line.toUpperCase().replace(/\s+/g, '');
    if (!cmd) cmd = this.last ?? ''; // real ELM327: empty line repeats the last command
    this.last = cmd;
    this.received.push(cmd);
    const echo = this.echo ? [line] : [];

    if (cmd.startsWith('AT')) {
      const r = this.handleAt(cmd.slice(2));
      return this.reply([...echo, ...r.lines], r.delay ?? 0);
    }
    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length % 2) return this.reply([...echo, '?'], 0);

    const bytes = cmd.match(/../g).map((h) => parseInt(h, 16));
    const [mode, ...args] = bytes;
    const notices = [];
    let delay = 0;
    if (!this.searched) {
      notices.push('SEARCHING...');
      delay += this.kind === 'legacy' ? 2500 : 1200;
      this.searched = true;
    }
    if (this.random() < this.opts.noDataRate) return this.reply([...echo, ...notices, 'NO DATA'], delay + 200);

    const s = this.state();
    const answers = [];
    for (const [id, ecu] of Object.entries(this.profile.ecus)) {
      const payloads = this.answer(ecu, mode, args);
      if (payloads) answers.push({ id, payloads, delay: ecu.delay(s) });
    }
    if (!answers.length) return this.reply([...echo, ...notices, 'NO DATA'], delay + 200);
    delay += Math.max(...answers.map((a) => a.delay));
    const lines = answers.flatMap((a) => a.payloads.flatMap((p) => this.formatPayload(a.id, p)));
    return this.reply([...echo, ...notices, ...lines], delay);
  }

  reply(lines, delay) {
    if (this.random() < this.opts.dropRate) return; // simulate a lost response
    const eol = this.linefeeds ? '\r\n' : '\r';
    const out = lines.join(eol) + eol + eol + '>';
    const chunks = [];
    for (let i = 0; i < out.length; ) {
      const n = this.opts.tinyFragments ? 1 + Math.floor(this.random() * 6) : 20;
      chunks.push(out.slice(i, i + n));
      i += n;
    }
    let at = this.opts.latencyMs + delay;
    for (const c of chunks) {
      setTimeout(() => this.emit(c), at);
      at += this.opts.tinyFragments ? 4 : 2;
    }
  }
}

export class MockTransport {
  constructor(log, { profile = 'petrol', ...opts } = {}) {
    this.log = log;
    this.kind = 'mock';
    this.profileName = profile;
    this.opts = opts;
    this.ondata = null;
    this.ondisconnect = null;
    this.connected = false;
    this.info = null;
    this.sim = null;
  }

  get label() {
    return this.opts.label ?? MOCK_PROFILES[this.profileName]?.label ?? 'Simulator';
  }

  async connect() {
    this.log.ble(`Simulator: connecting to "${this.label}"`);
    await sleep(this.opts.connectDelayMs ?? 250);
    this.sim = new SimElm(this.profileName, this.opts, (s) => this.connected && this.ondata?.(s));
    this.info = {
      device: this.label,
      service: 'FFF0',
      notify: 'FFF1',
      write: 'FFF2',
      writeMode: 'with',
      services: [{ uuid: 'FFF0', chars: ['FFF1[notify]', 'FFF2[write|writeWithoutResponse]'] }],
      simulator: { profile: this.profileName, ...this.opts },
    };
    this.log.ble('Service FFF0 (simulated)');
    this.log.ble('  Characteristic FFF1 [notify]');
    this.log.ble('  Characteristic FFF2 [write, writeWithoutResponse]');
    this.log.ble('Using service FFF0, notify FFF1, write FFF2 (simulated)');
    this.connected = true;
  }

  async reconnect() {
    this.connected = true;
    this.log.ble('Simulator: reconnected');
  }

  async disconnect() {
    this.connected = false;
    this.log.ble('Simulator: disconnected');
  }

  /** Test helper: pretend the adapter dropped the link. */
  simulateLinkLoss() {
    this.connected = false;
    this.log.warn('Simulator: link lost');
    this.ondisconnect?.();
  }

  async write(text) {
    if (!this.connected) throw new Error('Not connected');
    await sleep(1);
    this.sim.input(text);
  }
}
