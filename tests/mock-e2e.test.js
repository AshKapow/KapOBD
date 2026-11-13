// End-to-end: real Elm327 + decoders against the simulated adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { discoverVehicle, snapshot } from '../js/vehicle.js';
import { readDtcs, clearCodes, readPid } from '../js/obd/modes.js';

async function setup(profile, opts = {}) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, ...opts });
  await t.connect();
  // Shorten the simulator's built-in delays so tests run quickly.
  const sim = t.sim;
  const handle = sim.reply.bind(sim);
  sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50, clearCooldownMs: 1000 });
  return { log, t, elm, sim };
}

test('Hybrid with gateway (real layout): 29-bit CAN, five ECUs, VIN, PIDs 5B and 9A', async () => {
  const { elm, sim } = await setup('hybrid');
  const init = await elm.init();
  assert.equal(init.ok, true, init.error);
  assert.equal(init.adapterId, 'ELM327 v1.5');
  assert.equal(init.protocol, 'A7');
  assert.deepEqual(init.ecus.sort(), ['18DAF115', '18DAF1DA', '18DAF1DB', '18DAF1DF', '18DAF1E3']);
  assert.equal(elm.headers, true);
  assert.ok(!sim.received.includes(''), 'never sends an empty line');

  const p = await discoverVehicle(elm);
  assert.equal(p.vin, 'SIMHYBRID00000001');
  assert.equal(Object.keys(p.ecus).length, 5);
  assert.equal(p.ecus['18DAF115'].supported01.length, 50, 'engine computer supports 50 PIDs, as in the field log');
  assert.ok(p.ecus['18DAF1DA'].supported01.includes(0x9a));
  for (const e of Object.values(p.ecus)) assert.ok(e.supported01.includes(0x5b), 'every computer reports 5B');
  assert.ok(!p.supported01.includes(0x2f), 'no fuel level on this car');
  assert.equal(p.fuelType, 'Petrol', 'the real car reports petrol');
  assert.equal(p.monitor['18DAF115'].mil, true);
  assert.equal(p.monitor['18DAF115'].dtcCount, 1);
  assert.equal(p.monitor['18DAF1DA'].mil, false);
});

test('Hybrid with gateway: stored/pending/permanent codes, clearing refused, no retry', async () => {
  const { elm, sim } = await setup('hybrid');
  await elm.init();
  assert.deepEqual((await readDtcs(elm, 0x03)).codes, ['P0420']);
  assert.deepEqual((await readDtcs(elm, 0x07)).codes, ['P0171']);
  assert.deepEqual((await readDtcs(elm, 0x0a)).codes, ['P0420']);
  const r = await clearCodes(elm);
  assert.equal(r.status, 'refused');
  assert.match(r.detail[0], /7F 04 22/);
  assert.equal(sim.received.filter((c) => c === '04').length, 1);
  assert.deepEqual((await readDtcs(elm, 0x03)).codes, ['P0420']);
});

test('Petrol car: single ECU, clearing works and is verified', async () => {
  const { elm } = await setup('petrol');
  await elm.init();
  const p = await discoverVehicle(elm);
  assert.equal(p.vin, 'SIMPETROL00000002');
  assert.deepEqual(Object.keys(p.ecus), ['7E8']);
  assert.ok(p.supported01.includes(0x44), 'discovery continues past 0x40');
  assert.deepEqual((await readDtcs(elm, 0x03)).codes, ['P0301', 'P0128']);
  const r = await clearCodes(elm);
  assert.equal(r.status, 'cleared');
  assert.deepEqual((await readDtcs(elm, 0x03)).codes, []);
  assert.deepEqual((await readDtcs(elm, 0x0a)).codes, ['P0301'], 'permanent codes survive clearing');
  const mon = (await readPid(elm, 0x01)).values[0].value;
  assert.equal(mon.mil, false);
});

test('survives tiny fragments and NO DATA injection', async () => {
  const { elm } = await setup('petrol', { tinyFragments: true, noDataRate: 0.3 });
  const init = await elm.init();
  // Init may hit an injected NO DATA on 0100; the adapter part must still work.
  assert.equal(init.adapterId, 'ELM327 v1.5');
  const p = await discoverVehicle(elm);
  const rows = await snapshot(elm, { ...p, supported01: [0x0c, 0x0d, 0x05, 0x42] });
  assert.equal(rows.length >= 4, true);
  for (const r of rows) assert.ok(r.error === 'NO DATA' || typeof r.value === 'number', JSON.stringify(r));
});

test('survives lost responses (timeouts)', async () => {
  const { elm } = await setup('petrol', { dropRate: 0.3 });
  let ok = 0;
  let timeouts = 0;
  for (let i = 0; i < 15; i++) {
    const r = await elm.send('ATI');
    if (r.ok) {
      ok++;
      assert.equal(r.lines[0], 'ELM327 v1.5');
    } else {
      assert.equal(r.error, 'TIMEOUT');
      timeouts++;
    }
  }
  assert.ok(ok > 0);
  assert.equal(ok + timeouts, 15);
});

test('older K-line car: legacy headers, multi-message VIN and DTCs, no mode 0A', async () => {
  const { elm } = await setup('oldpetrol');
  const init = await elm.init();
  assert.equal(init.ok, true, init.error);
  assert.equal(elm.protocol, 'legacy');
  assert.deepEqual(init.ecus, ['10']);
  const p = await discoverVehicle(elm);
  assert.equal(p.vin, 'SIMOLDCAR00000003');
  assert.ok(p.supported01.includes(0x14), 'O2 sensor PIDs discovered');
  const stored = await readDtcs(elm, 0x03);
  assert.deepEqual(stored.codes, ['P0171', 'P0300', 'P0442', 'P0128'], 'codes split over two messages');
  assert.deepEqual((await readDtcs(elm, 0x07)).codes, ['P0420']);
  const perm = await readDtcs(elm, 0x0a);
  assert.equal(perm.answered, false);
  const o2 = (await readPid(elm, 0x14)).values[0];
  assert.ok(o2.value >= 0 && o2.value <= 1.275);
});

test('diesel on 29-bit CAN: two ECUs, compression monitors, odometer', async () => {
  const { elm } = await setup('diesel');
  const init = await elm.init();
  assert.equal(init.ok, true, init.error);
  assert.equal(elm.protocol, 'can29');
  assert.deepEqual(init.ecus.sort(), ['18DAF110', '18DAF118']);
  const p = await discoverVehicle(elm);
  assert.equal(p.vin, 'SIMDIESEL00000004');
  assert.equal(p.fuelType, 'Diesel');
  const mon = p.monitor['18DAF110'];
  assert.equal(mon.ignition, 'compression');
  assert.ok(mon.monitors.some((m) => m.name === 'Particulate filter' && m.status === 'not ready'));
  assert.ok(p.supported01.includes(0xa6), 'discovery reaches the A0 range');
  const odo = (await readPid(elm, 0xa6)).values[0].value;
  assert.ok(odo > 48000 && odo < 49000, String(odo));
  assert.deepEqual((await readDtcs(elm, 0x07)).codes, ['P0401']);
});
