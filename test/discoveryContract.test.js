// -----------------------------------------------------------------------------
// The discovery payload against the rules the Gladys core actually applies.
//
// `POST /discovered_device` validates the whole batch and rejects it entirely
// on the first violation, so ONE bad field means ZERO devices appear in the
// Discovery screen — with no error on the integration side unless you look for
// it. That is exactly what happened with `poll_frequency`, hence this file:
// it mirrors server/lib/external-integration/externalIntegration.setDiscoveredDevices.js
// so a payload the core would refuse fails here first.
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
    });
  });
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
