// Fault-code history per vehicle: when each code was first and last seen,
// how often, when it went away, and every clear-codes attempt.

import { load, save } from './storage.js';

const KEY = 'codeHistory';
const MAX_CODES = 200;
const MAX_CLEARS = 50;
const KINDS = ['stored', 'pending', 'permanent'];

export function loadHistory() {
  const h = load(KEY, {});
  return h && typeof h === 'object' ? h : {};
}

export function saveHistory(all) {
  save(KEY, all);
}

/**
 * Merge one fault-code read into the history (pure: returns a new object).
 * A section the car didn't answer leaves that kind's history untouched.
 */
export function updateHistory(all, vehicleKey, diag, now = Date.now()) {
  if (!vehicleKey || !diag) return all;
  const prev = all[vehicleKey] ?? { codes: {}, clears: [] };
  const codes = { ...prev.codes };
  for (const kind of KINDS) {
    const section = diag[kind];
    if (!section?.answered) continue;
    const present = new Set();
    for (const { ecu, codes: list } of section.ecus) {
      for (const code of list) {
        const id = `${kind}:${code}`;
        present.add(id);
        const e = codes[id];
        codes[id] = e
          ? { ...e, ecu, lastSeen: now, timesSeen: e.timesSeen + 1, goneAt: null, returned: e.returned + (e.goneAt ? 1 : 0) }
          : { code, kind, ecu, firstSeen: now, lastSeen: now, timesSeen: 1, goneAt: null, returned: 0 };
      }
    }
    for (const [id, e] of Object.entries(codes)) {
      if (e.kind === kind && !present.has(id) && !e.goneAt) codes[id] = { ...e, goneAt: now };
    }
  }
  // Keep the most recently seen entries if the list grows too long.
  const trimmed = Object.fromEntries(Object.entries(codes).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, MAX_CODES));
  return { ...all, [vehicleKey]: { ...prev, codes: trimmed } };
}

export function recordClear(all, vehicleKey, outcome, now = Date.now()) {
  if (!vehicleKey) return all;
  const prev = all[vehicleKey] ?? { codes: {}, clears: [] };
  const clears = [{ t: now, status: outcome?.status ?? 'error', verified: !!outcome?.verified }, ...prev.clears].slice(0, MAX_CLEARS);
  return { ...all, [vehicleKey]: { ...prev, clears } };
}

/** History entries for one vehicle, current problems first, then most recent. */
export function historyFor(all, vehicleKey) {
  const h = all?.[vehicleKey];
  if (!h) return { entries: [], clears: [] };
  const entries = Object.values(h.codes).sort((a, b) => (a.goneAt ? 1 : 0) - (b.goneAt ? 1 : 0) || b.lastSeen - a.lastSeen);
  return { entries, clears: h.clears ?? [] };
}
