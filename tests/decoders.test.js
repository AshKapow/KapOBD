import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PIDS, decodeBitmap, decodePid, decodeMonitorStatus, formatValue, toDisplay } from '../js/obd/pids.js';
import { decodeDtc, parseDtcMessages, describeDtc } from '../js/obd/dtc.js';
import { vinFromMessages } from '../js/obd/modes.js';
import { chooseCharacteristics, fullUuid, shortUuid } from '../js/transport/ble.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('PID formulas from the brief', () => {
  close(decodePid(0x04, [0xff]).value, 100);
  assert.equal(decodePid(0x05, [0x7b]).value, 83);
  assert.equal(decodePid(0x0b, [0x65]).value, 101);
  assert.equal(decodePid(0x0c, [0x1a, 0xf8]).value, 1726);
  assert.equal(decodePid(0x0d, [0x50]).value, 80);
  close(decodePid(0x10, [0x01, 0x90]).value, 4);
  close(decodePid(0x11, [0x80]).value, 50.2);
  assert.equal(decodePid(0x1f, [0x01, 0x00]).value, 256);
  close(decodePid(0x42, [0x37, 0x46]).value, 14.15);
  assert.equal(decodePid(0x46, [0x33]).value, 11);
  assert.equal(decodePid(0x51, [0x11]).value, 'Hybrid petrol');
  close(decodePid(0x5b, [0xc7]).value, 78.04);
  close(decodePid(0x06, [0x80]).value, 0);
  close(decodePid(0x06, [0x00]).value, -100);
});

test('unknown and short PIDs do not throw', () => {
  assert.equal(decodePid(0xa9, [1, 2, 3, 4]).known, false);
  assert.equal(decodePid(0x0c, [0x1a]).error, 'short reply');
});

test('supported-PID bitmap', () => {
  // BE 3E A8 13 is a classic 0100 reply
  const pids = decodeBitmap([0xbe, 0x3e, 0xa8, 0x13], 0x00);
  assert.deepEqual(pids, [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20]);
  assert.deepEqual(decodeBitmap([0x80, 0, 0, 0x01], 0x20), [0x21, 0x40]);
});

test('monitor status: MIL, count, readiness', () => {
  const m = decodeMonitorStatus([0x81, 0x07, 0x65, 0x04]);
  assert.equal(m.mil, true);
  assert.equal(m.dtcCount, 1);
  assert.equal(m.ignition, 'spark');
  const byName = Object.fromEntries(m.monitors.map((x) => [x.name, x.status]));
  assert.equal(byName.Misfire, 'ready');
  assert.equal(byName.Catalyst, 'ready');
  assert.equal(byName['Evaporative system'], 'not ready');
  assert.equal(byName['Secondary air'], 'not supported');
  assert.equal(decodeMonitorStatus([0, 0x08, 0, 0]).ignition, 'compression');
});

test('units: mph default, °C', () => {
  close(toDisplay(0x0d, 100).value, 62.14);
  assert.equal(toDisplay(0x05, 90).unit, '°C');
  assert.equal(formatValue(0x0d, 100), '62 mph');
  assert.equal(formatValue(0x42, 14.15), '14.15 V');
  assert.equal(toDisplay(0x05, 100, { temp: 'F' }).value, 212);
});

test('every PID definition decodes a zero-filled reply', () => {
  for (const [pid, def] of Object.entries(PIDS)) {
    assert.doesNotThrow(() => def.decode(new Array(def.bytes).fill(0)), `PID ${pid}`);
  }
});

test('DTC byte decoding', () => {
  assert.equal(decodeDtc(0x03, 0x01), 'P0301');
  assert.equal(decodeDtc(0x04, 0x20), 'P0420');
  assert.equal(decodeDtc(0x41, 0x23), 'C0123');
  assert.equal(decodeDtc(0x81, 0x00), 'B0100');
  assert.equal(decodeDtc(0xc1, 0x55), 'U0155');
  assert.equal(decodeDtc(0x1a, 0xbc), 'P1ABC');
});

test('DTC response parsing: CAN with count, legacy without', () => {
  const can = parseDtcMessages([{ ecu: '7E8', bytes: [0x43, 0x02, 0x03, 0x01, 0x01, 0x28], can: true }, { ecu: '7EA', bytes: [0x43, 0x00], can: true }], 0x03);
  assert.deepEqual(can, [{ ecu: '7E8', codes: ['P0301', 'P0128'] }, { ecu: '7EA', codes: [] }]);
  const legacy = parseDtcMessages([{ ecu: '10', bytes: [0x43, 0x01, 0x71, 0x00, 0x00, 0x00, 0x00] }], 0x03);
  assert.deepEqual(legacy, [{ ecu: '10', codes: ['P0171'] }]);
});

test('DTC descriptions', () => {
  const table = JSON.parse(readFileSync(new URL('../data/dtc-codes.json', import.meta.url)));
  assert.match(describeDtc('P0420', table), /Catalyst/);
  assert.equal(describeDtc('P1234', table), 'Manufacturer-specific code');
  assert.match(describeDtc('P0999', table), /Generic/);
  for (const code of Object.keys(table)) assert.match(code, /^P[0-3][0-9A-F]{3}$/);
});

test('VIN from CAN and legacy messages', () => {
  const vin = 'SIMPETROL00000002';
  const ascii = [...vin].map((c) => c.charCodeAt(0));
  assert.equal(vinFromMessages([{ ecu: '7E8', bytes: [0x49, 0x02, 0x01, ...ascii] }]).vin, vin);
  const legacy = [];
  const padded = [0, 0, 0, ...ascii];
  for (let i = 0; i < 5; i++) legacy.push({ ecu: '10', bytes: [0x49, 0x02, i + 1, ...padded.slice(i * 4, i * 4 + 4)] });
  assert.equal(vinFromMessages(legacy.reverse()).vin, vin);
});

test('BLE characteristic choice for the common layouts', () => {
  const fff0 = [{ uuid: fullUuid(0xfff0), chars: [{ uuid: fullUuid(0xfff1), props: ['read', 'notify'] }, { uuid: fullUuid(0xfff2), props: ['writeWithoutResponse', 'write'] }] }];
  const c1 = chooseCharacteristics(fff0);
  assert.equal(shortUuid(c1.notifyUuid), 'FFF1');
  assert.equal(shortUuid(c1.writeUuid), 'FFF2');
  assert.equal(c1.writeMode, 'with');
  assert.equal(chooseCharacteristics(fff0, 'without').writeMode, 'without');

  const ffe0 = [{ uuid: fullUuid(0xffe0), chars: [{ uuid: fullUuid(0xffe1), props: ['read', 'writeWithoutResponse', 'notify'] }] }];
  const c2 = chooseCharacteristics(ffe0);
  assert.equal(c2.notifyUuid, c2.writeUuid);
  assert.equal(c2.writeMode, 'without');

  // A device exposing both: FFF0 preferred; services without a usable pair are skipped.
  const both = [{ uuid: fullUuid(0x180a), chars: [{ uuid: fullUuid(0x2a29), props: ['read'] }] }, ...ffe0, ...fff0];
  assert.equal(shortUuid(chooseCharacteristics(both).serviceUuid), 'FFF0');
  assert.equal(chooseCharacteristics([{ uuid: fullUuid(0x180a), chars: [{ uuid: 'x', props: ['read'] }] }]), null);
});

test('ECU labels for CAN 11-bit, 29-bit and K-line addresses', async () => {
  const { ecuLabel } = await import('../js/vehicle.js');
  assert.match(ecuLabel('7E8'), /engine/);
  assert.match(ecuLabel('18DAF110'), /ECU 10 \(usually engine\)/);
  assert.match(ecuLabel('10'), /usually engine/);
  assert.equal(ecuLabel('XYZ'), 'XYZ');
});

test('newer PIDs: odometer, fuel rate, O2 voltage, torque', () => {
  close(decodePid(0xa6, [0x00, 0x07, 0x5b, 0xca]).value, 48225);
  close(decodePid(0x5e, [0x00, 0x32]).value, 2.5);
  close(decodePid(0x14, [0x5a, 0xff]).value, 0.45);
  assert.equal(decodePid(0x62, [0x96]).value, 25);
  assert.equal(formatValue(0xa6, 1000), '621 mi');
});
