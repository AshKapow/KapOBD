// Maintenance log per vehicle: dated entries (service, MOT, tyres, …) and
// due dates with "soon" / "overdue" reminders shown in the app.

import { load, save } from './storage.js';

const KEY = 'maintenance';
export const ENTRY_TYPES = ['Service', 'Oil change', 'MOT', 'Tyres', 'Brakes', 'Battery', 'Repair', 'Other'];
const SOON_DAYS = 30;

export function loadMaintenance() {
  const m = load(KEY, {});
  return m && typeof m === 'object' ? m : {};
}

export function saveMaintenance(all) {
  save(KEY, all);
}

const blank = () => ({ entries: [], due: { mot: null, service: null, serviceMiles: null } });

export function maintenanceFor(all, key) {
  const m = all?.[key];
  return m ? { ...blank(), ...m, due: { ...blank().due, ...(m.due ?? {}) } } : blank();
}

export function addEntry(all, key, entry, now = Date.now()) {
  const m = maintenanceFor(all, key);
  const clean = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : new Date(now).toISOString().slice(0, 10),
    type: ENTRY_TYPES.includes(entry.type) ? entry.type : 'Other',
    mileage: Number.isFinite(Number(entry.mileage)) && String(entry.mileage).trim() !== '' ? Math.round(Number(entry.mileage)) : null,
    note: String(entry.note ?? '').trim().slice(0, 300),
  };
  const entries = [clean, ...m.entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300);
  return { ...all, [key]: { ...m, entries } };
}

export function removeEntry(all, key, id) {
  const m = maintenanceFor(all, key);
  return { ...all, [key]: { ...m, entries: m.entries.filter((e) => e.id !== id) } };
}

export function setDue(all, key, patch) {
  const m = maintenanceFor(all, key);
  const due = { ...m.due };
  for (const k of ['mot', 'service']) if (k in patch) due[k] = /^\d{4}-\d{2}-\d{2}$/.test(patch[k] ?? '') ? patch[k] : null;
  if ('serviceMiles' in patch) {
    const n = Number(patch.serviceMiles);
    due.serviceMiles = String(patch.serviceMiles ?? '').trim() !== '' && Number.isFinite(n) ? Math.round(n) : null;
  }
  return { ...all, [key]: { ...m, due } };
}

/** Due dates with their state: 'overdue' | 'soon' (within 30 days) | 'ok'. */
export function dueStatus(due, today = new Date()) {
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const t = day(today);
  const out = [];
  for (const [k, label] of [['mot', 'MOT'], ['service', 'Service']]) {
    if (!due?.[k]) continue;
    const [y, mo, d] = due[k].split('-').map(Number);
    const days = Math.round((Date.UTC(y, mo - 1, d) - t) / 86400000);
    out.push({ key: k, label, date: due[k], daysLeft: days, state: days < 0 ? 'overdue' : days <= SOON_DAYS ? 'soon' : 'ok' });
  }
  return out;
}

export function describeDue(item) {
  if (item.state === 'overdue') return `${item.label} overdue by ${-item.daysLeft} day${item.daysLeft === -1 ? '' : 's'}`;
  if (item.daysLeft === 0) return `${item.label} due today`;
  return `${item.label} due in ${item.daysLeft} day${item.daysLeft === 1 ? '' : 's'}`;
}
