// Fault codes, freeze frame, readiness and clearing, end to end against the simulators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { readAllCodes, readinessSummary, checkClearConditions, clearAndVerify, countCodes } from '../js/diagnostics.js';
import { decodeMonitorStatus } from '../js/obd/pids.js';

async function setup(profile, opts = {}) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, parked: true, ...opts });
  await t.connect();
  const sim = t.sim;
  const handle = sim.reply.bind(sim);
  sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50, clearCooldownMs: 1000 });
  elm.clearSettleMs = 1;
  const init = await elm.init();
  assert.equal(init.ok, true, init.error);
  return { log, elm, sim };
}

test('readiness summary', () => {
  assert.equal(readinessSummary({}).state, 'unknown');
  const ready = readinessSummary({ '7E8': decodeMonitorStatus([0x00, 0x07, 0x65, 0x00]) });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.mil, false);
  const almost = readinessSummary({ '7E8': decodeMonitorStatus([0x81, 0x07, 0x65, 0x04]) });
  assert.equal(almost.state, 'almost');
  assert.equal(almost.mil, true);
  assert.equal(almost.notReady[0].name, 'Evaporative system');
  assert.equal(readinessSummary({ '7E8': decodeMonitorStatus([0, 0x07, 0x65, 0x65]) }).state, 'not-ready');
});

test('hybrid with gateway: codes, freeze frame, clear refused and nothing retried', async () => {
  const { elm, sim } = await setup('hybrid');
  const diag = await readAllCodes(elm);
  assert.deepEqual(diag.stored.codes, ['P0420']);
  assert.deepEqual(diag.pending.codes, ['P0171']);
  assert.deepEqual(diag.permanent.codes, ['P0420']);
  assert.equal(diag.stored.ecus.find((e) => e.ecu === '18DAF115').codes[0], 'P0420');
  assert.deepEqual(diag.permanent.ecus.map((e) => e.ecu), ['18DAF115'], 'only the engine computer answers mode 0A');
  assert.equal(readinessSummary(diag.monitor).mil, true);

  assert.equal(diag.freeze.code, 'P0420');
  assert.equal(diag.freeze.ecu, '18DAF115');
  const ff = Object.fromEntries(diag.freeze.values.map((v) => [v.pid, v.value]));
  assert.equal(ff[0x0c], 2140);
  assert.equal(ff[0x0d], 63);
  assert.equal(ff[0x05], 88);

  const pre = await checkClearConditions(elm, [0x0c, 0x0d]);
  assert.deepEqual(pre.problems, []);

  const r = await clearAndVerify(elm);
  assert.equal(r.status, 'refused');
  assert.equal(r.verified, false);
  assert.ok(r.detail.some((d) => d.includes('7F 04 22')));
  assert.deepEqual(r.after.stored.codes, ['P0420'], 'codes are still there');
  assert.equal(sim.received.filter((c) => c === '04').length, 1, 'mode 04 sent exactly once');
});

test('petrol car: clear works, is verified, permanent code stays, monitors reset', async () => {
  const { elm, sim } = await setup('petrol');
  const before = await readAllCodes(elm);
  assert.deepEqual(countCodes(before), { stored: 2, pending: 0, permanent: 1 });
  assert.equal(before.freeze.code, 'P0301');

  const r = await clearAndVerify(elm);
  assert.equal(r.status, 'cleared');
  assert.equal(r.verified, true);
  assert.deepEqual(countCodes(r.after), { stored: 0, pending: 0, permanent: 1 });
  assert.equal(r.after.freeze, null, 'no freeze frame without a stored code');
  const ready = readinessSummary(r.after.monitor);
  assert.equal(ready.mil, false);
  assert.equal(ready.state, 'not-ready');
  assert.equal(sim.received.filter((c) => c === '04').length, 1);
});

test('clearing is blocked while the engine runs or the car moves', async () => {
  const { elm } = await setup('petrol', { parked: false });
  const pre = await checkClearConditions(elm, [0x0c, 0x0d]);
  assert.ok(pre.rpm > 0);
  assert.ok(pre.problems.some((p) => p.includes('engine is running')));
});

test('older K-line car: codes over several messages, no permanent codes, legacy freeze frame', async () => {
  const { elm } = await setup('oldpetrol');
  const diag = await readAllCodes(elm);
  assert.deepEqual(diag.stored.codes, ['P0171', 'P0300', 'P0442', 'P0128']);
  assert.equal(diag.permanent.answered, false);
  assert.equal(diag.freeze.code, 'P0171');
  assert.ok(diag.freeze.values.length >= 3);
});

test('diesel: pending code only, compression monitors', async () => {
  const { elm } = await setup('diesel');
  const diag = await readAllCodes(elm);
  assert.deepEqual(countCodes(diag), { stored: 0, pending: 1, permanent: 0 });
  assert.equal(diag.freeze, null);
  const ready = readinessSummary(diag.monitor);
  assert.equal(ready.state, 'almost');
  assert.equal(ready.notReady[0].name, 'Particulate filter');
});
