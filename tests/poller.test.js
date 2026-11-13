// Live-data poller against the simulators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Logger } from '../js/logger.js';
import { MockTransport } from '../js/transport/mock.js';
import { LivePoller, defaultTiles, ecuPreference, isLivePid } from '../js/poller.js';
import { discoverVehicle } from '../js/vehicle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(profile, opts = {}) {
  const log = new Logger();
  const t = new MockTransport(log, { profile, latencyMs: 1, connectDelayMs: 0, seed: 1234, ...opts });
  await t.connect();
  const sim = t.sim;
  const handle = sim.reply.bind(sim);
  sim.reply = (lines, delay) => handle(lines, Math.min(delay, 5));
  const elm = new Elm327(t, log, { resetDelayMs: 1, timeoutMs: 300, searchTimeoutMs: 500, lateGraceMs: 50 });
  await elm.init();
  const profileData = await discoverVehicle(elm);
  return { log, elm, sim, t, profile: profileData };
}

test('default tiles follow the brief and only use supported PIDs', () => {
  assert.deepEqual(defaultTiles([0x0c, 0x0d, 0x05, 0x42, 0x2f, 0x5b, 0x46]), [0x0d, 0x0c, 0x05, 0x42, 0x2f, 0x5b]);
  // No hybrid battery or voltage: topped up from other main values.
  assert.deepEqual(defaultTiles([0x04, 0x05, 0x0c, 0x0d, 0x11, 0x2f]), [0x0d, 0x0c, 0x05, 0x2f, 0x04, 0x11]);
  assert.equal(isLivePid(0x01), false, 'monitor status is not a live value');
  assert.equal(isLivePid(0x51), false, 'fuel type is text');
  assert.equal(isLivePid(0xa6), false, 'odometer is read once, not polled');
});

test('the ECU with the most PIDs is preferred, whatever its address', () => {
  assert.deepEqual(ecuPreference(['7EA', '7E8']), ['7E8', '7EA']);
  assert.deepEqual(ecuPreference(['18DAF118', '18DAF110']), ['18DAF110', '18DAF118']);
  // Layout seen on a real hybrid: engine at 18DAF115, four other computers.
  const ecus = {
    '18DAF1DA': { supported01: [0x01, 0x0d] },
    '18DAF115': { supported01: [0x01, 0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x11, 0x42] },
    '18DAF1E3': { supported01: [0x01] },
  };
  assert.equal(ecuPreference(ecus)[0], '18DAF115');
});

test('each cycle polls every fast PID plus one slow PID in rotation', () => {
  const p = new LivePoller({ stats: { timeouts: 0 }, log: new Logger() }, { pids: [0x0d, 0x0c, 0x05, 0x42, 0x2f] });
  const batches = [p.nextBatch(), p.nextBatch(), p.nextBatch(), p.nextBatch()];
  for (const b of batches) assert.deepEqual(b.slice(0, 2), [0x0d, 0x0c]);
  assert.deepEqual(batches.map((b) => b[2]), [0x05, 0x42, 0x2f, 0x05]);
});

test('petrol car: live values, history, quiet log, clean stop', async () => {
  const { elm, log, profile } = await setup('petrol');
  const updates = [];
  const before = log.entries.length;
  const p = new LivePoller(elm, { pids: defaultTiles(profile.supported01), ecus: profile.ecus, onUpdate: (pid) => updates.push(pid) });
  p.start();
  await sleep(600);
  await p.stop();
  assert.ok(p.stats.requests >= 6, `made ${p.stats.requests} requests`);
  assert.ok(p.value(0x0d) != null, 'speed read');
  assert.ok(p.value(0x0c) > 600, 'engine running');
  assert.equal(p.engineState(), 'running');
  assert.ok(p.series(0x0c).length >= 2, 'history kept');
  const s = p.summary(0x0c);
  assert.ok(s.min <= s.avg && s.avg <= s.max);
  const traffic = log.entries.slice(before).filter((e) => e.kind === 'tx' || e.kind === 'rx' || e.kind === 'frag');
  assert.equal(traffic.length, 0, 'polling traffic is not written to the log');
  assert.ok(log.entries.some((e) => e.text.startsWith('Live data: stopped')));
});

test('parked hybrid: engine reported as off (RPM 0 or a silent engine computer)', async () => {
  const { elm, profile } = await setup('hybrid', { parked: true });
  const p = new LivePoller(elm, { pids: defaultTiles(profile.supported01), ecus: profile.ecus });
  assert.ok(p.pids.includes(0x5b), 'hybrid battery tile');
  p.start();
  await sleep(700);
  await p.stop();
  assert.equal(p.engineState(), 'off');
  const speedEcu = p.latest.get(0x0d)?.ecu;
  assert.ok(speedEcu, 'speed read');
  // The engine computer is preferred, but when it goes quiet another computer's answer is used.
  assert.ok(['18DAF115', '18DAF1DA', '18DAF1DB', '18DAF1E3', '18DAF1DF'].includes(speedEcu));
  assert.deepEqual(p.pids, [0x0d, 0x0c, 0x05, 0x42, 0x5b, 0x9a], 'no fuel level on this car, so the hybrid pack voltage fills in');
});

test('engine state from values: running, off, electric, unknown', () => {
  const p = new LivePoller({ stats: { timeouts: 0 }, log: new Logger() }, { pids: [0x0c, 0x0d, 0x05] });
  const now = 1_000_000;
  p.stats.startedAt = now - 10_000;
  assert.equal(p.engineState(now), 'unknown');
  p.record(0x0c, 1500, '7E8', now);
  assert.equal(p.engineState(now), 'running');
  p.record(0x0c, 0, '7E8', now);
  p.record(0x0d, 30, '7E8', now);
  assert.equal(p.engineState(now), 'electric');
  // RPM goes stale (engine computer silent) while speed keeps arriving.
  p.record(0x0d, 0, '7E8', now + 5000);
  assert.equal(p.engineState(now + 5000), 'off');
});

test('history is trimmed to the window', () => {
  const p = new LivePoller({ stats: { timeouts: 0 }, log: new Logger() }, { pids: [0x0c], historySeconds: 10 });
  for (let i = 0; i < 30; i++) p.record(0x0c, i, null, i * 1000);
  const h = p.history.get(0x0c);
  assert.equal(h[0].t, 19000);
  assert.equal(p.series(0x0c, 5, 29000).length, 6);
});

test('polling stops by itself when the adapter disconnects', async () => {
  const { elm, t, profile } = await setup('petrol');
  let reason = null;
  const p = new LivePoller(elm, { pids: defaultTiles(profile.supported01), ecus: profile.ecus, onStop: (r) => (reason = r) });
  p.start();
  await sleep(150);
  t.simulateLinkLoss();
  await sleep(400);
  assert.equal(p.running, false);
  assert.equal(reason, 'disconnected');
});

test('chart ticks are clean, round numbers', async () => {
  const { niceTicks, formatTick, tickDecimals } = await import('../js/ui/chart.js');
  assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(812, 2130, 4), [500, 1000, 1500, 2000, 2500]);
  assert.deepEqual(niceTicks(14.08, 14.21, 4), [14.05, 14.1, 14.15, 14.2, 14.25]);
  assert.ok(niceTicks(5, 5).length >= 2, 'a flat line still gets a range');
  assert.equal(formatTick(2000), '2,000');
  assert.equal(formatTick(48000), '48K');
  assert.equal(formatTick(14.5, 1), '14.5');
  // Every tick on a narrow voltage axis must read differently.
  const vt = niceTicks(14.08, 14.21, 4);
  const labels = vt.map((t) => formatTick(t, tickDecimals(vt[1] - vt[0])));
  assert.deepEqual(labels, ['14.05', '14.10', '14.15', '14.20', '14.25']);
  assert.equal(tickDecimals(25), 0);
  assert.equal(tickDecimals(0.5), 1);
});

test('hybrid battery detail (current, power) is kept with the value', async () => {
  const { elm, profile } = await setup('hybrid', { parked: true });
  const p = new LivePoller(elm, { pids: [0x9a], ecus: profile.ecus });
  p.start();
  await sleep(500);
  await p.stop();
  const l = p.latest.get(0x9a);
  assert.ok(l.value > 200 && l.value < 260, `pack voltage ${l.value}`);
  assert.equal(typeof l.detail.current, 'number');
  assert.ok(elm.log.entries.some((e) => e.text.includes('PID 9A (unverified formula)')), 'first raw reply logged');
});

test('auto driving view: after 3 s above 5 mph, not before, and respects Exit until stopped', async () => {
  const { AutoDrive } = await import('../js/poller.js');
  const a = new AutoDrive();
  let t = 0;
  assert.equal(a.update(30, (t += 1000)), false, 'just started moving');
  assert.equal(a.update(30, (t += 1000)), false, '1 s');
  assert.equal(a.update(30, (t += 1000)), false, '2 s');
  assert.equal(a.update(30, (t += 1000)), true, '3 s above 8 km/h');
  assert.equal(a.update(30, (t += 1000), { driving: true }), false, 'already in driving view');

  // User taps Exit while still moving: no switching back...
  a.dismiss();
  assert.equal(a.update(40, (t += 5000)), false);
  // ...until the car stops and sets off again.
  assert.equal(a.update(0, (t += 1000)), false);
  assert.equal(a.update(20, (t += 1000)), false);
  assert.equal(a.update(20, (t += 3000)), true);

  // Crawling below 5 mph never switches; unknown speed changes nothing.
  const b = new AutoDrive();
  for (let i = 0; i < 10; i++) assert.equal(b.update(6, i * 1000), false);
  assert.equal(b.update(null, 20000), false);
});

test('speed and RPM are always polled while live, without duplicating tiles', async () => {
  const { livePids } = await import('../js/poller.js');
  assert.deepEqual(livePids([0x05, 0x42], [0x05, 0x0c, 0x0d, 0x42]), [0x05, 0x42, 0x0d, 0x0c]);
  assert.deepEqual(livePids([0x0d, 0x0c], [0x0c, 0x0d]), [0x0d, 0x0c]);
  assert.deepEqual(livePids([0x05], [0x05]), [0x05], 'a car without speed/RPM just polls its tiles');
});
