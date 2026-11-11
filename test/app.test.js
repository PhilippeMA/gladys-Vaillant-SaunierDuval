// -----------------------------------------------------------------------------
// The integration, wired for real.
//
// These tests start `createApp` on the fake Gladys of the SDK, which validates
// what it receives like the host API: a discovery list or a state the real
// Gladys would refuse is refused here, with the same 400. The mistakes that
// reached a real installation — a poll frequency in seconds, a feature Gladys
// could not save — were all in this wiring, which nothing was testing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from './helpers/fakeGladys.js';
import { startApp } from './helpers/app.js';
import { tliSnapshotEntry, vrc700SnapshotEntry } from './helpers/fixtures.js';

/** Requests the fake Gladys refused: there must never be any. */
const refused = (gladys) => gladys.fake.requests.filter((request) => request.status >= 400);

test('on connection, Gladys accepts the discovered devices and their states', async () => {
  const t = await startApp({ entries: [tliSnapshotEntry(), vrc700SnapshotEntry()] });

  assert.deepEqual(refused(t.gladys), [], 'Gladys refused a request');
  assert.equal(t.gladys.fake.discoveredDevices.length, 8);
  assert.deepEqual(t.gladys.fake.connectionStatus, { connected: true });
  assert.equal(t.gladys.fake.lastState(id('boiler:system-1:water-pressure')), 1.3);
  assert.equal(t.gladys.fake.lastState(id('zone:system-1-0:temperature')), 19.3);

  await t.stop();
});

test('without credentials, nothing is read and the status says what to do', async () => {
  const t = await startApp({ config: {} });

  assert.equal(t.calls.length, 0, 'the platform must not be called without credentials');
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(t.gladys.fake.connectionStatus.message.fr, /e-mail/);

  await t.stop();
});

test('an offline gateway is said so, instead of serving frozen values in silence', async () => {
  const entry = tliSnapshotEntry();
  entry.online = false;
  const t = await startApp({ entries: [entry] });

  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(t.gladys.fake.connectionStatus.message.fr, /hors ligne/);
  // The last known values are still published.
  assert.equal(t.gladys.fake.lastState(id('boiler:system-1:water-pressure')), 1.3);

  await t.stop();
});

test('a command is sent, shown at once, then read back from the boiler', async () => {
  const t = await startApp();
  const boiler = t.device('boiler:system-1');
  const boost = t.feature('boiler:system-1', 'ventilation-boost');
  const readsBefore = t.calls.filter((call) => call.method === 'GET').length;

  assert.deepEqual(await t.gladys.fake.setValue(boiler, boost, 1), { success: true });

  // Sent to the platform...
  assert.equal(t.writes().length, 1);
  assert.equal(t.writes()[0].method, 'POST');
  assert.match(t.writes()[0].url, /\/systems\/system-1\/tli\/ventilation-boost$/);
  // ...and shown without waiting for the boiler.
  assert.equal(t.gladys.fake.lastState(boost.external_id), 1);

  // The zones now report the boost: the read-back publishes what the boiler
  // says, with a single extra request.
  t.entries[0].system.state.zones[0].currentSpecialFunction = 'VENTILATION_BOOST';
  await t.app.settle();
  assert.equal(t.calls.filter((call) => call.method === 'GET').length, readsBefore + 1);
  assert.equal(t.gladys.fake.lastState(boost.external_id), 1);

  await t.stop();
});

test('the read-back corrects a value the boiler did not keep', async () => {
  const t = await startApp();
  const boiler = t.device('boiler:system-1');
  const boost = t.feature('boiler:system-1', 'ventilation-boost');

  // The platform accepts the order but the zones never report the boost.
  await t.gladys.fake.setValue(boiler, boost, 1);
  assert.equal(t.gladys.fake.lastState(boost.external_id), 1);
  await t.app.settle();

  assert.equal(t.gladys.fake.lastState(boost.external_id), 0);

  await t.stop();
});

test('stopping the ventilation boost is a DELETE on the same endpoint', async () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'VENTILATION_BOOST';
  const t = await startApp({ entries: [entry] });
  const boost = t.feature('boiler:system-1', 'ventilation-boost');

  // Read from the special function of the zones.
  assert.equal(t.gladys.fake.lastState(boost.external_id), 1);

  await t.gladys.fake.setValue(t.device('boiler:system-1'), boost, 0);
  assert.equal(t.writes()[0].method, 'DELETE');
  assert.match(t.writes()[0].url, /\/ventilation-boost$/);

  await t.stop();
});

test('the ventilation boost uses the same endpoint on an older control', async () => {
  const t = await startApp({ entries: [vrc700SnapshotEntry()] });

  await t.gladys.fake.setValue(
    t.device('boiler:system-2'),
    t.feature('boiler:system-2', 'ventilation-boost'),
    1,
  );
  assert.match(t.writes()[0].url, /vrc700\/v1\/systems\/system-2\/ventilation-boost$/);

  await t.stop();
});

test('a command the boiler refuses is acknowledged as failed', async () => {
  const t = await startApp();
  const zone = t.device('zone:system-1-0');
  const mode = t.feature('zone:system-1-0', 'mode');

  // Cooling: a value Gladys knows and no Saunier Duval boiler accepts.
  const ack = await t.gladys.fake.setValue(zone, mode, 2);

  assert.equal(ack.success, false);
  assert.match(ack.error, /not supported/);
  assert.equal(t.writes().length, 0);

  await t.stop();
});

test('a device just created gets its values at once, without a call to the platform', async () => {
  const t = await startApp();
  const callsBefore = t.calls.length;
  const statesBefore = t.gladys.fake.states.length;

  // Gladys drops the states of a feature that does not exist yet: without
  // this, a new device would stay empty until the next cycle.
  await t.gladys.fake.deviceCreated(t.device('zone:system-1-0'));

  assert.equal(t.calls.length, callsBefore);
  assert.ok(t.gladys.fake.states.length > statesBefore);

  await t.stop();
});

test('an unchanged device list is not published again on every reading', async () => {
  const t = await startApp();
  const publications = () =>
    t.gladys.fake.requests.filter((request) => request.path.includes('discovered_device')).length;
  const before = publications();

  await t.gladys.fake.action('refresh', {});
  assert.equal(publications(), before, 'the same list was sent twice');

  // A scan is the user asking for the list: it is always sent.
  await t.readAgain();
  assert.equal(publications(), before + 1);

  await t.stop();
});

test('the override duration survives a restart of the integration', async () => {
  // Gladys kept the last value of the control; the process forgot it.
  const zone = id('zone:system-1-0');
  const t = await startApp({
    devices: [
      {
        external_id: zone,
        features: [{ external_id: `${zone}:override-duration`, last_value: 90 }],
      },
    ],
  });

  assert.equal(t.gladys.fake.lastState(`${zone}:override-duration`), 90);

  await t.stop();
});

test('new credentials start over on the new account', async () => {
  const t = await startApp({ config: {} });
  assert.equal(t.gladys.fake.discoveredDevices.length, 0);

  await t.gladys.fake.configUpdated({ email: 'user@example.com', password: 's3cret' });

  assert.equal(t.gladys.fake.discoveredDevices.length, 4);
  assert.deepEqual(t.gladys.fake.connectionStatus, { connected: true });

  await t.stop();
});
