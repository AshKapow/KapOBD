// Experimental "other warning lights" check (UDS 19 02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUdsDtcs, statusText, scanModules, scanTargets } from '../js/obd/modules.js';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { discoverVehicle } from '../js/vehicle.js';
import { readPid } from '../js/obd/modes.js';

async function setup(profile) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, parked: true });
  await t.connect();
  const handle = t.sim.reply.bind(t.sim);
  t.sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50 });
  await elm.init();
  return { elm, sim: t.sim, profile: await discoverVehicle(elm) };
}

test('UDS code records: 3-byte code + status flags', () => {
  const codes = parseUdsDtcs([0x59, 0x02, 0xff, 0x47, 0x50, 0x16, 0x89, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00]);
  assert.deepEqual(codes.map((c) => c.code), ['C0750-16'], 'empty and status-0 records skipped');
  assert.equal(codes[0].flagsText, 'failing now, confirmed, warning light requested');
  assert.equal(statusText(0x04), 'pending');
  assert.equal(parseUdsDtcs([0x7f, 0x19, 0x11]), null);
});

test('11-bit car: asks the engine and common modules, finds the ABS code, restores addressing', async () => {
  const { elm, sim, profile } = await setup('petrol');
  const ids = scanTargets(elm, profile).map((t) => t.id);
  assert.equal(ids[0], '7E0', 'the engine computer found by discovery first');
  assert.ok(ids.includes('760') && ids.includes('737'));
  const r = await scanModules(elm, profile);
  const abs = r.modules.find((m) => m.id === '760');
  assert.equal(abs.status, 'codes');
  assert.equal(abs.codes[0].code, 'C0750-16');
  assert.equal(r.modules.find((m) => m.id === '737').status, 'none');
  assert.equal(r.modules.find((m) => m.id === '7E0').codes.length, 2);
  assert.equal(r.modules.find((m) => m.id === '726').status, 'no-answer');
  // Normal OBD requests work again afterwards (functional addressing restored).
  assert.equal(sim.header, '7DF');
  assert.equal(sim.cra, null);
  assert.ok((await readPid(elm, 0x0c)).values.length > 0, 'live data still answers after the check');
  assert.ok(sim.received.every((c) => !c.startsWith('19') || c === '1902FF'), 'only 19 02 FF was ever sent');
});

test('29-bit hybrid: asks each of the computers it found by their own address', async () => {
  const { elm, sim, profile } = await setup('hybrid');
  const r = await scanModules(elm, profile);
  assert.equal(r.modules.length, 5);
  const engine = r.modules.find((m) => m.id === '15');
  assert.deepEqual(engine.codes.map((c) => c.code), ['P0420-00']);
  assert.ok(r.modules.filter((m) => m.id !== '15').every((m) => m.status === 'none'));
  assert.equal(sim.header, 'DB33F1', 'functional 29-bit addressing restored');
  assert.ok((await readPid(elm, 0x0d)).values.length > 0);
});

test('older K-line car: not attempted', async () => {
  const { elm, profile } = await setup('oldpetrol');
  const r = await scanModules(elm, profile);
  assert.equal(r.supported, false);
});
