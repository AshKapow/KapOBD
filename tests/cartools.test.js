// Battery test, code history, maintenance log and health report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { sampleVoltage, average, rateResting, rateCranking, rateCharging, engineStarted, crankMinimum } from '../js/battery.js';
import { updateHistory, recordClear, historyFor } from '../js/history.js';
import { addEntry, removeEntry, setDue, dueStatus, describeDue, maintenanceFor } from '../js/maintenance.js';
import { buildReport } from '../js/report.js';
import { readAllCodes, clearAndVerify } from '../js/diagnostics.js';
import { readinessTip } from '../js/obd/readiness-guide.js';

async function setup(profile, opts = {}) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, parked: true, ...opts });
  await t.connect();
  const handle = t.sim.reply.bind(t.sim);
  t.sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50, clearCooldownMs: 10 });
  elm.clearSettleMs = 1;
  await elm.init();
  return { elm, sim: t.sim };
}

test('battery ratings', () => {
  assert.equal(rateResting(12.7).level, 'good');
  assert.equal(rateResting(12.45).level, 'ok');
  assert.equal(rateResting(12.0).level, 'weak');
  assert.equal(rateCranking(10.2).level, 'good');
  assert.equal(rateCranking(9.7).level, 'ok');
  assert.equal(rateCranking(9.0).level, 'weak');
  assert.equal(rateCharging(14.2).level, 'good');
  assert.equal(rateCharging(12.9).level, 'ok', 'smart alternators can sit low');
  assert.equal(rateCharging(12.3).level, 'weak');
  assert.equal(rateCharging(15.4).level, 'weak');
});

test('battery test against the petrol simulator: resting, cranking dip, charging', async () => {
  const { elm, sim } = await setup('petrol');
  const logStart = elm.log.entries.length; // setup itself sends one ATRV normally
  const resting = average(await sampleVoltage(elm, 300));
  assert.ok(resting > 12.4 && resting < 12.7, `resting ${resting}`);
  sim.setParked(false); // "start the engine"
  const crank = await sampleVoltage(elm, 5000, { stop: engineStarted });
  assert.ok(engineStarted(crank), 'start detected');
  assert.ok(crankMinimum(crank) < 10.5 && crankMinimum(crank) > 9.5, `dip ${crankMinimum(crank)}`);
  const charging = average(await sampleVoltage(elm, 300));
  assert.equal(rateCharging(charging).level, 'good');
  assert.ok(!elm.log.entries.slice(logStart).some((e) => e.kind === 'tx' && e.text === 'ATRV'), 'voltage sampling is quiet in the log');
});

test('hybrid simulator: no cranking dip, charges straight away', async () => {
  const { elm, sim } = await setup('hybrid');
  sim.setParked(false);
  const s = await sampleVoltage(elm, 600);
  assert.ok(crankMinimum(s) > 13, 'no dip on a hybrid');
});

test('code history: first/last seen, gone, returned, clears', async () => {
  const { elm } = await setup('petrol');
  let h = {};
  const d1 = await readAllCodes(elm);
  h = updateHistory(h, 'car1', d1, 1000);
  h = updateHistory(h, 'car1', d1, 2000);
  let { entries } = historyFor(h, 'car1');
  const p0301 = entries.find((e) => e.kind === 'stored' && e.code === 'P0301');
  assert.equal(p0301.firstSeen, 1000);
  assert.equal(p0301.lastSeen, 2000);
  assert.equal(p0301.timesSeen, 2);

  const r = await clearAndVerify(elm);
  h = recordClear(h, 'car1', r, 3000);
  h = updateHistory(h, 'car1', r.after, 3000);
  ({ entries } = historyFor(h, 'car1'));
  assert.equal(entries.find((e) => e.kind === 'stored' && e.code === 'P0301').goneAt, 3000);
  assert.equal(entries.find((e) => e.kind === 'permanent' && e.code === 'P0301').goneAt, null, 'permanent code still present');
  assert.equal(historyFor(h, 'car1').clears[0].status, 'cleared');

  // The code comes back.
  h = updateHistory(h, 'car1', d1, 4000);
  const back = historyFor(h, 'car1').entries.find((e) => e.kind === 'stored' && e.code === 'P0301');
  assert.equal(back.goneAt, null);
  assert.equal(back.returned, 1);
});

test('readiness tips exist for every standard monitor name', () => {
  for (const n of ['Catalyst', 'Evaporative system', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR / VVT', 'Particulate filter', 'NOx / SCR', 'Misfire']) {
    assert.ok(readinessTip(n), n);
  }
  assert.equal(readinessTip('Something else'), null);
});

test('maintenance: entries, due dates, reminders', () => {
  let m = {};
  m = addEntry(m, 'car1', { date: '2026-03-01', type: 'MOT', mileage: '41200', note: 'Pass, advisory: tyres' }, 1);
  m = addEntry(m, 'car1', { date: '2026-09-10', type: 'Oil change', mileage: '', note: '' }, 2);
  const mine = maintenanceFor(m, 'car1');
  assert.deepEqual(mine.entries.map((e) => e.type), ['Oil change', 'MOT'], 'newest first');
  assert.equal(mine.entries[1].mileage, 41200);
  assert.equal(mine.entries[0].mileage, null);
  m = removeEntry(m, 'car1', mine.entries[0].id);
  assert.equal(maintenanceFor(m, 'car1').entries.length, 1);

  m = setDue(m, 'car1', { mot: '2026-12-01', service: '2026-11-01', serviceMiles: 'abc' });
  const due = dueStatus(maintenanceFor(m, 'car1').due, new Date(2026, 10, 13));
  assert.deepEqual(due.map((d) => [d.label, d.state]), [['MOT', 'soon'], ['Service', 'overdue']]);
  assert.equal(describeDue(due[1]), 'Service overdue by 12 days');
  assert.equal(maintenanceFor(m, 'car1').due.serviceMiles, null, 'junk mileage ignored');
});

test('health report: codes, readiness, battery; escaped; text version', async () => {
  const { elm } = await setup('petrol');
  const diag = await readAllCodes(elm);
  const r = buildReport({
    appName: 'KapOBD',
    version: '9.9.9',
    generatedAt: Date.UTC(2026, 10, 13, 12),
    vehicle: { name: '<Dave’s> car', vin: 'SIMPETROL00000002', simulated: true, protocol: 'CAN 11/500', fuelType: 'Petrol' },
    diag,
    dtcTable: { P0301: 'Cylinder 1 misfire detected' },
    battery: { at: 0, overall: 'good', resting: 12.6, restingRating: { text: 'Fully charged.' }, crankMin: 10.2, crankRating: { text: 'Strong.' }, charging: 14.2, chargingRating: { text: 'Charging normally.' } },
    maintenance: { due: [{ label: 'MOT', date: '2026-12-01', text: 'MOT due in 18 days' }], entries: [] },
  });
  assert.match(r.html, /Cylinder 1 misfire detected/);
  assert.match(r.html, /&lt;Dave’s&gt; car/, 'vehicle name escaped');
  assert.ok(!r.html.includes('<Dave'), 'no raw markup from data');
  assert.match(r.text, /STORED CODES\nP0301/);
  assert.match(r.text, /Engine warning light: ON/);
  assert.match(r.text, /Resting: 12\.60 V/);
  assert.match(r.html, /Simulated car/);
});
