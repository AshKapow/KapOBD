// Mode 06 self-test results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecords, midName, scale, readMonitorTests } from '../js/obd/mode06.js';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';

async function setup(profile) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, parked: true });
  await t.connect();
  const handle = t.sim.reply.bind(t.sim);
  t.sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50 });
  await elm.init();
  return elm;
}

test('monitor names', () => {
  assert.equal(midName(0x01), 'O2 sensor bank 1 sensor 1');
  assert.equal(midName(0x06), 'O2 sensor bank 2 sensor 2');
  assert.equal(midName(0x21), 'Catalyst bank 1');
  assert.equal(midName(0xa4), 'Misfire cylinder 3');
  assert.equal(midName(0x42), 'O2 sensor heater bank 1 sensor 2');
  assert.equal(midName(0xee), 'Monitor EE');
});

test('records: scaling, signed values and pass/fail on raw numbers', () => {
  // O2 sensor in mV (0x0A = 0.122 mV/bit): 3690 → 450.2 mV, inside 400–600 mV.
  const [o2] = parseRecords([0x01, 0x81, 0x0a, 0x0e, 0x6a, 0x0c, 0xcf, 0x13, 0x36]);
  assert.equal(o2.unit, 'mV');
  assert.ok(Math.abs(o2.value - 450.18) < 0.01);
  assert.equal(o2.passed, true);
  // Misfire count 38 against a limit of 30: fails.
  const [mis] = parseRecords([0xa2, 0x0b, 0x24, 0x00, 0x26, 0x00, 0x00, 0x00, 0x1e]);
  assert.equal(mis.passed, false);
  assert.equal(mis.name, 'Misfires, average of the last 10 drives');
  // Signed scaling (0x81): -5 inside -10..10.
  const [sgn] = parseRecords([0x31, 0x80, 0x81, 0xff, 0xfb, 0xff, 0xf6, 0x00, 0x0a]);
  assert.equal(sgn.value, -5);
  assert.equal(sgn.passed, true);
  // Unknown scaling: shown raw, pass/fail still right.
  const [unk] = parseRecords([0x21, 0x80, 0x5e, 0x01, 0x00, 0x00, 0x00, 0x00, 0x80]);
  assert.equal(unk.known, false);
  assert.equal(unk.passed, false);
  assert.equal(scale(0x16, 600).value, 20, 'unsigned temperature has the -40 offset');
});

test('petrol simulator: misfire on cylinder 1 is flagged, others pass', async () => {
  const elm = await setup('petrol');
  const r = await readMonitorTests(elm);
  assert.equal(r.supported, true);
  assert.ok(r.monitors.some((m) => m.name === 'Catalyst bank 1'));
  assert.deepEqual(r.failed.map((f) => `${f.monitor}: ${f.name}`), ['Misfire cylinder 1: Misfires, average of the last 10 drives']);
});

test('hybrid simulator (29-bit): catalyst result over its limit', async () => {
  const elm = await setup('hybrid');
  const r = await readMonitorTests(elm);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].monitor, 'Catalyst bank 1');
  assert.equal(r.failed[0].ecu, '18DAF115');
});

test('older K-line car: reported as not supported rather than misread', async () => {
  const elm = await setup('oldpetrol');
  const r = await readMonitorTests(elm);
  assert.equal(r.supported, false);
  assert.match(r.reason, /older format/);
});
