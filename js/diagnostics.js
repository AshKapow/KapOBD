// Fault codes, freeze frame, readiness and the clear-and-verify step.
// UI-free so it can be tested against the simulators.

import { readDtcs, readPid, readFreezePid, clearCodes } from './obd/modes.js';
import { decodeBitmap, decodePid, isBitmapPid, PIDS } from './obd/pids.js';
import { decodeDtc } from './obd/dtc.js';

const summarize = (r) => ({ answered: r.answered, error: r.answered ? null : r.res.error ?? null, ecus: r.ecus, codes: r.codes });

/**
 * Read stored (03), pending (07) and permanent (0A) codes, the warning light
 * and monitors (PID 01), and the freeze frame if there is a stored code.
 */
export async function readAllCodes(elm, { onStep } = {}) {
  const step = (s) => {
    elm.log.info(`Codes: ${s}`);
    onStep?.(s);
  };
  step('stored codes (mode 03)');
  const stored = summarize(await readDtcs(elm, 0x03));
  step('pending codes (mode 07)');
  const pending = summarize(await readDtcs(elm, 0x07));
  step('permanent codes (mode 0A)');
  const permanent = summarize(await readDtcs(elm, 0x0a));
  step('warning light and readiness monitors');
  const monitor = {};
  for (const v of (await readPid(elm, 0x01)).values) if (v.value && typeof v.value === 'object') monitor[v.ecu] = v.value;
  let freeze = null;
  if (stored.codes.length) {
    step('freeze frame (mode 02)');
    freeze = await readFreezeFrame(elm);
  }
  const result = { readAt: Date.now(), stored, pending, permanent, monitor, freeze };
  elm.log.info(`Codes: stored [${stored.codes.join(' ')}] pending [${pending.codes.join(' ')}] permanent [${permanent.answered ? permanent.codes.join(' ') : 'not reported'}]`);
  return result;
}

/**
 * Freeze frame 0: the code that triggered it, then every known PID the ECU
 * stored with it. Returns { ecu, code, values } or null.
 */
export async function readFreezeFrame(elm, { maxPids = 12 } = {}) {
  const trigger = (await readFreezePid(elm, 0x02)).msgs.find((m) => m.bytes.length >= 5 && (m.bytes[3] || m.bytes[4]));
  if (!trigger) return null;
  const ecu = trigger.ecu;
  const code = decodeDtc(trigger.bytes[3], trigger.bytes[4]);

  const bitmapMsg = (await readFreezePid(elm, 0x00)).msgs.find((m) => m.ecu === ecu);
  let pids = bitmapMsg
    ? decodeBitmap(bitmapMsg.bytes.slice(3, 7), 0).filter((p) => !isBitmapPid(p) && p !== 0x02 && p !== 0x01 && PIDS[p])
    : [0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d]; // common set if the ECU has no bitmap
  pids = pids.slice(0, maxPids);

  const values = [];
  for (const pid of pids) {
    const m = (await readFreezePid(elm, pid)).msgs.find((x) => x.ecu === ecu);
    if (!m) continue;
    const v = decodePid(pid, m.bytes.slice(3));
    if (v.value != null) values.push(v);
  }
  return { ecu, code, values };
}

/**
 * Overall readiness from PID 01 of every ECU.
 * state: 'ready' | 'almost' (one incomplete) | 'not-ready' | 'unknown'
 */
export function readinessSummary(monitorByEcu = {}) {
  const monitors = [];
  for (const [ecu, m] of Object.entries(monitorByEcu)) {
    for (const x of m.monitors ?? []) if (!x.continuous && x.status !== 'not supported') monitors.push({ ...x, ecu });
  }
  const notReady = monitors.filter((x) => x.status === 'not ready');
  const mil = Object.values(monitorByEcu).some((m) => m.mil);
  const state = !monitors.length ? 'unknown' : notReady.length === 0 ? 'ready' : notReady.length === 1 ? 'almost' : 'not-ready';
  return { mil, state, monitors, notReady };
}

export function countCodes(diag) {
  return {
    stored: diag?.stored?.codes.length ?? 0,
    pending: diag?.pending?.codes.length ?? 0,
    permanent: diag?.permanent?.codes.length ?? 0,
  };
}

/**
 * Before clearing: the engine must be off and the car stationary.
 * Returns { rpm, speed, problems: [...] }; rpm/speed are null when the car
 * didn't say (common on hybrids with the engine stopped).
 */
export async function checkClearConditions(elm, supported01 = [0x0c, 0x0d]) {
  const read = async (pid) => {
    if (!supported01.includes(pid)) return null;
    const nums = (await readPid(elm, pid)).values.map((v) => v.value).filter((n) => typeof n === 'number');
    return nums.length ? Math.max(...nums) : null;
  };
  const rpm = await read(0x0c);
  const speed = await read(0x0d);
  const problems = [];
  if (rpm > 0) problems.push(`The engine is running (${Math.round(rpm)} rpm). Switch it off, then turn the ignition on without starting the engine.`);
  if (speed > 0) problems.push('The car is moving. Stop and park first.');
  elm.log.info(`Clear pre-check: rpm ${rpm ?? 'n/a'}, speed ${speed ?? 'n/a'} → ${problems.length ? 'blocked' : 'ok'}`);
  return { rpm, speed, problems };
}

/**
 * Send mode 04 once (never retried), then re-read everything to verify.
 * Only the clear-codes confirmation flow may call this.
 */
export async function clearAndVerify(elm, { onStep } = {}) {
  onStep?.('sending clear request (mode 04)');
  const result = await clearCodes(elm);
  elm.log.info(`Clear result: ${result.status}${result.detail?.length ? ` (${result.detail.join('; ')})` : ''}`);
  // Give the ECUs a moment to update before checking.
  await new Promise((r) => setTimeout(r, elm.clearSettleMs ?? 1500));
  const after = await readAllCodes(elm, { onStep });
  const left = countCodes(after);
  // The car can acknowledge a clear but immediately re-store a code whose fault is still present.
  const verified = (result.status === 'cleared' || result.status === 'partial') && left.stored === 0 && left.pending === 0;
  return { status: result.status, detail: result.detail ?? [], clearedBy: result.clearedBy ?? [], verified, after };
}
