// Request helpers for OBD modes 01/02/03/04/07/09/0A.
// All of them go through Elm327.send(), so the allow-list always applies.

import { decodeBitmap, decodePid, hex2, isBitmapPid } from './pids.js';
import { parseDtcMessages } from './dtc.js';
import { NRC_NAMES } from '../elm327.js';

/** Positive response messages for a service (and optionally a PID). */
export function positive(res, service, pid = null) {
  return (res?.messages ?? []).filter((m) => m.bytes[0] === service + 0x40 && (pid == null || m.bytes[1] === pid));
}

/** Read one mode 01 PID. Returns { res, values: [{ ecu, pid, value, ... }] }. */
export async function readPid(elm, pid) {
  const res = await elm.send('01' + hex2(pid));
  const values = positive(res, 0x01, pid).map((m) => ({ ecu: m.ecu, ...decodePid(pid, m.bytes.slice(2)) }));
  return { res, values };
}

/**
 * Supported-PID discovery for mode 01 (or 09): 00, 20, 40 … while any ECU
 * says the next range exists. Returns { [ecu]: [pid, …] } (bitmap PIDs removed).
 */
export async function discoverSupportedPids(elm, mode = 0x01) {
  const byEcu = {};
  for (let base = 0; base <= 0xe0; base += 0x20) {
    const res = await elm.send(hex2(mode) + hex2(base));
    const msgs = positive(res, mode, base);
    if (!msgs.length) break;
    let more = false;
    for (const m of msgs) {
      const pids = decodeBitmap(m.bytes.slice(2, 6), base);
      byEcu[m.ecu] ??= [];
      for (const p of pids) if (!isBitmapPid(p) && !byEcu[m.ecu].includes(p)) byEcu[m.ecu].push(p);
      if (pids.includes(base + 0x20)) more = true;
    }
    if (!more) break;
  }
  for (const k of Object.keys(byEcu)) byEcu[k].sort((a, b) => a - b);
  return byEcu;
}

/** VIN (mode 09 PID 02). Returns { vin, ecu, res } (vin null if not read). */
export async function readVin(elm) {
  const res = await elm.send('0902', { timeoutMs: 4000 });
  const msgs = positive(res, 0x09, 0x02);
  const vin = vinFromMessages(msgs);
  return { vin: vin?.vin ?? null, ecu: vin?.ecu ?? null, res };
}

export function vinFromMessages(msgs) {
  if (!msgs.length) return null;
  // CAN: one message per ECU, [49 02 01 + 17 chars]. Legacy: several
  // messages [49 02 seq a b c d] that must be joined in order.
  const byEcu = new Map();
  for (const m of msgs) {
    const list = byEcu.get(m.ecu) ?? [];
    list.push(m);
    byEcu.set(m.ecu, list);
  }
  for (const [ecu, list] of byEcu) {
    let bytes;
    if (list.length === 1 && list[0].bytes.length > 7) bytes = list[0].bytes.slice(3);
    else bytes = [...list].sort((a, b) => a.bytes[2] - b.bytes[2]).flatMap((m) => m.bytes.slice(3));
    const text = String.fromCharCode(...bytes.filter((b) => b >= 0x30 && b <= 0x5a));
    if (text.length >= 17) return { vin: text.slice(-17), ecu };
  }
  return null;
}

/** Stored (03), pending (07) or permanent (0A) codes. */
export async function readDtcs(elm, mode) {
  if (![0x03, 0x07, 0x0a].includes(mode)) throw new Error('readDtcs: mode must be 03, 07 or 0A');
  const res = await elm.send(hex2(mode), { timeoutMs: 4000 });
  const ecus = parseDtcMessages(res.messages, mode);
  // "NO DATA" to a DTC request usually means "no codes" on older cars, but
  // we report it rather than guess.
  return { res, ecus, codes: [...new Set(ecus.flatMap((e) => e.codes))], answered: ecus.length > 0 };
}

/** Freeze frame PID (mode 02, frame 0). */
export async function readFreezePid(elm, pid, frame = 0) {
  const res = await elm.send('02' + hex2(pid) + hex2(frame));
  const msgs = positive(res, 0x02, pid);
  return { res, msgs };
}

/**
 * Mode 04. Only call from the clear-codes confirmation flow. Never retries.
 * status: 'cleared' | 'partial' | 'refused' | 'no-response' | 'error'
 */
export async function clearCodes(elm) {
  const res = await elm.send('04', { clearConfirmed: true, timeoutMs: 6000 });
  const ok = positive(res, 0x04);
  const refused = (res.negatives ?? []).filter((n) => n.service === 0x04);
  const detail = refused.map((n) => `${n.ecu}: 7F 04 ${hex2(n.nrc)} (${NRC_NAMES[n.nrc] ?? 'unknown'})`);
  if (ok.length && refused.length) return { status: 'partial', clearedBy: ok.map((m) => m.ecu), detail, res };
  if (ok.length) return { status: 'cleared', clearedBy: ok.map((m) => m.ecu), detail, res };
  if (refused.length) return { status: 'refused', detail, res };
  if (res.error === 'NO DATA' || res.error === 'TIMEOUT') return { status: 'no-response', detail: [res.error], res };
  return { status: 'error', detail: [res.error ?? 'unknown'], res };
}
