// -----------------------------------------------------------------------------
// External identifiers. Because the devices are discovered rather than
// hard-coded, every poll and every command is routed by parsing the id back:
// the round trip must hold for any system id the cloud hands out.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boilerIds,
  DEVICE_TYPES,
  parseDeviceExternalId,
  parseFeatureKey,
  thermostatIds,
  thermostatPlatformId,
} from '../src/devices/externalIds.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { SYSTEM_ID } from './helpers/fixtures.js';

const gladys = createFakeGladys();

test('a thermostat id round trips back to its system and zone', () => {
  const ids = thermostatIds(gladys, SYSTEM_ID, 2);
  assert.deepEqual(parseDeviceExternalId(ids.device), {
    type: DEVICE_TYPES.THERMOSTAT,
    systemId: SYSTEM_ID,
    zoneIndex: 2,
  });
});

test('a boiler id round trips back to its system', () => {
  const ids = boilerIds(gladys, SYSTEM_ID);
  assert.deepEqual(parseDeviceExternalId(ids.device), {
    type: DEVICE_TYPES.BOILER,
    systemId: SYSTEM_ID,
  });
});

test('a system id containing underscores is not truncated', () => {
  // The zone suffix is matched greedily from the right, so an underscore in
  // the system id itself cannot be mistaken for the separator.
  const ids = thermostatIds(gladys, 'home_1_z9_abc', 0);
  assert.deepEqual(parseDeviceExternalId(ids.device), {
    type: DEVICE_TYPES.THERMOSTAT,
    systemId: 'home_1_z9_abc',
    zoneIndex: 0,
  });
});

test('the platform id keeps the zone index readable', () => {
  assert.equal(thermostatPlatformId(SYSTEM_ID, 1), `${SYSTEM_ID}_z1`);
});

test('ids that are not ours are rejected instead of half-parsed', () => {
  assert.equal(parseDeviceExternalId(undefined), null);
  assert.equal(parseDeviceExternalId(''), null);
  assert.equal(parseDeviceExternalId('zwave:node:12'), null);
  assert.equal(parseDeviceExternalId('ext:saunier-duval:unknown:abc'), null);
  assert.equal(parseDeviceExternalId('ext:saunier-duval:thermostat:no-zone-suffix'), null);
  assert.equal(parseDeviceExternalId('ext:saunier-duval:boiler:'), null);
});

test('a feature key is read from the last segment of its id', () => {
  const ids = thermostatIds(gladys, SYSTEM_ID, 0);
  assert.equal(parseFeatureKey(ids.feature('target-temperature')), 'target-temperature');
  assert.equal(parseFeatureKey(ids.device), null, 'a device id carries no feature');
});
