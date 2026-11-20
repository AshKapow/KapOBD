// EXPERIMENTAL: fault codes from the car's other computers (ABS, airbag,
// steering…), where warnings like tyre pressure are kept. Uses UDS service
// 19 02 ("report fault codes by status"), which is read-only, addressed to
// one computer at a time. Manufacturer-specific: addresses and code meanings
// differ between makes, and some modules aren't reachable through the OBD port.

import { hex2 } from './pids.js';
import { decodeDtc } from './dtc.js';
import { positive } from './modes.js';
import { NRC_NAMES } from '../elm327.js';

// Common 11-bit request addresses (the reply comes from address + 8).
export const COMMON_11BIT = [
  { id: '760', label: 'ABS / stability control (common address on Ford and Mazda)' },
  { id: '737', label: 'Airbag (common address on Ford and Mazda)' },
  { id: '730', label: 'Power steering (some makes)' },
  { id: '726', label: 'Body control (some makes)' },
  { id: '740', label: 'Central electrics (some makes)' },
  { id: '750', label: 'Tyre pressure (some makes)' },
  { id: '7E1', label: 'Transmission' },
  { id: '713', label: 'Brakes (VW group)' },
  { id: '715', label: 'Airbag (VW group)' },
];

const STATUS_BITS = [
  [0x01, 'failing now'],
  [0x04, 'pending'],
  [0x08, 'confirmed'],
  [0x80, 'warning light requested'],
];

export function statusText(status) {
  const parts = STATUS_BITS.filter(([bit]) => status & bit).map(([, t]) => t);
  return parts.length ? parts.join(', ') : 'stored, not active';
}

/** 59 02 <availability mask> then 4-byte records: DTC (3 bytes) + status. */
export function parseUdsDtcs(bytes) {
  if (bytes[0] !== 0x59 || bytes[1] !== 0x02) return null;
  const codes = [];
  for (let i = 3; i + 4 <= bytes.length; i += 4) {
    const [a, b, ftb, status] = bytes.slice(i, i + 4);
    if (!a && !b && !ftb) continue;
    if (!status) continue; // no status bits: not a current or stored fault
    codes.push({ code: `${decodeDtc(a, b)}-${hex2(ftb)}`, status, flagsText: statusText(status) });
  }
  return codes;
}

/** Which addresses to ask, for this car's protocol and the computers already found. */
export function scanTargets(elm, profile) {
  const known = Object.keys(profile?.ecus ?? {});
  if (elm.protocol === 'can29') {
    // Ask each computer that answered OBD for its full code list (18DAF1xx → xx).
    return known.filter((id) => /^18DAF1[0-9A-F]{2}$/.test(id)).map((id) => ({ id: id.slice(6), reply: id, label: id }));
  }
  const fromOBD = known.filter((id) => /^7E[89A-F]$/.test(id)).map((id) => ({ id: (parseInt(id, 16) - 8).toString(16).toUpperCase(), reply: id, label: id }));
  const seen = new Set(fromOBD.map((t) => t.id));
  return [...fromOBD, ...COMMON_11BIT.filter((m) => !seen.has(m.id)).map((m) => ({ ...m, reply: (parseInt(m.id, 16) + 8).toString(16).toUpperCase() }))];
}

/**
 * Ask each target for its fault codes. Always restores the adapter's normal
 * (functional, all-computers) addressing afterwards.
 * Returns { supported, reason?, modules: [{ id, reply, label, status, codes, detail }] }.
 */
export async function scanModules(elm, profile, { onStep, labelFor } = {}) {
  if (elm.protocol !== 'can11' && elm.protocol !== 'can29') {
    return { supported: false, reason: 'This check needs a CAN car (most cars from 2008 onwards).', modules: [] };
  }
  const can29 = elm.protocol === 'can29';
  const modules = [];
  elm.log.info('Other warning lights: experimental check started (UDS 19 02, read-only)');
  try {
    if (can29) await elm.send('ATCP18');
    for (const t of scanTargets(elm, profile)) {
      const label = labelFor?.(t.reply) ?? t.label;
      onStep?.(label);
      if (can29) {
        await elm.send(`ATSHDA${t.id}F1`);
        await elm.send(`ATCRA${t.reply}`);
      } else {
        await elm.send(`ATSH${t.id}`);
        await elm.send(`ATCRA${t.reply}`);
      }
      const res = await elm.send('1902FF', { allowUds19: true, timeoutMs: 2000 });
      const msg = positive(res, 0x19)[0];
      const neg = (res.negatives ?? []).find((n) => n.service === 0x19);
      if (msg) {
        const codes = parseUdsDtcs(msg.bytes) ?? [];
        modules.push({ id: t.id, reply: t.reply, label, status: codes.length ? 'codes' : 'none', codes });
      } else if (neg) {
        modules.push({ id: t.id, reply: t.reply, label, status: 'refused', codes: [], detail: `7F 19 ${hex2(neg.nrc)} (${NRC_NAMES[neg.nrc] ?? 'unknown'})` });
      } else {
        modules.push({ id: t.id, reply: t.reply, label, status: 'no-answer', codes: [], detail: res.error ?? null });
      }
    }
  } finally {
    // Back to normal addressing for everything else in the app.
    await elm.send('ATCRA');
    await elm.send(can29 ? 'ATSHDB33F1' : 'ATSH7DF');
  }
  const found = modules.reduce((n, m) => n + m.codes.length, 0);
  elm.log.info(`Other warning lights: ${modules.filter((m) => m.status !== 'no-answer').length} of ${modules.length} computers answered, ${found} code(s)`);
  return { supported: true, modules, readAt: Date.now() };
}
