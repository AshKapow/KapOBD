// Bluetooth request handling, including Bluefy's non-standard rejections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleTransport, SERVICE_CANDIDATES, describeError } from '../js/transport/ble.js';
import { Logger } from '../js/logger.js';

/** Install a fake navigator.bluetooth whose requestDevice answers from a list. */
function fakeBluetooth(answers) {
  const calls = [];
  const bluetooth = {
    requestDevice(options) {
      calls.push(options);
      const a = answers[calls.length - 1];
      return a instanceof Function ? a() : Promise.reject(a);
    },
  };
  Object.defineProperty(globalThis.navigator, 'bluetooth', { value: bluetooth, configurable: true });
  return calls;
}

const device = { name: 'VEEPEAK', id: 'dev1', addEventListener() {}, removeEventListener() {} };

function transport() {
  const t = new BleTransport(new Logger());
  t._open = async () => {}; // GATT is out of scope here
  return t;
}

test('service UUIDs are all full 128-bit lowercase strings', () => {
  for (const s of SERVICE_CANDIDATES) assert.match(s, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('describeError handles bare values, plain objects and real errors', () => {
  assert.deepEqual([describeError(2).message, describeError(2).standard], ['2', false]);
  assert.equal(describeError('oops').message, 'oops');
  assert.equal(describeError(undefined).standard, false);
  const plain = describeError({ code: 2 });
  assert.equal(plain.code, 2);
  assert.match(plain.raw, /"code":2/);
  assert.equal(describeError(new DOMException('User cancelled', 'NotFoundError')).standard, true);
  assert.equal(describeError(new Error('2')).standard, false);
});

test('a bare rejection (Bluefy "2") falls back to the all-devices request', async () => {
  const calls = fakeBluetooth([2, () => Promise.resolve(device)]);
  const t = transport();
  await t.connect();
  assert.equal(t.device, device);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].filters, 'first try is filtered');
  assert.equal(calls[1].acceptAllDevices, true, 'fallback shows all devices');
  assert.ok(t.log.entries.some((e) => e.kind === 'warn' && e.text.includes('type=number') && e.text.includes('message="2"')));
});

test('a real cancel is not retried', async () => {
  const calls = fakeBluetooth([new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError')]);
  await assert.rejects(transport().connect(), { name: 'NotFoundError' });
  assert.equal(calls.length, 1);
});

test('every attempt failing gives a BluetoothRequestError with the details', async () => {
  const calls = fakeBluetooth([2, 2, { code: 2 }]);
  const err = await transport().connect().catch((e) => e);
  assert.equal(err.name, 'BluetoothRequestError');
  assert.equal(err.attempts.length, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].optionalServices, SERVICE_CANDIDATES.slice(0, 2));
});

test('"Show all devices" starts with acceptAllDevices and has one fallback', async () => {
  const calls = fakeBluetooth([2, 2]);
  await transport().connect({ showAll: true }).catch(() => {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].acceptAllDevices, true);
});
