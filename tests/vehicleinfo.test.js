// Mode 09 vehicle information and VIN decoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEcuName, parseCalIds, parseCvns, parsePerformance, readVehicleInfo } from '../js/obd/vehicleinfo.js';
import { decodeVin } from '../js/obd/vin.js';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { discoverVehicle, ecuLabel, setEcuNames } from '../js/vehicle.js';

const ascii = (t, n) => [...t].map((c) => c.charCodeAt(0)).concat(Array(n - t.length).fill(0));

test('ECU name, calibration IDs, CVNs', () => {
  assert.deepEqual(parseEcuName([0x49, 0x0a, 0x01, ...ascii('ECM-EngineControl', 20)]), { short: 'ECM', name: 'Engine Control', raw: 'ECM-EngineControl' });
  assert.deepEqual(parseCalIds([0x49, 0x04, 0x02, ...ascii('CAL-A', 16), ...ascii('CAL-B', 16)]), ['CAL-A', 'CAL-B']);
  assert.deepEqual(parseCvns([0x49, 0x06, 0x01, 0xca, 0xfe, 0x12, 0x34]), ['CAFE1234']);
});

test('in-use performance counters', () => {
  const vals = [112, 340, 18, 110, 0, 0, 25, 110];
  const p = parsePerformance([0x49, 0x08, vals.length, ...vals.flatMap((v) => [v >> 8, v & 0xff])]);
  assert.equal(p.ignitionCycles, 340);
  assert.deepEqual(p.monitors.map((m) => m.name), ['Catalyst bank 1', 'O2 sensor bank 1'], 'unused monitors (0/0) left out');
  assert.equal(p.monitors[0].completed, 18);
});

test('VIN decoding', () => {
  const eu = decodeVin('VF1AAA00000000001');
  assert.equal(eu.manufacturer, 'Renault');
  assert.equal(eu.region, 'France');
  assert.equal(eu.modelYear, null, 'European VINs: model year not trusted');
  assert.equal(decodeVin('JMZBN000000000001').manufacturer, 'Mazda');
  const us = decodeVin('1HGCM82633A004352', new Date('2026-01-01'));
  assert.equal(us.manufacturer, 'Honda (USA)');
  assert.equal(us.modelYear, 2003);
  assert.equal(decodeVin('5YJ3E1EA7KF000001', new Date('2026-01-01')).modelYear, 2019);
  assert.equal(decodeVin('1G1ZB5ST0LF000001', new Date('2026-01-01')).manufacturer, 'General Motors');
  assert.equal(decodeVin('NOT-A-VIN').valid, false);
  assert.equal(decodeVin('XXXIOQ00000000000').valid, false, 'I, O and Q never appear in VINs');
});

test('hybrid simulator: every computer reports its name; names label the ECUs', async () => {
  const log = new Logger();
  const t = new MockTransport(log, { profile: 'hybrid', latencyMs: 1, connectDelayMs: 0, seed: 1234, parked: true });
  await t.connect();
  const handle = t.sim.reply.bind(t.sim);
  t.sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50 });
  await elm.init();
  const profile = await discoverVehicle(elm);
  const info = await readVehicleInfo(elm, profile);
  assert.equal(Object.keys(info).length, 5);
  assert.equal(info['18DAF115'].name.name, 'Engine Control');
  assert.equal(info['18DAF1DA'].name.name, 'Hybrid Control');
  assert.deepEqual(info['18DAF115'].calIds, ['SIMCAL-ENG-0001']);
  assert.ok(info['18DAF115'].performance.monitors.length >= 4);
  assert.equal(info['18DAF1DA'].performance, null);
  setEcuNames({ '18DAF1DA': 'Hybrid Control' });
  assert.equal(ecuLabel('18DAF1DA'), '18DAF1DA · Hybrid Control');
  setEcuNames({});
  assert.match(ecuLabel('18DAF1DA'), /ECU DA/);
});
