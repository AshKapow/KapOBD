// 12 V battery and charging test using the adapter's own voltage reading
// (ATRV, an adapter command - nothing is sent to the car's computers).
// Thresholds are common rules of thumb, not a substitute for a load test.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseVoltage(res) {
  if (!res?.ok) return null;
  const m = /(\d+(?:\.\d+)?)\s*V/i.exec(res.lines.join(' '));
  return m ? Number(m[1]) : null;
}

/** Read ATRV repeatedly for `ms`, or until `stop(samples)` returns true. */
export async function sampleVoltage(elm, ms, { onSample, stop, gapMs = 0 } = {}) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = parseVoltage(await elm.send('ATRV', { quiet: true }));
    if (v != null) {
      samples.push({ t: Date.now(), v });
      onSample?.(v, samples);
      if (stop?.(samples)) break;
    }
    if (gapMs) await sleep(gapMs);
  }
  return samples;
}

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
