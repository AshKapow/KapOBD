// Capability discovery and per-vehicle profiles (keyed by VIN).

import { discoverSupportedPids, readPid, readVin } from './obd/modes.js';
import { PIDS } from './obd/pids.js';
import { load, save } from './storage.js';

export const ECU_NAMES = {
  '7E8': 'ECU 1 (usually engine)',
  '7E9': 'ECU 2 (often transmission)',
  '7EA': 'ECU 3',
  '7EB': 'ECU 4',
  '7EC': 'ECU 5',
  '7ED': 'ECU 6',
  '7EE': 'ECU 7',
  '7EF': 'ECU 8',
};

// Source addresses used by 29-bit CAN and K-line/J1850 cars.
const SOURCE_NAMES = { '10': 'usually engine', '11': 'often engine #2', '18': 'often transmission', '1A': 'often transmission' };

export function ecuLabel(id) {
  if (ECU_NAMES[id]) return `${id} · ${ECU_NAMES[id]}`;
  const src = /^18DAF1([0-9A-F]{2})$/.exec(id)?.[1] ?? (/^[0-9A-F]{2}$/.test(id) ? id : null);
  if (src) return `${id} · ECU ${src}${SOURCE_NAMES[src] ? ` (${SOURCE_NAMES[src]})` : ''}`;
  return id;
}

/**
 * Ask the car what it supports. Returns a profile object:
 * { key, vin, protocol, protocolName, ecus: { id: { supported01, supported09 } },
 *   supported01, fuelType, monitor, adapter, firstSeen, lastSeen }
 */
export async function discoverVehicle(elm, { onStep, adapter } = {}) {
  const step = (s) => {
    elm.log.info(`Discovery: ${s}`);
    onStep?.(s);
  };

  step('supported mode 01 PIDs');
  const s01 = await discoverSupportedPids(elm, 0x01);
  step('supported mode 09 PIDs');
  const s09 = await discoverSupportedPids(elm, 0x09);

  const ecus = {};
  for (const id of new Set([...Object.keys(s01), ...Object.keys(s09)])) {
    ecus[id] = { supported01: s01[id] ?? [], supported09: s09[id] ?? [] };
  }
  const union = [...new Set(Object.values(s01).flat())].sort((a, b) => a - b);

  step('VIN');
  const { vin, ecu: vinEcu } = await readVin(elm);

  let fuelType = null;
  if (union.includes(0x51)) {
    step('fuel type');
    const values = await readPidFromAll(elm, 0x51, ecus);
    fuelType = values[0]?.value ?? null;
  }

  let monitor = {};
  if (union.includes(0x01)) {
    step('monitor status');
    for (const v of await readPidFromAll(elm, 0x01, ecus)) monitor[v.ecu] = v.value;
  }

  const now = new Date().toISOString();
  const profile = {
    key: vin ?? `no-vin:${adapter?.device ?? 'unknown'}:${Object.keys(ecus).sort().join('+')}`,
    vin,
    vinEcu,
    protocol: elm.protocolNumber,
    protocolName: elm.protocolName,
    ecus,
    supported01: union,
    unknownPids: union.filter((p) => !PIDS[p]),
    fuelType,
    monitor,
    adapter: adapter ?? null,
    firstSeen: now,
    lastSeen: now,
  };
  const ecuSummary = Object.entries(ecus).map(([id, e]) => `${id}: ${e.supported01.map((p) => p.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
  step(`VIN ${vin ?? 'not reported'}; ${Object.keys(ecus).length} ECU(s)`);
  for (const line of ecuSummary) elm.log.info(`Supported 01 PIDs ${line}`);
  return profile;
}

/**
 * Read a mode 01 PID, trying once more if an ECU that says it supports the
 * PID stayed silent (the hybrid engine computer often does while stopped).
 * Read-only, so a retry is safe; mode 04 is never retried.
 */
export async function readPidFromAll(elm, pid, ecus, tries = 2) {
  const expected = Object.entries(ecus).filter(([, e]) => e.supported01.includes(pid)).map(([id]) => id);
  const got = new Map();
  for (let i = 0; i < tries; i++) {
    const { values } = await readPid(elm, pid);
    for (const v of values) if (!got.has(v.ecu)) got.set(v.ecu, v);
    if (expected.every((id) => got.has(id))) break;
    if (i + 1 < tries) elm.log.info(`PID ${pid.toString(16).toUpperCase().padStart(2, '0')}: no reply from ${expected.filter((id) => !got.has(id)).join(', ')}; asking once more`);
  }
  return [...got.values()];
}

/** Read every supported (non-bitmap) mode 01 PID once. */
export async function snapshot(elm, profile, { onValue } = {}) {
  const rows = [];
  for (const pid of profile.supported01) {
    const { res, values } = await readPid(elm, pid);
    if (!values.length) rows.push({ pid, ecu: null, error: res.error ?? 'no reply' });
    for (const v of values) rows.push(v);
    onValue?.(rows);
  }
  return rows;
}

// --- storage ------------------------------------------------------------------

export function loadProfiles() {
  const p = load('profiles', {});
  return p && typeof p === 'object' ? p : {};
}

export function saveProfile(profile) {
  const all = loadProfiles();
  const prev = all[profile.key];
  all[profile.key] = { ...profile, firstSeen: prev?.firstSeen ?? profile.firstSeen, nickname: prev?.nickname ?? profile.nickname };
  save('profiles', all);
  save('lastProfile', profile.key);
  return all[profile.key];
}

/** A friendly name, e.g. "Dave's Golf". Empty string clears it. */
export function setNickname(key, nickname) {
  const all = loadProfiles();
  if (!all[key]) return null;
  all[key].nickname = String(nickname ?? '').trim().slice(0, 40) || null;
  save('profiles', all);
  return all[key];
}

export function deleteProfile(key) {
  const all = loadProfiles();
  delete all[key];
  save('profiles', all);
}
