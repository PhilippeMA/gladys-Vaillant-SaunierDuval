// -----------------------------------------------------------------------------
// Commands: which HTTP call a user action turns into.
//
// The boiler has no single "target temperature" register, and the endpoints
// differ between controller families — the two places where a silent mistake
// would either do nothing or quietly wipe the user's schedule. These tests
// record the calls a stubbed client receives.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { buildDeviceModels, findCommand } from '../src/devices/index.js';
import { THERMOSTAT_MODE, WATER_HEATER_MODE } from '../src/devices/mappings.js';
import { SaunierDuvalClient } from '../src/saunierDuval/client.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { tliSnapshotEntry, vrc700SnapshotEntry } from './helpers/fixtures.js';

const config = normalizeConfig({
  email: 'user@example.com',
  password: 's3cret',
  quick_veto_duration: 2,
});

/**
 * A real client whose only stubbed part is the HTTP layer: the URL building
 * and the payloads are the code under test.
 */
function recordingClient() {
  const client = new SaunierDuvalClient({
    email: 'user@example.com',
    password: 's3cret',
    country: 'france',
  });
  const calls = [];
  client.request = async (method, url, body) => {
    calls.push({ method, url, body });
    return null;
  };
  return { client, calls };
}

function commandFor(entry, featureExternalId) {
  const gladys = createFakeGladys();
  const models = buildDeviceModels(gladys, [entry], config);
  const command = findCommand(models, featureExternalId);
  assert.ok(command, `no command handler for ${featureExternalId}`);
  return command;
}

test('setting a temperature on a scheduled zone starts a temporary override', async () => {
  // The zone of the fixture is in TIME_CONTROLLED: writing a permanent
  // setpoint would silently defeat the schedule the user configured.
  const { client, calls } = recordingClient();
  await commandFor(tliSnapshotEntry(), 'zone:system-1-0:target-temperature')(client, 21);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/systems\/system-1\/tli\/zones\/0\/quick-veto$/);
  assert.deepEqual(calls[0].body, {
    desiredRoomTemperatureSetpoint: 21,
    duration: config.quick_veto_duration,
  });
});

test('an override already running is extended, not restarted', async () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  const { client, calls } = recordingClient();
  await commandFor(entry, 'zone:system-1-0:target-temperature')(client, 22);

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { desiredRoomTemperatureSetpoint: 22 });
});

test('setting a temperature on a manual zone writes the manual setpoint', async () => {
  const entry = tliSnapshotEntry();
  entry.system.configuration.zones[0].heating.operationModeHeating = 'MANUAL';
  const { client, calls } = recordingClient();
  await commandFor(entry, 'zone:system-1-0:target-temperature')(client, 19.5);

  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/zones\/0\/manual-mode-setpoint$/);
  assert.deepEqual(calls[0].body, { setpoint: 19.5, type: 'HEATING' });
});

test('setting a temperature on a zone that is off is refused with a clear reason', async () => {
  const entry = tliSnapshotEntry();
  entry.system.configuration.zones[0].heating.operationModeHeating = 'OFF';
  const { client, calls } = recordingClient();

  await assert.rejects(
    () => commandFor(entry, 'zone:system-1-0:target-temperature')(client, 21),
    /OFF mode/,
  );
  assert.equal(calls.length, 0, 'nothing must be sent to the boiler');
});

test('a vrc700 zone in comfort mode uses the comfort temperature endpoint', async () => {
  const entry = vrc700SnapshotEntry();
  entry.system.configuration.zones[0].heating.operationModeHeating = 'DAY';
  const { client, calls } = recordingClient();
  await commandFor(entry, 'zone:system-2-0:target-temperature')(client, 20.5);

  assert.equal(calls[0].method, 'PATCH');
  assert.match(
    calls[0].url,
    /vrc700\/v1\/systems\/system-2\/zone\/0\/heating\/comfort-room-temperature$/,
  );
  assert.deepEqual(calls[0].body, { comfortRoomTemperature: 20.5 });
});

test('the zone mode is translated into the vocabulary of each controller', async () => {
  const tli = recordingClient();
  await commandFor(tliSnapshotEntry(), 'zone:system-1-0:mode')(tli.client, THERMOSTAT_MODE.HEATING);
  assert.deepEqual(tli.calls[0].body, { operationMode: 'MANUAL' });
  assert.match(tli.calls[0].url, /end-user-app-api.*\/zones\/0\/heating-operation-mode$/);

  const vrc700 = recordingClient();
  await commandFor(vrc700SnapshotEntry(), 'zone:system-2-0:mode')(
    vrc700.client,
    THERMOSTAT_MODE.HEATING,
  );
  assert.deepEqual(vrc700.calls[0].body, { operationMode: 'DAY' });
  // vrc700 writes its modes on the system-control root.
  assert.match(vrc700.calls[0].url, /system-control\/v1\/systems\/system-2\/zones\/0\//);
});

test('a cooling mode is refused: a Saunier Duval boiler does not cool', async () => {
  const { client, calls } = recordingClient();
  await assert.rejects(
    () => commandFor(tliSnapshotEntry(), 'zone:system-1-0:mode')(client, THERMOSTAT_MODE.COOLING),
    /not supported/,
  );
  assert.equal(calls.length, 0);
});

test('the hot water setpoint is rounded and clamped to the range of the boiler', async () => {
  const { client, calls } = recordingClient();
  const command = commandFor(tliSnapshotEntry(), 'hot-water:system-1-255:target-temperature');

  await command(client, 60.4);
  assert.match(calls[0].url, /\/domestic-hot-water\/255\/temperature$/);
  // tli controllers only accept whole degrees.
  assert.deepEqual(calls[0].body, { setpoint: 60 });

  // The fixture caps the boiler at 65 °C.
  await command(client, 90);
  assert.deepEqual(calls[1].body, { setpoint: 65 });
});

test('the hot water mode is translated per controller family', async () => {
  const tli = recordingClient();
  await commandFor(tliSnapshotEntry(), 'hot-water:system-1-255:mode')(
    tli.client,
    WATER_HEATER_MODE.MANUAL,
  );
  assert.deepEqual(tli.calls[0].body, { operationMode: 'MANUAL' });

  const vrc700 = recordingClient();
  await commandFor(vrc700SnapshotEntry(), 'hot-water:system-2-255:mode')(
    vrc700.client,
    WATER_HEATER_MODE.PROGRAM,
  );
  assert.deepEqual(vrc700.calls[0].body, { operationMode: 'AUTO' });
});

test('the boost is started with a POST and cancelled with a DELETE', async () => {
  const { client, calls } = recordingClient();
  const command = commandFor(tliSnapshotEntry(), 'hot-water:system-1-255:boost');

  await command(client, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/domestic-hot-water\/255\/boost$/);

  await command(client, 0);
  assert.equal(calls[1].method, 'DELETE');
});
