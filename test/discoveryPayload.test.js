// -----------------------------------------------------------------------------
// The discovery payload against the rules of the Gladys core.
//
// `POST /discovered_device` validates the WHOLE batch and rejects it entirely
// on the first offending field — one bad value and the Discovery screen stays
// empty, with nothing published and no obvious culprit. These tests replay the
// server-side checks of `externalIntegration.setDiscoveredDevices` on the
// payload we actually build.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import { buildDeviceModels, toDiscoveredDevices } from '../src/devices/index.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { tliSnapshotEntry, vrc700SnapshotEntry } from './helpers/fixtures.js';

/** Flatten the SDK constants the way the core builds its validation lists. */
const CATEGORIES = new Set(Object.values(DEVICE_FEATURE_CATEGORIES));
const TYPES = new Set(Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group)));
const UNITS = new Set(Object.values(DEVICE_FEATURE_UNITS));

/**
 * The only poll frequencies the core accepts, in MILLISECONDS
 * (DEVICE_POLL_FREQUENCIES in server/utils/constants.js). Anything else — a
 * value in seconds, for instance — makes the core reject the whole batch.
 */
const ALLOWED_POLL_FREQUENCIES = new Set([60000, 30000, 15000, 10000, 2000, 1000]);

/** Same limit as MAX_DISCOVERED_DEVICES in the core. */
const MAX_DISCOVERED_DEVICES = 2000;

const config = normalizeConfig({ email: 'user@example.com', password: 's3cret' });

function discoveredDevices() {
  const gladys = createFakeGladys();
  const models = buildDeviceModels(
    gladys,
    [tliSnapshotEntry(), vrc700SnapshotEntry()],
    normalizeConfig({ ...config, poll_frequency: 300 }),
  );
  return toDiscoveredDevices(models);
}

test('a device never carries a poll frequency the core would refuse', () => {
  // This is what kept the Discovery screen empty: a poll_frequency in seconds
  // (300) is not in the core list, so the whole payload was rejected. The
  // integration drives its own refresh loop instead of declaring one.
  for (const device of discoveredDevices()) {
    if (device.poll_frequency !== undefined) {
      assert.ok(
        ALLOWED_POLL_FREQUENCIES.has(device.poll_frequency),
        `${device.external_id}: poll_frequency ${device.poll_frequency} would be refused by Gladys`,
      );
    }
  }
});

test('a configured refresh interval never leaks into the payload', () => {
  const gladys = createFakeGladys();
  for (const pollFrequency of [60, 120, 300, 900, 3600]) {
    const models = buildDeviceModels(
      gladys,
      [tliSnapshotEntry()],
      normalizeConfig({ ...config, poll_frequency: pollFrequency }),
    );
    for (const device of toDiscoveredDevices(models)) {
      assert.equal(
        device.poll_frequency,
        undefined,
        `${device.external_id}: the refresh interval belongs to the integration loop, not to the device`,
      );
    }
  }
});

test('every device passes the core validation of the batch', () => {
  const devices = discoveredDevices();
  assert.ok(devices.length > 0);
  assert.ok(devices.length <= MAX_DISCOVERED_DEVICES);

  for (const device of devices) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.name.length > 0, 'a device without a name is refused');
    assert.equal(typeof device.external_id, 'string');
    assert.ok(Array.isArray(device.features), 'features must be an array');
    // We publish no params: the GLADYS_* namespace is reserved and validated.
    assert.equal(device.params, undefined);
    // The core forces the selector itself; publishing one is pointless.
    assert.equal(device.selector, undefined);
  }
});

test('every feature carries the fields the database refuses to default', () => {
  // `min`, `max`, `name`, `read_only`, `has_feedback` and `keep_history` are
  // NOT NULL on t_device_feature. A missing min/max only fails when the user
  // creates the device (HTTP 422, "min cannot be null") — the discovery list
  // itself looks perfectly fine, which is what makes it easy to miss. Text
  // features have no numeric range and still need both.
  for (const device of discoveredDevices()) {
    for (const feature of device.features) {
      const where = `${feature.external_id}`;
      assert.ok(typeof feature.name === 'string' && feature.name.length > 0, `${where}: no name`);
      assert.equal(typeof feature.min, 'number', `${where}: min must be a number`);
      assert.equal(typeof feature.max, 'number', `${where}: max must be a number`);
      assert.ok(Number.isFinite(feature.min), `${where}: min must be finite`);
      assert.ok(Number.isFinite(feature.max), `${where}: max must be finite`);
      assert.ok(feature.min <= feature.max, `${where}: min must not exceed max`);
      assert.equal(typeof feature.read_only, 'boolean', `${where}: read_only must be a boolean`);
      assert.equal(
        typeof feature.has_feedback,
        'boolean',
        `${where}: has_feedback must be a boolean`,
      );
      assert.equal(
        typeof feature.keep_history,
        'boolean',
        `${where}: keep_history must be a boolean`,
      );
    }
  }
});

test('every feature uses a category, a type and a unit the core knows', () => {
  for (const device of discoveredDevices()) {
    for (const feature of device.features) {
      assert.ok(
        CATEGORIES.has(feature.category),
        `${feature.external_id}: unknown category "${feature.category}"`,
      );
      assert.ok(TYPES.has(feature.type), `${feature.external_id}: unknown type "${feature.type}"`);
      if (feature.unit !== undefined && feature.unit !== null) {
        assert.ok(
          UNITS.has(feature.unit),
          `${feature.external_id}: unknown unit "${feature.unit}"`,
        );
      }
    }
  }
});

/**
 * Category/type pairs Gladys has a name and a pictogram for. A pair outside
 * this list still saves fine, but the interface shows "undefined" with no
 * icon — `humidity-sensor` exists as `decimal` only, never as `integer`.
 * Mirrors front/src/config/i18n (deviceFeatureCategory) and
 * front/src/utils/consts.js (DeviceFeatureCategoriesIcon).
 */
const RENDERABLE_PAIRS = new Set([
  'temperature-sensor/decimal',
  'humidity-sensor/decimal',
  'pressure-sensor/decimal',
  'counter-sensor/integer',
  'text/text',
  'thermostat/target-temperature',
  'thermostat/mode',
  'thermostat/operating-state',
  'duration/decimal',
  'water-heater/target-temperature',
  'water-heater/mode',
  'water-heater/boost',
  'water-heater/heating',
]);

test('every feature is one Gladys can name and illustrate', () => {
  for (const device of discoveredDevices()) {
    for (const feature of device.features) {
      const pair = `${feature.category}/${feature.type}`;
      assert.ok(
        RENDERABLE_PAIRS.has(pair),
        `${feature.external_id}: "${pair}" has no label nor pictogram in Gladys`,
      );
    }
  }
});

test('supported options are shaped the way the core validates them', () => {
  // normalizeSupportedOptions (Joi): integer value, non-empty label, optional
  // integer sort_order, and no duplicate value inside one feature.
  let checked = 0;
  for (const device of discoveredDevices()) {
    for (const feature of device.features) {
      if (feature.supported_options === undefined) {
        continue;
      }
      checked += 1;
      assert.ok(Array.isArray(feature.supported_options), `${feature.external_id}: must be a list`);
      const values = feature.supported_options.map((option) => option.value);
      assert.equal(
        new Set(values).size,
        values.length,
        `${feature.external_id}: duplicate supported option`,
      );
      for (const option of feature.supported_options) {
        assert.ok(Number.isInteger(option.value), `${feature.external_id}: value must be an int`);
        assert.ok(
          typeof option.label === 'string' && option.label.trim().length > 0,
          `${feature.external_id}: label must be a non-empty string`,
        );
        assert.ok(
          option.sort_order === undefined || Number.isInteger(option.sort_order),
          `${feature.external_id}: sort_order must be an int`,
        );
        assert.ok(
          option.value >= feature.min && option.value <= feature.max,
          `${feature.external_id}: option ${option.value} falls outside the feature range`,
        );
      }
    }
  }
  assert.ok(checked > 0, 'the mode features must declare their supported options');
});

test('external ids are unique across the whole batch', () => {
  const devices = discoveredDevices();
  const deviceIds = devices.map((device) => device.external_id);
  assert.equal(new Set(deviceIds).size, deviceIds.length, 'duplicate device external_id');

  const featureIds = devices.flatMap((device) =>
    device.features.map((feature) => feature.external_id),
  );
  assert.equal(new Set(featureIds).size, featureIds.length, 'duplicate feature external_id');
});
