// -----------------------------------------------------------------------------
// The discovery payload against the rules the Gladys core actually applies.
//
// There are TWO gates, and passing the first says nothing about the second:
//
//   1. publishing — `POST /discovered_device` validates the whole batch and
//      rejects it entirely on the first violation, so one bad field means ZERO
//      devices in the Discovery screen (what `poll_frequency: 300` did);
//   2. creating — when the user clicks "Add to Gladys", the payload is written
//      to the database, where the NOT NULL columns of `t_device_feature` are
//      enforced. A feature can sail through gate 1 and still fail here with a
//      422 (what the missing `min`/`max` did on the binary features).
//
// This file mirrors both: setDiscoveredDevices.js for the first,
// server/models/device_feature.js for the second.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, SELECTOR } from './helpers/fakeGladys.js';
import { buildRawSystem } from './helpers/fixtures.js';
import { buildStubbedClient } from './helpers/stubClient.js';

/**
 * The ONLY poll intervals the core accepts, in milliseconds
 * (DEVICE_POLL_FREQUENCIES in server/utils/constants.js). Note the cap at one
 * minute: our refresh interval is configurable up to an hour, which is why the
 * devices declare no poll_frequency at all and the integration runs its own
 * loop.
 */
const ALLOWED_POLL_FREQUENCIES = [60000, 30000, 15000, 10000, 2000, 1000];

/** Batch size limit of the core (MAX_DISCOVERED_DEVICES). */
const MAX_DISCOVERED_DEVICES = 2000;

const EXTERNAL_ID_PREFIX = `ext:${SELECTOR}:`;

/**
 * Feature types Gladys can actually NAME, per category.
 *
 * The UI does not display the `name` an integration publishes: it looks up
 * `deviceFeatureCategory.<category>.<type>` in its translations. A pair that is
 * missing there renders as a blank label and a device titled "(undefined)" —
 * which is what `humidity-sensor` + `integer` did, since humidity is only
 * translated as `decimal`.
 *
 * Copied from front/src/config/i18n/fr.json of the Gladys repository, limited
 * to the categories this integration publishes.
 */
const LABELLED_TYPES = {
  'temperature-sensor': ['decimal', 'min', 'max', 'average'],
  'humidity-sensor': ['decimal'],
  'pressure-sensor': ['decimal', 'integer'],
  thermostat: ['target-temperature'],
  switch: [
    'binary',
    'power',
    'energy',
    'voltage',
    'current',
    'burglar',
    'dimmer',
    'target-current',
  ],
};

// The core checks against its own flat lists; the SDK mirrors them, so
// flattening the SDK constants gives the same vocabulary.
const CATEGORIES = new Set(Object.values(DEVICE_FEATURE_CATEGORIES));
const TYPES = new Set(Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group)));
const UNITS = new Set(Object.values(DEVICE_FEATURE_UNITS));

/**
 * Apply the core's admission rules to a discovery batch.
 * @param {Array<object>} devices - The published devices.
 */
function assertAcceptedByGladys(devices) {
  assert.ok(Array.isArray(devices), 'devices must be an array');
  assert.ok(devices.length <= MAX_DISCOVERED_DEVICES, 'too many devices');

  devices.forEach((device, index) => {
    const at = `devices[${index}]`;
    assert.equal(typeof device.name, 'string', `${at}.name must be a string`);
    assert.ok(device.name.length > 0, `${at}.name must not be empty`);
    assert.ok(
      typeof device.external_id === 'string' && device.external_id.startsWith(EXTERNAL_ID_PREFIX),
      `${at}.external_id must start with "${EXTERNAL_ID_PREFIX}"`,
    );
    if (device.poll_frequency !== undefined) {
      assert.ok(
        ALLOWED_POLL_FREQUENCIES.includes(device.poll_frequency),
        `${at}.poll_frequency: ${device.poll_frequency} is not one of ${ALLOWED_POLL_FREQUENCIES.join(', ')}`,
      );
    }
    assert.ok(Array.isArray(device.features), `${at}.features must be an array`);

    device.features.forEach((feature, featureIndex) => {
      const featureAt = `${at}.features[${featureIndex}]`;
      assert.ok(
        typeof feature.external_id === 'string' &&
          feature.external_id.startsWith(EXTERNAL_ID_PREFIX),
        `${featureAt}.external_id must start with "${EXTERNAL_ID_PREFIX}"`,
      );
      assert.ok(CATEGORIES.has(feature.category), `${featureAt}.category: unknown category`);
      assert.ok(TYPES.has(feature.type), `${featureAt}.type: unknown type`);
      if (feature.unit !== undefined && feature.unit !== null) {
        assert.ok(UNITS.has(feature.unit), `${featureAt}.unit: unknown unit`);
      }
      assertStorable(feature, featureAt);
    });
  });
}

/**
 * Apply the NOT NULL columns of `t_device_feature` — the constraints that bite
 * at creation time, not at publication time.
 *
 * `selector` and `device_id` are the core's job; `unit` is nullable. Everything
 * else below has no database default, so a missing value is a 422 the moment
 * the user clicks "Add to Gladys".
 * @param {object} feature - A published feature.
 * @param {string} at - Path of the feature, for the assertion message.
 */
function assertStorable(feature, at) {
  for (const field of ['name', 'external_id']) {
    assert.equal(typeof feature[field], 'string', `${at}.${field}: NOT NULL, must be a string`);
    assert.ok(feature[field].length > 0, `${at}.${field}: must not be empty`);
  }
  for (const field of ['read_only', 'has_feedback', 'keep_history']) {
    assert.equal(typeof feature[field], 'boolean', `${at}.${field}: NOT NULL, must be a boolean`);
  }
  // The one that bit us: min/max are NOT NULL even for a binary feature, where
  // "0 to 1" feels redundant enough to leave out.
  for (const field of ['min', 'max']) {
    assert.equal(typeof feature[field], 'number', `${at}.${field}: NOT NULL, must be a number`);
    assert.ok(Number.isFinite(feature[field]), `${at}.${field}: must be finite`);
  }
  assert.ok(feature.min <= feature.max, `${at}: min must not exceed max`);
}

/**
 * Discover the devices of a stubbed account.
 * @param {object} [raw] - Raw system payload to serve.
 * @returns {Promise<Array<object>>} The published devices.
 */
async function discover(raw = buildRawSystem()) {
  const gladys = createFakeGladys();
  const { client } = buildStubbedClient({ raw });
  const config = normalizeConfig({ username: 'user@example.com', password: 'secret' });
  return buildDiscoveredDevices(gladys, { client, config });
}

test('the discovery payload is accepted by the Gladys admission rules', async () => {
  assertAcceptedByGladys(await discover());
});

test('the payload stays valid when the optional sensors are missing', async () => {
  const raw = buildRawSystem();
  delete raw.state.zones[0].currentRoomHumidity;
  delete raw.state.system.systemWaterPressure;

  assertAcceptedByGladys(await discover(raw));
});

test('no device declares a poll_frequency', async () => {
  // Gladys caps its own intervals at one minute, so relying on them would
  // silently ignore the user's refresh interval — the integration polls itself.
  for (const device of await discover()) {
    assert.equal(
      device.poll_frequency,
      undefined,
      `${device.name} must not declare a poll_frequency`,
    );
  }
});

test('every feature carries the min and max the database demands', async () => {
  // Binary features are the trap: "0 to 1" reads as redundant, but the column
  // is NOT NULL and the user only finds out when creating the device.
  for (const device of await discover()) {
    for (const feature of device.features) {
      assert.equal(typeof feature.min, 'number', `${feature.external_id} has no min`);
      assert.equal(typeof feature.max, 'number', `${feature.external_id} has no max`);
    }
  }
});

test('a feature missing min or max is caught', () => {
  // Guards the guard: the exact shape that returned a 422 must fail here.
  assert.throws(
    () =>
      assertAcceptedByGladys([
        {
          name: 'Boiler',
          external_id: `${EXTERNAL_ID_PREFIX}boiler:abc`,
          features: [
            {
              name: 'Boiler state',
              external_id: `${EXTERNAL_ID_PREFIX}boiler:abc:state`,
              category: DEVICE_FEATURE_CATEGORIES.SWITCH,
              type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
              read_only: true,
              has_feedback: false,
              keep_history: true,
            },
          ],
        },
      ]),
    /min: NOT NULL/,
  );
});

test('every feature is one Gladys can put a name on', async () => {
  for (const device of await discover()) {
    for (const feature of device.features) {
      const types = LABELLED_TYPES[feature.category];
      assert.ok(types, `no known labels for category "${feature.category}"`);
      assert.ok(
        types.includes(feature.type),
        `${feature.category}/${feature.type} has no label: the feature would render as "(undefined)"`,
      );
    }
  }
});

test('humidity is published as a decimal, the only type it has a label for', async () => {
  const [, thermostatDevice] = await discover();
  const humidity = thermostatDevice.features.find((feature) =>
    feature.external_id.endsWith(':humidity'),
  );

  assert.ok(humidity, 'the fixture reports humidity');
  assert.equal(humidity.type, 'decimal');
});

test('a payload with an out-of-range poll_frequency is caught', () => {
  // Guards the guard: the check above must actually reject the value that
  // silently emptied the Discovery screen.
  assert.throws(
    () =>
      assertAcceptedByGladys([
        {
          name: 'Thermostat',
          external_id: `${EXTERNAL_ID_PREFIX}thermostat:abc`,
          poll_frequency: 300,
          features: [],
        },
      ]),
    /poll_frequency: 300 is not one of/,
  );
});
