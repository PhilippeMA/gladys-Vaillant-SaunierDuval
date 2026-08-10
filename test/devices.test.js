// -----------------------------------------------------------------------------
// The devices are discovered, not declared: these tests check that a snapshot
// of the boiler produces the right devices, the right features and the right
// states — on both controller families.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  buildDeviceModels,
  findCommand,
  statesOfDevice,
  toDiscoveredDevices,
  toStates,
} from '../src/devices/index.js';
import { THERMOSTAT_MODE, WATER_HEATER_MODE } from '../src/devices/mappings.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { tliSnapshotEntry, vrc700SnapshotEntry } from './helpers/fixtures.js';

const config = normalizeConfig({ email: 'user@example.com', password: 's3cret' });

function build(entries) {
  const gladys = createFakeGladys();
  return { gladys, models: buildDeviceModels(gladys, entries, config) };
}

/** State published for a feature, by its external id. */
function stateOf(models, featureExternalId) {
  const found = toStates(models).find(
    (state) => state.device_feature_external_id === featureExternalId,
  );
  return found?.state;
}

function textOf(models, featureExternalId) {
  const found = toStates(models).find(
    (state) => state.device_feature_external_id === featureExternalId,
  );
  return found?.text;
}

test('a MiGo Link installation produces a boiler, a zone, a circuit and a hot water device', () => {
  const { models } = build([tliSnapshotEntry()]);
  const externalIds = models.map((model) => model.externalId);
  assert.deepEqual(externalIds, [
    'boiler:system-1',
    'zone:system-1-0',
    'circuit:system-1-0',
    'hot-water:system-1-255',
  ]);
});

test('every discovered device carries a name and at least one feature', () => {
  const { models } = build([tliSnapshotEntry()]);
  for (const device of toDiscoveredDevices(models)) {
    assert.ok(device.name, `${device.external_id} needs a name`);
    assert.ok(device.features.length > 0, `${device.external_id} needs features`);
    for (const feature of device.features) {
      assert.ok(feature.external_id.startsWith(device.external_id));
      assert.ok(feature.category && feature.type);
    }
  }
});

test('the boiler publishes the outdoor temperature, the pressure and its activity', () => {
  const { models } = build([tliSnapshotEntry()]);
  assert.equal(stateOf(models, 'boiler:system-1:outdoor-temperature'), 8);
  assert.equal(stateOf(models, 'boiler:system-1:outdoor-temperature-24h'), 11.3);
  assert.equal(stateOf(models, 'boiler:system-1:water-pressure'), 1.3);
  assert.equal(textOf(models, 'boiler:system-1:activity'), 'HEATING');
});

test('a stopped system reports OFF rather than its last activity', () => {
  const entry = tliSnapshotEntry();
  entry.system.state.system.systemOff = true;
  const { models } = build([entry]);
  assert.equal(textOf(models, 'boiler:system-1:activity'), 'OFF');
});

test('fault codes are published as a count and as a readable detail', () => {
  const { models } = build([vrc700SnapshotEntry()]);
  assert.equal(stateOf(models, 'boiler:system-2:trouble-codes'), 1);
  assert.equal(textOf(models, 'boiler:system-2:trouble-codes-detail'), 'F.28 Ignition failure');

  const { models: healthy } = build([tliSnapshotEntry()]);
  assert.equal(stateOf(healthy, 'boiler:system-1:trouble-codes'), 0);
  assert.equal(textOf(healthy, 'boiler:system-1:trouble-codes-detail'), 'OK');
});

test('the zone takes its name from the boiler and publishes its readings', () => {
  const { models } = build([tliSnapshotEntry()]);
  const zone = models.find((model) => model.externalId === 'zone:system-1-0');
  assert.equal(zone.device.name, 'Maison – Salon');
  assert.equal(stateOf(models, 'zone:system-1-0:temperature'), 19.3);
  assert.equal(stateOf(models, 'zone:system-1-0:humidity'), 42);
  // The manual setpoint of the fixture, not its instantaneous demand (20).
  assert.equal(stateOf(models, 'zone:system-1-0:target-temperature'), 21);
  assert.equal(stateOf(models, 'zone:system-1-0:mode'), THERMOSTAT_MODE.AUTO);
  assert.equal(stateOf(models, 'zone:system-1-0:operating-state'), 1);
});

test('the setpoint published is the one the user edits, not the demand of the moment', () => {
  // A real boiler reports desiredRoomTemperatureSetpoint = 0 whenever nothing
  // is asked of the heating (scheduled zone outside its slots, summer mode).
  // Publishing that would fill the input box with a 0 the boiler would refuse.
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].desiredRoomTemperatureSetpoint = 0;
  entry.system.configuration.zones[0].heating.manualModeSetpointHeating = 19.5;

  const { models } = build([entry]);
  assert.equal(stateOf(models, 'zone:system-1-0:target-temperature'), 19.5);
});

test('a temporary override in force is what the setpoint shows', () => {
  // While an override runs, the override temperature IS the setpoint applied,
  // and the value the user just asked for.
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  entry.system.state.zones[0].desiredRoomTemperatureSetpoint = 22.5;

  const { models } = build([entry]);
  assert.equal(stateOf(models, 'zone:system-1-0:target-temperature'), 22.5);
});

test('a MiPro control publishes its comfort temperature as the setpoint', () => {
  const { models } = build([vrc700SnapshotEntry()]);
  // dayTemperatureHeating = 20, desiredRoomTemperatureSetpoint = 19.5.
  assert.equal(stateOf(models, 'zone:system-2-0:target-temperature'), 20);
});

test('no setpoint is published when the boiler reports nothing usable', () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].desiredRoomTemperatureSetpoint = 0;
  delete entry.system.configuration.zones[0].heating.manualModeSetpointHeating;

  const { models } = build([entry]);
  // Nothing published at all: the feature keeps its previous value rather than
  // showing a 0.
  assert.equal(stateOf(models, 'zone:system-1-0:target-temperature'), undefined);
});

test('a zone without a humidity probe does not declare a humidity feature', () => {
  const entry = tliSnapshotEntry();
  delete entry.system.state.zones[0].currentRoomHumidity;
  const { models } = build([entry]);
  const zone = models.find((model) => model.externalId === 'zone:system-1-0');
  const keys = zone.device.features.map((feature) => feature.external_id);
  assert.ok(!keys.includes('zone:system-1-0:humidity'));
});

test('an inactive zone is skipped: it would only add a device that never reports', () => {
  const entry = tliSnapshotEntry();
  entry.system.properties.zones[0].isActive = false;
  const { models } = build([entry]);
  assert.ok(!models.some((model) => model.externalId.startsWith('zone:')));
});

test('the hot water device reads its setpoint range from the boiler', () => {
  const { models } = build([tliSnapshotEntry()]);
  const dhw = models.find((model) => model.externalId === 'hot-water:system-1-255');
  const target = dhw.device.features.find((feature) =>
    feature.external_id.endsWith(':target-temperature'),
  );
  assert.equal(target.min, 35);
  assert.equal(target.max, 65);
  assert.equal(stateOf(models, 'hot-water:system-1-255:target-temperature'), 55);
  assert.equal(stateOf(models, 'hot-water:system-1-255:mode'), WATER_HEATER_MODE.PROGRAM);
  assert.equal(stateOf(models, 'hot-water:system-1-255:boost'), 0);
  // The boiler is heating the house, not the water.
  assert.equal(stateOf(models, 'hot-water:system-1-255:heating'), 0);
});

test('a vrc700 installation is read despite its different payload shape', () => {
  const { models } = build([vrc700SnapshotEntry()]);
  const externalIds = models.map((model) => model.externalId);
  assert.deepEqual(externalIds, [
    'boiler:system-2',
    'zone:system-2-0',
    'circuit:system-2-0',
    // Read from `domesticHotWater`, where the tli payload uses `dhw`.
    'hot-water:system-2-255',
  ]);
  assert.equal(stateOf(models, 'zone:system-2-0:mode'), THERMOSTAT_MODE.AUTO);
  assert.equal(stateOf(models, 'hot-water:system-2-255:mode'), WATER_HEATER_MODE.MANUAL);
  assert.equal(stateOf(models, 'hot-water:system-2-255:boost'), 1);
  assert.equal(stateOf(models, 'hot-water:system-2-255:heating'), 1);
  assert.equal(stateOf(models, 'circuit:system-2-0:flow-temperature'), 32.5);
  assert.equal(textOf(models, 'circuit:system-2-0:state'), 'STANDBY');
  // STANDBY circuit -> the zone is idle.
  assert.equal(stateOf(models, 'zone:system-2-0:operating-state'), 0);
});

test('two accounts on two installations produce two independent sets of devices', () => {
  const { models } = build([tliSnapshotEntry(), vrc700SnapshotEntry()]);
  const externalIds = models.map((model) => model.externalId);
  assert.equal(new Set(externalIds).size, externalIds.length, 'external ids must be unique');
  assert.ok(externalIds.includes('zone:system-1-0'));
  assert.ok(externalIds.includes('zone:system-2-0'));
});

test('statesOfDevice only returns the states of the requested device', () => {
  const { models } = build([tliSnapshotEntry()]);
  const states = statesOfDevice(models, 'zone:system-1-0');
  assert.ok(states.length > 0);
  for (const state of states) {
    assert.ok(state.device_feature_external_id.startsWith('zone:system-1-0'));
  }
  assert.deepEqual(statesOfDevice(models, 'unknown:device'), []);
});

test('read-only features have no command handler', () => {
  const { models } = build([tliSnapshotEntry()]);
  assert.equal(findCommand(models, 'boiler:system-1:water-pressure'), null);
  assert.equal(findCommand(models, 'circuit:system-1-0:flow-temperature'), null);
  assert.ok(findCommand(models, 'zone:system-1-0:target-temperature'));
  assert.ok(findCommand(models, 'hot-water:system-1-255:boost'));
});
