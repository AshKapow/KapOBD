import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand, parseResponse, assembleMessages, Elm327, CommandRejected, protocolKind } from '../js/elm327.js';
import { Logger } from '../js/logger.js';

// --- allow-list --------------------------------------------------------------

test('allow-list accepts AT commands and read-only OBD modes', () => {
  for (const c of ['ATZ', 'at e0', 'ATSP0', 'ATDPN', 'ATSH7E0', 'AT@1', '0100', '010C', '010C0D', '020200', '03', '07', '0A', '0902']) {
    assert.equal(checkCommand(c).ok, true, c);
  }
});

test('allow-list rejects dangerous UDS services', () => {
  for (const c of ['2E1234AA', '3101FF00', '2701', '1101', '1003', '1902', '14FFFFFF', '3E00', '85', '28']) {
    const r = checkCommand(c);
    assert.equal(r.ok, false, c);
  }
});

test('mode 22 needs allowMode22', () => {
  assert.equal(checkCommand('22F190').ok, false);
  assert.equal(checkCommand('22F190', { allowMode22: true }).ok, true);
});

test('mode 04 needs clearConfirmed and takes no data', () => {
  assert.equal(checkCommand('04').ok, false);
  assert.equal(checkCommand('04', { clearConfirmed: true }).ok, true);
  assert.equal(checkCommand('0401', { clearConfirmed: true }).ok, false);
});

test('allow-list rejects empty lines, junk, odd lengths and risky AT commands', () => {
  for (const c of ['', '   ', '010', 'HELLO', '01 0C;', 'ATPP0CSV19', 'ATBRD08', 'ATMA', '0100\r0400']) {
    assert.equal(checkCommand(c).ok, false, JSON.stringify(c));
  }
});

// --- parsing -------------------------------------------------------------------

test('parses single-frame CAN with headers and multiple ECUs', () => {
  const r = parseResponse('7E8064100BE3EA813\r7EA06410098180001\r\r', { cmd: '0100', headers: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages.map((m) => m.ecu), ['7E8', '7EA']);
  assert.deepEqual(r.messages[0].bytes, [0x41, 0x00, 0xbe, 0x3e, 0xa8, 0x13]);
});

test('ignores padding after the PCI length', () => {
  const r = parseResponse('7E8 03 41 0D 32 AA AA AA AA', { cmd: '010D', headers: true });
  assert.deepEqual(r.messages[0].bytes, [0x41, 0x0d, 0x32]);
});

test('reassembles multi-frame (ISO-TP) VIN with headers on', () => {
  // First frame (10 14 = 20 bytes) + two consecutive frames (21, 22).
  const raw = '7E8101449020153494D\r7E82148594252494430\r7E82230303030303031\r';
  const r = parseResponse(raw, { cmd: '0902', headers: true });
  assert.equal(r.messages.length, 1);
  const vin = String.fromCharCode(...r.messages[0].bytes.slice(3));
  assert.equal(vin, 'SIMHYBRID00000001');
});

test('reassembles multi-frame with headers off', () => {
  const raw = '014\r0: 49 02 01 53 49 4D\r1: 48 59 42 52 49 44 30\r2: 30 30 30 30 30 30 31\r';
  const r = parseResponse(raw, { cmd: '0902', headers: false });
  assert.equal(String.fromCharCode(...r.messages[0].bytes.slice(3)), 'SIMHYBRID00000001');
});

test('strips echo, SEARCHING and spaces', () => {
  const r = parseResponse('0100\rSEARCHING...\r7E8 06 41 00 BE 3E A8 13\r\r', { cmd: '0100', headers: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notices, ['SEARCHING...']);
  assert.equal(r.messages.length, 1);
});

test('classifies adapter errors', () => {
  for (const [raw, err] of [
    ['NO DATA', 'NO DATA'],
    ['SEARCHING...\rUNABLE TO CONNECT', 'UNABLE TO CONNECT'],
    ['CAN ERROR', 'CAN ERROR'],
    ['BUFFER FULL', 'BUFFER FULL'],
    ['STOPPED', 'STOPPED'],
    ['BUS INIT: ...ERROR', 'BUS INIT ERROR'],
    ['?', '?'],
  ]) {
    const r = parseResponse(raw + '\r\r', { cmd: '010C', headers: true });
    assert.equal(r.ok, false, raw);
    assert.equal(r.error, err, raw);
  }
  assert.equal(parseResponse('?\r', { cmd: 'ATXX' }).error, '?');
});

test('negative response 7F 04 22 is reported per ECU', () => {
  const r = parseResponse('7E8037F0422\r7EA037F0422\r', { cmd: '04', headers: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NEGATIVE_RESPONSE');
  assert.equal(r.negatives.length, 2);
  assert.equal(r.negatives[0].nrc, 0x22);
  assert.equal(r.negatives[0].nrcName, 'conditions not correct');
});

test('response-pending (7F xx 78) is dropped when the ECU answers later', () => {
  const r = parseResponse('7E8037F0478\r7E80144\r', { cmd: '04', headers: true });
  assert.equal(r.ok, true);
  assert.equal(r.negatives.length, 0);
});

test('29-bit CAN and legacy header layouts', () => {
  const can29 = assembleMessages(['18DAF110064100BE3EA813']);
  assert.equal(can29[0].ecu, '18DAF110');
  assert.deepEqual(can29[0].bytes.slice(0, 2), [0x41, 0x00]);
  const legacy = assembleMessages(['486B104100BE3EA813C4'], { protocol: 'legacy' });
  assert.equal(legacy[0].ecu, '10');
  assert.deepEqual(legacy[0].bytes, [0x41, 0x00, 0xbe, 0x3e, 0xa8, 0x13]);
});

test('protocolKind maps ATDPN output', () => {
  assert.equal(protocolKind('A6'), 'can11');
  assert.equal(protocolKind('7'), 'can29');
  assert.equal(protocolKind('A3'), 'legacy');
  assert.equal(protocolKind('A0'), null);
});

// --- queue / buffering ---------------------------------------------------------

/** Fake transport that answers each write via a handler. */
function fakeTransport(handler) {
  const t = {
    written: [],
    ondata: null,
    async write(s) {
      t.written.push(s);
      handler(s, (chunk, delay = 1) => setTimeout(() => t.ondata(chunk), delay));
    },
  };
  return t;
}

test('buffers fragments until the > prompt', async () => {
  const t = fakeTransport((s, emit) => {
    emit('7E8 06 4', 1);
    emit('1 00 BE 3E A8', 3);
    emit(' 13\r\r', 5);
    emit('>', 7);
  });
  const elm = new Elm327(t, new Logger());
  elm.headers = true;
  const r = await elm.send('0100');
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages[0].bytes, [0x41, 0x00, 0xbe, 0x3e, 0xa8, 0x13]);
  assert.deepEqual(t.written, ['0100\r']);
});

test('one command in flight at a time, in order', async () => {
  const t = fakeTransport((s, emit) => emit(`OK ${s.trim()}\r\r>`, 5));
  const elm = new Elm327(t, new Logger());
  const results = await Promise.all(['ATE0', 'ATL0', 'ATS0'].map((c) => elm.send(c)));
  assert.deepEqual(results.map((r) => r.lines[0]), ['OK ATE0', 'OK ATL0', 'OK ATS0']);
});

test('timeout resolves with TIMEOUT and discards the late reply', async () => {
  let n = 0;
  const t = fakeTransport((s, emit) => {
    n++;
    if (n === 1) emit('LATE\r\r>', 60); // after the 20 ms timeout
    else emit('ELM327 v1.5\r\r>', 1);
  });
  const log = new Logger();
  const elm = new Elm327(t, log, { timeoutMs: 20, lateGraceMs: 200 });
  const r1 = await elm.send('ATRV');
  assert.equal(r1.error, 'TIMEOUT');
  const r2 = await elm.send('ATI');
  assert.equal(r2.lines[0], 'ELM327 v1.5');
  assert.ok(log.entries.some((e) => e.kind === 'warn' && e.text.includes('LATE')));
});

test('blocked commands never reach the transport', async () => {
  const t = fakeTransport(() => assert.fail('should not write'));
  const elm = new Elm327(t, new Logger());
  await assert.rejects(elm.send('2E1234'), CommandRejected);
  await assert.rejects(elm.send('04'), CommandRejected);
  await assert.rejects(elm.send(''), CommandRejected);
  assert.equal(t.written.length, 0);
});

test('mode 04 cannot be sent twice in quick succession', async () => {
  const t = fakeTransport((s, emit) => emit('7E80144\r\r>', 1));
  const elm = new Elm327(t, new Logger());
  elm.headers = true;
  const r = await elm.send('04', { clearConfirmed: true });
  assert.equal(r.ok, true);
  await assert.rejects(elm.send('04', { clearConfirmed: true }), CommandRejected);
  assert.equal(t.written.length, 1);
});

test('write failures are reported, not thrown', async () => {
  const t = { ondata: null, write: async () => { throw new Error('GATT gone'); } };
  const elm = new Elm327(t, new Logger());
  const r = await elm.send('ATI');
  assert.equal(r.error, 'WRITE_FAILED');
});
