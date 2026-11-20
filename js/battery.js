// 12 V battery and charging test using the adapter's own voltage reading
// (ATRV, an adapter command - nothing is sent to the car's computers).
// Thresholds are common rules of thumb, not a substitute for a load test.

import { readPid } from './obd/modes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseVoltage(res) {
  if (!res?.ok) return null;
  const m = /(\d+(?:\.\d+)?)\s*V/i.exec(res.lines.join(' '));
  return m ? Number(m[1]) : null;
}

/**
 * Read ATRV repeatedly for `ms`, or until `stop(samples)` returns true.
 * `scale` corrects an adapter whose voltage reading is off (see checkAdapterVoltage).
 */
export async function sampleVoltage(elm, ms, { onSample, stop, gapMs = 0, scale = 1 } = {}) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const raw = parseVoltage(await elm.send('ATRV', { quiet: true }));
    const v = raw == null ? null : raw * scale;
    if (v != null) {
      samples.push({ t: Date.now(), v });
      onSample?.(v, samples);
      if (stop?.(samples)) break;
    }
    if (gapMs) await sleep(gapMs);
  }
  return samples;
}

/**
 * Some adapters misreport the voltage (one read 28.3 V on a 12 V car whose own
 * figure was 12.7 V). Compare with the car's control module voltage (PID 42)
 * when the car reports it, and work out a correction.
 * Returns { scale, adapter, car, corrected, usable, note }.
 */
export async function checkAdapterVoltage(elm, supported01 = []) {
  const adapter = average(await sampleVoltage(elm, 600));
  let car = null;
  if (supported01.includes(0x42)) {
    const vals = [];
    for (let i = 0; i < 3; i++) {
      for (const v of (await readPid(elm, 0x42)).values) if (typeof v.value === 'number') vals.push(v.value);
    }
    if (vals.length) car = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const plausible = (v) => v != null && v >= 8 && v <= 16.5;
  if (adapter == null) return { scale: 1, adapter, car, corrected: false, usable: false, note: 'The adapter gave no voltage reading.' };
  if (car != null && plausible(car) && Math.abs(adapter - car) > 1.0) {
    return {
      scale: car / adapter,
      adapter,
      car,
      corrected: true,
      usable: true,
      note: `The adapter’s own voltage reading (${adapter.toFixed(1)} V) didn’t match the car’s (${car.toFixed(1)} V), so the readings were corrected using the car’s figure.`,
    };
  }
  if (car == null && !plausible(adapter)) {
    return { scale: 1, adapter, car, corrected: false, usable: false, note: `The adapter’s voltage reading (${adapter.toFixed(1)} V) isn’t possible on a 12 V car, and this car doesn’t report its own voltage, so the battery test can’t give a trustworthy result.` };
  }
  return { scale: 1, adapter, car, corrected: false, usable: true, note: null };
}

/** For status displays: is this adapter voltage plausible for a 12 V car? */
export const plausibleVoltage = (v) => v != null && v >= 8 && v <= 16.5;

export const average = (samples) => (samples.length ? samples.reduce((s, x) => s + x.v, 0) / samples.length : null);

export function rateResting(v) {
  if (v == null) return { level: 'unknown', text: 'No reading.' };
  if (v >= 12.6) return { level: 'good', text: 'Fully charged.' };
  if (v >= 12.4) return { level: 'ok', text: 'Charged.' };
  if (v >= 12.2) return { level: 'low', text: 'Partly charged. A longer drive or a charger would help.' };
  return { level: 'weak', text: 'Low. Charge the battery and test again; if it stays low, it may be failing.' };
}

export function rateCranking(min) {
  if (min == null) return { level: 'unknown', text: 'No cranking dip was seen.' };
  if (min >= 10.0) return { level: 'good', text: 'Strong: the battery held up well while starting.' };
  if (min >= 9.6) return { level: 'ok', text: 'Acceptable, but on the weak side, especially in cold weather.' };
  return { level: 'weak', text: 'Weak: the voltage dropped a lot while starting. The battery may be near the end of its life.' };
}

export function rateCharging(v) {
  if (v == null) return { level: 'unknown', text: 'No reading.' };
  if (v > 15.0) return { level: 'weak', text: 'Too high: the charging system may be overcharging. Worth having it checked.' };
  if (v >= 13.2) return { level: 'good', text: 'Charging normally.' };
  if (v >= 12.6) return { level: 'ok', text: 'Low for charging. Many modern cars with “smart” alternators sit here at times; check again after a few minutes of driving.' };
  return { level: 'weak', text: 'Not charging: the voltage is below the battery’s own. Have the alternator or DC-DC converter checked.' };
}

/** Has the engine started? A cranking dip followed by a rise above 13 V for a second. */
export function engineStarted(samples) {
  const dipAt = samples.findIndex((s) => s.v < 11.5);
  if (dipAt < 0) return false;
  const after = samples.slice(dipAt).filter((s) => s.v >= 13.0);
  return after.length >= 2 && after[after.length - 1].t - after[0].t >= 800;
}

export function crankMinimum(samples) {
  return samples.length ? Math.min(...samples.map((s) => s.v)) : null;
}
