// -----------------------------------------------------------------------------
// Scene triggers and scene actions.
//
// Triggers are transitions: the same fault must not fire on every reading, nor
// on every restart of the integration. Actions end on the boiler: which call
// they make, and what they answer when there is nothing to do, is what a scene
// author builds on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from './helpers/fakeGladys.js';
import { startApp } from './helpers/app.js';
import { tliSnapshotEntry } from './helpers/fixtures.js';

const BOILER = id('boiler:system-1');
const ZONE = id('zone:system-1-0');

const fault = (code, title, occurrenceTimestamp = '2026-11-01T08:00:00Z') => ({
  code,
  title,
  type: 'ERROR',
  description: `Description of ${code}`,
  occurrenceTimestamp,
});

/** Replace the fault codes the "boiler" reports. */
function setFaults(entry, codes) {
  entry.troubleCodes = [{ serialNumber: 'abc', articleNumber: '0010', codes }];
}

// --- Triggers ----------------------------------------------------------------

test('a fault already present at startup is not news', async () => {
  const entry = tliSnapshotEntry();
  setFaults(entry, [fault('F.28', 'Ignition failure')]);
  const t = await startApp({ entries: [entry] });

  // Firing it again on every restart would wake people up for nothing.
  await t.readAgain();
  assert.deepEqual(t.gladys.fake.sceneEvents, []);

  await t.stop();
});

test('a new fault fires one event, with what a notification needs', async () => {
  const t = await startApp();

  setFaults(t.entries[0], [fault('F.28', 'Ignition failure')]);
  await t.readAgain();

  assert.deepEqual(t.gladys.fake.sceneEvents, [
    {
      key: 'fault_detected',
      data: {
        // The boiler device: what the "Boiler" filter of the trigger stores.
        device: BOILER,
        code: 'F.28',
        title: 'Ignition failure',
        description: 'Description of F.28',
        kind: 'ERROR',
        count: 1,
      },
    },
  ]);

  // The same fault, read again: no second event.
  await t.readAgain();
  assert.equal(t.gladys.fake.sceneEvents.length, 1);

  await t.stop();
});

test('a second fault fires its own event, the first one does not fire again', async () => {
  const t = await startApp();
  setFaults(t.entries[0], [fault('F.28', 'Ignition failure')]);
  await t.readAgain();

  setFaults(t.entries[0], [fault('F.28', 'Ignition failure'), fault('F.75', 'Pressure sensor')]);
  await t.readAgain();

  const events = t.gladys.fake.sceneEvents;
  assert.equal(events.length, 2);
  assert.equal(events[1].data.code, 'F.75');
  assert.equal(events[1].data.count, 2);

  await t.stop();
});

test('a fault that clears and comes back is a new fault', async () => {
  const t = await startApp();
  setFaults(t.entries[0], [fault('F.28', 'Ignition failure', '2026-11-01T08:00:00Z')]);
  await t.readAgain();
  setFaults(t.entries[0], []);
  await t.readAgain();
  setFaults(t.entries[0], [fault('F.28', 'Ignition failure', '2026-11-03T19:30:00Z')]);
  await t.readAgain();

  assert.deepEqual(
    t.gladys.fake.sceneEvents.map((event) => event.key),
    ['fault_detected', 'faults_cleared', 'fault_detected'],
  );

  await t.stop();
});

test('a burst of faults does not flood the scenes', async () => {
  const t = await startApp();
  setFaults(
    t.entries[0],
    Array.from({ length: 12 }, (_, i) => fault(`F.${i}`, `Fault ${i}`)),
  );
  await t.readAgain();

  assert.equal(t.gladys.fake.sceneEvents.length, 5);
  // Every event still tells how many codes are active.
  assert.equal(t.gladys.fake.sceneEvents[0].data.count, 12);

  await t.stop();
});

test('the gateway going offline and coming back fire one event each', async () => {
  const t = await startApp();

  t.entries[0].online = false;
  await t.readAgain();
  await t.readAgain(); // still offline: not a new event
  t.entries[0].online = true;
  await t.readAgain();

  assert.deepEqual(t.gladys.fake.sceneEvents, [
    { key: 'gateway_offline', data: { device: BOILER } },
    { key: 'gateway_online', data: { device: BOILER } },
  ]);

  await t.stop();
});

test('a plain reading fires nothing', async () => {
  const t = await startApp();
  t.entries[0].system.state.zones[0].currentRoomTemperature = 22;
  await t.readAgain();

  // A value is a device feature: scenes watch it with the standard trigger.
  assert.deepEqual(t.gladys.fake.sceneEvents, []);

  await t.stop();
});

// --- Actions -----------------------------------------------------------------

test('start_override sets a temperature for a duration, in one operation', async () => {
  const t = await startApp();

  const ack = await t.gladys.fake.sceneAction('start_override', {
    zone: ZONE,
    temperature: 21.5,
    duration: 90,
  });

  assert.deepEqual(ack, { success: true, data: { outputs: { started: true } } });
  assert.equal(t.writes().length, 1);
  assert.equal(t.writes()[0].method, 'POST');
  assert.match(t.writes()[0].url, /\/zones\/0\/quick-veto$/);
  // The platform takes hours.
  assert.deepEqual(t.writes()[0].body, { desiredRoomTemperatureSetpoint: 21.5, duration: 1.5 });
  // The setpoint of the zone shows the override at once.
  assert.equal(t.gladys.fake.lastState(`${ZONE}:target-temperature`), 21.5);

  await t.stop();
});

test('start_override without a duration uses the one set on the zone', async () => {
  const t = await startApp();
  await t.gladys.fake.setValue(
    t.device('zone:system-1-0'),
    t.feature('zone:system-1-0', 'override-duration'),
    240,
  );

  await t.gladys.fake.sceneAction('start_override', { zone: ZONE, temperature: 20 });

  assert.equal(t.writes()[0].body.duration, 4);

  await t.stop();
});

test('start_override on a running override restarts the clock', async () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  const t = await startApp({ entries: [entry] });

  await t.gladys.fake.sceneAction('start_override', { zone: ZONE, temperature: 22, duration: 60 });

  // Unlike the dial of the dashboard, which keeps the time left: the scene
  // states a duration, so it is sent.
  assert.equal(t.writes()[0].method, 'PATCH');
  assert.deepEqual(t.writes()[0].body, { desiredRoomTemperatureSetpoint: 22, duration: 1 });

  await t.stop();
});

test('start_override on a zone without a schedule answers started: false', async () => {
  const entry = tliSnapshotEntry();
  entry.system.configuration.zones[0].heating.operationModeHeating = 'MANUAL';
  const t = await startApp({ entries: [entry] });

  const ack = await t.gladys.fake.sceneAction('start_override', { zone: ZONE, temperature: 21 });

  // Not an error: the scene goes on, and its author can test the output.
  assert.deepEqual(ack, { success: true, data: { outputs: { started: false } } });
  assert.equal(t.writes().length, 0);

  await t.stop();
});

test('an action reads the zone again before acting on it', async () => {
  const t = await startApp();

  // An override started from the Saunier Duval application since the last
  // cycle: acting on the cached state would start a second one.
  t.entries[0].system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  await t.gladys.fake.sceneAction('start_override', { zone: ZONE, temperature: 22, duration: 60 });

  assert.equal(t.writes()[0].method, 'PATCH');

  await t.stop();
});

test('cancel_override gives the zone back to its schedule', async () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  const t = await startApp({ entries: [entry] });

  const ack = await t.gladys.fake.sceneAction('cancel_override', { zone: ZONE });

  assert.deepEqual(ack, { success: true, data: { outputs: { cancelled: true } } });
  assert.equal(t.writes()[0].method, 'DELETE');
  assert.match(t.writes()[0].url, /\/zones\/0\/quick-veto$/);

  await t.stop();
});

test('cancel_override without a running override answers cancelled: false', async () => {
  const t = await startApp();

  const ack = await t.gladys.fake.sceneAction('cancel_override', { zone: ZONE });

  assert.deepEqual(ack, { success: true, data: { outputs: { cancelled: false } } });
  assert.equal(t.writes().length, 0);

  await t.stop();
});

test('an action aimed at a device that is not a zone fails with a clear reason', async () => {
  const t = await startApp();

  // The select of the scene editor lists every device of the integration.
  const ack = await t.gladys.fake.sceneAction('start_override', { zone: BOILER, temperature: 21 });

  assert.equal(ack.success, false);
  assert.match(ack.error, /not a heating zone/);
  assert.equal(t.writes().length, 0);

  await t.stop();
});
