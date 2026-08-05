// -----------------------------------------------------------------------------
// The device layer: what Gladys is offered at discovery, what is published on
// a poll, and how a command reaches the right zone.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveredDevices,
  pollDevice,
  refreshAllDevices,
  routeDevice,
  setDeviceValue,
} from '../src/devices/index.js';
import { boilerIds, thermostatIds } from '../src/devices/externalIds.js';
import { FEATURE as THERMOSTAT_FEATURE, buildName } from '../src/devices/thermostat.js';
import { FEATURE as BOILER_FEATURE } from '../src/devices/boiler.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { buildRawSystem, SYSTEM_ID } from './helpers/fixtures.js';
import { buildStubbedClient, writeCalls } from './helpers/stubClient.js';

const config = normalizeConfig({ username: 'user@example.com', password: 'secret' });

/**
 * Build the two zones of a multi-zone installation.
 * @returns {object} A raw system payload with two active zones.
 */
function buildTwoZoneSystem() {
  const raw = buildRawSystem();
  raw.state.zones.push({
    ...raw.state.zones[0],
    index: 1,
    currentRoomTemperature: 18.5,
    currentRoomHumidity: 51,
  });
  raw.properties.zones.push({ index: 1, isActive: true });
  raw.configuration.zones.push({
    index: 1,
    general: { name: 'Chambre' },
    heating: { operationModeHeating: 'MANUAL', manualModeSetpointHeating: 17 },
  });
  return raw;
}

// --- Discovery ---------------------------------------------------------------

test('discovery publishes one boiler and one thermostat per active zone', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();

  const devices = await buildDiscoveredDevices(gladys, { client, config });

  assert.equal(devices.length, 2);
  assert.equal(devices[0].external_id, boilerIds(gladys, SYSTEM_ID).device);
  assert.equal(devices[1].external_id, thermostatIds(gladys, SYSTEM_ID, 0).device);
});

test('discovery covers the four requested thermostat features', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();

  const devices = await buildDiscoveredDevices(gladys, { client, config });
  const thermostatDevice = devices[1];
  const keys = thermostatDevice.features.map((feature) => feature.external_id.split(':').pop());

  assert.deepEqual(keys.sort(), ['heating', 'humidity', 'target-temperature', 'temperature']);
});

test('the target temperature and the heating switch are controllable', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();

  const devices = await buildDiscoveredDevices(gladys, { client, config });
  const byKey = Object.fromEntries(
    devices[1].features.map((feature) => [feature.external_id.split(':').pop(), feature]),
  );

  assert.equal(byKey['target-temperature'].read_only, false);
  assert.equal(byKey['target-temperature'].has_feedback, true);
  assert.equal(byKey.heating.read_only, false);
  assert.equal(byKey.temperature.read_only, true);
  assert.equal(byKey.humidity.read_only, true);
});

test('the boiler exposes the outdoor temperature, its state and its pressure', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();

  const devices = await buildDiscoveredDevices(gladys, { client, config });
  const keys = devices[0].features.map((feature) => feature.external_id.split(':').pop());

  assert.deepEqual(keys.sort(), ['outdoor-temperature', 'state', 'water-pressure']);
  // The boiler is observed, never commanded: the switch lives on the thermostat.
  assert.ok(devices[0].features.every((feature) => feature.read_only === true));
});

test('features the installation does not measure are not declared', async () => {
  const raw = buildRawSystem();
  delete raw.state.zones[0].currentRoomHumidity;
  delete raw.state.system.systemWaterPressure;

  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw });
  const devices = await buildDiscoveredDevices(gladys, { client, config });

  const boilerKeys = devices[0].features.map((feature) => feature.external_id.split(':').pop());
  const thermostatKeys = devices[1].features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(!boilerKeys.includes('water-pressure'));
  assert.ok(!thermostatKeys.includes('humidity'));
});

test('inactive zones are not turned into devices', async () => {
  const raw = buildTwoZoneSystem();
  raw.properties.zones[1].isActive = false;

  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw });
  const devices = await buildDiscoveredDevices(gladys, { client, config });

  assert.equal(devices.length, 2, 'only the boiler and the active zone');
});

test('a multi-zone installation names each thermostat after its zone', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw: buildTwoZoneSystem() });

  const devices = await buildDiscoveredDevices(gladys, { client, config });

  assert.equal(devices.length, 3);
  assert.equal(devices[1].name, 'Saunier Duval Maison - Salon');
  assert.equal(devices[2].name, 'Saunier Duval Maison - Chambre');
});

test('a single-zone installation keeps a simple name', () => {
  const system = { name: 'Maison', zones: [{ name: 'Salon' }] };
  assert.equal(buildName(system, system.zones[0]), 'Saunier Duval Maison');
});

// --- Polling -----------------------------------------------------------------

test('polling a thermostat publishes its four values', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await pollDevice(gladys, { external_id: ids.device }, { client, config });

  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.TEMPERATURE)), 21.9125);
  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.HUMIDITY)), 42);
  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.TARGET_TEMPERATURE)), 20);
  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.HEATING)), 1);
});

test('polling a thermostat skips the sensors the gateway did not report', async () => {
  const raw = buildRawSystem();
  delete raw.state.zones[0].currentRoomHumidity;

  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw });
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await pollDevice(gladys, { external_id: ids.device }, { client, config });

  assert.equal(
    gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.HUMIDITY)),
    undefined,
    'a missing reading must not be published as 0',
  );
});

test('polling a thermostat reports heating as off when the zone is off', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'OFF' } }),
  });
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await pollDevice(gladys, { external_id: ids.device }, { client, config });

  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.HEATING)), 0);
});

test('polling the boiler publishes the outdoor temperature and its state', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({
    raw: buildRawSystem({ circuitState: { circuitState: 'HEATING' } }),
  });
  const ids = boilerIds(gladys, SYSTEM_ID);

  await pollDevice(gladys, { external_id: ids.device }, { client, config });

  assert.equal(gladys.stateOf(ids.feature(BOILER_FEATURE.OUTDOOR_TEMPERATURE)), 4.0585938);
  assert.equal(gladys.stateOf(ids.feature(BOILER_FEATURE.STATE)), 1);
  assert.equal(gladys.stateOf(ids.feature(BOILER_FEATURE.WATER_PRESSURE)), 1.3);
});

test('polling the boiler reports it idle when no circuit is producing', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();
  const ids = boilerIds(gladys, SYSTEM_ID);

  await pollDevice(gladys, { external_id: ids.device }, { client, config });

  assert.equal(gladys.stateOf(ids.feature(BOILER_FEATURE.STATE)), 0);
});

// --- The integration's own refresh loop --------------------------------------

test('a refresh publishes every device of every zone in one API read', async () => {
  const gladys = createFakeGladys();
  const { client, calls } = buildStubbedClient({ raw: buildTwoZoneSystem() });

  await refreshAllDevices(gladys, { client, config });

  const boilerFeatures = boilerIds(gladys, SYSTEM_ID);
  const zone0 = thermostatIds(gladys, SYSTEM_ID, 0);
  const zone1 = thermostatIds(gladys, SYSTEM_ID, 1);

  assert.equal(
    gladys.stateOf(boilerFeatures.feature(BOILER_FEATURE.OUTDOOR_TEMPERATURE)),
    4.0585938,
  );
  assert.equal(gladys.stateOf(zone0.feature(THERMOSTAT_FEATURE.TEMPERATURE)), 21.9125);
  assert.equal(gladys.stateOf(zone1.feature(THERMOSTAT_FEATURE.TEMPERATURE)), 18.5);

  // The snapshot cache must collapse the three device reads into one fetch.
  assert.equal(calls.filter((call) => call.url.endsWith('/homes')).length, 1);
});

test('a refresh skips inactive zones', async () => {
  const raw = buildTwoZoneSystem();
  raw.properties.zones[1].isActive = false;

  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw });
  await refreshAllDevices(gladys, { client, config });

  const zone1 = thermostatIds(gladys, SYSTEM_ID, 1);
  assert.equal(gladys.stateOf(zone1.feature(THERMOSTAT_FEATURE.TEMPERATURE)), undefined);
});

// --- Routing and commands ----------------------------------------------------

test('a command reaches the zone its external id designates', async () => {
  const gladys = createFakeGladys();
  const { client, calls } = buildStubbedClient({ raw: buildTwoZoneSystem() });
  const ids = thermostatIds(gladys, SYSTEM_ID, 1);

  await setDeviceValue(
    gladys,
    {
      device: { external_id: ids.device },
      feature: { external_id: ids.feature(THERMOSTAT_FEATURE.TARGET_TEMPERATURE) },
      value: 21,
    },
    { client, config },
  );

  const [write] = writeCalls(calls);
  assert.match(write.url, /\/zones\/1\//, 'zone 1 must be the one written to');
  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.TARGET_TEMPERATURE)), 21);
});

test('the heating switch publishes the state it applied', async () => {
  const gladys = createFakeGladys();
  const { client, calls } = buildStubbedClient();
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await setDeviceValue(
    gladys,
    {
      device: { external_id: ids.device },
      feature: { external_id: ids.feature(THERMOSTAT_FEATURE.HEATING) },
      value: 0,
    },
    { client, config },
  );

  assert.deepEqual(writeCalls(calls)[0].body, { operationMode: 'OFF' });
  assert.equal(gladys.stateOf(ids.feature(THERMOSTAT_FEATURE.HEATING)), 0);
});

test('the configured "heating on" mode is the one applied', async () => {
  const gladys = createFakeGladys();
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'OFF' } }),
  });
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await setDeviceValue(
    gladys,
    {
      device: { external_id: ids.device },
      feature: { external_id: ids.feature(THERMOSTAT_FEATURE.HEATING) },
      value: 1,
    },
    { client, config: normalizeConfig({ ...config, heating_on_mode: 'MANUAL' }) },
  );

  assert.deepEqual(writeCalls(calls)[0].body, { operationMode: 'MANUAL' });
});

test('commanding a read-only boiler feature fails', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();
  const ids = boilerIds(gladys, SYSTEM_ID);

  await assert.rejects(
    () =>
      setDeviceValue(
        gladys,
        {
          device: { external_id: ids.device },
          feature: { external_id: ids.feature(BOILER_FEATURE.STATE) },
          value: 1,
        },
        { client, config },
      ),
    /read only/,
  );
});

test('commanding an unknown thermostat feature fails', async () => {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient();
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);

  await assert.rejects(
    () =>
      setDeviceValue(
        gladys,
        {
          device: { external_id: ids.device },
          feature: { external_id: ids.feature('temperature') },
          value: 20,
        },
        { client, config },
      ),
    /cannot be controlled/,
  );
});

test('a device that is not ours is rejected rather than mis-routed', () => {
  assert.throws(() => routeDevice({ external_id: 'ext:other:plug:1' }), /Unknown device/);
});
