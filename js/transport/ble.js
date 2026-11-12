// Web Bluetooth transport for ELM327 BLE adapters (Veepeak OBDCheck BLE+).
//
// Transport interface (shared with mock.js):
//   connect(opts)  – must be called straight from a user tap (no await before it)
//   reconnect()    – reconnect to the same device without the picker
//   disconnect()
//   write(text)    – send a string; chunked into ≤20-byte writes
//   ondata(str)    – set by the caller; receives notification fragments
//   ondisconnect() – set by the caller
//   kind, label, info

import { load } from '../storage.js';

// Every service UUID seen on ELM327-style BLE adapters. Only services listed
// here are accessible after connecting, so the list is deliberately broad.
export const SERVICE_CANDIDATES = [
  0xfff0, // FFF1 notify / FFF2 write: most common on clones
  0xffe0, // FFE1 notify+write (HM-10 style)
  0x18f0, // 2AF0 notify / 2AF1 write (Vgate and others)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // some iOS-oriented adapters
];

const NAME_PREFIXES = ['OBD', 'VEEPEAK', 'Veepeak', 'OBDCheck', 'OBDII', 'ELM', 'V-LINK', 'IOS-Vlink', 'Vgate', 'vLink'];
const CHUNK = 20;

export function bleAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** Normalise a 16-bit or full UUID to the full lowercase form. */
export function fullUuid(u) {
  if (typeof u === 'number') return `0000${u.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  const s = String(u).toLowerCase();
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  return s;
}

export function shortUuid(u) {
  const s = fullUuid(u);
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(s);
  return m ? m[1].toUpperCase() : s;
}

function propList(p) {
  const names = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
  return names.filter((n) => p?.[n]);
}

/**
 * Pick the read (notify) and write characteristics.
 * services: [{ uuid, chars: [{ uuid, props: [...] }] }]
 * writePref: 'auto' | 'with' | 'without'
 * Returns { serviceUuid, notifyUuid, writeUuid, writeMode } or null.
 */
export function chooseCharacteristics(services, writePref = 'auto') {
  const rank = (uuid) => {
    const i = SERVICE_CANDIDATES.map(fullUuid).indexOf(fullUuid(uuid));
    return i < 0 ? 99 : i;
  };
  const sorted = [...services].sort((a, b) => rank(a.uuid) - rank(b.uuid));
  for (const svc of sorted) {
    const notify = svc.chars.find((c) => c.props.includes('notify')) ?? svc.chars.find((c) => c.props.includes('indicate'));
    const canWrite = (c) => c.props.includes('write') || c.props.includes('writeWithoutResponse');
    // Prefer a write characteristic separate from the notify one (FFF0 layout),
    // otherwise accept the same one (FFE0 layout).
    const write = svc.chars.find((c) => canWrite(c) && c !== notify) ?? svc.chars.find(canWrite);
    if (!notify || !write) continue;
    const hasWith = write.props.includes('write');
    const hasWithout = write.props.includes('writeWithoutResponse');
    let writeMode;
    if (writePref === 'with' && hasWith) writeMode = 'with';
    else if (writePref === 'without' && hasWithout) writeMode = 'without';
    else writeMode = hasWith ? 'with' : 'without'; // with-response is slower but more reliable
    return { serviceUuid: svc.uuid, notifyUuid: notify.uuid, writeUuid: write.uuid, writeMode };
  }
  return null;
}

export class BleTransport {
  constructor(log) {
    this.log = log;
    this.kind = 'ble';
    this.ondata = null;
    this.ondisconnect = null;
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.info = null;
    this.connected = false;
    this._chain = Promise.resolve();
    this._decoder = new TextDecoder();
    this._onValue = (ev) => {
      const v = ev.target.value;
      const text = this._decoder.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      this.ondata?.(text);
    };
    this._onGattDisconnect = () => {
      const was = this.connected;
      this.connected = false;
      this.log.warn('BLE: gattserverdisconnected');
      if (was) this.ondisconnect?.();
    };
  }

  get label() {
    return this.device?.name || 'BLE adapter';
  }

  /** Call directly from a click handler: requestDevice needs a user gesture. */
  async connect({ showAll = false } = {}) {
    if (!bleAvailable()) {
      throw new Error('Web Bluetooth is not available in this browser. On iPhone/iPad, open this page in the Bluefy browser.');
    }
    const optionalServices = SERVICE_CANDIDATES;
    const options = showAll
      ? { acceptAllDevices: true, optionalServices }
      : {
          filters: [
            ...SERVICE_CANDIDATES.map((s) => ({ services: [s] })),
            ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
          ],
          optionalServices,
        };
    // No await before this line: keeps the user-gesture requirement satisfied.
    const pick = navigator.bluetooth.requestDevice(options);
    this.log.ble(`requestDevice (${showAll ? 'all devices' : 'filtered by OBD services/names'})`);
    this.device = await pick;
    this.log.ble(`Picked device name="${this.device.name ?? ''}" id=${this.device.id}`);
    this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnect);
    await this._open();
  }

  async reconnect() {
    if (!this.device) throw new Error('No device to reconnect to. Use Connect.');
    await this._open();
  }

  async _open() {
    this.log.ble('Connecting to GATT server…');
    const server = await this.device.gatt.connect();
    this.log.ble('GATT connected. Discovering services…');

    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      this.log.warn(`getPrimaryServices() failed (${e.message}); trying known services one by one`);
    }
    if (!services.length) {
      for (const s of SERVICE_CANDIDATES) {
        try {
          services.push(await server.getPrimaryService(s));
        } catch {
          /* not present */
        }
      }
    }
    if (!services.length) {
      throw new Error('Connected, but none of the known OBD BLE services were found. Copy the log and send it back.');
    }

    const found = [];
    for (const svc of services) {
      let chars = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        this.log.warn(`getCharacteristics(${shortUuid(svc.uuid)}) failed: ${e.message}`);
      }
      this.log.ble(`Service ${shortUuid(svc.uuid)} (${svc.uuid})`);
      const list = chars.map((c) => ({ c, uuid: c.uuid, props: propList(c.properties) }));
      for (const ch of list) this.log.ble(`  Characteristic ${shortUuid(ch.uuid)} [${ch.props.join(', ')}]`);
      found.push({ uuid: svc.uuid, chars: list });
    }

    const writePref = load('bleWriteMode', 'auto');
    const choice = chooseCharacteristics(found, writePref);
    if (!choice) throw new Error('No notify + write characteristic pair found. Copy the log and send it back.');

    const all = found.flatMap((s) => s.chars);
    this.rx = all.find((c) => c.uuid === choice.notifyUuid).c;
    this.tx = all.find((c) => c.uuid === choice.writeUuid).c;
    this.writeMode = choice.writeMode;

    this.rx.removeEventListener('characteristicvaluechanged', this._onValue);
    this.rx.addEventListener('characteristicvaluechanged', this._onValue);
    await this.rx.startNotifications();

    this.info = {
      device: this.device.name ?? '',
      service: shortUuid(choice.serviceUuid),
      notify: shortUuid(choice.notifyUuid),
      write: shortUuid(choice.writeUuid),
      writeMode: choice.writeMode,
      services: found.map((s) => ({ uuid: shortUuid(s.uuid), chars: s.chars.map((c) => `${shortUuid(c.uuid)}[${c.props.join('|')}]`) })),
    };
    this.log.ble(
      `Using service ${this.info.service}, notify ${this.info.notify}, write ${this.info.write} (write ${choice.writeMode} response)`,
    );
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
    try {
      this.rx?.removeEventListener('characteristicvaluechanged', this._onValue);
      await this.rx?.stopNotifications();
    } catch {
      /* already gone */
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.log.ble('Disconnected by user');
  }

  /** Writes are serialised and chunked to ≤20 bytes. */
  write(text) {
    const bytes = new TextEncoder().encode(text);
    const run = async () => {
      if (!this.connected || !this.tx) throw new Error('Not connected');
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.slice(i, i + CHUNK);
        if (this.writeMode === 'without' && this.tx.writeValueWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
        else if (this.writeMode === 'with' && this.tx.writeValueWithResponse) await this.tx.writeValueWithResponse(chunk);
        else await this.tx.writeValue(chunk); // older Web Bluetooth implementations
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
}
